import type { WorkspaceImage } from './workspaceImages';
import { normalizeWorkspaceAssetPath, toWorkspaceImages } from './workspaceImages';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';
import { useHistoryStore } from '../stores/useHistoryStore';
import { runProjectFileOperation } from '../hooks/useProjectSave';
import { readExplorerFile, getExplorerFileKind } from '../services/project/explorerFileService';
import { addItemsToDatasetFolder, removeItemsFromDatasetFolder, reverseDatasetFolderChanges, type DatasetFolderOperationResult } from '../services/dataset/datasetFolderService';

const requireDirectory = () => {
  const directory = useUIStore.getState().projectDirectoryHandle;
  if (!directory) throw new Error('Open a project directory before changing Dataset files.');
  return directory;
};

const pushMoveHistory = (label: string, result: DatasetFolderOperationResult) => {
  if (!result.completed.length) return;
  const directory = requireDirectory();
  let current = result.completed;
  useHistoryStore.getState().push({ label,
    undo: async () => { current = await runProjectFileOperation(() => reverseDatasetFolderChanges(directory, current)); },
    redo: async () => { current = await runProjectFileOperation(() => reverseDatasetFolderChanges(directory, current)); },
  });
};

const addItemsToDataset = async (items: WorkspaceImage[]): Promise<number> => {
  const result = await addItemsToDatasetFolder(requireDirectory(), items);
  pushMoveHistory('Add to Dataset', result);
  if (result.failed.length) throw new Error(result.failed[0].message);
  return result.completed.length;
};

export async function addAssetsToDataset(items: WorkspaceImage[]): Promise<void> { await addItemsToDataset(items); }

const resolvePathItems = async (paths: string[]): Promise<WorkspaceImage[]> => {
  const store = useProjectStore.getState();
  const registered = toWorkspaceImages(Object.values(store.sourceImages), Object.values(store.datasetItems));
  const byPath = new Map(registered.flatMap(item => item.assetPath ? [[normalizeWorkspaceAssetPath(item.assetPath), item] as const] : []));
  const items: WorkspaceImage[] = [];
  for (const path of [...new Set(paths.map(normalizeWorkspaceAssetPath))]) {
    const registeredItem = byPath.get(path);
    if (registeredItem) { items.push(registeredItem); continue; }
    const file = await readExplorerFile(requireDirectory(), path);
    const kind = getExplorerFileKind(file.name, file.type);
    if (kind !== 'image' && kind !== 'psd') continue;
    items.push({ id:`asset:${path}`, sourceImageId:'', kind, label:kind === 'psd' ? 'PSD' : 'Image', displayIdentity:path,
      fileName:file.name, assetPath:path, imageData:file, psdData:kind === 'psd' ? file : undefined,
      width:1, height:1, aspectRatio:'1:1' });
  }
  return items;
};

export async function addWorkspacePathsToDataset(paths: string[]): Promise<number> {
  return addItemsToDataset(await resolvePathItems(paths));
}

export async function addDatasetReferences(references: { assetIds?: string[]; assetPaths?: string[] }): Promise<number> {
  const store = useProjectStore.getState();
  const ids = new Set((references.assetIds ?? []).filter(Boolean));
  const items = toWorkspaceImages(Object.values(store.sourceImages), Object.values(store.datasetItems))
    .filter(item => ids.has(item.kind === 'edited' ? item.editedAssetId ?? '' : item.sourceImageId));
  return addItemsToDataset([...items, ...await resolvePathItems(references.assetPaths ?? [])]);
}

export function setAssetsExcluded(items: WorkspaceImage[], excluded: boolean) {
  const store = useProjectStore.getState();
  const targets = items.filter(item => item.kind === 'image' || item.kind === 'edited');
  const apply = (restore: boolean) => { for (const item of targets) {
    const value = restore ? item.excludedFromDataset ?? false : excluded;
    if (item.kind === 'edited' && item.editedAssetId) store.updateDatasetItem(item.editedAssetId, { excludedFromDataset: value });
    else store.updateSourceImage(item.sourceImageId, { excludedFromDataset: value });
  } };
  apply(false); if (targets.length) useHistoryStore.getState().push({ label: excluded ? 'Exclude from export' : 'Include in export', undo: () => apply(true), redo: () => apply(false) });
}

export async function removeAssetsFromDataset(items: WorkspaceImage[]): Promise<void> {
  const result = await removeItemsFromDatasetFolder(requireDirectory(), items);
  pushMoveHistory('Remove from Dataset', result);
  if (result.failed.length) throw new Error(result.failed[0].message);
}
