import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { Dataset } from '../../types';
import { isProjectDatasetPath } from './datasetFolderService';

export const normalizeDatasetPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^Project\//i, '');

export type DatasetMembershipResolution = {
  members: WorkspaceImage[];
  effective: WorkspaceImage[];
  missingAssetIds: string[];
  missingAssetPaths: string[];
  inactive: WorkspaceImage[];
};

export const isEffectiveDatasetImage = (item: WorkspaceImage): boolean =>
  item.kind !== 'video' && Boolean(item.imageData);

export const resolveDatasetMembership = (
  _dataset: Dataset,
  items: WorkspaceImage[]
): DatasetMembershipResolution => {
  const members = items.filter((item) => isProjectDatasetPath(item.assetPath));
  const effective = members.filter(isEffectiveDatasetImage);
  return {
    members,
    effective,
    inactive: members.filter((item) => !isEffectiveDatasetImage(item)),
    missingAssetIds: [],
    missingAssetPaths: [],
  };
};
