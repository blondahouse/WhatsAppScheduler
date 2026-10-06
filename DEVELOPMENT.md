# Development

## Stack and layout

Electron + TypeScript main process; isolated static HTML/CSS/JS renderer; Baileys stable 6.7.x; Pino (WhatsApp logger disabled); QRCode; esbuild; electron-builder / NSIS. Actual versions are pinned in package.json and package-lock.json by the first CI dependency bootstrap. Later builds use npm ci exclusively.

- `src/model.ts`: shared data types, recipient filtering, strict time/date validation.
- `src/store.ts`: synchronous atomic JSON transactions with file fsync, rename and POSIX directory fsync.
- `src/scheduler.ts`: wall-time slots, catch-up, durable claims, test-send history.
- `src/whatsapp.ts`: encrypted Signal auth adapter, socket lifecycle, sync, reconnect.
- `src/main.ts`: Electron lifecycle, tray, autostart, limited validated IPC.
- `src/preload.ts`: contextBridge exposing only call and subscribe.
- `ui/`: local-only renderer, no Node access, no remote content, no untrusted innerHTML.
- `scripts/build.mjs`: deterministic neutral clock icon generation and production bundling.
- `installer/custom.nsh`: NSIS installer customization source.
- `tests/`: account-free scheduler, restart, crash, DST and persistence tests.
- `scripts/smoke.mjs`: packaged/installed Electron UI verification using Playwright; not WhatsApp Web automation.
- `.github/workflows/release.yml`: Windows build, install smoke, release assets.

## Setup

Use Node.js 24 LTS, npm and Git for development only. On a clean clone:

```sh
npm ci
npm run typecheck
npm test
npm start
```

Production bundles:

```sh
npm run build
npm run dist:win
```

Windows packaging should run on Windows. No native database module is needed. Electron packages Node with the app. Runtime dependencies remain external to the esbuild bundle and are packaged by electron-builder in ASAR.

## Releases

Update `version` in package.json and package-lock.json plus RELEASE_NOTES.md, commit, push a `v*` tag. Workflow permissions: `contents: write`. CI builds with lockfile, typechecks, tests, packages NSIS, silently installs under RUNNER_TEMP, launches the installed app with a mock WhatsApp adapter, verifies the renderer and publishes `.exe` and SHA256 checksum. Release naming is constant: `WhatsAppScheduler-Setup-x64.exe`.

The initial push bootstraps exact current stable versions for dependencies marked `latest`, resolves/commits package-lock.json, then uses `npm ci` in the same job. The initial successful build creates `v0.1.0` at the lockfile commit and publishes the installer. Bootstrap is skipped when a lockfile is present. Regular main builds verify without replacing an existing release. Tags publish their matching version. `CSC_IDENTITY_AUTO_DISCOVERY=false`; no signing certificate is used. Build inputs are locked; NSIS timestamps mean byte-for-byte reproducibility is not guaranteed.

## Scheduling and idempotency

There are no long-lived execution timers. Every 30 seconds and on resume, schedules on disk produce the latest due slot per schedule. All calculations use JS local-time Date objects; the OS timezone is read afresh. Monday is 1, Sunday 0. Start/end are inclusive; interval slots never exceed end; equal boundaries generate one slot. Dates in the spring DST gap are rejected for one-time scheduling and skipped for weekly scheduling. A repeated fall-back wall minute is scheduled only once.

