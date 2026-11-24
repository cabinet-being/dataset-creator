# Дані, файли та збереження

Основні типи визначені в [`entities.ts`](../src/types/entities.ts). Серіалізатори — у [`projectDirectoryService.ts`](../src/services/project/projectDirectoryService.ts). Не використовуйте приклади документації як заміну цим контрактам.

## Сутності

| Тип | Зміст |
| --- | --- |
| `ProjectState` | ID, назва, тип проєкту, словники ресурсів, Dataset та налаштування |
| `SourceImage` | Початковий blob, ім’я, розміри, шляхи, tags та необов’язкові ознаки |
| `EditedAsset` | Результат редагування, PNG/blob і необов’язковий PSD, зв’язок із джерелом |
| `Dataset` | Налаштування спільного набору та порядок; не авторитетний список фізичних членів |
| `WorkspaceImage` | Проєкція source/edited/file-ресурсів для інструментів, включно з PSD і відео |
| `BuildSession` | Versioned профіль, стабільний порядок кандидатів, cursor і review records; зберігається разом із проєктом |

Тип проєкту — `general` (типовий), `character`, `style` або `concept`; `ProjectState.targetModel` — `sd15`, `sdxl` або `flux`, єдине джерело мінімальної коротшої сторони (512 для SD 1.5, 1024 для SDXL/Flux). Обидва зберігаються в `project` частині `.datasetcreator/project.json` (`projectType`, `targetModel`). Профілі в `projectProfiles.ts` задають тексти, початкові налаштування, осі покриття та політику тегів; зараз усі типи дозволяють повний набір інструментів. Міграція під час читання (папка й файл проєкту): відсутній `projectType` стає `general` без запиту й без переписування файлу проєкту, невідомий тип відхиляється; відсутній `targetModel` береться зі застарілого `buildSession.profile.minShortSide` (512 → `sd15`, інакше `sdxl`), невідоме значення рахується відсутнім. Нове значення потрапляє на диск зі звичайним збереженням.

`ProjectState.characterTraits` — список рис персонажа `{ tag, mode: 'include' | 'omit' }` (теги у форматі тегера, `blue_eyes`). Поле пишеться в `project` частину `.datasetcreator/project.json` лише коли список непорожній; відсутнє поле читається як `[]`. Риси діють лише для типу `character`, для інших типів зберігаються без впливу.

Build session зберігає й пропозиції автотріажу: `BuildReviewRecord.triage` (група accepted / rejected / needs-decision, причини, етап `quality` або `assembly`, ревізія вмісту, `duplicateOf`, `similarity`, числові виміри `ImageQualitySummary`, у яких `dark` відсутнє в зведеннях, збережених раніше), `autoPipeline` (відсутнє означає ввімкнено; UI більше не змінює й не читає це поле, його збережено для сумісності), `BuildSession.auto` (ключ і стан останнього автодобору та `auto.shortlist`), а `filter` розширено значеннями `needs-decision`, `accepted`, `rejected`, `shortlisted` (у UI — Candidates) і `picked` (Picks). `auto.shortlist` (`BuildShortlist`) — результат першого проходу Auto-select: `createdAt`, `mode` (`auto` або `target`), `poolCount`, `needed`, `size`, `duplicatesRejected`, `entries` (id ресурсу Build, `revision` вмісту, `cluster`, `gain`, `rank`) і необов’язковий результат другого проходу `narrowed` (`target`, впорядковані `ids`). Це лише позначки: членство Dataset лишається фізичним, а запис із зміненою `revision` відкидається. Поле необов’язкове, тож старі сесії читаються без міграції. `profile.sizeMode` (`auto` | `target`): нові сесії створюються з `auto`; сесія без поля читається як `target` з тим самим `target` (без переписування файлу). У `auto` `target` не обмежує добір; зміна режиму очищує `auto.shortlist`. Це лише пропозиції: поки `decision` не `unreviewed`, ефективну групу визначає ручне рішення. Усі поля необов’язкові, тому старі сесії читаються без міграції. Build session більше не зберігає `minShortSide` (його визначає `targetModel` проєкту); старе значення лише використовується під час міграції моделі й не записується знову.

