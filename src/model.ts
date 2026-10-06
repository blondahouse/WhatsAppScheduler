export type Recipient = { jid: string; name: string; kind: 'personal' | 'group' };
export type Schedule = {
  id: string; recipient: Recipient; text: string; enabled: boolean;
  kind: 'once' | 'weekly'; once?: string; days?: number[]; from?: string; to?: string; interval?: string;
  createdAt: number; updatedAt: number; notBefore: number;
  status: 'active' | 'paused' | 'completed' | 'error'; error?: string;
  consumed: Record<string, number[]>; floorDate: string;
};
export type Attempt = {
  id: string; scheduleId?: string; slot?: string; at: number; recipient: Recipient;
  result: 'sending' | 'sent' | 'failed' | 'uncertain' | 'skipped'; error?: string;
};
export type Settings = { grace: number; autostart: boolean; paused: boolean; trayHintSeen: boolean };
export type Data = { version: 1; schedules: Schedule[]; recipients: Recipient[]; history: Attempt[]; settings: Settings };
export function defaults(): Data {
  return { version: 1, schedules: [], recipients: [], history: [], settings: { grace: 30, autostart: true, paused: false, trayHintSeen: false } };
}
export function validRecipient(r: unknown): r is Recipient {
  if (!r || typeof r !== 'object') return false;
  const v = r as Recipient;
  return typeof v.name === 'string' && v.name.length > 0 && typeof v.jid === 'string' &&
    (v.kind === 'group' ? /^\d+(?:-\d+)?@g\.us$/.test(v.jid) : v.kind === 'personal' && /^\d+@(s\.whatsapp\.net|lid)$/.test(v.jid));
}
export function minutes(s: unknown): number {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) throw new Error('Введите время в формате HH:MM.');
  const [h, m] = s.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error('Введите корректное время HH:MM.');
  return h * 60 + m;
}
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseLocal(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) throw new Error('Выберите корректную дату и время.');
  const [y, mo, da, h, mi] = s.split(/[-T:]/).map(Number);
  const d = new Date(y, mo - 1, da, h, mi);
  if (`${localDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` !== s) {
    throw new Error('Это время не существует в локальном часовом поясе. Выберите другое время.');
  }
  return d;
}
export function validate(s: Partial<Schedule>, now = Date.now()): void {
  if (!validRecipient(s.recipient)) throw new Error('Выберите получателя.');
  if (typeof s.text !== 'string' || !s.text.trim()) throw new Error('Введите сообщение.');
  if (s.text.length > 10000) throw new Error('Сообщение не должно превышать 10 000 символов.');
  if (s.kind === 'once') {
    if (!s.once || parseLocal(s.once).getTime() <= now) throw new Error('Одноразовая дата и время должны быть в будущем.');
  } else if (s.kind === 'weekly') {
    if (!Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Выберите хотя бы один день недели.');
    const start = minutes(s.from), end = minutes(s.to), interval = minutes(s.interval);
    if (end < start) throw new Error('Время «До» не может быть раньше времени «От». Диапазоны через полночь пока не поддерживаются.');
    if (interval < 1) throw new Error('Интервал должен быть не меньше одной минуты.');
  } else throw new Error('Выберите тип расписания.');
}
