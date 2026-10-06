# WhatsApp Scheduler v0.1.4

- Personal chat names use saved contact name, chat title, verified business name, profile name, then incoming message name, in that order.
- Blank or technical names cannot overwrite readable names. Name sources and explicit phone/LID aliases persist across restarts.
- Unknown LID chats use a short “Unnamed chat” label instead of a misleading phone number. Actual phone numbers are used when WhatsApp supplies a mapping.
- Schedule cards show the current synced recipient name without changing their sending address.
- Settings → Sign out of WhatsApp unlinks this device, clears the local encrypted session and recipient cache, and pauses all schedules. Schedules and send history are retained.
- Sign out requires confirmation. Signing in again requires an explicit Connect WhatsApp action; resume schedules manually after checking the connected account.

The interface is in English. Windows build verification covers simulated logout, name priority, persistence, installed UI and real unauthenticated QR acquisition. Real account logout and account-specific name sync require verification with the user's phone.