`BuildSession` не дублює членство Dataset. Кожен review record має незалежні осі рішення користувача, застосування файлової зміни та перевірки ревізії. `acceptedRevision` стосується конкретного вмісту й підпису; готовим ресурс стає лише після успішного застосування, актуальної перевірки та фізичної присутності output у `dataset/`. Для source/edited використовуються сталі entity ID, для file-only ресурсів — ID із реєстру `assets.json`; шлях лишається змінним locator і оновлюється на rename/move.

## Папка проєкту (формат v3)

```text
project-folder/
  inbox/              # сирі матеріали (імпорт, кандидати)
    edits/            # похідні файли: результати редагування й кадрування
  dataset/            # лише пари image + <stem>.txt; підпапки [N_]name/ дозволені
  exports/            # ZIP експорту; видно в Explorer, не індексується
  .datasetcreator/
    project.json      # формат dataset-creator-project, версія 3
    assets.json       # реєстр ресурсів (dataset-creator-assets)
    cache/            # відновлювані прев’ю
    versions/         # index.json і snapshots/ (ZIP-знімки версій)
    journal/          # журнали міграцій і пакетних операцій
    backup/           # копії файлів, замінених міграцією або відновленням
```

Шляхи й назви визначає `PROJECT_LAYOUT` у [`projectLayoutService.ts`](../src/services/project/projectLayoutService.ts); `REQUIRED_PROJECT_DIRECTORIES` створюються при відкритті. Приклад показує ролі папок, а не повний список файлів.

- `.datasetcreator/project.json` — метадані проєкту, налаштування, Build session; формат `dataset-creator-project`. `detectProjectLayout` розрізняє `v3` (є `project.json`), `v2` (старий кореневий `manifest.json`) і `none`.
- `dataset/` — фізичний фінальний набір, готовий до kohya/OneTrainer напряму. Додавання переміщує сюди ресурс; вилучення переміщує в `inbox/`. Членство визначає лише фізичний шлях; підпапки (наприклад `10_name/`) зберігаються як є й повністю потрапляють в експорт.
- `inbox/` — сирі матеріали; імпорт кладе файли сюди. `inbox/edits/` — похідні файли інструментів.
- `exports/` — ZIP-архіви експорту (див. нижче). Ця тека виключена з індексації ресурсів.
- `.datasetcreator/assets.json` — реєстр `id → path/size/mtime/sha256` і метадані ресурсу (роль source/edited/file, розміри, оригінальне ім’я, параметри редагування). Окремих `*.manifest.json` більше немає. Власник — [`assetRegistryService.ts`](../src/services/project/assetRegistryService.ts).
- `.datasetcreator/cache/`, `versions/`, `journal/`, `backup/` — службові; `isInternalProjectEntry` ховає їх (і старі `.cache`, `.dataset-creator-data`, `.git`) від індексації та Explorer на будь-якій глибині. Знімки версій не включають `cache`, `journal`, `versions`, `backup`, а також `exports/` і справжній `.git`; відновлення їх не чіпає.
- `.git/` застосунок більше не використовує як службову теку. Справжній Git-репозиторій (тека з чужим вмістом, gitfile або нечитна `.git`) захищено: його не змінюють і не очищають; перед перебиранням теки без проєкту потрібне підтвердження. Старі файли версій у `.git` переносить міграція.

Explorer використовує логічний префікс `Project/`, наприклад `Project/dataset/portrait.png`; це не додаткова фізична папка. Нормалізацію й перенесення шляхів виконуйте через наявні helpers, не через довільні заміни рядків.

### Відкриття папки та реєстр

Під час відкриття `reconcileProjectAssets` ([`assetIndexService.ts`](../src/services/project/assetIndexService.ts)) звіряє реєстр із файлами:

