import type { Recipient } from './model.ts';

const collection = 'critical_unblock_low' as const;
type SnapshotSocket = {
  processingMutex: { mutex<T>(work: () => Promise<T>): Promise<T> };
  authState: { keys: {
    set(data: { 'app-state-sync-version': { critical_unblock_low: null } }): void | Promise<void>;
    get(type: 'app-state-sync-version', ids: string[]): Record<string, { version: number } | undefined> | Promise<Record<string, { version: number } | undefined>>;
  } };
  resyncAppState(collections: readonly (typeof collection)[], initial: boolean): Promise<void>;
};

// isInitialSync=true does not force a snapshot: Baileys still requests deltas
// from its saved version. Reset only the contact collection's sync cursor,
// under the same mutex as incoming app-state updates. Preserve Signal keys.
export async function forceContactSnapshot(socket: SnapshotSocket, active: () => boolean): Promise<boolean> {
  return socket.processingMutex.mutex(async () => {
    if (!active()) return false;
    await socket.authState.keys.set({ 'app-state-sync-version': { [collection]: null } });
    if (!active()) return false;
    await socket.resyncAppState([collection], false);
    if (!active()) return false;
    const state = await socket.authState.keys.get('app-state-sync-version', [collection]);
    // Baileys may swallow decode errors; do not call an absent cursor success.
    return !!state[collection] && typeof state[collection].version === 'number';
  });
}

export function recipientCounts(recipients: Recipient[]) {
  const personal = recipients.filter(r => r.kind === 'personal');
  const unresolved = personal.filter(r => r.name.startsWith('Unnamed chat ·')).length;
  const phoneOnly = personal.filter(r => /^\+\d+$/.test(r.name)).length;
  return { personal: personal.length, groups: recipients.filter(r => r.kind === 'group').length, named: personal.length - unresolved - phoneOnly, phoneOnly, unresolved };
}
export function refreshSummary(before: Map<string, string>, recipients: Recipient[], groupsFetched: number, snapshot: boolean, lookupFailed: boolean): string {
  const count = recipientCounts(recipients);
  const changed = recipients.filter(r => before.get(r.jid) !== r.name).length;
  return `Groups fetched: ${groupsFetched}. Labels added or changed: ${changed}. Personal chats: ${count.personal} (${count.named} named, ${count.phoneOnly} phone numbers, ${count.unresolved} unresolved).` +
    (!snapshot ? ' The contact snapshot could not be confirmed; cached names were kept.' : ' Contact snapshot received.') +
    (lookupFailed ? ' Some phone-to-chat lookups failed; try again later.' : '') +
    (count.unresolved ? ' WhatsApp has not supplied a name or phone mapping for the remaining chats.' : '');
}
