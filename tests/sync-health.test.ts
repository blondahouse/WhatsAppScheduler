import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStalledEvents, SyncHealth } from '../src/sync-health.ts';

test('startup buffer recovery waits for deadline and does not interrupt a completed offline handshake', () => {
  let calls = 0;
  const events = { isBuffering: () => true, flush: () => { calls++; return true; } };
  assert.equal(recoverStalledEvents(events, false, 44999), false);
  assert.equal(recoverStalledEvents(events, true, 60000), false);
  assert.equal(calls, 0);
  assert.equal(recoverStalledEvents(events, false, 45000), true);
  assert.equal(calls, 1);
});

test('healthy unbuffered session is left alone', () => {
  assert.equal(recoverStalledEvents({ isBuffering: () => false, flush: () => { throw new Error('must not flush'); } }, false, 100000), false);
});

test('diagnostics classify warnings without retaining private protocol text', () => {
  const health = new SyncHealth();
  health.warning('failed to decrypt secret 123456@s.whatsapp.net / token-secret');
  const report = JSON.stringify(health.snapshot(true, 0, 3));
  assert.equal(health.lastWarningCategory, 'decryption');
  assert.equal(health.protocolWarnings, 1);
  assert.ok(!report.includes('123456')); assert.ok(!report.includes('token-secret'));
});
