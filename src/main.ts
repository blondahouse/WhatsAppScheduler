import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, powerMonitor, Notification, clipboard } from 'electron';
import { release as osRelease } from 'node:os';
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
      dialog.showErrorBox('WhatsApp Scheduler', 'Unable to save data. Sending has stopped. Check available disk space and restart the app.');
    };
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    function updateTray() {
      tray.setToolTip(`WhatsApp Scheduler — ${wa.status}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'WhatsApp Scheduler', enabled: false }, { type: 'separator' },
        { label: wa.status, enabled: false }, { label: 'Open', click: () => window.show() },
        { label: 'Pause all schedules', enabled: !store.data.settings.paused, click: () => { store.change(d => { d.settings.paused = true; }); changed(); } },
        { label: 'Resume all schedules', enabled: store.data.settings.paused, click: () => { store.change(d => { d.settings.paused = false; }); changed(); void scheduler.tick(); } },
        { type: 'separator' }, { label: 'Exit', click: () => app.quit() }
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
        new Notification({ title: 'WhatsApp Scheduler', body: 'WhatsApp Scheduler keeps running in the system tray.' }).show();
      }
    });
    ipcMain.handle('scheduler', async (event, action: string, payload: any) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Invalid request.' };
      try {
        if (action === 'state') return { ok: true, data: state() };
        if (action === 'diagnostics') {
          clipboard.writeText(JSON.stringify({ schema: 1, appVersion: app.getVersion(), platform: process.platform, osRelease: osRelease(), node: process.versions.node, electron: process.versions.electron, connection: wa.status, sync: wa.diagnostics() }, null, 2));
          return { ok: true, data: state() };
        }
        if (action === 'save') {
          validate(payload);
          const r = store.data.recipients.find(r => r.jid === payload.recipient.jid && r.kind === payload.recipient.kind);
          if (!r) throw new Error('Choose a recipient from the synced list.');
          const old = payload.id ? store.data.schedules.find(s => s.id === payload.id) : undefined;
          if (payload.id && !old) throw new Error('This schedule no longer exists.');
          if (old && scheduler.inFlight.has(old.id)) throw new Error('Wait for the current send to finish.');
          const now = Date.now();
          const s: Schedule = { id: old?.id || randomUUID(), recipient: r, text: payload.text, enabled: true, kind: payload.kind, once: payload.once, days: payload.days, from: payload.from, to: payload.to, interval: payload.interval, createdAt: old?.createdAt || now, updatedAt: now, notBefore: now, status: 'active', consumed: old?.consumed || {}, floorDate: old?.floorDate || '' };
          store.change(d => { d.schedules = [...d.schedules.filter(x => x.id !== s.id), s]; });
        } else if (action === 'delete' || action === 'toggle') {
          const s = store.data.schedules.find(s => s.id === payload);
          if (!s) throw new Error('This schedule no longer exists.');
          if (scheduler.inFlight.has(s.id)) throw new Error('Wait for the current send to finish.');
          if (action === 'toggle' && s.status === 'completed') throw new Error('Completed schedules can be changed using Edit.');
          store.change(d => {
            if (action === 'delete') d.schedules = d.schedules.filter(x => x.id !== payload);
            else { const live = d.schedules.find(x => x.id === payload)!; live.enabled = !live.enabled; live.status = live.enabled ? 'active' : 'paused'; live.error = undefined; live.notBefore = Date.now(); }
          });
        } else if (action === 'test') {
          if (!validRecipient(payload?.recipient) || !store.data.recipients.some(r => r.jid === payload.recipient.jid && r.kind === payload.recipient.kind)) throw new Error('Choose a recipient.');
          if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 10000) throw new Error('Enter a message of up to 10,000 characters.');
          await scheduler.test(payload.recipient, payload.text);
        } else if (action === 'connect') await wa.reconnect();
        else if (action === 'refresh') await wa.refresh();
        else if (action === 'settings') {
          if (![0, 5, 15, 30, 60].includes(payload?.grace) || typeof payload.autostart !== 'boolean' || typeof payload.paused !== 'boolean') throw new Error('Invalid settings.');
          if (!smoke) app.setLoginItemSettings({ openAtLogin: payload.autostart, path: process.execPath, args: ['--hidden'] });
          store.change(d => { Object.assign(d.settings, { grace: payload.grace, autostart: payload.autostart, paused: payload.paused }); });
        } else throw new Error('Invalid request.');
        changed(); return { ok: true, data: state() };
      } catch (e) {
        debug(e);
        const text = e instanceof Error ? e.message : '';
        // Only allow errors deliberately written for users, never dependency exceptions.
        const safe = /^(Choose|Enter|One-time|This time|The end time|The interval|The message|Wait for|This schedule|Completed schedules|Invalid settings\.|Invalid request\.|No connection to WhatsApp\.|Unable to send the message\.|Sending is not confirmed)/.test(text);
        return { ok: false, error: safe ? text : 'Unable to complete the action. Check your connection and try again.' };
      }
    });
    await window.loadFile(join(root, 'ui/index.html'));
    if (!process.argv.includes('--hidden') || smoke) window.show();
    if (!smoke) {
      if (!verifyingQr) app.setLoginItemSettings({ openAtLogin: store.data.settings.autostart, path: process.execPath, args: ['--hidden'] });
      void wa.connect();
    } else {
      wa.status = 'WhatsApp connected';
      store.change(d => { d.recipients = [{ jid: '380501234567@s.whatsapp.net', name: 'Test chat', kind: 'personal' }, { jid: '120363000000000000@g.us', name: 'Test group', kind: 'group' }]; }); changed();
    }
    timer = setInterval(() => { void scheduler.tick().catch(fatal); }, 30000);
    powerMonitor.on('resume', () => { void scheduler.tick().catch(fatal); });
    void scheduler.tick().catch(fatal);
  }).catch(e => { dialog.showErrorBox('WhatsApp Scheduler', 'Unable to open local data. Your data has been preserved. See the recovery instructions in the README.'); console.error(e); app.exit(1); });
}
app.on('before-quit', event => {
  if (exiting) return;
  event.preventDefault(); exiting = true; clearInterval(timer);
  // Durable claims ensure an in-flight send is never retried on next startup.
  void wa?.stop().catch(() => {}).finally(() => { tray?.destroy(); app.quit(); });
});
app.on('window-all-closed', () => { /* Keep scheduler alive in tray. */ });
