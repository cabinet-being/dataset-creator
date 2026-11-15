/** Simple English plural: `1 file`, `2 files`. Pass `pluralForm` for irregular nouns. */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${Math.abs(count) === 1 ? singular : pluralForm}`;

export const countFiles = (count: number): string => plural(count, 'file');

export const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive whole-word match that also works for non-Latin trigger words. */
export const containsTrigger = (caption: string, trigger: string): boolean => {
  const word = trigger.trim();
  if (!word) return true;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(word)}($|[^\\p{L}\\p{N}_])`, 'iu').test(caption);
};

export const normalizeTag = (tag: string): string => tag.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** Resolved tags; undefined tags fall back to comma-separated caption parts. */
export const resolveItemTags = (item: { tags?: string[]; caption?: string }): string[] => {
  const source = item.tags ?? (item.caption ?? '').split(',');
  return [...new Set(source.map(normalizeTag).filter(Boolean))];
};

export const hasCaption = (item: { tags?: string[]; caption?: string }): boolean =>
  Boolean(item.caption?.trim()) || Boolean(item.tags?.some((tag) => tag.trim()));

export const captionText = (item: { tags?: string[]; caption?: string }): string =>
  item.caption?.trim() ? item.caption : (item.tags ?? []).join(', ');

/** Word count as a conservative proxy for CLIP text tokens. */
export const countCaptionTokens = (caption: string): number => caption.split(/[\s,]+/).filter(Boolean).length;
