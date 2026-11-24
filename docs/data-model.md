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
| `BuildSession` | Сесія v2: профіль Assemble, порядок кандидатів, записи кадрів (override, origin, assembly, тріаж); зберігається разом із проєктом |

Тип проєкту — `general` (типовий), `character`, `style` або `concept`; `ProjectState.targetModel` — `sd15`, `sdxl` або `flux`, єдине джерело мінімальної коротшої сторони (512 для SD 1.5, 1024 для SDXL/Flux). Обидва зберігаються в `project` частині `.datasetcreator/project.json` (`projectType`, `targetModel`). Профілі в `projectProfiles.ts` задають тексти, початкові налаштування, осі покриття та політику тегів; набір інструментів однаковий для всіх типів. Міграція під час читання (папка й файл проєкту): відсутній `projectType` стає `general` без запиту й без переписування файлу проєкту, невідомий тип відхиляється; відсутній `targetModel` береться зі застарілого `buildSession.profile.minShortSide` (512 → `sd15`, інакше `sdxl`), невідоме значення рахується відсутнім. Нове значення потрапляє на диск зі звичайним збереженням.

`ProjectState.characterTraits` — список рис персонажа `{ tag, mode: 'include' | 'omit' }` (теги у форматі тегера, `blue_eyes`). Поле пишеться в `project` частину `.datasetcreator/project.json` лише коли список непорожній; відсутнє поле читається як `[]`. Риси діють лише для типу `character`, для інших типів зберігаються без впливу.

### Сесія Build (версія 2)

`BuildSession` живе в частині `project` файлу `project.json`. Читач `normalizeBuildSession` приймає версії 1 і 2 і завжди повертає версію 2; невідомі версії замінюються типовою сесією. Єдиний статус кадра (In / Out / Inbox / Pinned / Banned) не зберігається, а виводиться `getImageStatus` із фізичного шляху та записів нижче; користувач задає лише `override`.

- **Профіль** (`profile`): `target` (цільова кількість для режиму Target), `captionRequired`, `transform` (рецепт crop/fit; відсутній означає None, застосовується при прийнятті кадра в Dataset), `sizeMode` (`auto` | відсутнє), `sources` (вибрані папки `inbox/`, підпапки входять) і `similarityStrictness` (`strict` | `balanced` | `loose`). Нова сесія створюється з `sizeMode: 'auto'` і `target: 60`. Сесія без `sizeMode` читається як режим Target, без `similarityStrictness` — як Balanced; без `sources` вважається позначеним увесь `inbox/` (папки, додані пізніше, не позначаються автоматично). Видалення папки прибирає її й підпапки з `sources`; переміщення папки оновлює шляхи.
- **Запис кадра** (`records[assetId]`): незалежні осі `decision` (`unreviewed` / `accepted` / `skipped` / `deferred`), `application` і `validation`, ревізії вмісту й підпису, `proposal` (сирі модельні теги), `triage` (пропозиція: група accepted / rejected / needs-decision, причини, етап `quality` або `assembly`, ревізія, `duplicateOf`, `similarity`, числові виміри якості), а також:
  - `override` — `pin` або `ban`, єдиний статус, який задає користувач. Pin тримає кадр у базі Dataset, Ban виключає його з усього (`decision` при цьому `skipped`);
  - `origin` — папка `inbox/`, звідки кадр прийшов, щоб Return to inbox і Ban повертали його туди (якщо папки вже немає — у корінь `inbox/`); шляхи оновлюються при переміщенні папок;
  - `assembly` — пояснення останнього Assemble для кадра, який він залишив поза Dataset (`duplicate` з `of` і `similarity` або `not-selected`); це кеш, а не членство, він відкидається, коли змінюється вміст кадра.
- **`auto`**: `assemblyKey` і `assembledAt` останнього Assemble, `assemblyError` та `assemblySummary` (кількість зображень, груп, доданих, дублікатів і відхилених за якістю) — числа, які записав сам конвеєр. Вони записуються в тому самому кроці Undo, що й результат Assemble; зміна цільової моделі обнуляє `auto`.
- `lastExport` — відбиток і час останнього експорту.

`decision` залишається основою застосування (`useApplyMembership`, Assemble, міграція v1): Pin записується як `accepted` + `override: pin`, Ban — як `skipped` + `override: ban`.

**Міграція v1 → v2** виконується один раз при читанні: `skipped` стає `ban`, ручне `accepted` (`provenance: manual`) — `pin`; решту статусів застосунок обчислює. Застарілі поля v1 не копіюються й не записуються назад: `stage`, `view`, `cursor`, `filter`, `profile.reviewMode`, `profile.autoPipeline`, `auto.shortlist` (результат колишнього pick-потоку) і `profile.minShortSide`. Останнє лише використовується під час міграції моделі (512 → `sd15`, інакше `sdxl`) і більше не пишеться. Поле `currentTool` у `project` читач ігнорує й не пише; `toolState` та `enabledTools` також не пишуться. Нове значення потрапляє на диск зі звичайним збереженням.

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

Старі `assetIds`, `assetPaths`, `psdAssetPaths`, `captionOverrides`, `overwriteCaptions`, `*.dataset.json`, `dataset.json`, sidecar-теги та поля сесії v1 (`stage`, `view`, `cursor`, `filter`, `auto.shortlist` тощо) зустрічаються лише у читачах і міграціях. Не повертайте їх у новий UI як паралельний механізм членства або підписів.

## Міграція старих проєктів

