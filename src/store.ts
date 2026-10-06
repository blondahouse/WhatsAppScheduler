import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaults, type Data } from './model.ts';

// Never continue after a failed write. Claiming must be durable before network I/O.
export function atomicWrite(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  if (process.platform !== 'win32') {
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
export class Store {
  path: string;
  data: Data;
  constructor(path: string) {
    this.path = path;
    // Corrupt/unreadable storage is a fatal error, never silently reset schedules.
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : defaults();
    if (this.data.version !== 1 || !Array.isArray(this.data.schedules) || !Array.isArray(this.data.history)) throw new Error('Unsupported data store');
    this.change(d => {
      for (const h of d.history) if (h.result === 'sending') {
        h.result = 'uncertain'; h.error = 'The result is unconfirmed. Automatic retry is disabled to avoid a duplicate.';
        const s = d.schedules.find(s => s.id === h.scheduleId);
        if (s) { s.status = 'error'; s.error = h.error; }
      }
    });
  }
  change(fn: (draft: Data) => void): void {
    const next = structuredClone(this.data);
    fn(next);
    next.history = next.history.filter(h => h.at >= Date.now() - 30 * 86400000).slice(-5000);
    atomicWrite(this.path, JSON.stringify(next));
    this.data = next;
  }
}