- той самий шлях, розмір і mtime — запис без змін;
- той самий шлях, але інший розмір або mtime — той самий id, SHA-256 і прев’ю скидаються, `modifiedAt` оновлюється; рішення Build, прийняті для старого вмісту, стають stale (revision змінилась);
- файл зник, а новий файл має ті самі вид, розмір і SHA-256 — запис переприв’язується до нового шляху (зовнішнє перейменування чи переміщення), id зберігається, а збережені посилання (Build session, порядок Dataset, вкладки) отримують `pathMoves`;
- новий файл отримує новий id; запис без файлу видаляється; edited-запис без джерела лишається звичайним файлом.

SHA-256 заповнюється у фоні (`fillAssetHashes`, до 256 MB на файл); запис без хешу ніколи не переприв’язується. Реєстр записується лише після успішної звірки.

Тека без проєкту: перед створенням проєкту застосунок просить підтвердження й показує кількість файлів, а також запитує назву й тип.

## Підписи та членство

Підпис ресурсу — єдине джерело істини: файл `<stem>.txt` поруч із зображенням або PSD. Формат і розбір належать [`captionFileService.ts`](../src/services/caption/captionFileService.ts).

- Немає `.txt` — `tags` відсутні (`undefined`); порожній файл — `tags: []`. Це різні стани: порожній підпис не замінюється fallback-текстом.
- У `dataset/` TXT починається з trigger word: `trigger, tag1, tag2`. У пам’яті `tags` не містять trigger. Поза `dataset/` TXT зберігає лише теги.
- Читання ніколи не переписує файл. Якщо TXT у `dataset/` не починається з trigger, ресурс позначається `captionTriggerMissing`; виправлення — явна дія «Add trigger» у Caption.
- Переміщення через межу `dataset/` додає (всередину) або прибирає (назовні) trigger у TXT (`reconcileTriggerAfterMove`); TXT переміщується разом із зображенням.
- Зміна trigger word — пакетний перезапис усіх TXT у `dataset/` (`rewriteTriggerWord` у `captionMutationService.ts`, виклик через `changeDatasetTriggerWord`) через журнал, одним записом історії з Undo. Застосовується на Enter або при втраті фокусу (`TriggerWordInput`); значення без ком і переносів рядка.
- Для аналізу підпис нормалізується окремо; нормалізований текст не слід записувати назад замість авторського підпису.

Старі `assetIds`, `assetPaths`, `psdAssetPaths`, `captionOverrides`, `overwriteCaptions`, `*.dataset.json`, `dataset.json` та sidecar-теги зустрічаються лише у читачах і міграціях. Не повертайте їх у новий UI як паралельний механізм членства або підписів.

## Міграція старих проєктів

Проєкт v2 (кореневий `manifest.json`, `src/`, `.cache/`, `.git/` зі знімками) і v1 відкриваються через діалог **Upgrade project layout** (`ProjectUpgradeDialog`); без підтвердження нічого не читається й не записується. Власник — [`layoutMigrationService.ts`](../src/services/project/layoutMigrationService.ts) (`runLayoutMigration`):

1. знімок версії «Before project upgrade …» у `versions/` (якщо його не вдалося записати, проєкт не змінюється);
2. завершення старих міграцій; блокери (`getLayoutMigrationBlockers`) дають діалог «Project cannot be upgraded yet» з варіантами Cancel або **Open without upgrading** (проєкт читається через старий читач; оновлення запропонують знову);
3. журнальні кроки: запис `project.json`, виведення `manifest.json` з обігу (із копією в `backup/`), перенесення `.cache` → `.datasetcreator/cache`, версій і restore-backup з `.git` → `versions/` і `backup/`, прибирання порожньої `.git`;
4. сирі матеріали `src/` → `inbox/` (`runRawMaterialsMove`);
5. sidecar-теги → TXT з trigger у `dataset/` (`runCaptionTxtMigration`); замінені файли — у `backup/<journal>/captions`;
6. sidecar `*.manifest.json` → `assets.json` (`runAssetsRegistryMigration`); старі sidecar — у `backup/<journal>/sidecars`.

