import type { WorkspaceImage } from '../../lib/workspaceImages';

export type ResolvedCaption = {
  text: string;
  tags: string[];
  normalized: string;
  source: 'override' | 'metadata' | 'text' | 'missing';
};
export type LegacyCaptionDataset = { overwriteCaptions?: boolean; captionOverrides?: Record<string, string[]>; triggerWord?: string };

const normalizeWhitespace = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

export const normalizeCaptionForAnalysis = (value: string, triggerWord = ''): string => {
  const trigger = normalizeWhitespace(triggerWord).toLocaleLowerCase();
  return value.normalize('NFKC')
    .split(/[\n,]+/u)
    .map((part) => normalizeWhitespace(part).toLocaleLowerCase())
    .filter((part) => part && part !== trigger && !/^(tags?|caption|prompt)\s*:/iu.test(part))
    .join(', ');
};

export const captionKeysForItem = (item: Pick<WorkspaceImage, 'id' | 'sourceImageId' | 'assetPath'>): string[] => [
  item.id,
  item.sourceImageId ? `source:${item.sourceImageId}` : '',
  item.assetPath ? `asset:${item.assetPath}` : '',
].filter(Boolean);

export const resolveAssetCaption = (
  item: Pick<WorkspaceImage, 'id' | 'sourceImageId' | 'assetPath' | 'tags'>,
  triggerWord = '',
  fallbackText?: string
): ResolvedCaption => {
  if (item.tags !== undefined) {
    const tags = item.tags;
    const text = tags.join(', ');
    return { text, tags, normalized: normalizeCaptionForAnalysis(text, triggerWord), source: 'metadata' };
  }
  const text = fallbackText?.trim() ?? '';
  return { text, tags: text ? [text] : [], normalized: normalizeCaptionForAnalysis(text, triggerWord), source: text ? 'text' : 'missing' };
};

/** Read-only compatibility for migrating the retired Dataset override model. */
export const resolveLegacyDatasetCaption = (
  dataset: LegacyCaptionDataset,
  item: Pick<WorkspaceImage, 'id' | 'sourceImageId' | 'assetPath' | 'tags'>,
  fallbackText?: string
): ResolvedCaption => {
  if (dataset.overwriteCaptions) {
    for (const key of captionKeysForItem(item)) {
      if (Object.prototype.hasOwnProperty.call(dataset.captionOverrides ?? {}, key)) {
        const tags = dataset.captionOverrides?.[key] ?? [];
        const text = tags.join(', ');
        return { text, tags, normalized: normalizeCaptionForAnalysis(text, dataset.triggerWord ?? ''), source: 'override' };
      }
    }
  }
  return resolveAssetCaption(item, dataset.triggerWord ?? '', fallbackText);
};

/** @deprecated Use resolveAssetCaption. Kept temporarily for legacy loaders. */
export const resolveDatasetCaption = resolveLegacyDatasetCaption;
