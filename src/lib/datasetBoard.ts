import type { Dataset } from '../types';
import type { WorkspaceImage } from './workspaceImages';

export type DatasetBoardSortMode = 'name' | 'type' | 'captioned' | 'aspect';
export const DATASET_BOARD_SORT_OPTIONS: Array<{ value: DatasetBoardSortMode; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'captioned', label: 'Captioned' },
  { value: 'aspect', label: 'Aspect ratio' },
];

/** Sort the Dataset's asset-owned captions without projecting Dataset-local state. */
export function datasetBoardItems(items: WorkspaceImage[], _dataset: Dataset, sort: DatasetBoardSortMode): WorkspaceImage[] {
  const projected = [...items];
  const byName = (left: WorkspaceImage, right: WorkspaceImage) =>
    (left.originalFileName ?? left.fileName).localeCompare(right.originalFileName ?? right.fileName, undefined, { numeric: true, sensitivity: 'base' });
  return projected.sort((left, right) => {
    if (sort === 'type') return left.kind.localeCompare(right.kind) || byName(left, right);
    if (sort === 'captioned') return (right.tags?.length ?? 0) - (left.tags?.length ?? 0) || byName(left, right);
    if (sort === 'aspect') return left.width / Math.max(1, left.height) - right.width / Math.max(1, right.height) || byName(left, right);
    return byName(left, right);
  });
}
