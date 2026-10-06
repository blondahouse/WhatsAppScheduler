# WhatsApp Scheduler v0.1.3

- English interface, tray menu, status labels, validation and error messages. Existing messages and schedules are preserved.
- Recover the Baileys initial event buffer when an open connection never receives offline-batch completion. This targets the reported symptom: groups and sending work while personal-chat events remain queued.
- Settings → Copy diagnostics: event counters and connection/buffer health without contacts, messages, session keys or automatic uploads.
- Regression coverage: 32 core tests plus an actual Baileys event-buffer test; Windows NSIS build, installation, English UI/clipboard checks, restart/DPAPI/tray and live pre-login QR verification.

Exit the previous app from the tray before installing the update. The existing WhatsApp session and schedules are retained. The fix is tested with queued library events; personal-chat synchronization with the user's real account still needs verification.
