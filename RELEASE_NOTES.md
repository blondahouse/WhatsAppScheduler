# WhatsApp Scheduler v0.1.6

- Enable jitter separately in any one-time or weekly schedule. Enter a whole number of minutes (1–1440); disabled by default.
- Each execution chooses a nonzero offset from −J to −1 or +1 to +J minutes. A cryptographically random persistent schedule seed and nominal slot key make the choice stable across restart.
- Jitter may cross midnight and the weekly From–To boundaries. The selected weekday belongs to the original nominal execution.
- One-time schedules require their complete jitter window to be in the future when saved.
- Catch-up never starts sending in the original nominal minute. Messages beyond the jitter window are skipped; the existing grace limit still applies inside the window.
- Distinct normal executions that land in the same minute are preserved. Older missed executions still coalesce into at most one catch-up message.
- Cards display jitter and history includes the chosen shifted time and offset. Send test remains immediate.
- Existing schedules keep jitter off. Persistent claims and execution IDs continue to use the nominal slot, preventing duplicates after restart.

55 unit/integration tests cover jitter bounds, validation, early/late sends, restart, catch-up, midnight, collisions, and immediate tests. Installed UI checks cover enabling, validation, editing and persistence. Real unauthenticated QR acquisition is also checked. Actual WhatsApp receipt time depends on network and server delivery; jitter controls when the app begins the send.
