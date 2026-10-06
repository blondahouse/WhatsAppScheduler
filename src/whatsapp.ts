import makeWASocket, { BufferJSON, DisconnectReason, initAuthCreds, proto, Browsers, type AuthenticationState, type WASocket } from '@whiskeysockets/baileys';
import { safeStorage } from 'electron';
import pino from 'pino';
import QRCode from 'qrcode';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, Store } from './store.ts';
import { validRecipient, type Recipient } from './model.ts';

export class WhatsApp {
  store: Store; directory: string; changed: () => void;
  socket?: WASocket; state?: AuthenticationState;
  status = 'Подключение…'; qr = ''; syncNote = ''; error = '';
  stopping = false; retries = 0; timer?: ReturnType<typeof setTimeout>;
  names = new Map<string, string>(); generation = 0;
  auth: { creds: ReturnType<typeof initAuthCreds>; keys: Record<string, unknown> } | undefined;
  writes: Promise<void> = Promise.resolve();
  constructor(store: Store, directory: string, changed: () => void) { this.store = store; this.directory = directory; this.changed = changed; }
  get connected(): boolean { return this.status === 'WhatsApp подключён'; }
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
    const generation = ++this.generation;
    this.status = 'Подключение…'; this.error = ''; this.changed();
    try {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Защищённое хранилище Windows недоступно. Перезапустите приложение.');
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
      const socket = makeWASocket({ auth: this.state, logger: pino({ level: 'silent' }), browser: Browsers.windows('Desktop'), syncFullHistory: true, markOnlineOnConnect: false, connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000 });
      this.socket = socket;
      const active = () => generation === this.generation && !this.stopping;
      socket.ev.on('creds.update', update => {
        if (!active()) return;
        Object.assign(auth.creds, update);
        void this.saveAuth().catch(() => this.fatalAuth());
      });
      socket.ev.on('connection.update', update => {
        if (!active()) return;
        void (async () => {
          if (update.qr) { this.qr = await QRCode.toDataURL(update.qr, { width: 240, margin: 2, color: { dark: '#111111', light: '#ffffff' } }); if (!active()) return; this.status = 'Требуется повторная авторизация'; }
          if (update.connection === 'open') {
            this.qr = ''; this.status = 'WhatsApp подключён'; this.retries = 0;
            this.syncNote = 'Синхронизация чатов…'; this.changed();
            void this.refresh().catch(() => { this.syncNote = 'Не удалось обновить группы. Попробуйте «Обновить списки».'; this.changed(); });
          }
          if (update.connection === 'close') {
            this.qr = ''; this.socket = undefined;
            const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
            if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
              await this.writes.catch(() => {});
              rmSync(join(this.directory, 'auth.enc'), { force: true });
              this.auth = undefined; this.writes = Promise.resolve();
              this.store.change(d => { d.recipients = []; }); this.names.clear();
              this.status = 'Требуется повторная авторизация';
              this.syncNote = 'Сессия WhatsApp завершена. Отсканируйте QR-код снова.';
              this.scheduleReconnect(1000);
            } else {
              this.status = 'Нет подключения';
              this.scheduleReconnect(Math.min(60000, 2000 * 2 ** Math.min(this.retries++, 5)));
            }
          }
          this.changed();
        })().catch(() => this.fatalAuth());
      });
      const contacts = (list: Array<{ id: string; name?: string; notify?: string; verifiedName?: string }>) => {
        if (!active()) return;
        for (const c of list) if (c.name || c.notify || c.verifiedName) this.names.set(c.id, c.name || c.notify || c.verifiedName!);
        this.store.change(d => { for (const r of d.recipients) r.name = this.names.get(r.jid) || r.name; }); this.changed();
      };
      const chats = (list: Array<{ id: string; name?: string }>) => {
        if (!active()) return;
        this.store.change(d => {
          for (const c of list) {
            const kind = c.id.endsWith('@g.us') ? 'group' : 'personal';
            const r: Recipient = { jid: c.id, kind, name: this.names.get(c.id) || c.name || (kind === 'group' ? c.id.split('@')[0] : c.id.endsWith('@lid') ? `Чат ${c.id.split('@')[0]}` : `+${c.id.split('@')[0]}`) };
            if (!validRecipient(r)) continue;
            const prev = d.recipients.find(x => x.jid === r.jid);
            if (prev) { if (c.name || this.names.has(c.id)) prev.name = r.name; } else d.recipients.push(r);
          }
        }); this.changed();
      };
      socket.ev.on('messaging-history.set', history => { contacts(history.contacts); chats(history.chats); this.syncNote = `Синхронизировано чатов: ${this.store.data.recipients.length}.`; this.changed(); });
      socket.ev.on('contacts.upsert', contacts);
      socket.ev.on('contacts.update', updates => contacts(updates.filter(c => c.id) as any));
      socket.ev.on('chats.upsert', chats);
      socket.ev.on('chats.update', updates => chats(updates.filter(c => c.id) as any));
      socket.ev.on('chats.delete', ids => { if (active()) { this.store.change(d => { d.recipients = d.recipients.filter(r => !ids.includes(r.jid)); }); this.changed(); } });
    } catch {
      this.status = 'Нет подключения'; this.error = 'Не удалось подключиться или открыть защищённую сессию. Проверьте интернет и перезапустите приложение. Данные сессии не удалены.';
      this.changed(); this.scheduleReconnect(30000);
    }
  }
  fatalAuth(): void {
    this.stopping = true; ++this.generation; this.socket?.end(new Error('Auth persistence failed'));
    this.status = 'Нет подключения'; this.error = 'Не удалось сохранить защищённую сессию. Отправка остановлена. Проверьте свободное место и перезапустите приложение.'; this.changed();
  }
  scheduleReconnect(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.connect(); }, ms);
  }
  async refresh(): Promise<void> {
    if (!this.connected || !this.socket) throw new Error('Нет соединения с WhatsApp.');
    const groups = await this.socket.groupFetchAllParticipating();
    this.store.change(d => {
      d.recipients = d.recipients.filter(r => r.kind !== 'group');
      for (const g of Object.values(groups)) d.recipients.push({ jid: g.id, name: g.subject, kind: 'group' });
    });
    this.syncNote = 'Списки обновлены. Личные чаты дополняются при синхронизации и новых сообщениях.'; this.changed();
  }
  async send(r: Recipient, text: string, messageId: string): Promise<void> {
    if (!this.connected || !this.socket) throw new Error('Нет соединения с WhatsApp.');
    await this.socket.sendMessage(r.jid, { text }, { messageId });
  }
  async stop(): Promise<void> {
    this.stopping = true; ++this.generation; clearTimeout(this.timer); this.socket?.end(undefined);
    await this.writes;
  }
}
