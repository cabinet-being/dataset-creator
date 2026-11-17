import { QUALITY_THRESHOLDS as T } from './thresholds';
import { captionText, countCaptionTokens, countFiles, hasCaption, normalizeTag, percent, plural, resolveItemTags } from './text';
import type { QualityItemInput, QualityMetric } from './types';
import type { TagPolicy } from '../../../lib/projectProfilePresets';
import { median } from './vectorMath';

export type TagFrequency = { tag: string; files: number; fraction: number };

/** Tag → number of files; the trigger word is excluded. */
export const countTagFrequencies = (items: readonly QualityItemInput[], triggerWord = ''): TagFrequency[] => {
  const trigger = normalizeTag(triggerWord);
  const counts = new Map<string, number>();
  for (const item of items) for (const tag of resolveItemTags(item)) if (tag !== trigger) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, files]) => ({ tag, files, fraction: items.length ? files / items.length : 0 }))
    .sort((left, right) => right.files - left.files || left.tag.localeCompare(right.tag));
};

export const measureCommonTags = (items: readonly QualityItemInput[], triggerWord = '', policy?: TagPolicy, traitTags: readonly string[] = []): QualityMetric => {
  const title = 'Tags in almost every file';
  if (items.length < 3) {
    return { id: 'common-tags', title, value: null, display: 'too few files', status: 'ok', evaluated: false, explanation: 'At least 3 files are required.' };
  }
  const traits = new Set(traitTags.map(normalizeTag));
  const common = countTagFrequencies(items, triggerWord).filter((entry) => entry.fraction >= T.tags.commonFraction && !traits.has(entry.tag));
  const mode = policy?.constantTags ?? 'review';
  const base = {
    id: 'common-tags', title, value: common.length,
    display: common.length ? common.slice(0, 5).map((entry) => entry.tag).join(', ') : 'none', evaluated: true,
  } as const;
  if (!common.length) return { ...base, status: 'ok', explanation: 'No tags repeat almost everywhere.' };
  const source = `${plural(common.length, 'tag')} appear in at least ${percent(T.tags.commonFraction)} of ${countFiles(items.length)} (≥ ${countFiles(Math.ceil(T.tags.commonFraction * items.length))}).`;
  const tags = common.map((entry) => entry.tag);
  if (mode === 'keep') {
    return { ...base, status: 'ok', explanation: `${source} For a style, keep such tags: the shared traits describe the style itself.` };
  }
  if (mode === 'prune') {
    return {
      ...base, status: 'warn',
      explanation: `${source} These are constant traits: if left in the captions, the model will not bind them to the trigger. Remove them from the captions.`,
      action: { kind: 'remove', label: 'Remove from captions', tags },
    };
  }
  return {
    ...base, status: 'warn',
    explanation: `${source} If this is a constant trait the LoRA should bind to the trigger, remove the tag from the captions; otherwise the tag distinguishes nothing.`,
    action: { kind: 'review', label: 'Review tags', tags },
  };
};

export const measureRareTags = (items: readonly QualityItemInput[], triggerWord = ''): QualityMetric => {
  const title = 'Single-use tags';
  if (items.length < T.tags.rareMinDataset) {
    return { id: 'rare-tags', title, value: null, display: 'too few files', status: 'ok', evaluated: false, explanation: `Evaluated from ${T.tags.rareMinDataset} files.` };
  }
  const all = countTagFrequencies(items, triggerWord);
  const rare = all.filter((entry) => entry.files <= T.tags.rareMaxFiles);
  const fraction = all.length ? rare.length / all.length : 0;
  return {
    id: 'rare-tags', title, value: fraction,
    display: `${rare.length} of ${plural(all.length, 'tag')}`,
    status: fraction > T.tags.rareWarnFraction ? 'warn' : 'ok', evaluated: true,
    explanation: rare.length
      ? `${percent(fraction)} of tags appear in only one file: the model will not have time to learn them. Unify synonyms or remove the noise.`
      : 'No single-use tags.',
    action: rare.length ? { kind: 'review', label: 'Unify or remove', tags: rare.slice(0, 40).map((entry) => entry.tag) } : undefined,
  };
};

export const measureCaptionLength = (items: readonly QualityItemInput[]): QualityMetric => {
  const title = 'Caption length';
  const captioned = items.filter(hasCaption).map((item) => ({ id: item.id, tokens: countCaptionTokens(captionText(item)) }));
  if (!captioned.length) {
    return { id: 'caption-length', title, value: null, display: 'no captions', status: 'warn', evaluated: false, explanation: 'No file has a caption.' };
  }
  const middle = median(captioned.map((entry) => entry.tokens));
  const longest = Math.max(...captioned.map((entry) => entry.tokens));
  const tooLong = captioned.filter((entry) => entry.tokens > T.captionLength.maxTokens);
  const tooShort = middle < T.captionLength.minMedianTokens;
  const parts: string[] = [];
  if (tooShort) parts.push(`Median ${middle} words: captions are too short, the model will not separate the concept from background and details.`);
  if (tooLong.length) parts.push(`${countFiles(tooLong.length)} longer than ${T.captionLength.maxTokens} words: the text encoder will truncate the end.`);
  return {
    id: 'caption-length', title, value: middle,
    display: `median ${middle}, max ${longest} words`,
    status: tooShort || tooLong.length ? 'warn' : 'ok', evaluated: true,
    explanation: parts.length ? parts.join(' ') : 'Caption length is fine.',
    action: tooLong.length ? { kind: 'caption', label: 'Shorten captions', ids: tooLong.map((entry) => entry.id) } : undefined,
  };
};
