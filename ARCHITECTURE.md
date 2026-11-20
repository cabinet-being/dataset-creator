# Архітектура DatasetCreator

Статичний React-застосунок виконує обробку даних у браузері. Vite збирає ресурси для розміщення під `/DatasetCreator/`. Власного API-сервера або серверної бази даних у репозиторії немає.

## Межі модулів

```mermaid
flowchart TD
  App[App: проєкт, вкладки, команди] --> UI[Workspace та інструменти]
  UI --> Stores[Zustand stores]
  UI --> Services[Сервіси предметної області]
  Services --> Files[File System Access: папка проєкту]
  Services --> Cache[IndexedDB та кеші]
  App --> Layout[localStorage: вкладки та layout]
  UI --> Photopea[Photopea iframe]
  UI --> Video[Video client та worker]
```

- [`src/App.tsx`](src/App.tsx) композиційний корінь: з’єднує хуки, спільні рефи сесії, відкриття файлів у вкладках, збирання екранів (`renderEditor`, `workspaceViews`) і панелі; стан Explorer (`src/hooks/useExplorerTree.ts`), його мутації через `runExplorerMutation` (`src/hooks/useExplorerMutations.ts`), клавіатура (`useExplorerShortcuts.ts`) і життєвий цикл проєкту (`src/hooks/useProjectLifecycle.ts`) винесені в хуки; модель вкладок (`src/lib/workspaceTabs.ts`, `src/hooks/useWorkspaceTabs.ts`), команди (`src/hooks/useWorkspaceCommands.ts`) та інспектор винесені в окремих власників. Це все ще інтеграційний модуль; нову незалежну логіку краще розміщувати в наявних сервісах.
- `src/components/workspace/` містить оболонку (меню File, View, Tools без activity bar; панелі Explorer, Inspector, Output відкриває View, Versions — File), докування, Explorer, Dataset, Project home, статус операцій і командну палітру.
- `src/components/build/` містить єдиний Build Dataset workspace зі степером етапів Add → Select (List/Grid/Clusters) → Caption → Check → Export (`BuildStepper`, `buildStageSummary.ts`), а `src/components/tools/` — окремі Import, Video Frames, Remove Duplicates, Photopea, Analysis, Review, Caption та Export. Список, назви й рівень (`primary` — Build, `advanced` — решта в групі «Advanced») визначає [`toolDefinitions.ts`](src/lib/toolDefinitions.ts); окремий ToolHub видалено, відкритий проєкт за замовчуванням потрапляє у Build.
- `src/lib/` містить проєкції ресурсів, правила вкладок і шляхів, геометрію, команди та спільні дії.
- `src/services/` відповідає за імпорт, файли проєкту, Dataset, підписи, експорт, зображення, відео й моделі.
- `src/hooks/` з’єднує життєвий цикл React зі збереженням, навігацією, операціями та документами Photopea.

Повна таблиця точок входу — у [карті коду](docs/code-map.md).

## Стан

| Store | Відповідальність |
| --- | --- |
| `useProjectStore` | `ProjectState`, вихідні та редаговані ресурси, Dataset, налаштування підписів |
| `useUIStore` | UI, вибір, фільтри, доступ до папки проєкту |
| `useDocumentStateStore` | Стан відкритих документів, незбережені зміни, запис і перевірка перед закриттям |
| `useOperationStore` | Прогрес, скасування й завершення тривалих операцій |
| `useHistoryStore` | Асинхронні Undo/Redo, до 20 записів, ізоляція за ID проєкту; Undo/Redo чекають завершення запущених history-транзакцій |
| `useLocalTaggerStore` | Сесія, стан і назви збережених файлів локального тегера |

Versioned `BuildSession` є частиною `ProjectState`, а не окремим глобальним store. Pure transitions, стабільна черга, revision stamps і readiness належать `services/build/buildSessionService.ts`; React-компонент лише оркеструє наявні caption, Dataset, transform, video та export owners.

`SourceImage` і `EditedAsset` зберігаються в словниках стану. `WorkspaceImage` — спільне представлення для галерей та інструментів, яке також охоплює файли з папки. Не створюйте окремі списки «тих самих зображень» у кожному інструменті: використовуйте проєкції `workspaceImages.ts` і кеш `workspaceFileAssets.ts`.

## Збереження та файлові операції

`useProjectSave` підключає `createSaveSession` до stores. Сесія прив’язана до конкретного проєкту та handle папки; без папки статус — `local`. Поточна затримка автозбереження в `saveSession.ts` — 250 мс.

`createSaveQueue` послідовно записує snapshots. Базовий збережений стан оновлюється тільки після успішного запису. Під час запису нові зміни накопичуються й записуються наступними; помилка залишає можливість повтору. `runProjectFileOperation` проводить файлові зміни через ту саму чергу. Усередині exclusive-операції не можна викликати `flush`: це може заблокувати чергу.

