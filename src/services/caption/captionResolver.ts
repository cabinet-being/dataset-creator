import type { Dataset } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';

export type ResolvedCaption = {
  text: string;
  tags: string[];
  normalized: string;
  source: 'override' | 'metadata' | 'text' | 'missing';
};

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

export const resolveDatasetCaption = (
  dataset: Pick<Dataset, 'overwriteCaptions' | 'captionOverrides' | 'triggerWord'>,
  item: Pick<WorkspaceImage, 'id' | 'sourceImageId' | 'assetPath' | 'tags'>,
  fallbackText?: string
): ResolvedCaption => {
  if (dataset.overwriteCaptions) {
    for (const key of captionKeysForItem(item)) {
      if (Object.prototype.hasOwnProperty.call(dataset.captionOverrides ?? {}, key)) {
        const tags = dataset.captionOverrides[key] ?? [];
        const text = tags.join(', ');
        return { text, tags, normalized: normalizeCaptionForAnalysis(text, dataset.triggerWord), source: 'override' };
      }
    }
  }
  const tags = item.tags ?? [];
  if (tags.length) {
    const text = tags.join(', ');
    return { text, tags, normalized: normalizeCaptionForAnalysis(text, dataset.triggerWord), source: 'metadata' };
  }
  const text = fallbackText?.trim() ?? '';
  return { text, tags: text ? [text] : [], normalized: normalizeCaptionForAnalysis(text, dataset.triggerWord), source: text ? 'text' : 'missing' };
};
