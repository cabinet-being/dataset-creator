import { describeImageStatus, buildKeptDuplicateCounts, matchesBoardFilter, type BoardFilter, type StatusLabel } from '../../lib/imageStatusLabels';
import { getWorkspaceDisplayName, type WorkspaceImage } from '../../lib/workspaceImages';
import { getBuildAssetId, getBuildRecordForItem, getImageStatus, type ImageStatus } from '../../services/build/buildSessionService';
import type { BuildReviewRecord, BuildSession } from '../../types';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import type { TileGroup } from './VirtualTileGrid';

/** One frame of the Board with its status, computed once. */
export type FrameEntry = {
  /** Workspace image id (also the preview key). */
  id: string;
  assetId: string;
  item: WorkspaceImage;
  name: string;
  /** Project-relative folder, for example `inbox/day1` or `dataset`. */
  folder: string;
  status: ImageStatus;
  record?: BuildReviewRecord;
  label: StatusLabel;
};

export const UNSORTED_FOLDER = 'Unsorted';
export const folderOfImage = (item: WorkspaceImage): string =>
  (item.assetPath ?? '').replace(/^Project\//, '').split('/').slice(0, -1).join('/') || UNSORTED_FOLDER;

const naturalCompare = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Status of every Build candidate (videos excluded: they need frames first), in group order: `dataset` first,
 * then folders by name; inside a folder the session order. `effectiveItems` resolves transformed outputs.
 */
export const buildFrameEntries = (candidates: readonly WorkspaceImage[], effectiveItems: readonly WorkspaceImage[], session: BuildSession): FrameEntry[] => {
  const byAssetId = new Map(effectiveItems.map(item => [getBuildAssetId(item), item]));
  const kept = buildKeptDuplicateCounts(session.records);
  const position = new Map(session.order.map((id, index) => [id, index]));
  const nameOf = (assetId: string) => { const item = byAssetId.get(assetId); return item ? getWorkspaceDisplayName(item) : undefined; };
  const entries = candidates.filter(item => item.kind !== 'video').map<FrameEntry>(item => {
    const assetId = getBuildAssetId(item);
    const record = getBuildRecordForItem(session, item);
    const status = getImageStatus(record, item, record?.outputAssetId ? byAssetId.get(record.outputAssetId) : undefined);
    return { id: item.id, assetId, item, name: getWorkspaceDisplayName(item), folder: folderOfImage(item), status, record,
      label: describeImageStatus(status, { record, keptDuplicates: kept.get(assetId), nameOf }) };
  });
  const groupRank = (folder: string) => folder === 'dataset' || folder.startsWith('dataset/') ? 0 : 1;
  // Session position first (same as the Build queue); frames without a position follow in natural name order.
  const rank = (entry: FrameEntry) => position.get(entry.assetId) ?? Number.MAX_SAFE_INTEGER;
  return entries.sort((left, right) => groupRank(left.folder) - groupRank(right.folder) || naturalCompare(left.folder, right.folder)
    || rank(left) - rank(right) || naturalCompare(left.name, right.name));
};

export const countBoardFilters = (entries: readonly FrameEntry[]): Record<BoardFilter, number> => {
  const counts: Record<BoardFilter, number> = { all: 0, in: 0, out: 0, pinned: 0, banned: 0 };
  for (const entry of entries) for (const filter of Object.keys(counts) as BoardFilter[]) if (matchesBoardFilter(filter, entry.status, entry.record)) counts[filter] += 1;
  return counts;
};

/** Groups entries (already in group order) by folder. */
export const groupFrameEntries = (entries: readonly FrameEntry[]): TileGroup<FrameEntry>[] => {
  const groups: TileGroup<FrameEntry>[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last?.key === entry.folder) last.items.push(entry); else groups.push({ key: entry.folder, label: entry.folder, items: [entry] });
  }
  return groups;
};

export type CursorMove = 'left' | 'right' | 'up' | 'down' | 'home' | 'end';

/** Id of the entry the cursor moves to; up/down move by rows of `columns` tiles and cross group boundaries. */
export const moveFrameCursor = (groups: readonly TileGroup<FrameEntry>[], currentId: string | null, move: CursorMove, columns: number): string | null => {
  const flat = groups.flatMap(group => group.items);
  if (!flat.length) return null;
  if (move === 'home') return flat[0].id;
  if (move === 'end') return flat[flat.length - 1].id;
  const groupIndex = groups.findIndex(group => group.items.some(entry => entry.id === currentId));
  if (groupIndex < 0) return flat[0].id;
  const group = groups[groupIndex];
  const index = group.items.findIndex(entry => entry.id === currentId);
  if (move === 'left' || move === 'right') {
    const next = flat.findIndex(entry => entry.id === currentId) + (move === 'left' ? -1 : 1);
    return flat[Math.min(flat.length - 1, Math.max(0, next))].id;
  }
  const column = index % columns;
  if (move === 'down') {
    if (index + columns < group.items.length) return group.items[index + columns].id;
    // A shorter last row has nothing directly below: go to its last tile; at the end of a group continue in the next one.
    if (Math.floor(index / columns) < Math.floor((group.items.length - 1) / columns)) return group.items[group.items.length - 1].id;
    const next = groups[groupIndex + 1];
    return next ? next.items[Math.min(column, next.items.length - 1)].id : currentId;
  }
  if (index - columns >= 0) return group.items[index - columns].id;
  const previous = groups[groupIndex - 1];
  if (!previous) return currentId;
  const lastRowStart = Math.floor((previous.items.length - 1) / columns) * columns;
  return previous.items[Math.min(lastRowStart + column, previous.items.length - 1)].id;
};

/** Frame files that live in `dataset/` (membership is the physical path). */
export const isDatasetEntry = (entry: FrameEntry): boolean => isProjectDatasetPath(entry.item.assetPath);

/**
 * What the P and B keys do for `entries`: setting the override, or removing it when every entry already has it
 * (so pressing the key again undoes the last choice).
 */
export const overrideKeyAction = (entries: readonly FrameEntry[], key: 'pin' | 'ban'): 'pin' | 'ban' | 'clear' =>
  entries.length > 0 && entries.every(entry => entry.record?.override === key) ? 'clear' : key;
