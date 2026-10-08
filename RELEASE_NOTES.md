# WhatsApp Scheduler v0.1.7

- Preserve encrypted credentials and cached chat names after stream ack/500 and temporary network failures. Baileys uses 500 as a fallback for unknown stream errors; it is no longer treated as confirmed sign-out.
- Handle WhatsApp's 515 restart request separately, without stale sign-out messages or an unnecessary QR reset. Finish pending encrypted key writes before replacing the socket, and serialize connection attempts.
- Delete revoked credentials only on explicit logged-out code 401 (or successful user-requested logout).
- Distinguish expired QR (408) from network timeout (408). Stop repeating expired QR attempts; Reconnect requests a new QR. Stop automatic retries on connection replacement 440 and rejection 403/411 while preserving credentials.
- Diagnostics and debug.log record sanitized disconnect codes, categories, registration state and recovery actions. Diagnostics retain the latest 20 disconnects, without auth keys, phone numbers or protocol payloads.
- Distinguish persistence/encryption failures from other unexpected application failures, retaining the original storage error cause in debug.log. Sending stops on either fatal failure; unexpected exceptions are no longer falsely labelled as disk-space errors.
- Propagate persistence failures from sending and contact refresh rather than treating them as ordinary network failures. Preserve durable sending claims to prevent automatic duplicate retries after restart.

Validation: 60 unit/integration tests; real Baileys buffering regression; real WhatsApp lifecycle with mocked network/OS storage covering session retention, 515 restart, QR expiry, replacement, explicit logout, late events, and encryption failure. Windows CI also checks types, builds and installs the executable, verifies the renderer, and obtains a real unauthenticated QR. Account linking and prolonged connected-session stability still require testing on an affected Windows machine.
