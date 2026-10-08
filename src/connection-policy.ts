export type DisconnectAction = 'retry' | 'restart' | 'logout' | 'manual' | 'qr-expired';

// Baileys also uses 500 as the fallback for an unrecognised stream error.
// It does not prove that the encrypted local credentials are invalid.
export function disconnectAction(code: number | null, message: string): DisconnectAction {
  if (code === 401) return 'logout';
  if (code === 515) return 'restart';
  if (code === 408 && message === 'QR refs attempts ended') return 'qr-expired';
  if (code === 440 || code === 403 || code === 411) return 'manual';
  return 'retry';
}

export class PersistenceError extends Error {
  operation: 'local data' | 'protected session';
  constructor(operation: 'local data' | 'protected session', cause: unknown) {
    super(`Unable to save ${operation}`, { cause });
    this.operation = operation;
    this.name = 'PersistenceError';
  }
}

export function failureMessage(error: unknown): string {
  return error instanceof PersistenceError
    ? `Unable to save ${error.operation}. Sending has stopped. Check available disk space and access permissions, then restart the app.`
    : 'An unexpected application error occurred. Sending has stopped. Restart the app. Diagnostic details were written to debug.log.';
}
