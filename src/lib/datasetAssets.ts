import { filterLegacyProjectAssetPaths } from '../services/project/projectPathFilters';
import { createWorkspaceFileAssetId, type WorkspaceImage } from './workspaceImages';

export type ExplorerPathMove = { from: string; to: string };

export const createDatasetImageAssetKey = (assetId: string): string => `image:${assetId}`;
export const createDatasetFileAssetKey = (assetPath: string): string => `file:${assetPath}`;

export const getWorkspaceDatasetAssetKey = (item: WorkspaceImage): string | null => {
  if ((item.kind === 'image' || item.kind === 'synthetic') && item.sourceImageId) {
    return createDatasetImageAssetKey(item.sourceImageId);
  }
  if ((item.kind === 'video' || item.kind === 'psd') && item.assetPath) {
    return createDatasetFileAssetKey(item.assetPath);
  }
  return null;
};

export const getDatasetAssetOrderKeys = (
  assetIds: string[] = [],
  assetPaths: string[] = []
): string[] => [
  ...[...new Set(assetIds)].map(createDatasetImageAssetKey),
  ...filterLegacyProjectAssetPaths([...new Set(assetPaths)]).map(createDatasetFileAssetKey),
];

export const normalizeDatasetAssetOrder = (
  assetOrder: string[] | undefined,
  assetIds: string[] = [],
  assetPaths: string[] = []
): string[] => {
  const allowedKeys = getDatasetAssetOrderKeys(assetIds, assetPaths);
  const allowedKeySet = new Set(allowedKeys);
  const orderedKeys = [...new Set(assetOrder ?? [])].filter((key) => allowedKeySet.has(key));
  const orderedKeySet = new Set(orderedKeys);
  return [...orderedKeys, ...allowedKeys.filter((key) => !orderedKeySet.has(key))];
};

export const orderWorkspaceItemsByDatasetOrder = (
  items: WorkspaceImage[],
  assetOrder: string[] | undefined,
  assetIds: string[] = []
): WorkspaceImage[] => {
  const assetPaths = items
    .map((item) => item.assetPath)
    .filter((path): path is string => Boolean(path));
  const orderedKeys = normalizeDatasetAssetOrder(assetOrder, assetIds, assetPaths);
  const itemsByKey = new Map<string, WorkspaceImage[]>();
  const unorderedItems: WorkspaceImage[] = [];

  for (const item of items) {
    const key = getWorkspaceDatasetAssetKey(item);
    if (!key) {
      unorderedItems.push(item);
      continue;
    }

    itemsByKey.set(key, [...(itemsByKey.get(key) ?? []), item]);
  }

  const orderedItems = orderedKeys.flatMap((key) => itemsByKey.get(key) ?? []);
  const orderedItemIds = new Set(orderedItems.map((item) => item.id));
  const unorderedItemIds = new Set(unorderedItems.map((item) => item.id));
  return [
    ...orderedItems,
    ...unorderedItems,
    ...items.filter((item) => !orderedItemIds.has(item.id) && !unorderedItemIds.has(item.id)),
  ];
};

export const applyExplorerPathMoves = (path: string, moves: ExplorerPathMove[]): string => {
  for (const move of moves) {
    if (path === move.from || path.startsWith(`${move.from}/`)) {
      return path === move.from ? move.to : `${move.to}/${path.slice(move.from.length + 1)}`;
    }
  }
  return path;
};

export const applyFileAssetOrderPathMoves = (
  assetOrder: string[] = [],
  moves: ExplorerPathMove[]
): string[] =>
  assetOrder.map((key) => {
    if (!key.startsWith('file:')) {
      return key;
    }
    return createDatasetFileAssetKey(applyExplorerPathMoves(key.slice('file:'.length), moves));
  });

export const applyCaptionOverridePathMoves = (
  captionOverrides: Record<string, string[]> = {},
  moves: ExplorerPathMove[]
): Record<string, string[]> => {
  const nextOverrides: Record<string, string[]> = {};

  Object.entries(captionOverrides).forEach(([key, tags]) => {
    if (!key.startsWith('asset:')) {
      nextOverrides[key] = tags;
      return;
    }

    const path = key.slice('asset:'.length);
    const nextPath = applyExplorerPathMoves(path, moves);
    nextOverrides[createWorkspaceFileAssetId(nextPath)] = tags;
  });

  return nextOverrides;
};
