import type { WorkspaceImage } from '../../lib/workspaceImages';
import { normalizeWorkspaceAssetPath } from '../../lib/workspaceImages';
import { applyProjectRelativePathMoves } from '../../lib/datasetAssets';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { indexProjectAssets } from '../project/assetIndexService';
import {
  getDirectoryAtExplorerPath,
  getExplorerParentDirectory,
  getUniqueExplorerName,
  moveExplorerEntries,
  type ExplorerPathChange,
} from '../project/explorerFileService';
import { PROJECT_DATASET_DIRECTORY, PROJECT_SHARED_DIRECTORY } from '../project/projectLayoutService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';

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

const updateRegisteredPaths = (moves: ExplorerPathChange[]) => {
  const store = useProjectStore.getState();
  for (const source of Object.values(store.sourceImages)) {
    const originalFilePath = applyProjectRelativePathMoves(source.originalFilePath, moves);
    const manifestPath = applyProjectRelativePathMoves(source.manifestPath, moves, true);
    if (originalFilePath !== source.originalFilePath || manifestPath !== source.manifestPath) {
      store.updateSourceImage(source.id, {
        originalFilePath,
        manifestPath,
        fileName: originalFilePath?.split('/').pop() ?? source.fileName,
      });
    }
  }
  for (const item of Object.values(store.datasetItems)) {
    const imageDataPath = applyProjectRelativePathMoves(item.imageDataPath, moves);
    const psdDataPath = applyProjectRelativePathMoves(item.psdDataPath, moves);
    const manifestPath = applyProjectRelativePathMoves(item.manifestPath, moves, true);
    if (imageDataPath !== item.imageDataPath || psdDataPath !== item.psdDataPath || manifestPath !== item.manifestPath) {
      store.updateDatasetItem(item.id, { imageDataPath, psdDataPath, manifestPath });
    }
  }
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
  if (item.tags?.length) await writeBlob(directory, targetName.replace(/\.[^.]+$/, '.txt'), new Blob([`${item.tags.join(', ')}\n`], { type: 'text/plain' }));
  return { from: item.assetPath ?? `memory:${item.id}`, to: `${destinationPath}/${targetName}` };
};

const indexChanges = async (root: ProjectDirectoryHandle, changes: ExplorerPathChange[]) => {
  if (!changes.length) return;
  const store = useProjectStore.getState();
  await indexProjectAssets(root, {
    paths: changes.map(change => change.to),
    existingSourceImages: store.sourceImages,
    onAssetIndexed: ({ sourceImage }) => { if (sourceImage && !useProjectStore.getState().sourceImages[sourceImage.id]) useProjectStore.getState().addSourceImage(sourceImage); },
  });
  useUIStore.getState().refreshAssetPreviews();
};

const moveItems = async (
  root: ProjectDirectoryHandle,
  items: WorkspaceImage[],
  destinationPath: string
): Promise<DatasetFolderOperationResult> => {
  const result: DatasetFolderOperationResult = { operationId: crypto.randomUUID(), completed: [], unchanged: [], failed: [] };
  const projectId = useProjectStore.getState().id;
  for (const item of items) {
    const sourcePath = item.assetPath ? normalizeWorkspaceAssetPath(item.assetPath) : undefined;
    if (sourcePath && (sourcePath === destinationPath || sourcePath.startsWith(`${destinationPath}/`))) {
      result.unchanged.push(sourcePath); continue;
    }
    try {
      let change: ExplorerPathChange;
      if (sourcePath && await pathExists(root, sourcePath)) {
        [change] = await moveExplorerEntries(root, [{ path: sourcePath, name: sourcePath.split('/').pop()!, kind: 'file' }], destinationPath);
      } else {
        change = await writeUnsavedItem(root, item, destinationPath);
      }
      if (useProjectStore.getState().id !== projectId || useUIStore.getState().projectDirectoryHandle !== root) throw new Error('The active project changed during the Dataset operation.');
      result.completed.push(change);
      updateRegisteredPaths([change]);
    } catch (error) {
      result.failed.push({ path: sourcePath ?? item.id, message: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  await indexChanges(root, result.completed);
  notifyPathMoves(result.completed);
  return result;
};

export const addItemsToDatasetFolder = async (root: ProjectDirectoryHandle, items: WorkspaceImage[]) =>
  moveItems(root, items, DATASET_EXPLORER_PATH);

export const removeItemsFromDatasetFolder = async (root: ProjectDirectoryHandle, items: WorkspaceImage[]) =>
  moveItems(root, items, `Project/${PROJECT_SHARED_DIRECTORY}`);

export const reverseDatasetFolderChanges = async (root: ProjectDirectoryHandle, changes: ExplorerPathChange[]) => {
  const completed: ExplorerPathChange[] = [];
  for (const change of [...changes].reverse()) {
    const sourcePath = change.to;
    const destination = change.from.split('/').slice(0, -1).join('/') || 'Project';
    const [reversed] = await moveExplorerEntries(root, [{ path:sourcePath, name:sourcePath.split('/').pop()!, kind:'file' }], destination);
    completed.push(reversed);
    updateRegisteredPaths([reversed]);
  }
  await indexChanges(root, completed);
  notifyPathMoves(completed);
  return completed;
};
