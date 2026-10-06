export type EventBuffer = { isBuffering(): boolean; flush(): boolean };

// Baileys 6.7.24 can retain its initial buffer forever if the server never
// completes the offline batch. Allow normal startup/history sync to finish first.
export function recoverStalledEvents(events: EventBuffer, pendingReceived: boolean, elapsedMs: number): boolean {
  if (pendingReceived || elapsedMs < 45000 || !events.isBuffering()) return false;
  return events.flush();
}

export class SyncHealth {
  startedAt = new Date().toISOString();
  pendingReceived = false;
  historyEvents = 0; historyChats = 0; historyMessages = 0;
  contactEvents = 0; chatEvents = 0; messageEvents = 0; personalMessageAddresses = 0;
  bufferRecoveries = 0; protocolWarnings = 0; lastWarningCategory = '';
  lastHistoryType: number | null = null;
  historyProgress: number | null = null;
  lastDisconnectCode: number | null = null;
  snapshot(buffering: boolean, personalChats: number, groups: number) {
    return { ...this, buffering, personalChats, groups };
  }
  warning(message: unknown): string {
    const text = typeof message === 'string' ? message : '';
    // Keep diagnostics useful without copying raw protocol logs or message data.
    const category = /decrypt|cipher|key/i.test(text) ? 'decryption' : /hist|sync/i.test(text) ? 'history-sync' : /connect|socket|stream/i.test(text) ? 'connection' : 'other';
    this.protocolWarnings++; this.lastWarningCategory = category;
    return category;
  }
}
