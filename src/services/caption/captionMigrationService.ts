import { createWorkspaceFileAssetId, normalizeWorkspaceAssetPath } from '../../lib/workspaceImages';
import type { Dataset, EditedAsset, SourceImage } from '../../types';
import { captionKeyGroupsForItem, resolveLegacyDatasetCaption, type LegacyCaptionDataset } from './captionResolver';

export const CAPTION_MIGRATION_VERSION = 1;
export type CaptionMigrationReport = {
  version: typeof CAPTION_MIGRATION_VERSION;
  status: 'complete' | 'pending';
  overwriteEnabled: boolean;
  legacyOverrides: Record<string, string[]>;
  assetSnapshots: Record<string, string[] | null>;
  applied: string[];
  unresolved: string[];
  unavailable: string[];
  conflicts: Array<{ asset: string; keys: string[] }>;
};
export type PathCaptionAsset = { path: string; tags?: string[]; available?: boolean };

const distinct = (values: string[][]) => new Set(values.map((tags) => JSON.stringify(tags))).size;

export function migrateLegacyCaptions(options: {
  legacy: LegacyCaptionDataset;
  dataset: Pick<Dataset, 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'triggerWord'>;
  sourceImages: Record<string, SourceImage>;
  datasetItems: Record<string, EditedAsset>;
  pathAssets?: PathCaptionAsset[];
}): { sourceImages: Record<string, SourceImage>; datasetItems: Record<string, EditedAsset>; pathCaptions: Record<string, string[] | undefined>; report: CaptionMigrationReport } {
  const overrides = options.legacy.captionOverrides ?? {};
  const consumed = new Set<string>();
  const applied: string[] = [];
  const assetSnapshots: Record<string, string[] | null> = {};
  const conflicts: CaptionMigrationReport['conflicts'] = [];
  const sources = { ...options.sourceImages };
  const edited = { ...options.datasetItems };
  const pathCaptions: Record<string, string[] | undefined> = {};
  const apply = (asset: string, item: { id: string; sourceImageId: string; assetPath?: string; tags?: string[] }, update: (tags: string[]) => void) => {
    const keys = captionKeyGroupsForItem(item)
      .map((group) => group.filter((key) => Object.prototype.hasOwnProperty.call(overrides, key)))
      .find((group) => group.length > 0) ?? [];
    if (distinct(keys.map((key) => overrides[key] ?? [])) > 1) {
      conflicts.push({ asset, keys });
      return;
    }
    keys.forEach((key) => consumed.add(key));
    if (!options.legacy.overwriteCaptions || !keys.length) return;
    const tags = resolveLegacyDatasetCaption({ ...options.legacy, triggerWord: options.dataset.triggerWord }, item).tags;
    assetSnapshots[asset] = item.tags ? [...item.tags] : null;
    update([...tags]); applied.push(asset);
  };
  for (const id of options.dataset.assetIds) {
    const source = sources[id];
    if (source) apply(`source:${id}`, { id: `source:${id}`, sourceImageId: id, assetPath: source.originalFilePath, tags: source.tags }, (tags) => { sources[id] = { ...source, tags }; });
    for (const item of Object.values(edited).filter((candidate) => candidate.sourceImageId === id && !candidate.deleted)) {
      apply(`edited:${item.id}`, { id: `edited:${item.id}`, sourceImageId: id, assetPath: item.imageDataPath, tags: item.tags }, (tags) => { edited[item.id] = { ...item, tags }; });
    }
  }
  const pathAssets = new Map((options.pathAssets ?? []).map((asset) => [normalizeWorkspaceAssetPath(asset.path), asset]));
  for (const path of [...options.dataset.assetPaths, ...options.dataset.psdAssetPaths]) {
    const normalized = normalizeWorkspaceAssetPath(path);
    const asset = pathAssets.get(normalized);
    const item = { id: createWorkspaceFileAssetId(normalized), sourceImageId: '', assetPath: normalized, tags: asset?.tags };
    if (asset?.available === false) continue;
    apply(`asset:${normalized}`, item, (tags) => { pathCaptions[normalized] = tags; });
  }
  const unresolved = Object.keys(overrides).filter((key) => !consumed.has(key));
  const unavailablePaths = options.legacy.overwriteCaptions
    ? (options.pathAssets ?? []).filter((asset) => asset.available === false).map((asset) => normalizeWorkspaceAssetPath(asset.path))
    : [];
  return {
    sourceImages: sources,
    datasetItems: edited,
    pathCaptions,
    report: {
      version: CAPTION_MIGRATION_VERSION,
      status: unresolved.length || unavailablePaths.length ? 'pending' : 'complete',
      overwriteEnabled: options.legacy.overwriteCaptions === true,
      legacyOverrides: structuredClone(overrides),
      assetSnapshots,
      applied,
      unresolved,
      unavailable: [...new Set(unavailablePaths)],
      conflicts,
    },
  };
}
