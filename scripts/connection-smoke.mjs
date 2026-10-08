// Exercise the real WhatsApp lifecycle without a linked account or network I/O.
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let encryptionFailure = false;
globalThis.__connectionMocks = {
  encrypt: async text => { if (encryptionFailure) throw new Error('encryption failed'); return Buffer.from(text); },
  socket: () => ({ ev: Object.assign(new EventEmitter(), { isBuffering: () => false }), end() {}, groupFetchAllParticipating: async () => ({}) })
};
const mocks = {
  electron: `export const safeStorage = { isAsyncEncryptionAvailable: async()=>true, encryptStringAsync: text=>globalThis.__connectionMocks.encrypt(text), decryptStringAsync: async bytes=>({result:bytes.toString()}) };`,
  '@whiskeysockets/baileys': `export default function(){return globalThis.__connectionMocks.socket()}; export const BufferJSON={}, initAuthCreds=()=>({registered:true}), proto={}, Browsers={ubuntu:()=>[]};`,
  pino: `export default function(){return {}}`,
  qrcode: `export default {toDataURL:async()=> 'qr-image'}`
};
const hook = registerHooks({ resolve(specifier, context, next) {
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  return next(specifier, context);
} });
const { WhatsApp } = await import('../src/whatsapp.ts');
const { Store } = await import('../src/store.ts');
const directory = mkdtempSync(join(tmpdir(), 'wa-connection-'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const close = async (wa, code, message) => {
  wa.socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode: code } }) } });
  await tick();
};
let wa;
try {
  const store = new Store(join(directory, 'state.json'));
  store.change(d => { d.recipients = [{ jid: '123456789@s.whatsapp.net', name: 'Saved name', kind: 'personal' }]; });
  wa = new WhatsApp(store, directory, () => {});
  await Promise.all([wa.connect(), wa.connect()]);
  const original = readFileSync(join(directory, 'auth.enc'), 'utf8');
  const oldSocket = wa.socket;
  await close(wa, 500, 'Stream Errored (ack)');
  assert.equal(readFileSync(join(directory, 'auth.enc'), 'utf8'), original);
  assert.equal(store.data.recipients[0].name, 'Saved name');
  assert.ok(wa.timer); assert.equal(wa.diagnostics().disconnects.at(-1).action, 'retry');
  oldSocket.ev.emit('creds.update', { registered: false });
  assert.equal(wa.auth.creds.registered, true);
  await wa.reconnect();
  assert.equal(wa.auth.creds.registered, true);
  await close(wa, 515, 'Stream Errored (restart required)');
  assert.equal(wa.error, ''); assert.ok(wa.timer); assert.equal(store.data.recipients.length, 1);
  await wa.reconnect();
  await close(wa, 408, 'QR refs attempts ended');
  assert.equal(wa.timer, undefined); assert.equal(wa.qr, ''); assert.match(wa.syncNote, /QR code expired/);
  await wa.reconnect();
  await close(wa, 440, 'Connection replaced'); assert.equal(wa.timer, undefined);
  assert.ok(existsSync(join(directory, 'auth.enc')));
  await wa.reconnect();
  await close(wa, 401, 'Connection Failure');
  assert.equal(existsSync(join(directory, 'auth.enc')), false); assert.equal(wa.auth, undefined);
  assert.equal(store.data.recipients.length, 0);
  await wa.reconnect();
  assert.doesNotMatch(wa.syncNote, /session ended|revoked/);
  encryptionFailure = true;
  wa.socket.ev.emit('creds.update', {}); await tick();
  assert.equal(wa.stopping, true); assert.equal(wa.socket, undefined); assert.equal(wa.qr, '');
  assert.match(wa.error, /Unable to save the protected session|Unable to save protected session/);
  assert.equal(wa.diagnostics().reconnectScheduled, false);
  console.log('Connection lifecycle smoke passed: session preservation, restart, QR expiry, replacement, logout, late events and encryption failure.');
} finally {
  if (wa) await wa.stop().catch(() => {});
  hook.deregister(); delete globalThis.__connectionMocks;
  rmSync(directory, { recursive: true, force: true });
}