Execution ID = `schedule UUID:YYYY-MM-DDTHH:MM` (local wall time). The wire ID is a stable SHA256-derived 32-character string, but correctness does not depend on the server deduplicating it. Before I/O, an atomic persistent transaction consumes the slot (and older slots in that day's catch-up window) and writes a `sending` attempt. After success another transaction marks `sent`; one-time schedules become completed. Crash after claim or network failure gives `uncertain` and **no automatic retry**. This is at-most-once automatic submission, not distributed exactly-once delivery. A crash before submission can lose one message; a crash after successful submission cannot cause scheduler replay. A real child-process crash test exercises the send/commit gap.

Consumed wall minutes are retained independently from the visible history, by local date for 32 days. A monotonic floorDate prevents old executions from resurfacing after ledger pruning. Clock rollback beyond the floor skips old dates intentionally. Editing retains the consumed ledger; notBefore moves forward so edits do not send pre-edit recurring intervals. Simultaneous ticks are serialized. Editing/deleting during an in-flight send is rejected. OS single-instance locking prevents two app copies sharing the same store.

Offline slots remain pending while inside the chosen grace. Once outside grace they are consumed as skipped. Grace=0 means only the currently due minute (normal loop lateness) is accepted. For a backlog, only the latest due occurrence can be sent; no loop over missed sends. Global pause prevents execution; per-schedule re-enable moves notBefore to the enable time. Each schedule catches up independently, so several distinct schedules can each send one missed message.

Storage read/write failure is fail-closed. Corruption never triggers automatic reset. JSON transactions clone the current store, serialize to a same-directory temporary file, fsync it and replace the old file. POSIX also fsyncs the parent directory; Windows relies on file flush and same-volume rename. Normal process crash/restart is covered; hardware/controller faults and arbitrary manual edits/backups cannot provide distributed delivery guarantees.

## WhatsApp lifecycle

Auth credentials plus Signal key map serialize with Baileys BufferJSON. A custom auth adapter persists every creds/key mutation to `auth.enc`, encrypted via asynchronous Electron safeStorage (Windows DPAPI). Writes are serialized. If encryption/storage fails, networking stops; plaintext fallback is never used. No passwords are requested and auth never crosses IPC. The app retains encrypted state if decryption fails; it does not silently discard it.

Fresh credentials generate QR. Open connection clears QR and fetches all participating groups. Personal recipients originate from messaging-history.set/chats.upsert/chats.update, never just the phonebook. Contact events enrich names of known chats. Accept only numeric `@s.whatsapp.net`/`@lid` personal JIDs and numeric `@g.us` groups; exclude status, broadcast and newsletters. Display names are escaped by DOM textContent. The stable 6.7.x protocol may surface both PN/LID identifiers for one contact; cached metadata depends on what WhatsApp synchronizes.

Transient close reconnects exponentially (2–60 seconds); revoked/bad sessions delete encrypted auth and recipient cache before requesting a new QR. Old schedules remain bound to their stored JIDs: review them when switching accounts. Stale socket handlers are ignored by a generation guard. Retry writes keep Signal keys durable. Shutdown ends the socket and flushes queued auth writes.

## Security and diagnostics

Context isolation and sandbox enabled, nodeIntegration disabled, navigation/popups/permission requests denied. CSP forbids network in renderer. IPC checks the originating main frame and validates save/settings/recipient payloads. Test-send is an explicit action. Errors from dependencies are translated into user-friendly messages; stack traces go only to rotating local debug logs. The Baileys logger is disabled to avoid writing credentials/QR/message contents.

Schedules/cache/history are local unencrypted metadata; auth is encrypted. DPAPI is user-bound and does not defend against another process running as the same Windows user. Store paths use app.getPath('userData'). Do not restore an old execution ledger after messages have already been submitted.

## Verification limits

Unit tests need no dependencies or account beyond Node 24. Windows CI smoke uses mock WhatsApp sending and a temporary profile (`WASCHEDULER_SMOKE=1`, `WASCHEDULER_DATA=...`). The test mode never establishes a WhatsApp network connection; it exists for build verification. The installed UI, NSIS installation, DPAPI roundtrip, tray-close behavior and restart persistence are exercised. Test mode suppresses registration in Windows startup; normal autostart uses app.setLoginItemSettings and has not been manually verified through an actual reboot.

No real QR scan or WhatsApp message is verified without a user's account. Windows 10/11 desktop and actual account sync/send still require the README first-run test. Windows 7, media, overnight ranges, delivery/read receipts and automated retries of ambiguous sends are not supported. WhatsApp protocol changes may require dependency updates.