Зміна проєкту від’єднує попередню сесію. Завершення її старого запиту не повинно змінювати статус нового проєкту. Зміни шляхів синхронізуються з посиланнями у store, Explorer, файловим кешем і вкладками. Часткові помилки мають зберігати відомості про вже завершені операції.

## Dataset, підписи й експорт

Dataset — фізична папка `dataset/` (лише пари image + TXT, підпапки дозволені), а не список активних ID. `datasetMembershipResolver.ts` визначає членство за шляхом. `datasetFolderService.ts` переміщує файли, а `assetActions.ts` додає інтеграцію з історією. Видалення з Dataset переміщує ресурс у `inbox/`. Службові дані проєкту лежать у `.datasetcreator/` (`project.json`, реєстр `assets.json`, cache, versions, journal, backup); `.git` не використовується, справжній Git-репозиторій захищено. Формат теки, відкриття (reconcile з реєстром, rebind за SHA-256) і міграція описані в [моделі даних](docs/data-model.md).

Підпис ресурсу — файл `<stem>.txt` поруч із зображенням; формат (trigger word першим лише в `dataset/`) належить `captionFileService.ts`. `resolveAssetCaption` розрізняє відсутній TXT (tags відсутні) і порожній (`[]`): порожній підпис не слід підміняти fallback-текстом. Зміна trigger word — пакетний перезапис TXT з Undo (`rewriteTriggerWord`, застосовується на Enter/blur). Старі sidecar-теги й Dataset overrides читаються лише міграцією.

`buildExportPlan` у `exportPlan.ts` — єдиний власник експорту: план імен, blob-даних і фінальних підписів. Експорт Dataset — побайтова копія `dataset/` з підпапками (TXT як на диску), ZIP за замовчуванням зберігається в `exports/` (`saveZipToProjectExports`). ZIP і запис у папку використовують цей план. Перед записом у папку перевіряються конфлікти вихідних імен. Підтримка PSD делегує конвертацію Photopea, а не змінює лише розширення файлу.

План має content fingerprint. Під час folder export UI веде журнал повністю записаних image+TXT пар; retry перевіряє їх у вибраній папці, пропускає лише підтверджені пари й не перезаписує конфлікти.

## Аналіз і зовнішні інтеграції

Не всі вектори в проєкті мають однаковий зміст:

- `image/embeddingService.ts` обчислює гістограмні ознаки для наявного аналізу схожості.
- `video/videoModel.ts` завантажує й виконує DINOv2 через ONNX Runtime Web.
- `similarity/similarityLevels.ts` — єдина таблиця рівнів схожості DINOv2 (duplicate / near-copy / similar / related) і стопів Strictness; гістограмні пороги лише запасні. Поріг near-copy спільний для автодобору, тріажу Build і звіту якості.
- `quality/imageQuality.ts` вимірює технічну якість кожного зображення (роздільність, різкість, експозиція) для тріажу Build (`build/buildTriageService.ts`, `components/build/useBuildAutoPipeline.ts`: автоматично лише тріаж якості; Suggest selection, підготовка пропозицій підписів і звуження запускаються явно; ручне рішення переважає).
- `quality/metrics/` будує звіт якості Dataset: обов’язкові перевірки визначають готовність як найгірший статус, пояснювальні метрики (Vendi, покриття, профільні осі покриття, насичення, теги з політикою за типом проєкту, довжина підписів, узгодженість) не дають загального балу. Пороги зібрано в `thresholds.ts`; для DINOv2 вони евристичні й не відкалібровані, а звіт описує файли, а не якість навченої моделі.
- `analysis/semanticFeatureService.ts` використовує DINOv2 для зображень і локальне хешування Unicode-токенів та біграм для тексту. Це не мовна модель. Зображення кодує лінивий воркер (`semanticWorkerClient.ts`, `semanticWorker.worker.ts`), який сам читає байти моделі з IndexedDB; вектори кешуються в пам’яті (LRU) і постійно в `semanticFeatureStore.ts` (`dataset-creator-embeddings-v1`). Модель не завантажується мовчки, а `SemanticModelError` зупиняє весь запуск.
- Тегер WD виконується в окремому лінивому воркері (`tagging/taggerWorkerClient.ts`, `taggerWorker.worker.ts`); `localTaggerRelease.ts` звільняє воркер і сесію. Пакет із `connectLocalTaggerBundle` тримає `modelFile` і не зберігає другу копію сесії в головному потоці, якщо воркери доступні.
- `dataset/shortlistService.ts` — два проходи Auto-select над спільним `datasetAssemblyService`: шорт-лист (~1,75× потрібної кількості, квоти кластерів k-medoids, поріг `SELECTION_DUPLICATE_SIMILARITY`) і звуження за IDF-покриттям тегів та візуальним приростом. Жоден прохід не рухає файли; шорт-лист зберігається в `BuildSession.auto.shortlist`, застосування звуженого набору — один пакет Dataset-переміщень і один Undo.
- Імпорт декодує зображення воркером `imageWorker` (`probe`: розмір, мініатюра, гістограма, хеш), а `createImportBatcher` групує додавання й збереження пакетами; переміщення в Dataset оновлюють шляхи й реєстр один раз на пакет.
- `dataset/coverageService.ts` і `datasetAssemblyService.ts` оцінюють покриття заданої множини та пропонують доповнення; ці оцінки не доводять якість навчання моделі.

