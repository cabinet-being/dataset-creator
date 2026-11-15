import type { WorkspaceImage } from '../../lib/workspaceImages';
import { normalizeWorkspaceAssetPath } from '../../lib/workspaceImages';
import { applyProjectRelativePathMoves } from '../../lib/datasetAssets';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { indexProjectAssets } from '../project/assetIndexService';
import { moveAssetRegistryPaths } from '../project/assetRegistryService';
import {
  getDirectoryAtExplorerPath,
  getExplorerParentDirectory,
  getUniqueExplorerName,
  moveExplorerEntries,
  type ExplorerPathChange,
} from '../project/explorerFileService';
import { PROJECT_DATASET_DIRECTORY, PROJECT_INBOX_DIRECTORY } from '../project/projectLayoutService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { clearLegacyExclusionAtPath } from '../project/legacyDatasetExclusionService';
import { applyBuildSessionPathMoves } from '../build/buildSessionService';
import { getCaptionFileName, reconcileTriggerAfterMove, renderCaptionText } from '../caption/captionFileService';

export const DATASET_EXPLORER_PATH = `Project/${PROJECT_DATASET_DIRECTORY}`;

export const normalizeDatasetFolderPath = (path: string): string => path
  .replace(/\\/g, '/')
  .replace(/^\.?\//, '')
  .replace(/^Project\//, '');

export const isProjectDatasetPath = (path: string | undefined): boolean => {
  if (!path) return false;
  const normalized = normalizeDatasetFolderPath(path);
  return normalized === PROJECT_DATASET_DIRECTORY || normalized.startsWith(`${PROJECT_DATASET_DIRECTORY}/`);
};

export type DatasetFolderOperationResult = {
  operationId: string;
  completed: ExplorerPathChange[];
  unchanged: string[];
  failed: Array<{ path: string; message: string }>;
};

const updateRegisteredPaths = async (root: ProjectDirectoryHandle, moves: ExplorerPathChange[]) => {
  const store = useProjectStore.getState();
  for (const source of Object.values(store.sourceImages)) {
    const originalFilePath = applyProjectRelativePathMoves(source.originalFilePath, moves);
    if (originalFilePath !== source.originalFilePath) {
      store.updateSourceImage(source.id, {
        originalFilePath,
        fileName: originalFilePath?.split('/').pop() ?? source.fileName,
        // Crossing dataset/ adds or removes the trigger word in the TXT, so an old "trigger missing" mark is stale.
        ...(isProjectDatasetPath(source.originalFilePath) !== isProjectDatasetPath(originalFilePath) ? { captionTriggerMissing: undefined } : {}),
      });
    }
  }
  for (const item of Object.values(store.datasetItems)) {
    const imageDataPath = applyProjectRelativePathMoves(item.imageDataPath, moves);
    const psdDataPath = applyProjectRelativePathMoves(item.psdDataPath, moves);
    if (imageDataPath !== item.imageDataPath || psdDataPath !== item.psdDataPath) {
      store.updateDatasetItem(item.id, { imageDataPath, psdDataPath,
        ...(isProjectDatasetPath(item.imageDataPath) !== isProjectDatasetPath(imageDataPath) ? { captionTriggerMissing: undefined } : {}) });
    }
  }
  store.updateBuildSession((session) => applyBuildSessionPathMoves(session, moves));
  await moveAssetRegistryPaths(root, moves);
};

const notifyPathMoves = (moves: ExplorerPathChange[]) => {
  if (moves.length && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dataset-folder-paths-changed', { detail: moves }));
  }
};

const writeBlob = async (directory: ProjectDirectoryHandle, name: string, blob: Blob) => {
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try { await writable.write(blob); await writable.close(); }
  catch (error) { await writable.abort?.(); throw error; }
};

const pathExists = async (root: ProjectDirectoryHandle, path: string): Promise<boolean> => {
  try { const { directory, name } = await getExplorerParentDirectory(root, path); await directory.getFileHandle(name); return true; }
  catch { return false; }
};

const writeUnsavedItem = async (root: ProjectDirectoryHandle, item: WorkspaceImage, destinationPath: string): Promise<ExplorerPathChange> => {
  const directory = await getDirectoryAtExplorerPath(root, destinationPath);
  const targetName = await getUniqueExplorerName(directory, item.fileName);
  await writeBlob(directory, targetName, item.kind === 'psd' ? item.psdData ?? item.imageData : item.imageData);
  // tags: [] is an empty caption file, undefined is no file; the trigger word leads captions inside dataset/.
  const captionName = getCaptionFileName(targetName);
  if (item.tags !== undefined && captionName) {
    const trigger = isProjectDatasetPath(destinationPath) ? useProjectStore.getState().dataset.triggerWord.trim() : '';
    await writeBlob(directory, captionName, new Blob([renderCaptionText(item.tags, trigger || undefined)], { type: 'text/plain' }));
  }
  return { from: item.assetPath ?? `memory:${item.id}`, to: `${destinationPath}/${targetName}` };
};

const indexChanges = async (root: ProjectDirectoryHandle, changes: ExplorerPathChange[]) => {
  if (!changes.length) return;
  const store = useProjectStore.getState();
  await indexProjectAssets(root, {
    paths: changes.map(change => change.to),
    existingSourceImages: store.sourceImages,
    triggerWord: store.dataset.triggerWord,
    onAssetIndexed: ({ sourceImage }) => { if (sourceImage && !useProjectStore.getState().sourceImages[sourceImage.id]) useProjectStore.getState().addSourceImage(sourceImage); },
  });
};

const moveItems = async (
  root: ProjectDirectoryHandle,
  items: WorkspaceImage[],
  destinationPath: string
): Promise<DatasetFolderOperationResult> => {
  const result: DatasetFolderOperationResult = { operationId: crypto.randomUUID(), completed: [], unchanged: [], failed: [] };
  const projectId = useProjectStore.getState().id;
  const recordMove = async (change: ExplorerPathChange) => {
    if (useProjectStore.getState().id !== projectId || useUIStore.getState().projectDirectoryHandle !== root) throw new Error('The active project changed during the Dataset operation.');
    result.completed.push(change);
    // Same exclusive operation as the move: the caption gains or loses the trigger word as the file crosses dataset/.
    await reconcileTriggerAfterMove(root, change, useProjectStore.getState().dataset.triggerWord);
    await updateRegisteredPaths(root, [change]);
    await clearLegacyExclusionAtPath(root,change.to);
  };
  for (const item of items) {
    const sourcePath = item.assetPath ? normalizeWorkspaceAssetPath(item.assetPath) : undefined;
    if (sourcePath && (sourcePath === destinationPath || sourcePath.startsWith(`${destinationPath}/`))) {
      result.unchanged.push(sourcePath); continue;
    }
    try {
      if (sourcePath && await pathExists(root, sourcePath)) {
        await moveExplorerEntries(root, [{ path: sourcePath, name: sourcePath.split('/').pop()!, kind: 'file' }], destinationPath, recordMove);
      } else {
        await recordMove(await writeUnsavedItem(root, item, destinationPath));
      }
    } catch (error) {
      result.failed.push({ path: sourcePath ?? item.id, message: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  if (useProjectStore.getState().id === projectId && useUIStore.getState().projectDirectoryHandle === root) {
    try { await indexChanges(root, result.completed); }
    catch (error) { result.failed.push({path:destinationPath,message:error instanceof Error ? error.message : String(error)}); }
    finally { notifyPathMoves(result.completed); }
  }
  return result;
};

export const addItemsToDatasetFolder = async (root: ProjectDirectoryHandle, items: WorkspaceImage[]) =>
  moveItems(root, items, DATASET_EXPLORER_PATH);

export const removeItemsFromDatasetFolder = async (root: ProjectDirectoryHandle, items: WorkspaceImage[]) =>
  moveItems(root, items, `Project/${PROJECT_INBOX_DIRECTORY}`);

export const reverseDatasetFolderChanges = async (root: ProjectDirectoryHandle, changes: ExplorerPathChange[]) => {
  const completed: ExplorerPathChange[] = [];
  for (const change of [...changes].reverse()) {
    const sourcePath = change.to;
    const destination = change.from.split('/').slice(0, -1).join('/') || 'Project';
    const [reversed] = await moveExplorerEntries(root, [{ path:sourcePath, name:change.from.split('/').pop()!, kind:'file' }], destination);
    completed.push(reversed);
    await reconcileTriggerAfterMove(root, reversed, useProjectStore.getState().dataset.triggerWord);
    await updateRegisteredPaths(root, [reversed]);
  }
  await indexChanges(root, completed);
  notifyPathMoves(completed);
  return completed;
};
