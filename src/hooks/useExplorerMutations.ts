import { useEffect, useState } from 'react';
import type { DragEvent, MutableRefObject } from 'react';
import type { ExplorerTreeNode } from '../components/workspace/ExplorerTree';
import { moveToolViewScope, pruneToolViewScope } from '../lib/workspaceToolScope';
import type { WorkspaceTab } from '../lib/workspaceTabs';
import type { SourceImage } from '../types';
import { isFileBackedTab, moveFileTab } from '../lib/workspaceFileTabs';
import { addWorkspacePathsToDataset } from '../lib/assetActions';
import { isOperationRunning, useOperationStore } from '../stores/useOperationStore';
import type { ExplorerItemEntry, ExplorerClipboard } from './useWorkspaceCommands';
import { flushProjectSave, runProjectFileOperation } from './useProjectSave';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';
import { toProjectRelativePath } from '../lib/workspaceImages';
import { emptyExplorerChanges } from '../lib/explorerTreeUpdates';
import type { useExplorerTree } from './useExplorerTree';
import type { useWorkspaceTabsState } from './useWorkspaceTabs';
import { clearLegacyExclusionAtPath } from '../services/project/legacyDatasetExclusionService';
import type { ProjectDirectoryHandle } from '../services/project/projectDirectoryService';
import { getImportFilesFromDataTransfer, createImportBatcher, importImageFiles, pickImportDirectory, pickImportFiles, type ImportInputFile, type ImportImagesOptions, type ImportImagesResult } from '../services/import/importService';
import { createOperationLogger } from '../services/logging/applicationLog';
import { applyBuildSessionPathMoves } from '../services/build/buildSessionService';
import { indexProjectAssets } from '../services/project/assetIndexService';
import { moveAssetRegistryPaths, removeAssetRegistryPaths } from '../services/project/assetRegistryService';
import {
  applyExplorerPathMoves,
  applyProjectRelativePathMoves,
  applyFileAssetOrderPathMoves,
  type ExplorerPathMove,
} from '../lib/datasetAssets';
import {
  copyExplorerEntries,
  createExplorerDirectory,
  deleteExplorerEntry,
  duplicateExplorerEntries,
  getExplorerFileKind,
  isExplorerImageFileName,
  moveExplorerEntries,
  readExplorerFile,
  renameExplorerEntry,
  ExplorerBatchError,
  ExplorerRecoveryError,
  type ExplorerClipboardEntry,
} from '../services/project/explorerFileService';
import { reconcileTriggerAfterMove } from '../services/caption/captionFileService';
import { PROJECT_DATASET_DIRECTORY, PROJECT_INBOX_DIRECTORY } from '../services/project/projectLayoutService';
import { isProjectDatasetPath } from '../services/dataset/datasetFolderService';
import { EXPLORER_VIEW } from '../lib/workspaceLayout';
import { isAbortError } from '../lib/utils';

type FilesystemExplorerItemEntry = ExplorerItemEntry & { kind: 'folder' | 'file' };

export const isFilesystemExplorerEntry = (entry: ExplorerItemEntry): entry is FilesystemExplorerItemEntry =>
  entry.kind === 'folder' || entry.kind === 'file';

interface UseExplorerMutationsOptions {
  explorer: ReturnType<typeof useExplorerTree>;
  tabs: ReturnType<typeof useWorkspaceTabsState>;
  activeTab: WorkspaceTab | null;
  confirmClosingTabs: (tabs: WorkspaceTab[]) => Promise<boolean>;
  projectOperationBusyRef: MutableRefObject<boolean>;
}

