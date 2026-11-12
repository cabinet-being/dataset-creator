# Карта коду та перевикористання

Це довідник для вибору точки входу, а не друга специфікація. Шляхи нижче відносні до кореня репозиторію. Перед зміною перевір актуальні експорти й call sites через `rg`.

| Потрібна поведінка | Де вже реалізована | Що перевикористати |
| --- | --- | --- |
| Перевірка документації | `scripts/check-docs.mjs`, `tests/docs-checker.mjs` | `checkDocs`, локальні посилання, шляхи та npm-команди |
| Назви, іконки, scopes, tiers інструментів | `src/lib/toolDefinitions.ts`, `src/lib/constants.ts` | `TOOL_DEFINITIONS` (`tier`: `primary` Build / `advanced` решта; `PRIMARY_TOOLS`, `ADVANCED_TOOLS`), `DATASET_TOOL_DEFINITIONS` з окремими id (`add-files`, `review`, `analysis`, `tagging`), похідні labels/slugs; ToolHub видалено; відповідність URL slug і інструмента (`getToolFromUrlSlug`, `getUrlSlugForTool`) |
| Типи проєктів і початкові значення | `src/lib/projectProfiles.ts`, `src/types/entities.ts` | Профілі та фабрики сутностей |
| Єдиний список ресурсів | `src/lib/workspaceImages.ts` | `toWorkspaceImages`, `toWorkspaceReviewAssets`, нормалізація шляхів (`toProjectRelativePath`, `getProjectDataFileExtension`) |
| Файлові ресурси та incremental cache | `src/lib/workspaceFileAssets.ts` | `collectWorkspaceFileAssets`, `updateWorkspaceFileAssetCache` |
| Прев’ю і життєвий цикл blob URL | `src/lib/previewUrlCache.ts` | `useWorkspacePreviewUrls`, cache/prune helpers |
| Папка, manifest і differential save | `src/services/project/projectDirectoryService.ts` | `readProjectDirectory`, `writeProjectDirectoryChanges` |
| Структура папки | `src/services/project/projectLayoutService.ts` | Константи шляхів, `ensureProjectLayout` |
| Класифікація та службові файли | `src/services/project/assetTypeService.ts`, `assetManifestService.ts` у тій самій папці | MIME/extension rules і назви sidecar manifests |
| Стабільна копія File | `src/services/project/fileSnapshotService.ts` | `snapshotFile`, `snapshotFileIfNeeded` |
| Rename/copy/move/delete і читання папки Explorer | `src/services/project/explorerFileService.ts` | Batch-операції, unique names, recovery errors, `readExplorerDirectory` |
| Зміни шляхів і дерева | `src/lib/datasetAssets.ts`, `src/lib/explorerTreeUpdates.ts` | Path moves, incremental tree updates, сортування/санітизація/порожнє дерево |
| Контекстні дії Explorer | `src/lib/explorerContextActions.ts` | Чисті builder-и груп дій; виконання мутацій лишається в `runExplorerMutation` (`src/App.tsx`) |
| Порядок Dataset board | `src/lib/datasetBoard.ts` | `datasetBoardItems`, `orderDatasetBoardItems`, ключ ресурсу |
| Файлові вкладки | `src/lib/workspaceFileTabs.ts` | Пошук, перейменування та перевірка file-backed tabs |
| Модель вкладок workspace | `src/lib/workspaceTabs.ts`, `src/lib/workspacePersistence.ts`, `src/hooks/useWorkspaceTabs.ts` | Міграція старого dataset tool id `select` → `add-files` (`normalizeDatasetToolName`, `migrateDatasetToolTabId`, `migrateDatasetToolDockIds`); типи й фабрики вкладок, persist/dedupe/order, `getInspectorContext`; `useWorkspaceTabsState` і `useWorkspaceTabActions` для стану й дій |
| Серіалізація операцій | `src/hooks/useProjectSave.ts`, `src/services/project/saveQueue.ts`, `saveSession.ts` | `runProjectFileOperation`, `flushProjectSave`, queue/session |
| Dataset add/remove та Undo | `src/lib/assetActions.ts` | Спільні UI-дії; перевір wrapper черги перед викликом |
| Фізичне членство Dataset | `src/services/dataset/datasetFolderService.ts`, `datasetMembershipResolver.ts` | Move/reverse операції, `isProjectDatasetPath`, resolver |
| Кандидати й пропозиції Dataset | `src/services/dataset/sharedCandidateService.ts`, `datasetAssemblyService.ts`, `coverageService.ts` | Scan, assembly plan, coverage universe |
| Читання та запис підписів | `src/services/caption/captionResolver.ts`, `captionMutationService.ts` | `resolveAssetCaption`, `persistCaptionTagsForItems` |
| Імпорт і pairing TXT | `src/services/import/importService.ts` | `importImageFiles`, `getImportPairKey`, parser підписів |
| Експорт | `src/services/export/exportPlan.ts`, `datasetExportService.ts` | `buildExportPlan`, ZIP/folder writers, фізичні Dataset assets |
| Фото/PSD-редактор | `src/components/photopea/PhotopeaFrame.tsx`, `src/hooks/usePhotopeaDocumentState.ts` | Протокол iframe і стан документа |
| Черга PSD-прев’ю | `src/services/psd/photopeaPreviewQueue.ts` | Dedup за шляхом, timeout і завершення jobs |
| Рівні схожості DINOv2 і Strictness | `src/services/similarity/similarityLevels.ts`, `useSimilarityFeatures.ts` | `SIMILARITY_LEVELS`, `getStrictnessThreshold`, `classifyPair`; єдина таблиця порогів для Analysis, Remove Duplicates, автодобору; хук дає DINOv2-ознаки, стан моделі й завантаження (histogram — лише запасний basis) |
| Звіт якості Dataset | `src/services/quality/metrics/` (`thresholds.ts` — усі пороги, `report.ts`, `requiredChecks.ts`, `embeddingMetrics.ts`, `vendi.ts`, `captionBalance.ts`), `src/services/quality/datasetQualityInput.ts` | `buildQualityReport`; адаптер `buildDatasetQualityInput` збирає вхід із Dataset, Build session, caption resolver і ознак |
| Технічна якість зображення | `src/services/quality/imageQuality.ts` | `measureImageQuality`, `classifyImageQuality`, `getMinShortSide` — одне налаштування для тріажу й звіту |
| UI звіту якості | `src/components/quality/QualityReport.tsx`, `useDatasetQualityReport.ts`, `src/components/build/BuildQualityPanel.tsx` | Панель у Build, Finish, Dataset readiness в Analysis |
| Гістограмна схожість | `src/services/image/embeddingService.ts`, `src/services/similarity/similarityService.ts` | Наявні вектори та обчислення схожості |
| Семантичні ознаки | `src/services/analysis/semanticFeatureService.ts` | DINOv2 image encoder і text-token hashing |
| Відео | `src/services/video/videoClient.ts`, `video.worker.ts`, `videoAnalysis.ts` | Життєвий цикл задач, worker, bounded analysis |
| Кадри, модель і кеш | `src/services/video/frameSelection.ts`, `frameExport.ts`, `videoModel.ts`, `videoCache.ts` | Selection, safe writes, перевірена модель та cache keys |
| Редактор підписів | `src/components/caption/CaptionEditor.tsx`, `src/lib/captionEditor.ts` | Автодоповнення під курсором, клавіатура та діагностика повторів; запис делегується caption mutation service |
| Локальний тегер | `src/services/tagging/localTaggerConnectionService.ts`, `localTaggerFileSettings.ts`, `localTaggerService.ts`, `wdTagger.ts` у тій самій папці | Спільне підключення/відновлення Caption, Build і Settings; IndexedDB handles або копії File, дозволи; ONNX/CSV і правила WD; вибір файлів у UI — `src/hooks/useLocalTaggerFilePicker.tsx` |
| Версії проєкту | `src/services/project/projectVersionService.ts` | ZIP-знімки й restore; не shell Git |
| Docking і responsive geometry | `src/lib/workspaceLayout.ts`, `responsiveWorkspace.ts`, `viewportGeometry.ts` | Чисті layout/geometry helpers |
| Workspace persistence й навігація | `src/lib/workspacePersistence.ts`, `workspaceNavigation.ts` | Спільний snapshot та browser history; `WorkspaceLayout`, `readWorkspaceLayout`, `getRestorableWorkspaceTabs` |
| Вигляд workspace та Escape | `src/hooks/useWorkspaceAppearance.ts`, `src/hooks/useEscapeToClose.ts` | Тема/вигляд і закриття оверлеїв по Escape |
| Панель інспектора, Dataset-екрани, меню вкладок | `src/components/workspace/WorkspaceInspector.tsx`, `DatasetWorkspaceView.tsx`, `WorkspaceTabMenus.tsx` | `WorkspaceInspector`, `DatasetWorkspaceView`, `DatasetToolView`, контекстні меню вкладок |
| Контекст інспектора | `src/stores/useInspectorSelectionStore.ts`, `src/components/workspace/InspectorSelectionDetails.tsx` | Тимчасове виділення активного екрана; основні дії залишаються в робочих екранах |
| Команди й клавіатура | `src/lib/commandRegistry.ts`, `keyboard.ts`, `src/components/workspace/Commands.tsx`, `src/hooks/useWorkspaceCommands.ts` | Scope, shortcut matching, palette; реєстрація команд workspace у `useWorkspaceCommands` |
| Прогрес і Undo/Redo | `src/hooks/useOperation.ts`, `src/stores/useOperationStore.ts`, `useHistoryStore.ts` | Поточні stores і lifecycle; не окрема історія в кожному tool |
| Єдиний режим Build | `src/components/build/BuildWorkspace.tsx`, `src/services/build/buildSessionService.ts` | Versioned session, стабільна черга, рішення/revision/readiness; файлові дії делегуються чинним caption, Dataset та export services |
| Тріаж і автопайплайн Build | `src/services/build/buildTriageService.ts`, `src/components/build/useBuildAutoPipeline.ts` | `classifyQualityTriage`, `getBuildTriageGroup` (ручне рішення переважає), `getBuildTriageCounts`; хук послідовно запускає тріаж, автодобір і фонове тегування |
| Build crop/resize | `src/services/build/buildTransformService.ts` | Детермінований PNG output, no-upscale та idempotent output ID; recipe зберігається в build session |

## Короткий маршрут зміни

Знайди рядок таблиці → прочитай реалізацію → знайди виклики → відкрий відповідний тест із [матриці перевірок](development.md) → внеси зміну у спільного власника. `App.tsx` лишає стан Explorer-дерева, мутації Explorer (`runExplorerMutation`), життєвий цикл проєкту та збирання екранів; решту шукай у власниках вище. Якщо поведінка вже є в `App.tsx`, спочатку знайди її імпортований сервіс; нова копія всередині tool зазвичай створить друге джерело правил.

Карту потрібно оновлювати після перенесення або перейменування модуля. Не додавай сюди повні сигнатури: вони вже визначені в TypeScript.
