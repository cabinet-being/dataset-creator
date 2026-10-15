import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { Dataset } from '../../types';
import { filterLegacyProjectAssetPaths } from '../project/projectPathFilters';

export const normalizeDatasetPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^Project\//i, '');

export type DatasetMembershipResolution = {
  members: WorkspaceImage[];
  effective: WorkspaceImage[];
  missingAssetIds: string[];
  missingAssetPaths: string[];
  inactive: WorkspaceImage[];
};

export const isEffectiveDatasetImage = (item: WorkspaceImage): boolean =>
  !item.deleted && !item.hidden && !item.excludedFromDataset && item.kind !== 'video' && Boolean(item.imageData);

export const resolveDatasetMembership = (
  dataset: Pick<Dataset, 'assetIds' | 'assetPaths' | 'psdAssetPaths'>,
  items: WorkspaceImage[]
): DatasetMembershipResolution => {
  const ids = new Set(dataset.assetIds.filter(Boolean));
  const requestedPaths = filterLegacyProjectAssetPaths([...dataset.assetPaths, ...(dataset.psdAssetPaths ?? [])]);
  const paths = new Set(requestedPaths.map(normalizeDatasetPath));
  const members = items.filter((item) => ids.has(item.sourceImageId) || Boolean(item.assetPath && paths.has(normalizeDatasetPath(item.assetPath))));
  const presentIds = new Set(members.map((item) => item.sourceImageId).filter(Boolean));
  const presentPaths = new Set(members.flatMap((item) => item.assetPath ? [normalizeDatasetPath(item.assetPath)] : []));
  const effective = members.filter(isEffectiveDatasetImage);
  return {
    members,
    effective,
    inactive: members.filter((item) => !isEffectiveDatasetImage(item)),
    missingAssetIds: [...ids].filter((id) => !presentIds.has(id)),
    missingAssetPaths: requestedPaths.filter((path) => !presentPaths.has(normalizeDatasetPath(path))),
  };
};

