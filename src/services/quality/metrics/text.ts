/** Ukrainian plural: forms = [one, few, many], e.g. ['файл', 'файли', 'файлів']. */
export const plural = (count: number, forms: readonly [string, string, string]): string => {
  const value = Math.abs(Math.trunc(count));
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
};

export const FILES = ['файл', 'файли', 'файлів'] as const;

export const countFiles = (count: number): string => `${count} ${plural(count, FILES)}`;

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