export function useExplorerMutations({
  explorer,
  tabs: tabsState,
  activeTab,
  confirmClosingTabs,
  projectOperationBusyRef,
}: UseExplorerMutationsOptions) {
  const { openTabs, openTabsRef, setOpenTabs, setActiveTabId, setClosedTabs } = tabsState;
  const {
    explorerMutationChanges, getContextEntries, getSelectedExplorerEntries, refreshChangedExplorer, refreshExplorer,
    setCurrentDraggedExplorerEntries, setExpandedExplorerPaths, setFocusedExplorerPath, setSelectedExplorerPaths,
    setSelectionAnchorPath, draggedExplorerEntries,
  } = explorer;
  const projectDirectoryHandle = useUIStore(state => state.projectDirectoryHandle);
  const addNotification = useUIStore(state => state.addNotification);
  const addSourceImage = useProjectStore((state) => state.addSourceImage);
  const addSourceImages = useProjectStore((state) => state.addSourceImages);
  const removeSourceImage = useProjectStore((state) => state.removeSourceImage);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const updateProjectDataset = useProjectStore((state) => state.updateDataset);
  const updateBuildSession = useProjectStore((state) => state.updateBuildSession);

  const [explorerClipboard, setExplorerClipboard] = useState<ExplorerClipboard | null>(null);
  const [inlineExplorerEdit, setInlineExplorerEdit] = useState<{
    mode: 'create' | 'rename';
    parentPath: string;
    path?: string;
    kind: 'folder' | 'file';
    value: string;
  } | null>(null);

  const indexProjectWorkspaceAssets = async (save = true, paths?: string[], updateUi = true) => {
    if (!projectDirectoryHandle) {
      return;
    }
    for (const path of paths ?? []) {
      if (isProjectDatasetPath(path)) await clearLegacyExclusionAtPath(projectDirectoryHandle,path);
    }

    await indexProjectAssets(projectDirectoryHandle, {
      logger: createOperationLogger('Index'),
      paths,
      existingSourceImages: useProjectStore.getState().sourceImages,
      triggerWord: useProjectStore.getState().dataset.triggerWord,
      onAssetIndexed: async ({ sourceImage }) => {
        const previousProject = useProjectStore.getState();
        if (sourceImage && !previousProject.sourceImages[sourceImage.id]) {
          addSourceImage(sourceImage);
        }
      },
    });
    if (save) await flushProjectSave();
    if (updateUi) {
      refreshExplorer();
      useUIStore.getState().refreshAssetPreviews();
    }
  };

  const toPhysicalExplorerEntry = (entry: ExplorerItemEntry): ExplorerClipboardEntry => ({
    path: entry.path,
    name: entry.name,
    kind: entry.kind === 'folder' ? 'folder' : 'file',
  });

  const requireProjectDirectory = (): ProjectDirectoryHandle | null => {
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Save or open a project directory before changing Explorer files.');
      return null;
    }
    return projectDirectoryHandle;
  };

  const runExplorerMutation = async <T,>(label: string, action: () => Promise<T>): Promise<T> => {
    const operations = useOperationStore.getState();
    const running = operations.entries.find(isOperationRunning);
    if (projectOperationBusyRef.current || running) {
      throw new Error(running ? `Finish or cancel ${running.label} before changing project files.` : 'Wait for the project to finish opening.');
    }
    const id = `explorer:${crypto.randomUUID()}`;
    const directory = projectDirectoryHandle;
    const changes = emptyExplorerChanges();
    explorerMutationChanges.current = changes;
    operations.start({ id, viewId: EXPLORER_VIEW, label });
    try {
      const result = await runProjectFileOperation(action);
      operations.finish(id, 'completed');
      return result;
    } catch (error) {
      if (error instanceof ExplorerBatchError || error instanceof ExplorerRecoveryError) changes.paths.push(...error.recoveryPaths);
      operations.finish(id, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      explorerMutationChanges.current = null;
      if (directory) {
        try { await refreshChangedExplorer(directory, changes); }
        catch (error) { addNotification('warning', error instanceof Error ? error.message : 'Could not refresh changed files'); }
      }
    }
  };

  const updateFileTabsForPathMoves = (moves: Array<{ from: string; to: string }>) => {
    const movedTabs = openTabsRef.current.flatMap(tab => {
      if (!isFileBackedTab(tab)) return [];
      const moved = moveFileTab(tab, moves);
      return moved === tab ? [] : [{id: tab.id, path: moved.path}];
    });
    setOpenTabs(tabs => tabs.map(tab => moveToolViewScope(moveFileTab(tab, moves), moves)));
    setClosedTabs(tabs => tabs.map(tab => moveToolViewScope(moveFileTab(tab, moves), moves)));
    if (projectDirectoryHandle && movedTabs.length > 0) {
      void Promise.all(
        movedTabs.map(async ({ id, path }) => ({ id, path, file: await readExplorerFile(projectDirectoryHandle, path) }))
      ).then((refreshedTabs) => {
        setOpenTabs((tabs) =>
          tabs.map((tab) => {
            if (!isFileBackedTab(tab)) {
              return tab;
            }
            const refreshed = refreshedTabs.find((candidate) => candidate.id === tab.id && candidate.path === tab.path);
            if (!refreshed?.file) {
              return tab;
            }
            return {
              ...tab,
              file: refreshed.file,
              fileKind: getExplorerFileKind(tab.name, 'type' in refreshed.file ? refreshed.file.type : undefined),
            };
          })
        );
      }).catch(error => addNotification('warning', error instanceof Error ? error.message : 'Could not refresh the moved file'));
    }
  };

  const updateExplorerClipboardForPathMoves = (moves: Array<{ from: string; to: string }>) => {
    setExplorerClipboard((clipboard) => {
      if (!clipboard) {
        return clipboard;
      }
      return {
        ...clipboard,
        entries: clipboard.entries.map((entry) => {
          const nextPath = applyExplorerPathMoves(entry.path, moves);
          return {
            ...entry,
            path: nextPath,
            name: nextPath.split('/').pop() ?? entry.name,
          };
        }),
      };
    });
  };

  const clearExplorerClipboardForDeletedPaths = (entries: ExplorerItemEntry[]) => {
    setExplorerClipboard((clipboard) => {
      if (
        !clipboard ||
        !clipboard.entries.some((clipboardEntry) =>
          entries.some((entry) => clipboardEntry.path === entry.path || clipboardEntry.path.startsWith(`${entry.path}/`))
        )
      ) {
        return clipboard;
      }
      return null;
    });
  };

  const updateWorkspacePathsForPathMoves = async (moves: ExplorerPathMove[]) => {
    for (const source of Object.values(useProjectStore.getState().sourceImages)) {
      const originalFilePath = applyProjectRelativePathMoves(source.originalFilePath, moves);
      if (originalFilePath !== source.originalFilePath) {
        const fileNameChanged = originalFilePath && originalFilePath !== source.originalFilePath;
        const fileName = fileNameChanged ? originalFilePath.split('/').pop() ?? source.fileName : source.fileName;
        updateSourceImage(source.id, {
          originalFilePath,
          fileName,
          originalFileName: fileNameChanged ? fileName : source.originalFileName,
          ...(isProjectDatasetPath(source.originalFilePath) !== isProjectDatasetPath(originalFilePath) ? { captionTriggerMissing: undefined } : {}),
        });
      }
    }

    for (const item of Object.values(useProjectStore.getState().datasetItems)) {
      const imageDataPath = applyProjectRelativePathMoves(item.imageDataPath, moves);
      const psdDataPath = applyProjectRelativePathMoves(item.psdDataPath, moves);
      if (imageDataPath !== item.imageDataPath || psdDataPath !== item.psdDataPath) {
        updateDatasetItem(item.id, { imageDataPath, psdDataPath,
          ...(isProjectDatasetPath(item.imageDataPath) !== isProjectDatasetPath(imageDataPath) ? { captionTriggerMissing: undefined } : {}) });
      }
    }

    const dataset = useProjectStore.getState().dataset;
    const assetOrder = applyFileAssetOrderPathMoves(dataset.assetOrder, moves);
    if (assetOrder.some((key, index) => key !== dataset.assetOrder[index])) {
      updateProjectDataset(dataset.id, { assetOrder });
    }
    updateBuildSession((session) => applyBuildSessionPathMoves(session, moves));
    // The registry keeps every file's id across the move, like the references above.
    if (projectDirectoryHandle) await moveAssetRegistryPaths(projectDirectoryHandle, moves);
  };

  useEffect(() => {
    const handleDatasetFolderMoves = (event: Event) => {
      const moves = (event as CustomEvent<ExplorerPathMove[]>).detail;
      if (!Array.isArray(moves) || moves.length === 0) return;
      updateFileTabsForPathMoves(moves);
      updateExplorerClipboardForPathMoves(moves);
      if (explorerMutationChanges.current) explorerMutationChanges.current.moves.push(...moves);
      else if (projectDirectoryHandle) void refreshChangedExplorer(projectDirectoryHandle, { moves, paths: [] })
        .catch(error => addNotification('warning', error instanceof Error ? error.message : 'Could not refresh Dataset files'));
    };
    window.addEventListener('dataset-folder-paths-changed', handleDatasetFolderMoves);
    return () => window.removeEventListener('dataset-folder-paths-changed', handleDatasetFolderMoves);
  });

  const renameExplorerItem = async (
    path: string,
    kind: ExplorerTreeNode['kind'],
    requestedName: string
  ): Promise<string | null> => {
    const directory = requireProjectDirectory();
    const trimmedName = requestedName.trim();
    if (!directory || !trimmedName || path === 'Project') {
      return null;
    }

    return runExplorerMutation('Rename file', async () => {
      const nextFileName = trimmedName;
      const entryKind = kind === 'folder' ? 'folder' : 'file';
      const nextPath = await renameExplorerEntry(directory, path, entryKind, nextFileName, async change => {
        const moves = [change];
        explorerMutationChanges.current?.moves.push(change);
        const nextPath = change.to;
        setSelectedExplorerPaths(new Set([nextPath]));
        setSelectionAnchorPath(nextPath);
        setFocusedExplorerPath(nextPath);
        setInlineExplorerEdit(null);
        updateFileTabsForPathMoves(moves);
        await updateWorkspacePathsForPathMoves(moves);
        updateExplorerClipboardForPathMoves(moves);

      });
      await indexProjectWorkspaceAssets(false, [nextPath], false);
      return nextPath;
    });
  };

  const removeWorkspaceReferencesForDeletedEntries = async (entries: ExplorerClipboardEntry[]) => {
    if (projectDirectoryHandle) await removeAssetRegistryPaths(projectDirectoryHandle, entries.map((entry) => entry.path));
    const deletedPaths = entries.map((entry) => toProjectRelativePath(entry.path));
    const previousEdited = Object.values(useProjectStore.getState().datasetItems);
    const removedSourceIds: string[] = [];
    for (const source of Object.values(useProjectStore.getState().sourceImages)) {
      const sourcePath = source.originalFilePath;
      if (
        sourcePath &&
        deletedPaths.some((deletedPath) => sourcePath === deletedPath || sourcePath.startsWith(`${deletedPath}/`))
      ) {
        removeSourceImage(source.id);
        removedSourceIds.push(source.id);
      }
    }
    const removedIds = new Set([
      ...removedSourceIds.map(id => `source:${id}`),
      ...previousEdited.filter(item => removedSourceIds.includes(item.sourceImageId)).map(item => `edited:${item.id}`),
    ]);
    const explorerPaths = entries.map(entry => entry.path);
    const isDeletedExplorerPath = (path: string) => explorerPaths.some(root => path === root || path.startsWith(`${root}/`));
    const keepViews = (tabs: WorkspaceTab[]) => tabs
      .filter(tab => !isFileBackedTab(tab) || !explorerPaths.some(path => tab.path === path || tab.path.startsWith(`${path}/`)))
      .map(tab => pruneToolViewScope(tab, explorerPaths, removedIds));
    setOpenTabs(keepViews);
    setClosedTabs(keepViews);
    clearExplorerClipboardForDeletedPaths(entries);
    setSelectedExplorerPaths(paths => new Set([...paths].filter(path => !isDeletedExplorerPath(path))));
    setFocusedExplorerPath(path => path && isDeletedExplorerPath(path) ? null : path);
    setSelectionAnchorPath(path => path && isDeletedExplorerPath(path) ? null : path);
    {
      const dataset = useProjectStore.getState().dataset;

      const deletedExplorerPaths = entries.map((entry) => entry.path);
      const isDeletedPath = (path: string) =>
        deletedExplorerPaths.some((deletedPath) => path === deletedPath || path.startsWith(`${deletedPath}/`));
      const assetOrder = dataset.assetOrder.filter((key) => !key.startsWith('file:') || !isDeletedPath(key.slice('file:'.length)));

      if (assetOrder.length !== dataset.assetOrder.length) {
        updateProjectDataset(dataset.id, { assetOrder });
      }
    }
  };

  // Caller owns the save queue lane; updates are applied after each completed move.
  const moveWorkspaceEntries = async (directory: ProjectDirectoryHandle, entries: ExplorerClipboardEntry[], destinationPath: string) => {
    const completed: ExplorerPathMove[] = [];
    try {
      return await moveExplorerEntries(directory, entries, destinationPath, async move => {
        if (move.from === move.to) return;
        completed.push(move);
        // Moving across dataset/ adds or removes the trigger word in the captions, inside this same exclusive operation.
        await reconcileTriggerAfterMove(directory, move, useProjectStore.getState().dataset.triggerWord);
        explorerMutationChanges.current?.moves.push(move);
        updateFileTabsForPathMoves([move]);
        await updateWorkspacePathsForPathMoves([move]);
        updateExplorerClipboardForPathMoves([move]);
      });
    } finally {
      if (completed.length > 0) await indexProjectWorkspaceAssets(false, completed.map(move => move.to), false);
    }
  };

  const handleExplorerDelete = async (node: ExplorerTreeNode) => {
    if (node.path === 'Project') {
      return;
    }
    await deleteExplorerEntries(getContextEntries(node));
  };

  /** Confirms and deletes the given entries (Dataset images return to inbox instead); shared by the Explorer and the next UI. */
  const deleteExplorerEntries = async (entries: ExplorerItemEntry[]) => {
    if (entries.length === 0 || entries.some(entry => entry.path === 'Project')) {
      return;
    }
    const datasetFiles = entries.filter(
      (entry) =>
        entry.kind === 'file' &&
        entry.path.startsWith(`Project/${PROJECT_DATASET_DIRECTORY}/`) &&
        isExplorerImageFileName(entry.name)
    );
    const confirmation = datasetFiles.length > 0 && datasetFiles.length === entries.length
      ? `Remove ${datasetFiles.length === 1 ? `"${datasetFiles[0].name}"` : `${datasetFiles.length} images`} from the Dataset and move them to inbox?`
      : `Delete ${entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`}? This cannot be undone.`;
    if (!window.confirm(confirmation)) {
      return;
    }
    const affectedTabs = openTabs.filter(tab => isFileBackedTab(tab) && entries.some(entry => tab.path === entry.path || tab.path.startsWith(`${entry.path}/`)));
    if (!await confirmClosingTabs(affectedTabs)) return;

    try {
      await runExplorerMutation('Delete files', async () => {
        const filesystemEntries = entries.filter(isFilesystemExplorerEntry);
        const directory = filesystemEntries.length > 0 ? requireProjectDirectory() : null;
        if (filesystemEntries.length > 0 && !directory) {
          return;
        }
        const filesToReturnToShared = filesystemEntries.filter((entry) => datasetFiles.some((datasetFile) => datasetFile.path === entry.path));
        if (filesToReturnToShared.length > 0) {
          await moveWorkspaceEntries(directory!, filesToReturnToShared, `Project/${PROJECT_INBOX_DIRECTORY}`);
        }
        const deletedFilesystemEntries = filesystemEntries.filter((entry) => !filesToReturnToShared.some((moved) => moved.path === entry.path));
        const activeFileTabDeleted =
          activeTab &&
          isFileBackedTab(activeTab) &&
          deletedFilesystemEntries.some((entry) => activeTab.path === entry.path || activeTab.path.startsWith(`${entry.path}/`));
        for (const entry of deletedFilesystemEntries) {
          await deleteExplorerEntry(directory!, entry.path, true, async () => {
            explorerMutationChanges.current?.paths.push(entry.path);
            await removeWorkspaceReferencesForDeletedEntries([entry]);
          });
        }
        setOpenTabs((tabs) =>
          tabs.filter(
            (tab) =>
              (isFileBackedTab(tab) &&
                !deletedFilesystemEntries.some((entry) => tab.path === entry.path || tab.path.startsWith(`${entry.path}/`))) ||
              tab.kind === 'dataset' || tab.kind === 'dataset-tool' ||
              tab.kind === 'tool' || tab.kind === 'window'
          )
        );
        if (activeFileTabDeleted) {
          setActiveTabId(null);
        }
        clearExplorerClipboardForDeletedPaths(entries);
        setSelectedExplorerPaths(new Set());
        setFocusedExplorerPath(null);
      });
      addNotification('success', 'Explorer entry deleted');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to delete entry');
    }
  };

  const handleExplorerRename = async (node: ExplorerTreeNode) => {
    if (node.path === 'Project') {
      return;
    }
    setInlineExplorerEdit({
      mode: 'rename',
      parentPath: node.path.split('/').slice(0, -1).join('/') || 'Project',
      path: node.path,
      kind: node.kind,
      value: node.name,
    });
  };

  const handleExplorerNewFolder = async (node: ExplorerTreeNode) => {
    if (node.kind !== 'folder') {
      return;
    }
    setInlineExplorerEdit({ mode: 'create', parentPath: node.path, kind: 'folder', value: 'New Folder' });
    setExpandedExplorerPaths((paths) => new Set([...paths, node.path]));
  };

  const handleExplorerPaste = async (node: ExplorerTreeNode) => {
    if (node.kind !== 'folder' || !explorerClipboard) return;
    const directory = requireProjectDirectory();
    if (!directory) return;
    const clipboard = explorerClipboard;
    try {
      await runExplorerMutation('Paste files', async () => {
        if (clipboard.mode === 'cut') {
          const moves = await moveWorkspaceEntries(directory, clipboard.entries.map(toPhysicalExplorerEntry), node.path);
          setSelectedExplorerPaths(new Set(moves.map(move => move.to)));
          setExplorerClipboard(null);
        } else {
          let copied: ExplorerPathMove[] = [];
          try {
            copied = await copyExplorerEntries(directory, clipboard.entries.filter(isFilesystemExplorerEntry), node.path);
          } catch (error) {
            if (error instanceof ExplorerBatchError) copied = error.completed;
            throw error;
          } finally {
            explorerMutationChanges.current?.paths.push(...copied.map(change => change.to));
            if (copied.length > 0) await indexProjectWorkspaceAssets(false, copied.map(change => change.to), false);
          }
        }
        setExpandedExplorerPaths(paths => new Set([...paths,node.path]));
      });
      addNotification('success','Explorer entry pasted');
    } catch (error) {
      addNotification('error',error instanceof Error ? error.message : 'Failed to paste entry');
    }
  };

  const handleExplorerDuplicate = async (node: ExplorerTreeNode) => {
    try {
      await runExplorerMutation('Duplicate files', async () => {
        const entries = getContextEntries(node);
        const filesystemEntries = entries.filter(isFilesystemExplorerEntry);
        let duplicated: ExplorerPathMove[] = [];
        try {
          if (filesystemEntries.length > 0) {
            const directory = requireProjectDirectory();
            if (!directory) return;
            duplicated = await duplicateExplorerEntries(directory, filesystemEntries);
          }
        } catch (error) {
          if (error instanceof ExplorerBatchError) duplicated = error.completed;
          throw error;
        } finally {
          explorerMutationChanges.current?.paths.push(...duplicated.map(change => change.to));
          if (duplicated.length > 0) await indexProjectWorkspaceAssets(false, duplicated.map(change => change.to), false);
        }
      });
      addNotification('success', 'Explorer entry duplicated');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to duplicate entry');
    }
  };

  const commitInlineExplorerEdit = async () => {
    const edit = inlineExplorerEdit;
    if (!edit) {
      return;
    }

    try {
      const directory = requireProjectDirectory();
      if (!directory) {
        return;
      }

      if (edit.mode === 'create') {
        const nextPath = await runExplorerMutation('Create folder', async () => {
          const path = await createExplorerDirectory(directory, edit.parentPath, edit.value);
          explorerMutationChanges.current?.paths.push(path);
          return path;
        });
        setSelectedExplorerPaths(new Set([nextPath]));
        setSelectionAnchorPath(nextPath);
        setFocusedExplorerPath(nextPath);
      } else if (edit.path) {
        const nextName = edit.value.trim();
        if (!nextName || nextName === edit.path.split('/').pop()) {
          setInlineExplorerEdit(null);
          return;
        }
        const nextPath = await renameExplorerItem(edit.path, edit.kind, nextName);
        if (nextPath) {
          setSelectedExplorerPaths(new Set([nextPath]));
          setSelectionAnchorPath(nextPath);
          setFocusedExplorerPath(nextPath);
        }
      }
      setInlineExplorerEdit(null);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to update Explorer entry');
    }
  };

  const cancelInlineExplorerEdit = () => setInlineExplorerEdit(null);

  const moveSelectedExplorerEntries = async (destinationPath: string, entriesOverride?: ExplorerItemEntry[] | null) => {
    const entries = entriesOverride ?? getSelectedExplorerEntries();
    const directory = requireProjectDirectory();
    if (!directory || !entries.length) return;
    try {
      const moves = await runExplorerMutation('Move files', () => moveWorkspaceEntries(directory,entries.map(toPhysicalExplorerEntry),destinationPath));
      const paths = moves.map(move => move.to);
      setSelectedExplorerPaths(new Set(paths));
      setFocusedExplorerPath(paths[0] ?? null);
      setCurrentDraggedExplorerEntries(null);
    } catch (error) {
      addNotification('error',error instanceof Error ? error.message : 'Failed to move Explorer entries');
    }
  };

  const importExternalFilesIntoExplorer = async (files: ImportInputFile[], destinationPath: string, execution?: Pick<ImportImagesOptions, 'signal' | 'onProgress'>): Promise<ImportImagesResult> => {
    const directory = requireProjectDirectory();
    if (!directory || files.length === 0) {
      return { importedImages: [], importedAssets: [], skippedCount: 0, summary: { pairedImages: 0, imagesWithoutCaption: 0, standaloneTextFiles: 0, captionConflicts: 0, errors: 0 } };
    }

    try {
      let importedImageCount = 0;
      let importedAssetCount = 0;
      // One store update, one save and one Explorer refresh per batch instead of per file.
      const batcher = createImportBatcher<SourceImage | null>(async (items) => {
        const images = items.filter((item): item is SourceImage => Boolean(item));
        if (images.length) {
          addSourceImages(images);
          await flushProjectSave();
        }
        setExpandedExplorerPaths((paths) => new Set([...paths, destinationPath]));
        refreshExplorer();
      });
      let result: ImportImagesResult;
      try {
        result = await importImageFiles(files, {
          ...execution,
          logger: createOperationLogger('Import'),
          destination: {
            projectDirectory: directory,
            explorerPath: destinationPath,
          },
          onImageImported: async (image) => {
            importedImageCount += 1;
            await batcher.add(image);
          },
          onAssetImported: async () => {
            importedAssetCount += 1;
            await batcher.add(null);
          },
          onDirectoryImported: () => batcher.add(null),
          onError: (fileName) => addNotification('error', `Failed to process ${fileName}`),
        });
      } finally {
        await batcher.flush();
      }

      if (result.importedImages.length > 0 || result.importedAssets.length > 0) {
        const details = [
          result.summary.pairedImages ? `${result.summary.pairedImages} paired` : '',
          result.summary.imagesWithoutCaption ? `${result.summary.imagesWithoutCaption} without caption` : '',
          result.summary.standaloneTextFiles ? `${result.summary.standaloneTextFiles} standalone TXT` : '',
          result.summary.captionConflicts ? `${result.summary.captionConflicts} caption conflicts` : '',
        ].filter(Boolean).join(' · ');
        addNotification(
          'success',
          `Imported ${importedAssetCount || importedImageCount} asset${(importedAssetCount || importedImageCount) !== 1 ? 's' : ''}${details ? ` · ${details}` : ''}`
        );
        setExpandedExplorerPaths((paths) => new Set([...paths, destinationPath]));
        refreshExplorer();
        useUIStore.getState().refreshAssetPreviews();
      }
      return result;
    } catch (error) {
      if (execution) throw error;
      addNotification('error', error instanceof Error ? error.message : 'Failed to import files');
      return { importedImages: [], importedAssets: [], skippedCount: 0, summary: { pairedImages: 0, imagesWithoutCaption: 0, standaloneTextFiles: 0, captionConflicts: 0, errors: 1 } };
    }
  };

  const handleExplorerImport = async (destinationPath: string, importDirectory = false) => {
    try {
      const files = importDirectory ? await pickImportDirectory() : await pickImportFiles();
      await importExternalFilesIntoExplorer(files, destinationPath);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      addNotification('error', error instanceof Error ? error.message : 'Failed to select files for import');
    }
  };

  const handleExplorerDrop = (event: DragEvent, destinationPath: string) => {
    if (Array.from(event.dataTransfer.types).includes('Files')) {
      event.dataTransfer.dropEffect = 'copy';
      void getImportFilesFromDataTransfer(event.dataTransfer)
        .then((files) => importExternalFilesIntoExplorer(files, destinationPath))
        .catch((error) => {
          addNotification('error', error instanceof Error ? error.message : 'Failed to read dropped files');
        });
      return;
    }

    void moveSelectedExplorerEntries(destinationPath, draggedExplorerEntries);
  };

  const addToDatasetFromExplorer = async (paths: string[]) => {
    try {
      const added = await runExplorerMutation('Add to Dataset', async () => addWorkspacePathsToDataset(paths));
      addNotification(added ? 'success' : 'info', added ? `Added ${added} file${added !== 1 ? 's' : ''} to Dataset` : 'Files are already in Dataset');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Could not add files to Dataset');
    }
  };


  return {
    addToDatasetFromExplorer, cancelInlineExplorerEdit, commitInlineExplorerEdit, explorerClipboard, handleExplorerDelete, deleteExplorerEntries,
    handleExplorerDrop, handleExplorerDuplicate, handleExplorerImport, handleExplorerNewFolder, handleExplorerPaste,
    handleExplorerRename, importExternalFilesIntoExplorer, indexProjectWorkspaceAssets, inlineExplorerEdit,
    runExplorerMutation, setExplorerClipboard, setInlineExplorerEdit,
  };
}
