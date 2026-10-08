import makeWASocket, { BufferJSON, initAuthCreds, proto, Browsers, type AuthenticationState, type WASocket } from '@whiskeysockets/baileys';
import { safeStorage } from 'electron';
import pino from 'pino';
import QRCode from 'qrcode';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, Store } from './store.ts';
import { type Recipient } from './model.ts';
import { RecipientSync, chatJid } from './recipients.ts';
import { forceContactSnapshot, recipientCounts, refreshSummary } from './contact-refresh.ts';
import { recoverStalledEvents, SyncHealth } from './sync-health.ts';
import { disconnectAction, failureMessage, PersistenceError } from './connection-policy.ts';

export class WhatsApp {
  store: Store; directory: string; changed: () => void;
  socket?: WASocket; state?: AuthenticationState;
  status = 'Connecting…'; qr = ''; syncNote = ''; error = '';
  refreshing = false; refreshResult = '';
  stopping = false; retries = 0; timer?: ReturnType<typeof setTimeout>;
  recipients = new RecipientSync(); generation = 0;
  health = new SyncHealth(); openedAt = 0; syncTimer?: ReturnType<typeof setInterval>;
  report: (error: unknown) => void;
  auth: { creds: ReturnType<typeof initAuthCreds>; keys: Record<string, unknown> } | undefined;
  writes: Promise<void> = Promise.resolve();
  connecting?: Promise<void>;
  closing?: Promise<void>;
  disconnects: { at: string; code: number | null; reason: string; action: string; registered: boolean }[] = [];
  constructor(store: Store, directory: string, changed: () => void, report: (error: unknown) => void = () => {}) { this.store = store; this.directory = directory; this.changed = changed; this.report = report; this.recipients = new RecipientSync(store.data.recipientMetadata); store.change(d => this.recipients.contacts(d.recipients, [])); }
  get connected(): boolean { return this.status === 'WhatsApp connected'; }
  async saveAuth(): Promise<void> {
    this.writes = this.writes.then(async () => {
      const plain = JSON.stringify(this.auth, BufferJSON.replacer);
      try {
        const encrypted = await safeStorage.encryptStringAsync(plain);
        atomicWrite(join(this.directory, 'auth.enc'), encrypted);
      } catch (cause) { throw cause instanceof PersistenceError ? cause : new PersistenceError('protected session', cause); }
    });
    // An encryption/disk failure stops networking; never use unsaved Signal keys.
    await this.writes;
  }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async openSocket(): Promise<void> {
    await this.closing;
    if (this.stopping) return;
    clearTimeout(this.timer);
    clearInterval(this.syncTimer);
    this.health.pendingReceived = false;
    const generation = ++this.generation;
    this.status = 'Connecting…'; this.error = ''; this.syncNote = 'Connecting to WhatsApp…'; this.refreshResult = ''; this.changed();
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
            try { await this.saveAuth(); } catch (error) { this.fatalAuth(error); throw error; }
          }
        }
      };
      await this.saveAuth();
      if (this.stopping || generation !== this.generation) return;
      const socket = makeWASocket({ auth: this.state, logger: pino({ level: 'warn' }, { write: line => {
        try { const entry = JSON.parse(line); this.health.warning(entry.msg); } catch { /* Never keep raw protocol logs. */ }
      } }), browser: Browsers.ubuntu('Chrome'), syncFullHistory: true, markOnlineOnConnect: false, connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000 });
      this.socket = socket;
      const active = () => generation === this.generation && !this.stopping;
      socket.ev.on('creds.update', update => {
        if (!active()) return;
        Object.assign(auth.creds, update);
        void this.saveAuth().catch(error => this.fatalAuth(error));
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
            void this.refresh(false).catch(error => {
              if (error instanceof PersistenceError) { this.fatalAuth(error); return; }
              if (active()) { this.syncNote = 'Unable to refresh groups. Try Refresh lists.'; this.changed(); }
            });
          }
          if (update.connection === 'close') {
            clearInterval(this.syncTimer);
            ++this.generation; // Ignore late events from the disconnected socket.
            this.qr = ''; this.socket = undefined;
            this.closing = this.handleClose(update.lastDisconnect?.error);
            try { await this.closing; } finally { this.closing = undefined; }
          }
          this.changed();
        })().catch(error => { this.report(error); this.halt(failureMessage(error)); });
      });
      const updated = () => {
        if (!this.refreshing) this.syncNote = this.recipients.note(this.store.data.recipients);
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
      if (error instanceof PersistenceError) { this.halt(failureMessage(error)); return; }
      if (this.stopping || generation !== this.generation) return;
      this.status = 'Disconnected'; this.error = 'Unable to connect or open the protected session. Check your internet connection and restart the app. Your session data has been preserved.';
      this.changed(); this.scheduleReconnect(30000);
    }
  }
  private async handleClose(error: unknown): Promise<void> {
    const raw = error as { output?: { statusCode?: unknown }; message?: string } | undefined;
    const code = typeof raw?.output?.statusCode === 'number' ? raw.output.statusCode : null;
    const message = typeof raw?.message === 'string' ? raw.message : '';
    const action = disconnectAction(code, message);
    // Keep only known categories; raw protocol payloads can contain private data.
    const reason = message === 'QR refs attempts ended' ? 'qr-expired'
      : message.startsWith('Stream Errored (ack)') ? 'stream-ack'
      : message.startsWith('Stream Errored') ? 'stream-error' : 'connection';
    const entry = { at: new Date().toISOString(), code, reason, action, registered: !!this.auth?.creds.registered };
    this.disconnects = [...this.disconnects.slice(-19), entry];
    this.health.lastDisconnectCode = code;
    this.report(new Error(`WhatsApp disconnect ${JSON.stringify(entry)}`));
    clearTimeout(this.timer); this.timer = undefined;
    this.status = 'Disconnected'; this.refreshResult = '';
    this.syncNote = 'Saved chat lists and session are preserved.';
    this.error = `The WhatsApp connection closed${code !== null ? ` (code ${code})` : ''}. The app will reconnect automatically.`;
    // Finish durable key writes before a replacement socket reads the session.
    await this.writes;
    if (this.stopping) return;
    if (action === 'logout') {
      rmSync(join(this.directory, 'auth.enc'), { force: true });
      this.auth = undefined; this.state = undefined; this.writes = Promise.resolve();
      this.store.change(d => { d.recipients = []; d.recipientMetadata = {}; }); this.recipients.clear();
      this.syncNote = 'WhatsApp revoked this linked session (401). Scan a new QR code to sign in.';
      this.error = 'WhatsApp signed out this device. A new QR sign-in is required.';
      this.scheduleReconnect(1000);
    } else if (action === 'qr-expired') {
      this.syncNote = 'The QR code expired. Click Reconnect to get a new QR code.';
      this.error = 'QR sign-in timed out. Automatic QR retries have stopped.';
    } else if (action === 'manual') {
      this.syncNote = code === 440 ? 'Another connection replaced this session. Close the other instance, then click Reconnect.' : 'WhatsApp rejected this connection. Check Linked devices on your phone, then click Reconnect.';
      this.error = `WhatsApp stopped the connection (code ${code}). Automatic retries have stopped; your session is preserved.`;
    } else if (action === 'restart') {
      this.syncNote = 'WhatsApp requested a connection restart. Reconnecting with the saved session…';
      this.error = ''; this.scheduleReconnect(1000);
    } else this.scheduleReconnect(Math.min(60000, 2000 * 2 ** Math.min(this.retries++, 5)));
  }
  fatalAuth(error: unknown = new PersistenceError('protected session', undefined)): void {
    this.report(error); this.halt(failureMessage(error));
  }
  halt(message: string): void {
    clearInterval(this.syncTimer); clearTimeout(this.timer);
    this.stopping = true; ++this.generation; this.socket?.end(undefined); this.socket = undefined; this.qr = '';
    this.status = 'Disconnected'; this.error = message; this.syncNote = 'Sending is stopped. Restart the app; saved data is preserved.'; this.changed();
  }
  scheduleReconnect(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, ms);
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
    if (this.status === 'Signing out…') throw new Error('Wait for sign out to finish.');
    if (this.stopping) throw new Error('Unable to connect. Restart the app to open the protected session.');
    await this.closing;
    await this.connecting;
    if (this.stopping) throw new Error('Unable to connect. Restart the app to open the protected session.');
    clearTimeout(this.timer); clearInterval(this.syncTimer); ++this.generation;
    this.socket?.end(undefined); this.socket = undefined; this.qr = '';
    await this.connect();
  }
  async refresh(resync = true): Promise<void> {
    if (!this.connected || !this.socket) throw new Error('No connection to WhatsApp.');
    if (this.refreshing) throw new Error('Wait for the current refresh to finish.');
    const socket = this.socket, generation = this.generation;
    const active = () => generation === this.generation && socket === this.socket && this.connected;
    const before = new Map(this.store.data.recipients.map(r => [r.jid, r.name]));
    this.refreshing = true; this.refreshResult = ''; this.syncNote = 'Fetching groups and contact names…'; this.changed();
    try {
      const groups = await socket.groupFetchAllParticipating();
      if (!active()) return;
      this.store.change(d => {
        d.recipients = d.recipients.filter(r => r.kind !== 'group');
        for (const g of Object.values(groups)) {
          d.recipients.push({ jid: g.id, name: g.subject, kind: 'group' });
          // Group members supply explicit phone/LID pairs. Never create
          // personal chats merely because someone belongs to a group.
          this.recipients.contacts(d.recipients, g.participants || []);
        }
        d.recipientMetadata = structuredClone(this.recipients.metadata);
      });
      if (!resync) { this.syncNote = this.recipients.note(this.store.data.recipients); return; }
      let snapshot = false, lookupFailed = false;
      this.syncNote = 'Requesting a full contact snapshot…'; this.changed();
      try { snapshot = await forceContactSnapshot(socket, active); }
      catch (error) { if (error instanceof PersistenceError) throw error; this.report(error); }
      if (!active()) return;
      if (recoverStalledEvents(socket.ev, this.health.pendingReceived, Date.now() - this.openedAt)) this.health.bufferRecoveries++;
      // This lookup takes real phone numbers, NEVER anonymous LID digits.
      // It can connect phonebook names to LID chats without sending messages.
      if (recipientCounts(this.store.data.recipients).unresolved) {
        const phones = this.recipients.phoneCandidates(this.store.data.recipients).slice(0, 1000);
        for (let offset = 0; offset < phones.length; offset += 50) {
          if (!active()) return;
          this.syncNote = `Resolving known phone numbers: ${Math.min(offset + 50, phones.length)}/${phones.length}…`; this.changed();
          try {
            const mappings = await socket.onWhatsApp(...phones.slice(offset, offset + 50));
            if (!active()) return;
            this.store.change(d => {
              this.recipients.contacts(d.recipients, (mappings || []).map(mapping => ({ jid: chatJid(mapping.jid), lid: chatJid(mapping.lid) })));
              d.recipientMetadata = structuredClone(this.recipients.metadata);
            });
          } catch (error) { if (error instanceof PersistenceError) throw error; this.report(error); lookupFailed = true; break; }
        }
      }
      if (!active()) return;
      this.refreshResult = refreshSummary(before, this.store.data.recipients, Object.keys(groups).length, snapshot, lookupFailed);
      this.syncNote = this.refreshResult;
    } finally { this.refreshing = false; this.changed(); }
  }
  diagnostics() {
    return { ...this.health.snapshot(this.socket?.ev.isBuffering() || false, this.store.data.recipients.filter(r => r.kind === 'personal').length, this.store.data.recipients.filter(r => r.kind === 'group').length), names: recipientCounts(this.store.data.recipients), refreshing: this.refreshing, disconnects: this.disconnects, sessionRegistered: !!this.auth?.creds.registered, reconnectScheduled: !!this.timer && !this.stopping }; 
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
