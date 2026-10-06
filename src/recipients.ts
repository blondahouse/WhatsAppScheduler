import { type Recipient, validRecipient } from './model.ts';

type Contact = { id?: string; jid?: string; lid?: string; name?: string | null; notify?: string | null; verifiedName?: string | null };
type Chat = { id?: string; name?: string | null };
type Message = { key?: { remoteJid?: string | null; fromMe?: boolean | null }; pushName?: string | null; message?: unknown; messageStubType?: number | null };

// Linked-device events may carry device-qualified addresses. Store a chat JID,
// never a device JID; do not admit newsletters, status or broadcast lists.
export function chatJid(id: unknown): string | undefined {
  if (typeof id !== 'string') return;
  const personal = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid|c\.us)$/.exec(id);
  if (personal) return `${personal[1]}@${personal[2] === 'c.us' ? 's.whatsapp.net' : personal[2]}`;
  if (/^\d+(?:-\d+)?@g\.us$/.test(id)) return id;
}

export class RecipientSync {
  names = new Map<string, string>();
  contacts(recipients: Recipient[], contacts: Contact[]): void {
    for (const c of contacts) {
      const name = c.name || c.notify || c.verifiedName;
      if (!name) continue;
      for (const id of [c.id, c.jid, c.lid]) {
        const jid = chatJid(id);
        if (jid) this.names.set(jid, name);
      }
    }
    // A phonebook entry alone is not evidence of an existing conversation.
    for (const r of recipients) r.name = this.names.get(r.jid) || r.name;
  }
  chats(recipients: Recipient[], chats: Chat[]): void {
    for (const c of chats) this.add(recipients, c.id, c.name);
  }
  messages(recipients: Recipient[], messages: Message[]): void {
    for (const m of messages) {
      const jid = chatJid(m.key?.remoteJid);
      // Protocol/history notifications and group participants are not personal chats.
      if (!jid || jid.endsWith('@g.us') || (!m.message && m.messageStubType == null)) continue;
      if (m.message && typeof m.message === 'object' && 'protocolMessage' in m.message && Object.keys(m.message).every(k => k === 'protocolMessage' || k === 'messageContextInfo')) continue;
      this.add(recipients, jid, !m.key?.fromMe ? m.pushName : undefined);
    }
  }
  add(recipients: Recipient[], id: unknown, name?: string | null): void {
    const jid = chatJid(id);
    if (!jid) return;
    const kind = jid.endsWith('@g.us') ? 'group' : 'personal';
    const existing = recipients.find(r => r.jid === jid);
    const display = this.names.get(jid) || name || existing?.name || (kind === 'group' ? jid.split('@')[0] : jid.endsWith('@lid') ? `Chat ${jid.split('@')[0]}` : `+${jid.split('@')[0]}`);
    const recipient: Recipient = { jid, kind, name: display };
    if (!validRecipient(recipient)) return;
    if (existing) existing.name = display; else recipients.push(recipient);
  }
  note(recipients: Recipient[]): string {
    return `Personal chats: ${recipients.filter(r => r.kind === 'personal').length} · Groups: ${recipients.filter(r => r.kind === 'group').length}.`;
  }
}
