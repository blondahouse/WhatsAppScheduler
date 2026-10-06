# WhatsApp Scheduler v0.1.1

Fix first-run QR connection: register as a standard web companion instead of requesting native Windows full-history synchronization. The native full-history handshake was closed by WhatsApp before issuing a QR.

Add visible QR-loading instructions, connection error diagnostics and a Retry connection button. Existing schedules and encrypted sessions are preserved.

Windows release verification now includes a live WhatsApp QR request in the installed executable, with a fresh DPAPI-encrypted profile. No account is linked and no message is sent in this check.

Download **WhatsAppScheduler-Setup-x64.exe**. Exit the previous version from the system tray before installing. Unsigned installer: **More info → Run anyway** if SmartScreen prompts.

Real account linking, chat sync and sends still require the user's first-run verification.
