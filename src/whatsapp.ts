import makeWASocket, { BufferJSON, DisconnectReason, initAuthCreds, proto, Browsers, type AuthenticationState, type WASocket } from '@whiskeysockets/baileys';
import { safeStorage } from 'electron';
import pino from 'pino';
import QRCode from 'qrcode';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, Store } from './store.ts';
import { type Recipient } from './model.ts';
import { RecipientSync, chatJid } from './recipients.ts';
import { recoverStalledEvents, SyncHealth } from './sync-health.ts';

export class WhatsApp {
  store: Store; directory: string; changed: () => void;
  socket?: WASocket; state?: AuthenticationState;
  status = 'Connecting…'; qr = ''; syncNote = ''; error = '';
  stopping = false; retries = 0; timer?: ReturnType<typeof setTimeout>;
  recipients = new RecipientSync(); generation = 0;
  health = new SyncHealth(); openedAt = 0; syncTimer?: ReturnType<typeof setInterval>;
  report: (error: unknown) => void;
  auth: { creds: ReturnType<typeof initAuthCreds>; keys: Record<string, unknown> } | undefined;
  writes: Promise<void> = Promise.resolve();
  constructor(store: Store, directory: string, changed: () => void, report: (error: unknown) => void = () => {}) { this.store = store; this.directory = directory; this.changed = changed; this.report = report; this.recipients = new RecipientSync(store.data.recipientMetadata); store.change(d => this.recipients.contacts(d.recipients, [])); }
  get connected(): boolean { return this.status === 'WhatsApp connected'; }
  async saveAuth(): Promise<void> {
    this.writes = this.writes.then(async () => {
      const plain = JSON.stringify(this.auth, BufferJSON.replacer);
      const encrypted = await safeStorage.encryptStringAsync(plain);
      atomicWrite(join(this.directory, 'auth.enc'), encrypted);
    });
    // An encryption/disk failure stops networking; never use unsaved Signal keys.
    await this.writes;
  }
  async connect(): Promise<void> {
    if (this.stopping) return;
    clearInterval(this.syncTimer);
    this.health.pendingReceived = false;
    const generation = ++this.generation;
    this.status = 'Connecting…'; this.error = ''; this.changed();
    try {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Windows protected storage is unavailable. Restart the app.');
      if (!this.auth) {
        const file = join(this.directory, 'auth.enc');
        this.auth = existsSync(file)
          ? JSON.parse((await safeStorage.decryptStringAsync(readFileSync(file))).result, BufferJSON.reviver)
          : { creds: initAuthCreds(), keys: {} };
      }
      const auth = this.auth!;
      this.state = {
        creds: auth.creds,
        keys: {
          get: async (type, ids) => {
            const out: Record<string, any> = {};
            for (const id of ids) {
              let value = auth.keys[`${type}:${id}`] as any;
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              if (value) out[id] = value;
            }
            return out;
          },
          set: async data => {
            for (const [type, values] of Object.entries(data)) for (const [id, value] of Object.entries(values || {})) {
              if (value === null) delete auth.keys[`${type}:${id}`]; else auth.keys[`${type}:${id}`] = value;
            }
            await this.saveAuth();
          }
        }
      };
      await this.saveAuth();
      const socket = makeWASocket({ auth: this.state, logger: pino({ level: 'warn' }, { write: line => {
        try { const entry = JSON.parse(line); this.health.warning(entry.msg); } catch { /* Never keep raw protocol logs. */ }
      } }), browser: Browsers.ubuntu('Chrome'), syncFullHistory: true, markOnlineOnConnect: false, connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000 });
      this.socket = socket;
      const active = () => generation === this.generation && !this.stopping;
      socket.ev.on('creds.update', update => {
        if (!active()) return;
        Object.assign(auth.creds, update);
        void this.saveAuth().catch(() => this.fatalAuth());
      });
      socket.ev.on('connection.update', update => {
        if (!active()) return;
        if (update.receivedPendingNotifications) this.health.pendingReceived = true;
        void (async () => {
          if (update.qr) { const qr = await QRCode.toDataURL(update.qr, { width: 240, margin: 2, color: { dark: '#111111', light: '#ffffff' } }); if (!active()) return; this.qr = qr; this.status = 'Scan QR to sign in'; }
          if (update.connection === 'open') {
            this.qr = ''; this.status = 'WhatsApp connected'; this.retries = 0; this.openedAt = Date.now(); this.error = '';
            clearInterval(this.syncTimer);
            this.syncTimer = setInterval(() => {
              if (!active() || !this.connected) return;
              if (recoverStalledEvents(socket.ev, this.health.pendingReceived, Date.now() - this.openedAt)) {
                this.health.bufferRecoveries++;
                this.syncNote = this.recipients.note(this.store.data.recipients) + ' Recovered a stalled chat sync.'; this.changed();
              }
            }, 30000);
            this.syncNote = 'Syncing chats…'; this.changed();
            void this.refresh(false).catch(() => { this.syncNote = 'Unable to refresh groups. Try Refresh lists.'; this.changed(); });
          }
          if (update.connection === 'close') {
            clearInterval(this.syncTimer);
            ++this.generation; // Ignore late events from the disconnected socket.
            this.qr = ''; this.socket = undefined;
            const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
            this.health.lastDisconnectCode = typeof code === 'number' ? code : null;
            this.report(update.lastDisconnect?.error || new Error('WhatsApp connection closed'));
            this.error = `The WhatsApp connection closed${code ? ` (code ${code})` : ''}. The app will reconnect automatically.`;
            if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
              await this.writes.catch(() => {});
              rmSync(join(this.directory, 'auth.enc'), { force: true });
              this.auth = undefined; this.writes = Promise.resolve();
              this.store.change(d => { d.recipients = []; d.recipientMetadata = {}; }); this.recipients.clear();
              this.status = 'Scan QR to sign in';
              this.syncNote = 'The WhatsApp session ended. Scan the QR code again.';
              this.scheduleReconnect(1000);
            } else {
              this.status = 'Disconnected';
              this.scheduleReconnect(Math.min(60000, 2000 * 2 ** Math.min(this.retries++, 5)));
            }
          }
          this.changed();
        })().catch(() => this.fatalAuth());
      });
      const updated = () => {
        this.syncNote = this.recipients.note(this.store.data.recipients);
        if (!this.store.data.recipients.some(r => r.kind === 'personal')) this.syncNote += ' Waiting for history from your phone. Open WhatsApp on your phone; new personal messages also add chats to the list.';
        this.changed();
      };
      const contacts = (list: Parameters<RecipientSync['contacts']>[1]) => {
        if (!active()) return;
        this.health.contactEvents++;
        this.store.change(d => { this.recipients.contacts(d.recipients, list); d.recipientMetadata = this.recipients.metadata; }); updated();
      };
      const chats = (list: Parameters<RecipientSync['chats']>[1]) => {
        if (!active()) return;
        this.health.chatEvents++;
        this.store.change(d => { this.recipients.chats(d.recipients, list); d.recipientMetadata = this.recipients.metadata; }); updated();
      };
      socket.ev.on('messaging-history.set', history => {
        if (!active()) return;
        this.health.historyEvents++; this.health.historyChats += history.chats.length; this.health.historyMessages += history.messages.length;
        this.health.lastHistoryType = history.syncType ?? null; this.health.historyProgress = history.progress ?? null;
        this.store.change(d => {
          this.recipients.contacts(d.recipients, history.contacts);
          this.recipients.chats(d.recipients, history.chats);
          this.recipients.messages(d.recipients, history.messages);
          d.recipientMetadata = this.recipients.metadata;
        }); updated();
      });
      socket.ev.on('messages.upsert', event => {
        if (!active()) return;
        this.health.messageEvents++; this.health.personalMessageAddresses += event.messages.filter(m => { const jid = chatJid(m.key.remoteJid); return jid && !jid.endsWith('@g.us'); }).length;
        this.store.change(d => { this.recipients.messages(d.recipients, event.messages); d.recipientMetadata = this.recipients.metadata; }); updated();
      });
      socket.ev.on('chats.phoneNumberShare', mapping => contacts([mapping]));
      socket.ev.on('contacts.upsert', contacts);
      socket.ev.on('contacts.update', contacts);
      socket.ev.on('chats.upsert', chats);
      socket.ev.on('chats.update', chats);
      socket.ev.on('chats.delete', ids => { if (active()) { this.store.change(d => { d.recipients = d.recipients.filter(r => !ids.map(chatJid).includes(r.jid)); }); this.changed(); } });
    } catch (error) {
      this.report(error);
      this.status = 'Disconnected'; this.error = 'Unable to connect or open the protected session. Check your internet connection and restart the app. Your session data has been preserved.';
      this.changed(); this.scheduleReconnect(30000);
    }
  }
  fatalAuth(): void {
    clearInterval(this.syncTimer);
    this.stopping = true; ++this.generation; this.socket?.end(new Error('Auth persistence failed'));
    this.status = 'Disconnected'; this.error = 'Unable to save the protected session. Sending has stopped. Check available disk space and restart the app.'; this.changed();
  }
  scheduleReconnect(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.connect(); }, ms);
  }
  async logout(): Promise<void> {
    if (!this.connected || !this.socket) throw new Error('No connection to WhatsApp.');
    clearTimeout(this.timer); clearInterval(this.syncTimer); ++this.generation;
    const socket = this.socket;
    this.status = 'Signing out…'; this.qr = ''; this.changed();
    try {
      // Revoke the linked device, rather than only deleting local credentials.
      await socket.logout();
    } catch (error) {
      this.report(error);
      socket.end(undefined); this.socket = undefined;
      this.status = 'Disconnected';
      this.error = 'Unable to sign out of WhatsApp. Reconnect and try again, or unlink this device on your phone.';
      this.changed();
      throw new Error(this.error);
    }
    socket.end(undefined); this.socket = undefined;
    await this.writes;
    rmSync(join(this.directory, 'auth.enc'), { force: true });
    this.auth = undefined; this.state = undefined; this.writes = Promise.resolve();
    this.recipients.clear();
    this.store.change(d => {
      d.recipients = []; d.recipientMetadata = {}; d.settings.paused = true;
    });
    this.status = 'Signed out'; this.syncNote = 'Signed out. Schedules are paused. Click Connect WhatsApp to sign in again.';
    this.error = ''; this.changed();
  }
  async reconnect(): Promise<void> {
    if (this.stopping) throw new Error('Unable to connect. Restart the app to open the protected session.');
    clearTimeout(this.timer); clearInterval(this.syncTimer); ++this.generation;
    this.socket?.end(undefined); this.socket = undefined; this.qr = '';
    await this.connect();
  }
  async refresh(resync = true): Promise<void> {
    if (!this.connected || !this.socket) throw new Error('No connection to WhatsApp.');
    const socket = this.socket, generation = this.generation;
    const groups = await socket.groupFetchAllParticipating();
    if (generation !== this.generation || socket !== this.socket) return;
    this.store.change(d => {
      d.recipients = d.recipients.filter(r => r.kind !== 'group');
      for (const g of Object.values(groups)) d.recipients.push({ jid: g.id, name: g.subject, kind: 'group' });
    });
    if (resync) {
      await socket.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true);
      if (generation !== this.generation || socket !== this.socket) return;
      if (recoverStalledEvents(socket.ev, this.health.pendingReceived, Date.now() - this.openedAt)) this.health.bufferRecoveries++;
    }
    this.syncNote = this.recipients.note(this.store.data.recipients) + (this.store.data.recipients.some(r => r.kind === 'personal') ? ' Lists refreshed.' : ' Waiting for history from your phone. Open WhatsApp on your phone and send or receive a message in the personal chat.'); this.changed();
  }
  diagnostics() {
    return this.health.snapshot(this.socket?.ev.isBuffering() || false, this.store.data.recipients.filter(r => r.kind === 'personal').length, this.store.data.recipients.filter(r => r.kind === 'group').length);
  }
  async send(r: Recipient, text: string, messageId: string): Promise<void> {
    if (!this.connected || !this.socket) throw new Error('No connection to WhatsApp.');
    await this.socket.sendMessage(r.jid, { text }, { messageId });
  }
  async stop(): Promise<void> {
    clearInterval(this.syncTimer);
    this.stopping = true; ++this.generation; clearTimeout(this.timer); this.socket?.end(undefined);
    await this.writes;
  }
}
