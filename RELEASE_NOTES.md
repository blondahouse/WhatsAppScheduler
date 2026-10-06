# WhatsApp Scheduler v0.1.5

- Refresh lists now fetches current groups and forces a complete contact snapshot, instead of only requesting deltas from the existing cursor.
- Only the contact collection cursor is reset, under Baileys’ app-state processing mutex. Session, Signal keys, schedules and send history are retained.
- Group member metadata, history chat aliases and group sender profile names enrich existing personal chats without adding non-chat contacts to the dropdown.
- Refresh resolves phone-to-LID aliases using known phone numbers in bounded batches. Anonymous IDs are never treated as phone numbers; no messages are sent.
- Known full phone numbers appear when no human name is available. Unknown LIDs still show an unnamed label if WhatsApp supplies no mapping.
- The UI shows refresh progress, actual labels added/changed, and counts of named, phone-only and unresolved personal chats. Snapshot failures are disclosed instead of unconditional “Lists refreshed”.

Tests cover snapshot reset scope and mutex, unavailable snapshots, disconnected sockets, report counts, group/phone aliases, history aliases and group profile names. The installed Windows UI and unauthenticated real QR acquisition are verified in CI. Account-specific contact snapshots and phone lookup results require verification with the user’s linked WhatsApp account.