Відео має окремий client/worker, кеш кадрів і обмеження паралельних операцій. Photopea — зовнішній iframe із протоколом повідомлень і чергою PSD-прев’ю. Тегер використовує вибрані користувачем ONNX/CSV-файли. Наявність типів crop/augmentation не означає наявності окремих інструментів або workers для них.

Старі проєкти (v2/v1) оновлює `layoutMigrationService.ts` із журналом, знімком і бекапами; діалог — `ProjectUpgradeDialog`. Формат файлів і міграції описані в [моделі даних](docs/data-model.md), перевірки — у [посібнику розробника](docs/development.md).


## Інспектор і робочі екрани

Основні дії Build, Analysis, Caption і Photopea доступні всередині відповідного екрана незалежно від відкриття Inspector. Налаштування Dataset належать його екрану та профілю Build. Inspector показує поточне виділення, фізичне членство в Dataset, підпис і додаткові властивості; він не є другим редактором підписів.

`src/stores/useInspectorSelectionStore.ts` передає тимчасовий контекст активної вкладки з Build, Analysis, Caption і галерей Review/Dataset. Контекст прив’язаний до власника-вкладки, очищується при зміні проєкту та не зберігається в manifest. `src/components/workspace/InspectorSelectionDetails.tsx` відображає цей контекст. Статус готовності Build надходить із його чинного сервісу; наявність підпису в інших режимах не означає готовність до експорту.


## Написання підписів і локальне тегування

Build і Caption використовують спільний `src/components/caption/CaptionEditor.tsx`: керований текст, автодоповнення поточного фрагмента, клавіатурний вибір і попередження про повтори. Словник може поєднувати теги проєкту, підключеної моделі та імпортований користувачем список. Редактор не записує файли самостійно; чинні власники екранів викликають caption mutation service.

`src/services/tagging/localTaggerFileSettings.ts` зберігає вибрані ONNX і CSV у браузерному IndexedDB: native file handles, а для звичайного file input — копії `File`. Їхні назви й доступ належать браузеру, а не поточному проєкту чи його налаштуванням підписів. `localTaggerConnectionService.ts` спільно керує підключенням із Caption, Build і Settings та відкидає результат застарілого підключення. Під час запуску застосунок одноразово пробує відновити пару файлів без запиту дозволу; якщо браузер відкликав доступ до handle, користувач може повторити спробу з дозволом через Reconnect/Restore saved model. Копії `File` читаються без запиту дозволу.

Модель WD ViT Tagger v3 (`SmilingWolf/wd-vit-tagger-v3`, Apache-2.0, закріплена revision, ≈378.8 MB) завантажується лише явною дією користувача в Build або Settings (`WdTaggerDownloadPanel`). Маніфест із розмірами й SHA-256 — `wdTaggerModelManifest.ts`; процес, прогрес, скасування й повтор — `wdTaggerDownloadService.ts`; стан — `useLocalTaggerStore`. Перевірене завантаження виконує спільний `src/services/models/verifiedModelDownload.ts` (його ж використовує DINOv2 у `video/videoModel.ts`). Файли зберігаються як копії `File` у тому самому IndexedDB-сховищі тегера з позначкою `source: 'download'` і SHA-256; цей запис без провенансу перезаписує ручний вибір файлів. Під час кожного відновлення збережені завантажені файли перевіряються за SHA-256 повторно. Скасування або помилка нічого не зберігають; після успіху тегер підключається автоматично, і автотегування Build працює далі. Завантаження ніколи не стартує саме.

`src/services/tagging/wdTagger.ts` зберігає індекси та категорії рядків selected_tags.csv. Для WD bundle з колонкою category застосовується BGR float32 у діапазоні 0–255; старий формат CSV лише з name зберігає попередню RGB-поведінку. Рейтинги за замовчуванням виключені з підписів, поріг персонажів — не нижчий за 0.85 і загальний поріг. Наявність ONNX-файла не гарантує сумісність довільної моделі. Browser Canvas resize не гарантує піксельної тотожності Pillow bicubic з еталонної реалізації.
