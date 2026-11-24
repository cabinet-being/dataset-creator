import type { BuildSession } from '../types';
import type { WorkspaceImage } from './workspaceImages';
import { getBuildAssetId } from '../services/build/buildSessionService';
import { isProjectDatasetPath } from '../services/dataset/datasetFolderService';
import { toWorkspaceImages } from './workspaceImages';

/** Registered (project-state) images merged over the images the workspace passes in. */
export const mergeBuildItems = (
  items: readonly WorkspaceImage[],
  sourceImages: Parameters<typeof toWorkspaceImages>[0],
  datasetItems: Parameters<typeof toWorkspaceImages>[1],
): WorkspaceImage[] => {
  const registered = toWorkspaceImages(sourceImages, datasetItems);
  const byId = new Map(registered.map((item) => [getBuildAssetId(item), item]));
  // Linear: large projects (thousands of files) recompute this on every relevant store change.
  const itemIds = new Set(items.map(getBuildAssetId));
  return [...items.map((item) => item.sourceImageId ? byId.get(getBuildAssetId(item)) ?? item : item),
    ...registered.filter((item) => !itemIds.has(getBuildAssetId(item)))];
};

/** Source materials Build chooses from: everything except Build's own transformed outputs. */
export const selectBuildCandidates = (effectiveItems: readonly WorkspaceImage[], session: BuildSession): WorkspaceImage[] => {
  const outputIds = new Set(Object.values(session.records).flatMap((record) => record.outputAssetId ? [record.outputAssetId] : []));
  return effectiveItems.filter((item) => !outputIds.has(getBuildAssetId(item)) &&
    !(item.kind === 'edited' && item.editedAssetType === 'crop' && item.editedAssetId?.startsWith('build-')));
};

export const selectBuildDatasetItems = (items: readonly WorkspaceImage[]): WorkspaceImage[] =>
  items.filter((item) => item.kind !== 'video' && isProjectDatasetPath(item.assetPath));
