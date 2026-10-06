import { createHash, randomUUID } from 'node:crypto';
import { localDate, minutes, parseLocal, type Attempt, type Recipient, type Schedule } from './model.ts';
import { Store } from './store.ts';
export type Slot = { key: string; at: number; day: string; minute: number };
export function executions(s: Schedule, date: Date): Slot[] {
  const day = localDate(date);
  if (s.kind === 'once') {
    const d = parseLocal(s.once!);
    return localDate(d) === day ? [{ key: s.once!, at: d.getTime(), day, minute: d.getHours() * 60 + d.getMinutes() }] : [];
  }
  if (!s.days!.includes(date.getDay())) return [];
  const out: Slot[] = [];
  for (let m = minutes(s.from); m <= minutes(s.to); m += minutes(s.interval)) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(m / 60), m % 60);
    // Skip nonexistent DST spring-forward wall times. Fall-back sends once per wall minute.
    if (d.getHours() * 60 + d.getMinutes() !== m) continue;
    out.push({ key: `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, at: d.getTime(), day, minute: m });
  }
  return out;
}
export function latestDue(s: Schedule, now: number): Slot | undefined {
  if (s.kind === 'once') return executions(s, parseLocal(s.once!)).find(x => x.at <= now);
  const today = new Date(now), yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return [...executions(s, yesterday), ...executions(s, today)].filter(x => x.at <= now && x.at >= s.notBefore).sort((a, b) => b.at - a.at)[0];
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
        let slot: Slot | undefined;
        try { slot = latestDue(s, now); }
        catch {
          this.store.change(d => {
            const live = d.schedules.find(x => x.id === s.id)!;
            live.status = 'error'; live.enabled = false;
            live.error = 'Время расписания не существует в текущем часовом поясе. Измените дату и время.';
          });
          this.changed(); continue;
        }
        if (!slot || consumed(s, slot)) continue;
        const grace = this.store.data.settings.grace;
        // "No missed" still accepts the normal 30-second loop within the intended minute.
        const expired = now - slot.at >= (grace === 0 ? 60000 : grace * 60000 + 1);
        if (!expired && !this.connected()) continue;
        const id = executionId(s, slot);
        const attempt: Attempt = { id, scheduleId: s.id, slot: slot.key, at: now, recipient: s.recipient, result: expired ? 'skipped' : 'sending' };
        this.store.change(d => {
          const live = d.schedules.find(x => x.id === s.id)!;
          // Consume every older due slot, so catch-up cannot emit a backlog later.
          for (const day of [new Date(now - 86400000), new Date(now)]) {
            for (const x of executions(live, day)) if (x.at <= slot.at) {
              const values = live.consumed[x.day] ||= [];
              if (!values.includes(x.minute)) values.push(x.minute);
            }
          }
          const values = live.consumed[slot.day] ||= [];
          if (!values.includes(slot.minute)) values.push(slot.minute);
          const floor = new Date(now); floor.setDate(floor.getDate() - 32);
          const floorKey = localDate(floor);
          if (floorKey > live.floorDate) live.floorDate = floorKey;
          for (const day of Object.keys(live.consumed)) if (day < live.floorDate) delete live.consumed[day];
          if (expired && s.kind === 'once') { live.enabled = false; live.status = 'error'; live.error = 'Время отправки пропущено.'; }
          if (expired) attempt.error = 'Пропущено: задержка превышает выбранный предел.';
          d.history.push(attempt);
        });
        this.changed();
        if (!expired) await this.deliver(attempt, s.text);
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
      const error = 'Отправка не подтверждена. Проверьте WhatsApp. Автоматический повтор отключён, чтобы избежать дубля.';
      this.store.change(d => {
        const h = d.history.find(x => x.id === attempt.id)!; h.result = 'uncertain'; h.error = error;
        const s = d.schedules.find(x => x.id === attempt.scheduleId);
        if (s) { s.status = 'error'; s.error = error; }
      });
    } finally { this.inFlight.delete(attempt.scheduleId || attempt.id); this.changed(); }
  }
  async test(recipient: Recipient, text: string): Promise<void> {
    if (!this.connected()) throw new Error('Не удалось отправить сообщение. Нет соединения с WhatsApp.');
    const a: Attempt = { id: `test:${randomUUID()}`, at: Date.now(), recipient, result: 'sending' };
    this.store.change(d => { d.history.push(a); });
    await this.deliver(a, text);
    if (this.store.data.history.find(h => h.id === a.id)?.result !== 'sent') throw new Error('Отправка не подтверждена. Проверьте WhatsApp перед повтором.');
  }
}
