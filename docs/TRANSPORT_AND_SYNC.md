# Локальная архитектура, транспорт и синхронизация yuNote

**Статус:** фактическая клиентская реализация на 13 сентября 2026 года.

Полное межрепозиторное описание протокола находится в `IoT-Key-Fob-Project/docs/yunote-keyfob-transport.md`. Этот документ описывает сторону yuNote.

## 1. Принцип local-first

Любое ручное или полученное от Key Fob изменение сначала проходит через одну локальную транзакцию. Успех локальной операции не зависит от сети и не откатывается из-за ошибки cloud upload.

```text
UI или structured-action
        │
        ▼
runLocalOperation()
        ├── изменить notes/lists/list_items/classes
        ├── сохранить applied_operations
        ├── добавить mutation_journal events
        └── увеличить dataset_state.revision
        │
        ├── вернуть локальный результат/UI
        └── запросить фоновый sync
```

## 2. Идентичность локального набора данных

`dataset_state` содержит `replica_id`, `generation` и `revision`.

- `replica_id` идентифицирует логический локальный набор данных.
- `generation` меняется при будущей полной замене набора.
- `revision` увеличивается один раз на логическую транзакцию.

`installation_identity` хранит только метаданные привязки и alias ключа. Приватный ключ хранится Android Keystore.

## 3. Идемпотентная операция

`runLocalOperation()` канонизирует request JSON и проверяет `applied_operations`.

- Новый `operationId` выполняется один раз.
- Повтор с тем же request возвращает сохранённый result/revision.
- Повтор с изменённым request вызывает `OperationPayloadMismatchError`.
- Ошибка в любой части транзакции откатывает данные, журнал и cursor вместе.

Каждая операция обязана создать хотя бы одно journal event. `upsert` содержит payload, `delete` payload не содержит.

## 4. Полный snapshot v1

Канонический snapshot включает:

- `schemaVersion: 1`;
- `classes`;
- `notes` с `classId` и `position`;
- `lists` с `classId` и `position`;
- `listItems` с `listId`, `checked` и `position`;
- ids, entity revisions и timestamps.

Массивы имеют стабильную сортировку по `position`, затем `id`. Snapshot hash используется при enrollment, чтобы существующая ЛБД не была ошибочно наложена на отличающуюся ОБД.

## 5. Получение локального сообщения

Android manifest объявляет `com.yunote.permission.LOCAL_TRANSPORT` уровня `signature` и экспортированный `YunoteTransportService`, защищённый этим разрешением.

Сервис принимает Binder/Messenger message и запускает `YunoteTransportTask` через React Native `HeadlessJsTaskService`. Вход содержит:

- `transferId`;
- `kind`;
- опциональный JSON object в `payloadJson`.

`processTransportMessage()` открывает мигрированную ЛБД независимо от UI, регистрирует action/sync handlers и обрабатывает сообщение. Поэтому MainActivity и экран заметок не требуются для исполнения.

## 6. Enrollment

Secure `linked` message должен содержать одновременно:

- `pairingToken`: 64 hex symbols;
- `pairingExpiresAt`: parseable timestamp;
- `cloudBaseUrl`: только HTTPS.

Частично заполненный handoff отклоняется. Pending installation:

1. получает UUID и alias `yunote-installation-<UUID>`;
2. привязывается к одному HTTPS endpoint;
3. создаёт/находит P-256 key pair;
4. вычисляет локальные `datasetRevision` и canonical `snapshotHash`;
5. отправляет public key и идентичность реплики на enrollment endpoint;
6. принимает только ответ, совпадающий с локальной identity;
7. атомарно сохраняет `enrolled`, binding и server baseline cursor.

Pending identity сохраняется при сетевой ошибке, чтобы pairing можно было повторить тем же ключом. Она не может незаметно сменить cloud endpoint.

## 7. Ключ Android Keystore

Алгоритм: EC `secp256r1`/P-256, подпись `SHA256withECDSA`.

Приватный ключ:

- создаётся Android Keystore;
- не экспортируется в JavaScript;
- доступен по проверяемому alias;
- не требует user authentication для каждой подписи, поскольку sync должен работать на заблокированном телефоне;
- удаляется при локальном `unlinked`.

