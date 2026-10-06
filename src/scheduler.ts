import { createHash, randomUUID } from 'node:crypto';
import { localDate, minutes, parseLocal, type Attempt, type Recipient, type Schedule } from './model.ts';
import { Store } from './store.ts';
export type Slot = { key: string; at: number; day: string; minute: number; nominalAt?: number; jitterOffset?: number };
function wallMinute(at: number): string {
  const d = new Date(at);
  return `${localDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function shifted(s: Schedule, slot: Slot): Slot {
  const jitter = s.jitterMinutes || 0;
  if (!jitter) return slot;
  if (!s.jitterSeed) throw new Error('Missing persistent jitter seed');
  // A random seed stored with the schedule gives each nominal execution an
  // unpredictable, restart-stable offset. Zero is never in the sample space.
  const sample = createHash('sha256').update(`${s.jitterSeed}:${slot.key}`).digest().readUInt32BE(0);
  for (let attempt = 0; attempt < 2 * jitter; attempt++) {
    const index = (sample + attempt) % (2 * jitter);
    const offset = index < jitter ? index - jitter : index - jitter + 1;
    const at = slot.at + offset * 60000;
    // During DST fall-back, a nonzero elapsed offset can equal the original
    // local wall minute. Exclude that case too.
    if (wallMinute(at) !== slot.key) return { ...slot, at, nominalAt: slot.at, jitterOffset: offset };
  }
  throw new Error('No valid jitter offset');
}
export function executions(s: Schedule, date: Date): Slot[] {
  const day = localDate(date);
  if (s.kind === 'once') {
    const d = parseLocal(s.once!);
    return localDate(d) === day ? [shifted(s, { key: s.once!, at: d.getTime(), day, minute: d.getHours() * 60 + d.getMinutes() })] : [];
  }
  if (!s.days!.includes(date.getDay())) return [];
  const out: Slot[] = [];
  for (let m = minutes(s.from); m <= minutes(s.to); m += minutes(s.interval)) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(m / 60), m % 60);
    // Skip nonexistent DST spring-forward wall times. Fall-back sends once per wall minute.
    if (d.getHours() * 60 + d.getMinutes() !== m) continue;
    out.push({ key: `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, at: d.getTime(), day, minute: m });
  }
  return out.map(slot => shifted(s, slot));
}
export function candidateSlots(s: Schedule, now: number): Slot[] {
  if (s.kind === 'once') return executions(s, parseLocal(s.once!));
  const out: Slot[] = [];
  // Jitter up to one day can bring tomorrow's nominal slots into today, or
  // yesterday's slots into today. Include a further day for grace recovery.
  for (let delta = -2; delta <= 1; delta++) {
    const date = new Date(now); date.setDate(date.getDate() + delta);
    out.push(...executions(s, date));
  }
  return out;
}
export function latestDue(s: Schedule, now: number): Slot | undefined {
  return candidateSlots(s, now).filter(x => x.at <= now && x.at >= s.notBefore).sort((a, b) => b.at - a.at)[0];
}
export function dueSlots(s: Schedule, now: number): Slot[] {
  const due = candidateSlots(s, now).filter(x => x.at <= now && x.at >= s.notBefore && !consumed(s, x));
  if (!s.jitterMinutes) return due.sort((a,b) => b.at - a.at).slice(0,1);
  const current = due.filter(x => now - x.at < 60000);
  // Preserve separate normal executions even when independent jitters collide.
  // After sleep/offline, coalesce older missed executions into only one.
  return current.length ? current.sort((a,b) => a.at - b.at) : due.sort((a,b) => b.at - a.at).slice(0,1);
}
export function executionId(s: Schedule, slot: Slot): string { return `${s.id}:${slot.key}`; }
export function consumed(s: Schedule, slot: Slot): boolean {
  return slot.day < s.floorDate || (s.consumed[slot.day] || []).includes(slot.minute);
}
export class Scheduler {
  store: Store;
  send: (recipient: Recipient, text: string, messageId: string) => Promise<void>;
  connected: () => boolean;
  changed: () => void;
  busy = false;
  inFlight = new Set<string>();
  constructor(store: Store, send: Scheduler['send'], connected: Scheduler['connected'], changed = () => {}) {
    this.store = store; this.send = send; this.connected = connected; this.changed = changed;
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.busy || this.store.data.settings.paused) return;
    this.busy = true;
    try {
      for (const snapshot of [...this.store.data.schedules]) {
        const s = this.store.data.schedules.find(x => x.id === snapshot.id);
        if (!s || !s.enabled || s.status === 'completed') continue;
        let selected: Slot[];
        try { selected = dueSlots(s, now); }
        catch {
          this.store.change(d => {
            const live = d.schedules.find(x => x.id === s.id)!;
            live.status = 'error'; live.enabled = false;
            live.error = 'The scheduled time does not exist in the current time zone. Change the date and time.';
          });
          this.changed(); continue;
        }
        for (const slot of selected) {
        if (consumed(this.store.data.schedules.find(x => x.id === s.id)!, slot)) continue;
        const grace = this.store.data.settings.grace;
        // "No missed" still accepts the normal 30-second loop within the intended minute.
        const outsideJitter = !!s.jitterMinutes && now >= slot.nominalAt! + s.jitterMinutes * 60000 + 60000;
        const expired = outsideJitter || now - slot.at >= (grace === 0 ? 60000 : grace * 60000 + 1);
        // Never catch up inside the original nominal minute. Network delivery
        // still depends on WhatsApp; this controls when the app starts sending.
        if (!expired && s.jitterMinutes && wallMinute(now) === slot.key) continue;
        if (!expired && !this.connected()) continue;
        const id = executionId(s, slot);
        const attempt: Attempt = { id, scheduleId: s.id, slot: slot.key, plannedAt: slot.at, jitterOffset: slot.jitterOffset, at: now, recipient: s.recipient, result: expired ? 'skipped' : 'sending' };
        this.store.change(d => {
          const live = d.schedules.find(x => x.id === s.id)!;
          // Consume every older due slot, so catch-up cannot emit a backlog later.
          for (const x of candidateSlots(live, now)) if (x.at <= now && !selected.some(other => other.key === x.key && other.key !== slot.key)) {
            const values = live.consumed[x.day] ||= [];
            if (!values.includes(x.minute)) values.push(x.minute);
          }
          const values = live.consumed[slot.day] ||= [];
          if (!values.includes(slot.minute)) values.push(slot.minute);
          const floor = new Date(now); floor.setDate(floor.getDate() - 32);
          const floorKey = localDate(floor);
          if (floorKey > live.floorDate) live.floorDate = floorKey;
          for (const day of Object.keys(live.consumed)) if (day < live.floorDate) delete live.consumed[day];
          if (expired && s.kind === 'once') { live.enabled = false; live.status = 'error'; live.error = 'The send time was missed.'; }
          if (expired) attempt.error = outsideJitter ? 'Skipped: the jitter window has ended.' : 'Skipped: the delay exceeds the selected limit.';
          d.history.push(attempt);
        });
        this.changed();
        if (!expired) await this.deliver(attempt, s.text);
        }
      }
    } finally { this.busy = false; }
  }
  async deliver(attempt: Attempt, text: string): Promise<void> {
    this.inFlight.add(attempt.scheduleId || attempt.id);
    try {
      // Stable wire ID aids correlation; correctness does not assume WhatsApp deduplication.
      const wireId = createHash('sha256').update(attempt.id).digest('hex').slice(0, 32).toUpperCase();
      await this.send(attempt.recipient, text, wireId);
      this.store.change(d => {
        const h = d.history.find(x => x.id === attempt.id)!; h.result = 'sent';
        const s = d.schedules.find(x => x.id === attempt.scheduleId);
        if (s) { s.error = undefined; s.status = s.kind === 'once' ? 'completed' : s.enabled ? 'active' : 'paused'; if (s.kind === 'once') s.enabled = false; }
      });
    } catch {
      const error = 'Sending is not confirmed. Check WhatsApp. Automatic retry is disabled to avoid a duplicate.';
      this.store.change(d => {
        const h = d.history.find(x => x.id === attempt.id)!; h.result = 'uncertain'; h.error = error;
        const s = d.schedules.find(x => x.id === attempt.scheduleId);
        if (s) { s.status = 'error'; s.error = error; }
      });
    } finally { this.inFlight.delete(attempt.scheduleId || attempt.id); this.changed(); }
  }
  async test(recipient: Recipient, text: string): Promise<void> {
    if (!this.connected()) throw new Error('Unable to send the message. No connection to WhatsApp.');
    const a: Attempt = { id: `test:${randomUUID()}`, at: Date.now(), recipient, result: 'sending' };
    this.store.change(d => { d.history.push(a); });
    await this.deliver(a, text);
    if (this.store.data.history.find(h => h.id === a.id)?.result !== 'sent') throw new Error('Sending is not confirmed. Check WhatsApp before retrying.');
  }
}
