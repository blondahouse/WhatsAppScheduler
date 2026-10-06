# WhatsApp Scheduler v0.1.0

First local Windows desktop release: linked-device QR authentication, separate personal/group recipients, text test-send, one-time and weekday/time-range schedules, missed-send grace, persistent duplicate protection, system tray, autostart and send history.

Download **WhatsAppScheduler-Setup-x64.exe**. The installer is unsigned; SmartScreen may require **More info → Run anyway**. No Node.js/npm/Git is required.

Target: Windows 10/11 x64. CI validates the Windows runner build, NSIS installation, installed renderer and local persistence with mocked WhatsApp sending. Real WhatsApp authentication/sending and manual Windows 10/11 operation are not yet verified. Follow the first-run QR/test-send flow in README.

Ambiguous sends after a crash/disconnect are never automatically retried. Check the chat before manually repeating a message.