Компромисс `setUserAuthenticationRequired(false)` осознанный: доступ контролируется sandbox приложения и Keystore, но подпись не требует биометрии/PIN. Server revocation остаётся обязательным средством немедленно лишить установку полномочий.

## 8. Direct journal uploader

Uploader выбирает строки `mutation_journal` после локального `applied_revision`, строго по `(dataset_revision, sequence)`.

Границы пакета:

- 100 revisions;
- 500 events;
- 96 KiB UTF-8 body;
- только целые revisions.

Перед POST вычисляется SHA-256 exact JSON body. Каноническая строка с method/path/hash/installation/keyVersion/timestamp/nonce подписывается Android key.

Клиент принимает только `status = applied|replayed` и `ackRevision == toRevision`. Cursor изменяется compare-and-set транзакцией. Неожиданное изменение cursor во время запроса считается ошибкой.

Подтверждённые journal rows пока сохраняются. Политика безопасной bounded pruning является отдельной задачей.

## 9. Планирование синхронизации

`createInstallationSync()` сериализует все flush requests. Один uploader работает для одного cloud endpoint; повторный trigger во время upload устанавливает `rerun`.

Триггеры:

- создание/изменение/удаление заметки;
- создание/изменение/удаление списка или элемента;
- app bootstrap;
- возврат AppState в `active`;
- успешное выполнение headless `structured-action`;
- enrollment.

Ошибка фонового upload не превращается в ошибку локальной операции. Следующий trigger перечитает immutable journal.

## 10. Legacy relay

До enrollment `flushIfEnrolled()` возвращает false, и yuNote использует `sync_outbox`/Key Fob relay. После enrollment мутации идут по direct journal path. Это обеспечивает поэтапное обновление установок.

Нельзя вручную включать оба writer-path для одной мутации. Legacy outbox очищается только по точным acknowledgement rules; direct cursor не должен использоваться для массовой очистки старой очереди без миграционного решения.

## 11. Unlink

Локальный `unlinked`:

1. удаляет строку `installation_identity`;
2. пытается удалить соответствующий Keystore alias;
3. сохраняет notes/lists/items/classes, dataset state, journal и applied operations.

Даже если удаление ключа завершилось ошибкой, удалённая metadata прекращает direct upload, а server-side revocation закрывает полномочия ключа.

## 12. Что нельзя считать гарантированным

- Cabinet `Connected` сам по себе не доказывает наличие активного installation binding.
- Восстановление сети само по себе пока не гарантирует немедленный запуск: нужен lifecycle/action trigger.
- Force stop и состояние до первого unlock после reboot не поддерживаются.
- Snapshot baseline не является multi-device merge.
- Cloud-to-local restore отсутствует.
- Entity payload не шифруется дополнительно поверх HTTPS; защита data at rest требует отдельной политики.

## 13. Проверки

Основные suites:

- `test/data/localOperation.test.ts`;
- `test/security/installationKeys.test.ts`;
- `test/sync/installationEnrollment.test.ts`;
- `test/sync/journalUploader.test.ts`;
- `test/sync/journalSyncCoordinator.test.ts`;
- `test/relay/processTransportMessage.test.ts`;
- `test/sync/outbox.test.ts`;
- Android instrumentation/unit tests для Keystore и transport modules.

Последняя полная проверка: 26 Jest suites, 137 tests и `tsc --noEmit`. Отдельно на Samsung SM-G970F подтверждены locked-screen enrollment, offline local write, background retry, signed upload и удаление тестовых данных.

## 14. Следующие клиентские задачи

1. Android WorkManager/JobScheduler для bounded retry без foreground trigger.
2. Экран состояния direct sync: enrolled, pending, last ack, безопасный error code.
3. Полный staged restore ОБД→ЛБД с новым generation.
4. Bounded journal retention после доказанного backup/restore.
5. Recovery UX при потере Keystore или snapshot conflict.
6. Production signing и upgrade tests.
7. Battery/doze/OEM test matrix.

