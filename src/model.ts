export type Recipient = { jid: string; name: string; kind: 'personal' | 'group' };
export type Schedule = {
  id: string; recipient: Recipient; text: string; enabled: boolean;
  kind: 'once' | 'weekly'; once?: string; days?: number[]; from?: string; to?: string; interval?: string;
  jitterMinutes?: number; jitterSeed?: string;
  createdAt: number; updatedAt: number; notBefore: number;
  status: 'active' | 'paused' | 'completed' | 'error'; error?: string;
  consumed: Record<string, number[]>; floorDate: string;
};
export type Attempt = {
  id: string; scheduleId?: string; slot?: string; plannedAt?: number; jitterOffset?: number; at: number; recipient: Recipient;
  result: 'sending' | 'sent' | 'failed' | 'uncertain' | 'skipped'; error?: string;
};
export type Settings = { grace: number; autostart: boolean; paused: boolean; trayHintSeen: boolean };
export type RecipientMetadata = Record<string, { contact?: string; chat?: string; business?: string; profile?: string; push?: string; legacy?: string; aliases?: string[] }>;
export type Data = { recipientMetadata?: RecipientMetadata; version: 1; schedules: Schedule[]; recipients: Recipient[]; history: Attempt[]; settings: Settings };
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
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) throw new Error('Enter a time in HH:MM format.');
  const [h, m] = s.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error('Enter a valid time in HH:MM format.');
  return h * 60 + m;
}
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseLocal(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) throw new Error('Choose a valid date and time.');
  const [y, mo, da, h, mi] = s.split(/[-T:]/).map(Number);
  const d = new Date(y, mo - 1, da, h, mi);
  if (`${localDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` !== s) {
    throw new Error('This time does not exist in your local time zone. Choose another time.');
  }
  return d;
}
export function validate(s: Partial<Schedule>, now = Date.now()): void {
  if (s.jitterMinutes !== undefined && (!Number.isInteger(s.jitterMinutes) || s.jitterMinutes < 0 || s.jitterMinutes > 1440)) throw new Error('Enter jitter as a whole number of minutes from 1 to 1440, or turn it off.');
  if (!validRecipient(s.recipient)) throw new Error('Choose a recipient.');
  if (typeof s.text !== 'string' || !s.text.trim()) throw new Error('Enter a message.');
  if (s.text.length > 10000) throw new Error('The message must not exceed 10,000 characters.');
  if (s.kind === 'once') {
    if (!s.once || parseLocal(s.once).getTime() <= now) throw new Error('One-time date and time must be in the future.');
    if (s.jitterMinutes && parseLocal(s.once).getTime() - s.jitterMinutes * 60000 <= now) throw new Error('One-time date and time must leave the entire jitter window in the future.');
  } else if (s.kind === 'weekly') {
    if (!Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Choose at least one day of the week.');
    const start = minutes(s.from), end = minutes(s.to), interval = minutes(s.interval);
    if (end < start) throw new Error('The end time cannot be earlier than the start time. Overnight ranges are not supported.');
    if (interval < 1) throw new Error('The interval must be at least one minute.');
  } else throw new Error('Choose a schedule type.');
}
