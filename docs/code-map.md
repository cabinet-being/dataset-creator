# Карта коду та перевикористання

Це довідник для вибору точки входу, а не друга специфікація. Шляхи нижче відносні до кореня репозиторію. Перед зміною перевір актуальні експорти й call sites через `rg`.

| Потрібна поведінка | Де вже реалізована | Що перевикористати |
| --- | --- | --- |
| Перевірка документації | `scripts/check-docs.mjs`, `tests/docs-checker.mjs` | `checkDocs`, локальні посилання, шляхи та npm-команди |
| Назви, іконки, scopes інструментів | `src/lib/toolDefinitions.ts`, `src/lib/constants.ts` | `TOOL_DEFINITIONS`, похідні labels/slugs |
| Типи проєктів і початкові значення | `src/lib/projectProfiles.ts`, `src/types/entities.ts` | Профілі та фабрики сутностей |
| Єдиний список ресурсів | `src/lib/workspaceImages.ts` | `toWorkspaceImages`, `toWorkspaceReviewAssets`, нормалізація шляхів |
| Файлові ресурси та incremental cache | `src/lib/workspaceFileAssets.ts` | `collectWorkspaceFileAssets`, `updateWorkspaceFileAssetCache` |
| Прев’ю і життєвий цикл blob URL | `src/lib/previewUrlCache.ts` | `useWorkspacePreviewUrls`, cache/prune helpers |
| Папка, manifest і differential save | `src/services/project/projectDirectoryService.ts` | `readProjectDirectory`, `writeProjectDirectoryChanges` |
| Структура папки | `src/services/project/projectLayoutService.ts` | Константи шляхів, `ensureProjectLayout` |
| Класифікація та службові файли | `src/services/project/assetTypeService.ts`, `assetManifestService.ts` у тій самій папці | MIME/extension rules і назви sidecar manifests |
| Стабільна копія File | `src/services/project/fileSnapshotService.ts` | `snapshotFile`, `snapshotFileIfNeeded` |
| Rename/copy/move/delete | `src/services/project/explorerFileService.ts` | Batch-операції, unique names, recovery errors |
| Зміни шляхів і дерева | `src/lib/datasetAssets.ts`, `src/lib/explorerTreeUpdates.ts` | Path moves, incremental tree updates |
| Файлові вкладки | `src/lib/workspaceFileTabs.ts` | Пошук, перейменування та перевірка file-backed tabs |
| Серіалізація операцій | `src/hooks/useProjectSave.ts`, `src/services/project/saveQueue.ts`, `saveSession.ts` | `runProjectFileOperation`, `flushProjectSave`, queue/session |
| Dataset add/remove та Undo | `src/lib/assetActions.ts` | Спільні UI-дії; перевір wrapper черги перед викликом |
| Фізичне членство Dataset | `src/services/dataset/datasetFolderService.ts`, `datasetMembershipResolver.ts` | Move/reverse операції, `isProjectDatasetPath`, resolver |
| Кандидати й пропозиції Dataset | `src/services/dataset/sharedCandidateService.ts`, `datasetAssemblyService.ts`, `coverageService.ts` | Scan, assembly plan, coverage universe |
| Читання та запис підписів | `src/services/caption/captionResolver.ts`, `captionMutationService.ts` | `resolveAssetCaption`, `persistCaptionTagsForItems` |
| Імпорт і pairing TXT | `src/services/import/importService.ts` | `importImageFiles`, `getImportPairKey`, parser підписів |
| Експорт | `src/services/export/exportPlan.ts`, `datasetExportService.ts` | `buildExportPlan`, ZIP/folder writers, фізичні Dataset assets |
| Фото/PSD-редактор | `src/components/photopea/PhotopeaFrame.tsx`, `src/hooks/usePhotopeaDocumentState.ts` | Протокол iframe і стан документа |
| Черга PSD-прев’ю | `src/services/psd/photopeaPreviewQueue.ts` | Dedup за шляхом, timeout і завершення jobs |
| Гістограмна схожість | `src/services/image/embeddingService.ts`, `src/services/similarity/similarityService.ts` | Наявні вектори та обчислення схожості |
| Семантичні ознаки | `src/services/analysis/semanticFeatureService.ts` | DINOv2 image encoder і text-token hashing |
| Відео | `src/services/video/videoClient.ts`, `video.worker.ts`, `videoAnalysis.ts` | Життєвий цикл задач, worker, bounded analysis |
| Кадри, модель і кеш | `src/services/video/frameSelection.ts`, `frameExport.ts`, `videoModel.ts`, `videoCache.ts` | Selection, safe writes, перевірена модель та cache keys |
| Локальний тегер | `src/services/tagging/localTaggerService.ts`, `localTaggerFileSettings.ts` | ONNX/CSV, handles і дозволи |
| Версії проєкту | `src/services/project/projectVersionService.ts` | ZIP-знімки й restore; не shell Git |
| Docking і responsive geometry | `src/lib/workspaceLayout.ts`, `responsiveWorkspace.ts`, `viewportGeometry.ts` | Чисті layout/geometry helpers |
| Workspace persistence й навігація | `src/lib/workspacePersistence.ts`, `workspaceNavigation.ts` | Спільний snapshot та browser history |
| Команди й клавіатура | `src/lib/commandRegistry.ts`, `keyboard.ts`, `src/components/workspace/Commands.tsx` | Scope, shortcut matching, palette |
| Прогрес і Undo/Redo | `src/hooks/useOperation.ts`, `src/stores/useOperationStore.ts`, `useHistoryStore.ts` | Поточні stores і lifecycle; не окрема історія в кожному tool |

## Короткий маршрут зміни

Знайди рядок таблиці → прочитай реалізацію → знайди виклики → відкрий відповідний тест із [матриці перевірок](development.md) → внеси зміну у спільного власника. Якщо поведінка вже є в `App.tsx`, спочатку знайди її імпортований сервіс; нова копія всередині tool зазвичай створить друге джерело правил.

Карту потрібно оновлювати після перенесення або перейменування модуля. Не додавай сюди повні сигнатури: вони вже визначені в TypeScript.
