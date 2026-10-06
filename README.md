# WhatsApp Scheduler

Локальное Windows-приложение для отправки текстовых сообщений в существующие WhatsApp-чаты и группы по расписанию.

## [⬇ Download for Windows](https://github.com/blondahouse/WhatsAppScheduler/releases/latest/download/WhatsAppScheduler-Setup-x64.exe)

[All releases](https://github.com/blondahouse/WhatsAppScheduler/releases) · [Сборка и проверки](https://github.com/blondahouse/WhatsAppScheduler/actions) · [Для разработчиков](DEVELOPMENT.md)

## Features

- Личные чаты и группы: отдельные списки получателей с поиском.
- QR-подключение обычного WhatsApp как связанного устройства.
- Одноразовая отправка на дату и время.
- Еженедельные расписания с выбором дней, диапазона времени и интервала HH:MM.
- Если **From = To** — одно сообщение в каждый выбранный день.
- **Send test** перед сохранением расписания.
- Работа в области уведомлений, автозапуск вместе с Windows.
- Автоматическое восстановление соединения, сохранение сессии.
- Допуск пропущенной отправки: 5 / 15 / 30 / 60 минут или без догоняющих отправок.
- После сна — максимум одно актуальное пропущенное сообщение на расписание.
- Локальное хранилище; сессия шифруется Windows DPAPI через Electron safeStorage.
- История последних 30 дней, до 5 000 записей.
- Белый интерфейс, серые элементы; цвет используется для состояния и ошибок.

## Installation

1. Нажмите **Download for Windows** выше и скачайте `WhatsAppScheduler-Setup-x64.exe`.
2. Запустите установщик.
3. Сборка не подписана цифровым сертификатом. Если SmartScreen показывает **Windows protected your PC / Unknown publisher**, выберите **More info → Run anyway**.
4. Выберите папку установки и завершите установку. Node.js, npm и Git не нужны.

Установка выполняется для текущего пользователя. Перед обновлением завершите приложение через **Exit** в области уведомлений. Локальные данные сохраняются при обновлении и удалении приложения. Версия 0.1.3 переводит интерфейс на английский и добавляет восстановление зависшей синхронизации личных чатов. Локальные данные и сессия сохраняются.

## First connection

1. Запустите **WhatsApp Scheduler**.
2. Откройте WhatsApp на телефоне.
3. Откройте **Связанные устройства → Привязать устройство**.
4. Отсканируйте QR-код в приложении.
5. Дождитесь статуса **WhatsApp connected** и синхронизации чатов.

Пароль WhatsApp не требуется. Сессия сохраняется на этом компьютере, пока WhatsApp её не отзовёт. При отзыве сессии приложение показывает новый QR-код. Доступность личных чатов зависит от объёма истории, который WhatsApp передаёт связанному устройству. Если нужного чата нет, откройте его на телефоне и отправьте или получите сообщение; дождитесь синхронизации. **Refresh lists** повторно запрашивает группы и состояние чатов. Приложение показывает отдельное количество личных чатов и групп. Если сессия была привязана в старой версии и история так и не поступила, сначала обновите приложение; для нового запроса начальной истории можно отозвать только устройство WhatsApp Scheduler в WhatsApp → Связанные устройства и отсканировать новый QR. Это не удаляет расписания. Повторная привязка не нужна, если чаты уже появились.

## Creating schedule

1. Нажмите **+ New schedule**.
2. Выберите **Personal chat / Group**.
3. Выберите получателя из списка. Поиск фильтрует список по имени и идентификатору.
4. Введите текст. Переносы строк, Unicode и emoji сохраняются.
5. Выберите тип расписания и время.
6. Нажмите **Send test** и проверьте сообщение в WhatsApp.
7. Нажмите **Save**.

**Одноразовое:** выберите будущую дату и время. После успешной отправки статус станет **Completed**; запись останется в списке.

**Повторяющееся:** отметьте дни недели, задайте **From**, **To** и **Every**. Например, Пн / Ср / Пт, 08:00–09:00, каждые 00:30 отправляет в 08:00, 08:30 и 09:00. Диапазон 08:00–09:00 с интервалом 00:40 отправляет в 08:00 и 08:40. Равные границы 08:00–08:00 дают одну отправку независимо от интервала. Минимальный интервал — 00:01; диапазоны через полночь не поддерживаются.

Расписание использует **локальное время Windows**. Смена часового пояса влияет на следующие выполнения. Во время перевода часов несуществующее время пропускается; повторяющаяся при переводе назад минута отправляется один раз.

При создании или изменении повторяющегося расписания прошедшие интервалы до момента сохранения не отправляются. Включение приостановленного расписания также начинает отсчёт с момента включения.

## Sleep, restart и ошибки

По умолчанию допустимая задержка — **30 минут**. В **Settings** её можно изменить. Если QR ещё не появился, приложение показывает состояние подключения; кнопка **Reconnect** начинает новую попытку без удаления вашей сессии. Проверка идёт примерно раз в 30 секунд и после пробуждения. Если пропущено несколько интервалов, отправляется только последний актуальный; пачка пропущенных сообщений не отправляется.

Закрытие окна оставляет приложение в области уведомлений. Чтобы завершить работу, выберите **Exit** в tray. Автозапуск включён по умолчанию; запуск вместе с Windows происходит без открытия окна.

**Защита от дублей:** перед сетевой отправкой приложение надёжно сохраняет отметку о выполнении. Если процесс завершится после начала отправки либо соединение оборвётся в неоднозначный момент, попытка не повторяется автоматически. История показывает **Result unconfirmed**. Проверьте соответствующий чат перед ручным повтором. Такая стратегия предотвращает повторную отправку со стороны scheduler, но может пропустить сообщение при сбое между сохранением отметки и фактической отправкой. Абсолютная exactly-once доставка внешней системой не гарантируется.

**Sent** означает, что вызов отправки WhatsApp успешно завершился. Это не подтверждение доставки на телефон получателя или прочтения.

## Important

- Компьютер должен быть включён; приложение должно работать или находиться в tray.
- Для отправки нужен интернет и действующая сессия WhatsApp.
- Это **неофициальная интеграция**, без связи с Meta/WhatsApp. WhatsApp может изменить протокол, потребовать повторную авторизацию или ограничить аккаунт.
- Приложение предназначено для согласованных личных и групповых напоминаний; массовая/spam-отправка не является его назначением.
- Только текст; изображения, документы, аудио, видео и голосовые сообщения не поддерживаются.
- Нет внешнего backend, регистрации или облачной базы. Подключение к серверам WhatsApp необходимо для работы.
- Данные расписаний и имена получателей находятся локально в обычном JSON; auth state хранится отдельно в зашифрованном виде. DPAPI защищает сессию между пользователями Windows, но не от приложений с доступом к той же учётной записи.

## Supported Windows

Целевая платформа: **Windows 10 x64 и Windows 11 x64**. Windows 7 не поддерживается.

Автоматическая проверка выпуска выполняется на **GitHub Actions `windows-latest` (Windows Server)**: тесты scheduler, сборка NSIS, тихая установка и запуск установленного приложения, UI CRUD, тестовая отправка через mock, DPAPI, скрытие окна в tray и сохранение данных после перезапуска. Это не заменяет ручную проверку на Windows 10/11: эти версии Windows пока не проверены вручную. Пользовательская проверка на отдельной Windows-машине подтвердила привязку аккаунта, группы, ручную отправку и работу расписания; загрузка личных чатов пока не подтверждена. Успех конкретной сборки указан в [Actions](https://github.com/blondahouse/WhatsAppScheduler/actions).

## Local data и восстановление

Данные находятся в `%APPDATA%\whatsapp-scheduler\` (`app.getPath('userData')`):

- `state.json` — расписания, настройки, кэш получателей, история, отметки выполнения.
- `auth.enc` — зашифрованная сессия и ключи WhatsApp.
- `debug.log` и `debug.log.previous` — технические ошибки, ограниченные по размеру.

При повреждении `state.json` приложение останавливается и **не сбрасывает** расписания автоматически. Закройте приложение, скопируйте папку данных, восстановите `state.json` из своей резервной копии либо переименуйте его, чтобы начать с чистого списка. Не восстанавливайте старую копию журнала выполнения, если сообщения после её создания уже отправлялись: это может вернуть старые отметки. Сессию не переносите между разными пользователями Windows. Чтобы привязать другой аккаунт, отзовите устройство на телефоне и отсканируйте новый QR.

## Первый реальный тест

После установки: **Scan QR → дождитесь sync → выберите получателя → введите текст → Send test**. В интерфейсе появится понятный результат. Получение и отображение настоящего QR-кода проверяется в установленном `.exe` на Windows runner, без сканирования или привязки аккаунта. Реальная привязка аккаунта, синхронизация его чатов и отправка сообщения требуют вашего первого теста.

Исходный код распространяется под MIT. Название WhatsApp принадлежит его правообладателям.

### Если личные чаты не появились

После подключения подождите 60–90 секунд: приложение проверяет, не застряли ли события WhatsApp во внутреннем буфере. Откройте WhatsApp на телефоне и отправьте или получите сообщение в существующем личном чате, затем нажмите **Refresh lists**. Если список всё ещё пуст, откройте **Settings → Copy diagnostics** и вставьте отчёт в чат поддержки. Отчёт не содержит сообщений, номеров телефонов, имён контактов или ключей сессии. Приложение ничего автоматически не загружает.

Восстановление буфера проверено на механизме событий Baileys; успешная загрузка конкретного аккаунта пока не подтверждена. Если телефон не передал начальную историю, повторная привязка устройства может потребоваться.


## Recipient names and signing out

Personal chat names use this priority: saved contact name → chat title → verified business name → profile name → incoming message name → known phone number. Blank names and raw WhatsApp addresses are ignored. Name sources and explicit phone/LID aliases are stored locally in `state.json` and survive restarts. WhatsApp may omit all names; an unmapped LID then appears as “Unnamed chat · …1234”. The phonebook does not create chats by itself. Sending continues to use the original chat JID.

In Settings, **Sign out of WhatsApp** revokes the linked device through WhatsApp before removing `auth.enc` and the recipient/name cache. Schedules and send history stay on disk; all schedules are paused. No automatic new QR is requested. Click **Connect WhatsApp** to sign in again, check the account, then resume schedules manually. If remote logout fails, credentials are retained and the app explains how to reconnect or unlink the device on the phone. Logout waits until no scheduled send is in progress.


## Refresh lists (v0.1.5)

Refresh fetches current groups, including participant phone/LID mappings, then requests a full contact snapshot. Baileys’ `resyncAppState(..., true)` alone fetches deltas from its saved cursor; the app now resets only `app-state-sync-version:critical_unblock_low` under `socket.processingMutex` and requests that collection again. Signal sessions and app-state encryption keys are preserved. A restored cursor confirms successful snapshot decoding; an absent cursor is reported as unconfirmed. Cached names remain available during failures.

When unresolved personal chats remain, refresh looks up already known real phone numbers through `onWhatsApp` (50 per batch, at most 1,000 candidates per refresh) to obtain explicit LID aliases. LID digits are never submitted as phone numbers. Group membership alone does not create a personal chat. Refresh does not send messages or request a new QR. Names may still be unavailable if WhatsApp does not provide them; there is no guaranteed arbitrary-user profile-name lookup in this Baileys version. The result shows actual changed labels and named/phone-only/unresolved counts, including partial failures.


## Per-schedule jitter (v0.1.6)

Enable **Jitter** in a schedule and enter a whole number of minutes from 1 to 1440. Each nominal execution shifts by −J…−1 or +1…+J minutes; zero is excluded. For 08:00 with J=5, the planned send minute is 07:55–07:59 or 08:01–08:05. Jitter can cross midnight or the From–To range; weekdays refer to the nominal day. One-time schedules must leave the whole jitter window in the future when saved. Test sends remain immediate.

A random 256-bit seed is persisted per schedule. SHA-256(seed, nominal slot) deterministically selects a nonzero integer offset, so restarting does not redraw it. Original nominal slot keys remain the identity and duplicate-protection key; only the due timestamp shifts. Candidate generation includes adjacent nominal days for midnight crossing. Times follow the computer’s current local timezone. DST fall-back offsets that reproduce the nominal wall minute are excluded. Existing schedules default to jitter disabled.

Normal simultaneous jitter executions are sent separately. After sleep/offline, older missed executions coalesce into at most one catch-up send. Recovery is limited by both the grace period and the final jitter minute. A catch-up send never starts in its nominal minute; after the jitter window it is skipped. History stores the shifted planned timestamp, offset and actual attempt time. Jitter controls the start of the send, not the eventual arrival time at the recipient, which depends on WhatsApp and the network.
