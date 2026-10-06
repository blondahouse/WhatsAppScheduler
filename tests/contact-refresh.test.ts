import test from 'node:test';
import assert from 'node:assert/strict';
import { forceContactSnapshot, recipientCounts, refreshSummary } from '../src/contact-refresh.ts';

function fixture(confirm = true) {
  let cursor: { version: number } | undefined = { version: 18 };
  const operations: unknown[] = [];
  let locked = false;
  const socket = {
    processingMutex: { mutex: async <T>(fn: () => Promise<T>): Promise<T> => { locked = true; try { return await fn(); } finally { locked = false; } } },
    authState: { keys: {
      set: async (data: unknown) => { assert.equal(locked, true); operations.push(data); cursor = undefined; },
      get: async () => cursor ? { critical_unblock_low: cursor } : {}
    } },
    resyncAppState: async (collections: readonly string[], initial: boolean) => {
      assert.equal(locked, true); assert.equal(cursor, undefined);
      operations.push({ collections, initial });
      if (confirm) cursor = { version: 19 };
    }
  };
  return { socket, operations };
}

test('forced refresh removes only contact sync cursor and requests snapshot under the processing mutex', async () => {
  const { socket, operations } = fixture();
  assert.equal(await forceContactSnapshot(socket, () => true), true);
  assert.deepEqual(operations, [
    { 'app-state-sync-version': { critical_unblock_low: null } },
    { collections: ['critical_unblock_low'], initial: false }
  ]);
});

test('silently failed snapshot is not reported as confirmed', async () => {
  assert.equal(await forceContactSnapshot(fixture(false).socket, () => true), false);
});

test('disconnected or replaced socket cannot start a contact reset', async () => {
  const { socket, operations } = fixture();
  assert.equal(await forceContactSnapshot(socket, () => false), false);
  assert.deepEqual(operations, []);
});

test('refresh reports actual label changes and separates names, phones and unknown IDs', () => {
  const recipients = [
    { jid: '1@lid', name: 'Marina', kind: 'personal' as const },
    { jid: '2@lid', name: '+380123456789', kind: 'personal' as const },
    { jid: '3@lid', name: 'Unnamed chat · …1234', kind: 'personal' as const },
    { jid: '4@g.us', name: 'Group', kind: 'group' as const }
  ];
  assert.deepEqual(recipientCounts(recipients), { personal: 3, groups: 1, named: 1, phoneOnly: 1, unresolved: 1 });
  const before = new Map(recipients.map(r => [r.jid, r.name]));
  const unchanged = refreshSummary(before, recipients, 1, true, false);
  assert.match(unchanged, /Labels added or changed: 0/);
  assert.match(unchanged, /1 named, 1 phone numbers, 1 unresolved/);
  recipients[2].name = 'New name';
  assert.match(refreshSummary(before, recipients, 1, false, true), /Labels added or changed: 1/);
  assert.match(refreshSummary(before, recipients, 1, false, true), /could not be confirmed/);
  assert.match(refreshSummary(before, recipients, 1, false, true), /lookups failed/);
});
