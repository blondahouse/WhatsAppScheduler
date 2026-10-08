import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disconnectAction, failureMessage, PersistenceError } from '../src/connection-policy.ts';
import { atomicWrite } from '../src/store.ts';

test('only explicit logged-out code revokes local credentials', () => {
  for (const code of [500, 408, 428, 503, null]) assert.equal(disconnectAction(code, 'Stream Errored (ack)'), 'retry');
  assert.equal(disconnectAction(401, 'Connection Failure'), 'logout');
  assert.equal(disconnectAction(515, 'Stream Errored (restart required)'), 'restart');
});
test('QR expiration and a network timeout with the same code need different actions', () => {
  assert.equal(disconnectAction(408, 'QR refs attempts ended'), 'qr-expired');
  assert.equal(disconnectAction(408, 'Connection was lost'), 'retry');
});
test('connection replacement and rejection stop automatic retries', () => {
  for (const code of [440, 403, 411]) assert.equal(disconnectAction(code, 'Connection Failure'), 'manual');
});
test('disk failures retain their cause and are distinguished from unexpected exceptions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-storage-'));
  try {
    const blocked = join(directory, 'file'); writeFileSync(blocked, 'not a directory');
    assert.throws(() => atomicWrite(join(blocked, 'state.json'), '{}'), error => {
      assert.ok(error instanceof PersistenceError); assert.ok(error.cause instanceof Error);
      assert.equal(error.operation, 'local data'); assert.match(failureMessage(error), /access permissions/); return true;
    });
    assert.doesNotMatch(failureMessage(new Error('protocol failed')), /disk space|Unable to save/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
