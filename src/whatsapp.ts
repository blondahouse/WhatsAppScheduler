import makeWASocket, { BufferJSON, DisconnectReason, initAuthCreds, proto, Browsers, type AuthenticationState, type WASocket } from '@whiskeysockets/baileys';
import { safeStorage } from 'electron';
import pino from 'pino';
import QRCode from 'qrcode';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, Store } from './store.ts';
import { type Recipient } from './model.ts';
import { RecipientSync, chatJid } from './recipients.ts';

export class WhatsApp {
  store: Store; directory: string; changed: () => void;
  socket?: WASocket; state?: AuthenticationState;
  status = 'Подключение…'; qr = ''; syncNote = ''; error = '';
  stopping = false; retries = 0; timer?: ReturnType<typeof setTimeout>;
  recipients = new RecipientSync(); generation = 0;
  report: (error: unknown) => void;
  auth: { creds: ReturnType<typeof initAuthCreds>; keys: Record<string, unknown> } | undefined;
  writes: Promise<void> = Promise.resolve();
  constructor(store: Store, directory: string, changed: () => void, report: (error: unknown) => void = () => {}) { this.store = store; this.directory = directory; this.changed = changed; this.report = report; }
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
      const socket = makeWASocket({ auth: this.state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), syncFullHistory: true, markOnlineOnConnect: false, connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000 });
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
            void this.refresh(false).catch(() => { this.syncNote = 'Не удалось обновить группы. Попробуйте «Обновить списки».'; this.changed(); });
          }
          if (update.connection === 'close') {
            ++this.generation; // Ignore late events from the disconnected socket.
            this.qr = ''; this.socket = undefined;
            const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
            this.report(update.lastDisconnect?.error || new Error('WhatsApp connection closed'));
            this.error = `Соединение с WhatsApp закрыто${code ? ` (код ${code})` : ''}. Приложение повторит подключение автоматически.`;
            if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
              await this.writes.catch(() => {});
              rmSync(join(this.directory, 'auth.enc'), { force: true });
              this.auth = undefined; this.writes = Promise.resolve();
              this.store.change(d => { d.recipients = []; }); this.recipients.names.clear();
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
      const updated = () => {
        this.syncNote = this.recipients.note(this.store.data.recipients);
        if (!this.store.data.recipients.some(r => r.kind === 'personal')) this.syncNote += ' Ожидаем историю с телефона. Откройте WhatsApp на телефоне; новые личные сообщения также добавляют чат в список.';
        this.changed();
      };
      const contacts = (list: Parameters<RecipientSync['contacts']>[1]) => {
        if (!active()) return;
        this.store.change(d => this.recipients.contacts(d.recipients, list)); updated();
      };
      const chats = (list: Parameters<RecipientSync['chats']>[1]) => {
        if (!active()) return;
        this.store.change(d => this.recipients.chats(d.recipients, list)); updated();
      };
      socket.ev.on('messaging-history.set', history => {
        if (!active()) return;
        this.store.change(d => {
          this.recipients.contacts(d.recipients, history.contacts);
          this.recipients.chats(d.recipients, history.chats);
          this.recipients.messages(d.recipients, history.messages);
        }); updated();
      });
      socket.ev.on('messages.upsert', event => {
        if (!active()) return;
        this.store.change(d => this.recipients.messages(d.recipients, event.messages)); updated();
      });
      socket.ev.on('contacts.upsert', contacts);
      socket.ev.on('contacts.update', contacts);
      socket.ev.on('chats.upsert', chats);
      socket.ev.on('chats.update', chats);
      socket.ev.on('chats.delete', ids => { if (active()) { this.store.change(d => { d.recipients = d.recipients.filter(r => !ids.map(chatJid).includes(r.jid)); }); this.changed(); } });
    } catch (error) {
      this.report(error);
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
  async reconnect(): Promise<void> {
    if (this.stopping) throw new Error('Не удалось подключиться. Перезапустите приложение, чтобы открыть защищённую сессию.');
    clearTimeout(this.timer); ++this.generation;
    this.socket?.end(undefined); this.socket = undefined; this.qr = '';
    await this.connect();
  }
  async refresh(resync = true): Promise<void> {
    if (!this.connected || !this.socket) throw new Error('Нет соединения с WhatsApp.');
    const groups = await this.socket.groupFetchAllParticipating();
    this.store.change(d => {
      d.recipients = d.recipients.filter(r => r.kind !== 'group');
      for (const g of Object.values(groups)) d.recipients.push({ jid: g.id, name: g.subject, kind: 'group' });
    });
    if (resync) {
      await this.socket.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true);
    }
    this.syncNote = this.recipients.note(this.store.data.recipients) + (this.store.data.recipients.some(r => r.kind === 'personal') ? ' Списки обновлены.' : ' Ожидаем историю с телефона. Откройте WhatsApp на телефоне; отправьте или получите сообщение в нужном личном чате.'); this.changed();
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