Незавершений журнал дописується при наступному відкритті (`resumePendingJournals`). Проєкт, уже в v3 зі старим розташуванням сирих файлів або sidecar, добудовується тими самими кроками (для переміщення в `inbox/` показується підтвердження, якщо є файли). Колізії імен під час переміщення розв’язуються перейменуванням із сповіщенням; збережені вкладки переписує `rewriteWorkspaceTabPaths` ([`workspacePersistence.ts`](../src/lib/workspacePersistence.ts)). Відновлення версії старого формату після відновлення знову запускає оновлення. Міграція записує на диск; це не read-only операція.

## Експорт Dataset

Експорт Dataset — побайтова копія `dataset/` з повною структурою підпапок: зображення зберігають розширення, TXT копіюється як є на диску (trigger уже в ньому, blacklist не застосовується), PSD перетворюється на PNG. Зображення без `.txt` експортується без нього, з попередженням у плані. План — `buildExportPlan` у [`exportPlan.ts`](../src/services/export/exportPlan.ts), єдиний власник; ZIP за замовчуванням зберігається як `exports/<назва-dataset>-<yyyyMMdd-HHmmss>.zip` без перезапису існуючих (`saveZipToProjectExports`), альтернатива — звичайне завантаження або запис у вибрану папку. Експорт інших джерел (workspace) рендерить підпис із тегів, trigger і blacklist.

## Три види стану

| Сховище | Що містить | Обмеження |
| --- | --- | --- |
| Папка проєкту | Файли, `project.json`, `assets.json`, версії | Потрібен доступ на читання/запис; помилки запису не означають успішного збереження |
| IndexedDB | Дані ресурсів, кеші, handles тегера; окремі БД відео та ознак зображень | Може бути очищена браузером; не замінює копію проєкту |
| localStorage | Workspace, вкладки, докування, UI-параметри | Не є резервною копією зображень |

Основна IndexedDB — `DatasetCreator`, схема 3; перелік stores міститься в `constants.ts`. Відеокеш — `dataset-creator-video-frames-v1` зі stores `frames`, `thumbnails`, `meta`; «Clear video cache» очищає всі три, крім запису `model` у `meta`. Постійний кеш ознак зображень DINOv2 — `dataset-creator-embeddings-v1` (store `image`, індекс `at`; ключ `<sha256>:<id моделі>`, значення — вектор і час запису): обмежений 20 000 записів, найстаріші за записом витісняються; очищення відеокешу його не чіпає, а помилки сховища трактуються як промах кешу. Перед ним діє LRU у пам’яті (5 000 векторів). Workspace snapshot має ключ `dataset-creator-workspace-v2`; старі ключі читаються для міграції. Dataset-вкладка «Add files» тепер має id `add-files`; збережені вкладки й докування зі старим id `select` (`dataset:<id>:select`) перейменовуються під час читання, а `select` залишається id інструмента Remove Duplicates.

Blob URL живе лише в поточній сесії. Він не є шляхом до файлу і має звільнятися після заміни або завершення використання. Для довготривалого збереження потрібні bytes і метадані, а не URL.

## Версії та архіви

Versions зберігає іменовані ZIP-знімки (`.datasetcreator/versions/snapshots/`, індекс `versions/index.json`) та зв’язок із батьківською версією; відкриваються через File → Versions. Знімок не включає службові `cache`, `journal`, `versions`, `backup`, `exports/` і `.git`; перед відновленням копії замінюваних файлів кладуться в `backup/restore`. Відновлення змінює файли поточної папки; UI має враховувати незбережені документи та помилки відновлення. Не плутайте це з Undo/Redo окремої дії.

Архівний формат `.dcproj` не підтримується: його сервіс видалено як мертвий код.
