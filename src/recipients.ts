import { type Recipient, type RecipientMetadata, validRecipient } from './model.ts';

type Contact = { id?: string; jid?: string; lid?: string; name?: string | null; notify?: string | null; verifiedName?: string | null };
type Chat = { id?: string; name?: string | null; lidJid?: string | null; pnJid?: string | null };
type Message = { key?: { remoteJid?: string | null; remoteJidAlt?: string | null; participant?: string | null; participantAlt?: string | null; fromMe?: boolean | null }; pushName?: string | null; message?: unknown; messageStubType?: number | null };
const priority = ['contact', 'chat', 'business', 'profile', 'push', 'legacy'] as const;

export function chatJid(id: unknown): string | undefined {
  if (typeof id !== 'string') return;
  const personal = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid|c\.us)$/.exec(id);
  if (personal) return `${personal[1]}@${personal[2] === 'c.us' ? 's.whatsapp.net' : personal[2]}`;
  if (/^\d+(?:-\d+)?@g\.us$/.test(id)) return id;
}
function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const name = value.trim();
  if (!name || chatJid(name) || /^(?:Chat )?\+?\d+$/.test(name)) return;
  return name;
}

export class RecipientSync {
  metadata: RecipientMetadata;
  constructor(metadata: RecipientMetadata = {}) { this.metadata = structuredClone(metadata); }
  clear(): void { this.metadata = {}; }
  private remember(id: string, source: typeof priority[number], value: unknown): void {
    const name = clean(value);
    if (name) (this.metadata[id] ||= {})[source] = name;
  }
  private link(ids: string[]): void {
    // Only explicit aliases from WhatsApp are evidence of the same contact.
    const all = new Set(ids);
    for (const id of ids) for (const alias of this.metadata[id]?.aliases || []) all.add(alias);
    const aliases = [...all];
    for (const id of aliases) (this.metadata[id] ||= {}).aliases = aliases;
  }
  private display(jid: string, previous?: string): string {
    const ids = this.metadata[jid]?.aliases || [jid];
    for (const source of priority) for (const id of ids) {
      const name = clean(this.metadata[id]?.[source]);
      if (name) return name;
    }
    const legacy = clean(previous);
    if (legacy && !legacy.startsWith('Unnamed chat ·')) return legacy;
    const phone = [jid, ...ids].find(id => /^[1-9]\d*@s\.whatsapp\.net$/.test(id));
    if (phone) return `+${phone.split('@')[0]}`;
    return jid.endsWith('@g.us') ? jid.split('@')[0] : `Unnamed chat · …${jid.split('@')[0].slice(-4)}`;
  }
  private update(recipients: Recipient[]): void {
    for (const r of recipients) r.name = this.display(r.jid, r.name);
  }
  contacts(recipients: Recipient[], contacts: Contact[]): void {
    for (const c of contacts) {
      const ids = [c.id, c.jid, c.lid].map(chatJid).filter((id): id is string => !!id);
      this.link(ids);
      for (const id of ids) {
        this.remember(id, 'contact', c.name);
        this.remember(id, 'business', c.verifiedName);
        this.remember(id, 'profile', c.notify);
      }
    }
    // Phonebook entries alone do not create conversations.
    this.update(recipients);
  }
  chats(recipients: Recipient[], chats: Chat[]): void {
    for (const c of chats) {
      const ids = [c.id, c.lidJid, c.pnJid].map(chatJid).filter((id): id is string => !!id && !id.endsWith('@g.us'));
      this.link(ids);
      this.add(recipients, c.id, c.name);
    }
    this.update(recipients);
  }
  messages(recipients: Recipient[], messages: Message[]): void {
    for (const m of messages) {
      const jid = chatJid(m.key?.remoteJid);
      if (!jid || (!m.message && m.messageStubType == null)) continue;
      if (jid.endsWith('@g.us')) {
        const sender = chatJid(m.key?.participant), alt = chatJid(m.key?.participantAlt);
        if (sender && !sender.endsWith('@g.us') && !m.key?.fromMe) {
          if (alt && !alt.endsWith('@g.us')) this.link([sender, alt]);
          this.remember(sender, 'push', m.pushName);
        }
        continue;
      }
      if (m.message && typeof m.message === 'object' && 'protocolMessage' in m.message && Object.keys(m.message).every(k => k === 'protocolMessage' || k === 'messageContextInfo')) continue;
      const alt = chatJid(m.key?.remoteJidAlt);
      if (alt && !alt.endsWith('@g.us')) this.link([jid, alt]);
      if (!m.key?.fromMe) this.remember(jid, 'push', m.pushName);
      this.add(recipients, jid);
    }
    this.update(recipients);
  }
  add(recipients: Recipient[], id: unknown, name?: string | null): void {
    const jid = chatJid(id);
    if (!jid) return;
    this.remember(jid, 'chat', name);
    const kind = jid.endsWith('@g.us') ? 'group' : 'personal';
    const existing = recipients.find(r => r.jid === jid);
    const recipient: Recipient = { jid, kind, name: this.display(jid, existing?.name) };
    if (!validRecipient(recipient)) return;
    if (existing) existing.name = recipient.name; else recipients.push(recipient);
  }
  phoneCandidates(recipients: Recipient[]): string[] {
    return [...new Set([...Object.keys(this.metadata), ...recipients.map(r => r.jid)])].filter(jid => /^[1-9]\d{6,14}@s\.whatsapp\.net$/.test(jid));
  }
  note(recipients: Recipient[]): string {
    return `Personal chats: ${recipients.filter(r => r.kind === 'personal').length} · Groups: ${recipients.filter(r => r.kind === 'group').length}.`;
  }
}
