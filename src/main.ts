import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, powerMonitor, Notification } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { Store } from './store.ts';
import { Scheduler } from './scheduler.ts';
import { WhatsApp } from './whatsapp.ts';
import { validate, validRecipient, type Schedule } from './model.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const smoke = process.env.WASCHEDULER_SMOKE === '1';
const verifyingQr = process.env.WASCHEDULER_VERIFY_QR === '1';
if ((smoke || verifyingQr) && process.env.WASCHEDULER_DATA) app.setPath('userData', process.env.WASCHEDULER_DATA);
let window: BrowserWindow, tray: Tray, store: Store, scheduler: Scheduler, wa: WhatsApp;
let exiting = false, timer: ReturnType<typeof setInterval>;
app.setAppUserModelId('house.blonda.whatsapp-scheduler');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const dataDir = app.getPath('userData');
    const debug = (e: unknown) => {
      const file = join(dataDir, 'debug.log');
      try {
        if (existsSync(file) && statSync(file).size > 1000000) renameSync(file, `${file}.previous`);
        appendFileSync(file, `${new Date().toISOString()} ${e instanceof Error ? e.stack : 'Internal error'}\n`);
      } catch { /* Do not reveal errors in UI. */ }
    };
    store = new Store(join(dataDir, 'state.json'));
    const state = () => ({ schedules: store.data.schedules, recipients: store.data.recipients, history: [...store.data.history].reverse(), settings: store.data.settings, connection: wa.status, qr: wa.qr, syncNote: wa.syncNote, connectionError: wa.error, version: app.getVersion() });
    const changed = () => { if (window && !window.isDestroyed()) window.webContents.send('state', state()); if (tray) updateTray(); };
    wa = new WhatsApp(store, dataDir, changed, debug);
    scheduler = new Scheduler(store, async (r, text, id) => {
      if (smoke) return;
      try { await wa.send(r, text, id); } catch (e) { debug(e); throw e; }
    }, () => smoke || wa.connected, changed);
    const fatal = (e: unknown) => {
      debug(e); clearInterval(timer); wa.fatalAuth();
      dialog.showErrorBox('WhatsApp Scheduler', 'Не удалось сохранить данные. Отправка остановлена. Проверьте свободное место и перезапустите приложение.');
    };
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    function updateTray() {
      tray.setToolTip(`WhatsApp Scheduler — ${wa.status}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'WhatsApp Scheduler', enabled: false }, { type: 'separator' },
        { label: wa.status, enabled: false }, { label: 'Открыть', click: () => window.show() },
        { label: 'Приостановить все расписания', enabled: !store.data.settings.paused, click: () => { store.change(d => { d.settings.paused = true; }); changed(); } },
        { label: 'Возобновить все расписания', enabled: store.data.settings.paused, click: () => { store.change(d => { d.settings.paused = false; }); changed(); void scheduler.tick(); } },
        { type: 'separator' }, { label: 'Выход', click: () => app.quit() }
      ]));
    }
    window = new BrowserWindow({ width: 1050, height: 820, minWidth: 760, minHeight: 600, title: 'WhatsApp Scheduler', backgroundColor: '#ffffff', show: false, icon: join(root, 'assets/icon.png'), webPreferences: { preload: join(root, 'dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    tray = new Tray(nativeImage.createFromPath(join(root, 'assets/icon.png')).resize({ width: 20, height: 20 }));
    tray.on('double-click', () => window.show()); updateTray();
    window.on('close', event => {
      if (exiting) return;
      event.preventDefault(); window.hide();
      if (!store.data.settings.trayHintSeen) {
        store.change(d => { d.settings.trayHintSeen = true; });
        new Notification({ title: 'WhatsApp Scheduler', body: 'WhatsApp Scheduler продолжает работать в области уведомлений.' }).show();
      }
    });
    ipcMain.handle('scheduler', async (event, action: string, payload: any) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Недопустимый запрос.' };
      try {
        if (action === 'state') return { ok: true, data: state() };
        if (action === 'save') {
          validate(payload);
          const r = store.data.recipients.find(r => r.jid === payload.recipient.jid && r.kind === payload.recipient.kind);
          if (!r) throw new Error('Выберите получателя из синхронизированного списка.');
          const old = payload.id ? store.data.schedules.find(s => s.id === payload.id) : undefined;
          if (payload.id && !old) throw new Error('Расписание больше не существует.');
          if (old && scheduler.inFlight.has(old.id)) throw new Error('Дождитесь завершения текущей отправки.');
          const now = Date.now();
          const s: Schedule = { id: old?.id || randomUUID(), recipient: r, text: payload.text, enabled: true, kind: payload.kind, once: payload.once, days: payload.days, from: payload.from, to: payload.to, interval: payload.interval, createdAt: old?.createdAt || now, updatedAt: now, notBefore: now, status: 'active', consumed: old?.consumed || {}, floorDate: old?.floorDate || '' };
          store.change(d => { d.schedules = [...d.schedules.filter(x => x.id !== s.id), s]; });
        } else if (action === 'delete' || action === 'toggle') {
          const s = store.data.schedules.find(s => s.id === payload);
          if (!s) throw new Error('Расписание больше не существует.');
          if (scheduler.inFlight.has(s.id)) throw new Error('Дождитесь завершения текущей отправки.');
          if (action === 'toggle' && s.status === 'completed') throw new Error('Выполненное расписание можно изменить через «Редактировать».');
          store.change(d => {
            if (action === 'delete') d.schedules = d.schedules.filter(x => x.id !== payload);
            else { const live = d.schedules.find(x => x.id === payload)!; live.enabled = !live.enabled; live.status = live.enabled ? 'active' : 'paused'; live.error = undefined; live.notBefore = Date.now(); }
          });
        } else if (action === 'test') {
          if (!validRecipient(payload?.recipient) || !store.data.recipients.some(r => r.jid === payload.recipient.jid && r.kind === payload.recipient.kind)) throw new Error('Выберите получателя.');
          if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 10000) throw new Error('Введите сообщение длиной до 10 000 символов.');
          await scheduler.test(payload.recipient, payload.text);
        } else if (action === 'connect') await wa.reconnect();
        else if (action === 'refresh') await wa.refresh();
        else if (action === 'settings') {
          if (![0, 5, 15, 30, 60].includes(payload?.grace) || typeof payload.autostart !== 'boolean' || typeof payload.paused !== 'boolean') throw new Error('Некорректные настройки.');
          if (!smoke) app.setLoginItemSettings({ openAtLogin: payload.autostart, path: process.execPath, args: ['--hidden'] });
          store.change(d => { Object.assign(d.settings, { grace: payload.grace, autostart: payload.autostart, paused: payload.paused }); });
        } else throw new Error('Недопустимый запрос.');
        changed(); return { ok: true, data: state() };
      } catch (e) {
        debug(e);
        const text = e instanceof Error ? e.message : '';
        // Only allow errors deliberately written for users, never dependency exceptions.
        const safe = /^(Выберите|Введите|Одноразовая|Это время|Время «|Интервал|Дождитесь|Расписание|Выполненное|Некорректные|Недопустимый|Нет соединения|Не удалось отправить|Отправка не подтверждена)/.test(text);
        return { ok: false, error: safe ? text : 'Не удалось выполнить действие. Проверьте соединение и повторите.' };
      }
    });
    await window.loadFile(join(root, 'ui/index.html'));
    if (!process.argv.includes('--hidden') || smoke) window.show();
    if (!smoke) {
      if (!verifyingQr) app.setLoginItemSettings({ openAtLogin: store.data.settings.autostart, path: process.execPath, args: ['--hidden'] });
      void wa.connect();
    } else {
      wa.status = 'WhatsApp подключён';
      store.change(d => { d.recipients = [{ jid: '380501234567@s.whatsapp.net', name: 'Тестовый чат', kind: 'personal' }, { jid: '120363000000000000@g.us', name: 'Тестовая группа', kind: 'group' }]; }); changed();
    }
    timer = setInterval(() => { void scheduler.tick().catch(fatal); }, 30000);
    powerMonitor.on('resume', () => { void scheduler.tick().catch(fatal); });
    void scheduler.tick().catch(fatal);
  }).catch(e => { dialog.showErrorBox('WhatsApp Scheduler', 'Не удалось открыть локальные данные. Данные сохранены. Обратитесь к инструкции восстановления в README.'); console.error(e); app.exit(1); });
}
app.on('before-quit', event => {
  if (exiting) return;
  event.preventDefault(); exiting = true; clearInterval(timer);
  // Durable claims ensure an in-flight send is never retried on next startup.
  void wa?.stop().catch(() => {}).finally(() => { tray?.destroy(); app.quit(); });
});
app.on('window-all-closed', () => { /* Keep scheduler alive in tray. */ });
