# yuNote

Самостоятельное offline-first приложение заметок и списков для Android. Без явной привязки оно работает без аккаунта, сети и Key Fob. После привязки принимает структурированные действия от Key Fob в фоне и напрямую синхронизирует локальный журнал с Cloud Platform.

Платформенная архитектура, сервер и n8n находятся в репозитории [IoT-Key-Fob-Project](https://github.com/mastershad/IoT-Key-Fob-Project).

## Состояние на 13 сентября 2026 года

Реализовано:

- React Native Android-приложение с портретной ориентацией, светлой и тёмной темами;
- рабочий UI заметок и списков;
- SQLite ЛБД через `@op-engineering/op-sqlite`;
- заметки, списки, элементы, классы, связи с классами и сохраняемый порядок;
- атомарные dataset revisions и immutable mutation journal;
- идемпотентные локальные операции по `operationId`;
- Android bound service для защищённых сообщений Key Fob;
- Headless JS выполнение при закрытом UI и заблокированном телефоне;
- P-256 installation key в Android Keystore;
- enrollment через одноразовый pairing token;
- подписанная прямая синхронизация ЛБД→ОБД по HTTPS;
- локальная работа без сети и повтор sync при следующем lifecycle/action trigger;
- удаление локальных полномочий и Keystore key при unlink без удаления заметок.

Не реализовано:

- управляемое полное восстановление ОБД→ЛБД;
- разрешение конфликтов нескольких writers;
- гарантированный периодический retry через Android WorkManager;
- iOS;
- физический брелок и ограничения опасных команд;
- production signing key для публичного APK.

Подробности клиентской реализации: [docs/TRANSPORT_AND_SYNC.md](docs/TRANSPORT_AND_SYNC.md).

## Структура

- `src/db/`: соединение и миграции SQLite;
- `src/data/`: транзакционные операции и mutation journal;
- `src/state/`: Zustand stores и локальные mutation triggers;
- `src/relay/`: получение действий и совместимость с legacy relay;
- `src/security/`: интерфейс Android installation key;
- `src/sync/`: enrollment, batching, signing и direct sync coordinator;
- `src/ui/`: заметки, списки и темы;
- `android/`: Activity, Headless service, Keystore и native modules;
- `test/`: unit/integration tests;
- `docs/superpowers/`: исторические спецификации и планы.

## Разработка

Требуется Node.js 22.11 или новее и настроенный Android SDK/JDK.

```powershell
npm install
npm test -- --runInBand
npm run typecheck
cd android
.\gradlew.bat assembleRelease
```

Установка:

```powershell
adb install -r --no-streaming android\app\build\outputs\apk\release\app-release.apk
```

Release-вариант текущего контрольного этапа подписан отладочным сертификатом, общим с Key Fob, чтобы Android signature permission разрешал IPC. Для публичного выпуска требуется отдельная production signing strategy.

## Основные гарантии

- Сеть не участвует в commit локальной операции.
- Данные, dataset revision, результат и journal events записываются атомарно.
- Revision не дробится между сетевыми пакетами.
- Локальный applied cursor сдвигается только после точного server acknowledgement.
- Private installation key не экспортируется из Android Keystore.
- Unlink удаляет полномочия, но сохраняет ЛБД и журнал.