Проєкт v2 (кореневий `manifest.json`, `src/`, `.cache/`, `.git/` зі знімками) і v1 відкриваються через діалог **Upgrade project layout** (`ProjectUpgradeDialog`); без підтвердження нічого не читається й не записується. Власник — [`layoutMigrationService.ts`](../src/services/project/layoutMigrationService.ts) (`runLayoutMigration`):

1. знімок версії «Before project upgrade …» у `versions/` (якщо його не вдалося записати, проєкт не змінюється);
2. завершення старих міграцій; блокери (`getLayoutMigrationBlockers`) дають діалог «Project cannot be upgraded yet» з варіантами Cancel або **Open without upgrading** (проєкт читається через старий читач; оновлення запропонують знову);
3. журнальні кроки: запис `project.json`, виведення `manifest.json` з обігу (із копією в `backup/`), перенесення `.cache` → `.datasetcreator/cache`, версій і restore-backup з `.git` → `versions/` і `backup/`, прибирання порожньої `.git`;
4. сирі матеріали `src/` → `inbox/` (`runRawMaterialsMove`);
5. sidecar-теги → TXT з trigger у `dataset/` (`runCaptionTxtMigration`); замінені файли — у `backup/<journal>/captions`;
6. sidecar `*.manifest.json` → `assets.json` (`runAssetsRegistryMigration`); старі sidecar — у `backup/<journal>/sidecars`.

Незавершений журнал дописується при наступному відкритті (`resumePendingJournals`). Проєкт, уже в v3 зі старим розташуванням сирих файлів або sidecar, добудовується тими самими кроками (для переміщення в `inbox/` показується підтвердження, якщо є файли). Колізії імен під час переміщення розв’язуються перейменуванням із сповіщенням. Відновлення версії старого формату після відновлення знову запускає оновлення. Міграція записує на диск; це не read-only операція.

## Експорт Dataset

Експорт Dataset — побайтова копія `dataset/` з повною структурою підпапок: зображення зберігають розширення, TXT копіюється як є на диску (trigger уже в ньому, blacklist не застосовується), PSD перетворюється на PNG. Зображення без `.txt` експортується без нього, з попередженням у плані. План — `buildExportPlan` у [`exportPlan.ts`](../src/services/export/exportPlan.ts), єдиний власник; ZIP за замовчуванням зберігається як `exports/<назва-dataset>-<yyyyMMdd-HHmmss>.zip` без перезапису існуючих (`saveZipToProjectExports`), альтернатива — звичайне завантаження або запис у вибрану папку. Діалог Export на Board завжди експортує Dataset; необов’язкове зменшення (`resize`: найдовша сторона або бакети цільової моделі) змінює лише експортовані копії PNG/JPEG/WebP і входить у відбиток плану, зображення в проєкті не чіпаються. Після успіху сесія записує `lastExport`. Сервіс експорту інших джерел (workspace) рендерить підпис із тегів, trigger і blacklist, але в інтерфейсі не використовується.

## Три види стану

| Сховище | Що містить | Обмеження |
| --- | --- | --- |
| Папка проєкту | Файли, `project.json`, `assets.json`, версії | Потрібен доступ на читання/запис; помилки запису не означають успішного збереження |
| IndexedDB | Дані ресурсів, кеші, handles тегера, список недавніх проєктів (store `projects`: handle папки, назва, тип, модель, час зміни, кількість кадрів Dataset; до 12 записів); окремі БД відео та ознак зображень | Може бути очищена браузером; не замінює копію проєкту |
| localStorage | Лише `dataset-creator-theme` (System / Light / Dark) і `dataset-creator-shortcuts-v1` (параметр одноклавішних скорочень `singles`) | Не є резервною копією зображень |

Основна IndexedDB — `DatasetCreator`, схема 3; перелік stores міститься в `constants.ts`. Відеокеш — `dataset-creator-video-frames-v1` зі stores `frames`, `thumbnails`, `meta`; «Clear video cache» очищає всі три, крім запису `model` у `meta`. Постійний кеш ознак зображень DINOv2 — `dataset-creator-embeddings-v1` (store `image`, індекс `at`; ключ `<sha256>:<id моделі>`, значення — вектор і час запису): обмежений 20 000 записів, найстаріші за записом витісняються; очищення відеокешу його не чіпає, а помилки сховища трактуються як промах кешу. Перед ним діє LRU у пам’яті (5 000 векторів). Старі ключі localStorage попереднього інтерфейсу (`dataset-creator-ui-mode`, `-workspace-v2`, `-workspace-layout`, `-docking-v1`, `-density`, `-workspace-tab`, усі `review-view:*` і поле `bindings` у `-shortcuts-v1`) `cleanupLegacyStorage` ([`legacyStorageCleanup.ts`](../src/lib/legacyStorageCleanup.ts)) видаляє при кожному запуску з `main.tsx`; тема й `singles` лишаються. Дані проєкту ці ключі не містили, тож їх втрата нічого не змінює у папці.

Blob URL живе лише в поточній сесії. Він не є шляхом до файлу і має звільнятися після заміни або завершення використання. Для довготривалого збереження потрібні bytes і метадані, а не URL.

## Версії та архіви

Versions зберігає іменовані ZIP-знімки (`.datasetcreator/versions/snapshots/`, індекс `versions/index.json`) та зв’язок із батьківською версією; відкриваються діалогом Versions на Board. Знімок не включає службові `cache`, `journal`, `versions`, `backup`, `exports/` і `.git`; перед відновленням копії замінюваних файлів кладуться в `backup/restore`. Відновлення змінює файли поточної папки; UI має враховувати незбережені документи та помилки відновлення. Не плутайте це з Undo/Redo окремої дії.

Архівний формат `.dcproj` не підтримується: його сервіс видалено як мертвий код.
