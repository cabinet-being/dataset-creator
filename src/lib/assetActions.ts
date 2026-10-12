import type { WorkspaceImage } from './workspaceImages';
import { useProjectStore } from '../stores/useProjectStore';
import { useHistoryStore } from '../stores/useHistoryStore';
import { createDatasetFileAssetKey, createDatasetImageAssetKey, normalizeDatasetAssetOrder } from './datasetAssets';
import { filterLegacyProjectAssetPaths } from '../services/project/projectPathFilters';

export function addAssetsToDataset(items: WorkspaceImage[]) {
  addDatasetReferences({
    assetIds: items.filter(item => item.kind === 'image' || item.kind === 'edited').map(item => item.sourceImageId),
    assetPaths: items.filter(item => item.kind !== 'image' && item.kind !== 'edited').flatMap(item => item.assetPath ? [item.assetPath] : []),
  });
}

/** Explorer uses the same membership action as the gallery, retaining original files. */
export function addWorkspacePathsToDataset(paths: string[]): number {
  const sources = Object.values(useProjectStore.getState().sourceImages);
  const assetIds: string[] = [];
  const assetPaths: string[] = [];
  for (const path of new Set(paths)) {
    const relative = path.replace(/^Project\//, '');
    const source = sources.find(item => item.originalFilePath?.replace(/^Project\//, '') === relative);
    if (source) assetIds.push(source.id);
    else assetPaths.push(path);
  }
  return addDatasetReferences({assetIds,assetPaths});
}

/** All intake paths share one membership change and one undo entry. */
export function addDatasetReferences(references: { assetIds?: string[]; assetPaths?: string[] }): number {
  const store = useProjectStore.getState(); const before = store.dataset;
  const previousPaths = filterLegacyProjectAssetPaths([...new Set([...before.assetPaths, ...before.psdAssetPaths])]);
  const assetIds = [...new Set([...before.assetIds, ...(references.assetIds ?? []).filter(Boolean)])];
  const assetPaths = filterLegacyProjectAssetPaths([...new Set([...previousPaths, ...(references.assetPaths ?? []).filter(Boolean)])]);
  const addedCount = assetIds.length - before.assetIds.length + assetPaths.length - previousPaths.length;
  if (!addedCount) return 0;
  const next = { assetIds, assetPaths, psdAssetPaths: assetPaths.filter(path => /\.psd$/i.test(path)), assetOrder: normalizeDatasetAssetOrder([...(before.assetOrder ?? []), ...assetIds.map(createDatasetImageAssetKey), ...assetPaths.map(createDatasetFileAssetKey)], assetIds, assetPaths) };
  const redo = () => store.updateDataset(before.id, next);
  const undo = () => store.updateDataset(before.id, { assetIds: before.assetIds, assetPaths: before.assetPaths, psdAssetPaths: before.psdAssetPaths, assetOrder: before.assetOrder });
  redo(); useHistoryStore.getState().push({ label: 'Add to Dataset', redo, undo });
  return addedCount;
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

export function removeAssetsFromDataset(items: WorkspaceImage[]) {
  const store = useProjectStore.getState(); const before = store.dataset;
  const ids = new Set(items.filter(item => item.kind === 'image' || item.kind === 'edited').map(item => item.sourceImageId));
  const paths = new Set(items.flatMap(item => item.assetPath ? [item.assetPath] : []));
  const assetIds = before.assetIds.filter(id => !ids.has(id));
  const assetPaths = before.assetPaths.filter(path => !paths.has(path));
  if (assetIds.length === before.assetIds.length && assetPaths.length === before.assetPaths.length) return;
  const next = { assetIds, assetPaths, psdAssetPaths: (before.psdAssetPaths ?? []).filter(path => !paths.has(path)), assetOrder: normalizeDatasetAssetOrder(before.assetOrder, assetIds, assetPaths) };
  const redo = () => store.updateDataset(before.id, next);
  const undo = () => store.updateDataset(before.id, { assetIds: before.assetIds, assetPaths: before.assetPaths, psdAssetPaths: before.psdAssetPaths, assetOrder: before.assetOrder });
  redo(); useHistoryStore.getState().push({ label: 'Remove from Dataset', redo, undo });
}
