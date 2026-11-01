export type CaptionFragment = { start: number; end: number; text: string };

export const normalizeCaptionTag = (value: string): string =>
  value.trim().replace(/\s+/g, '_').toLocaleLowerCase();

/** Finds the comma/newline-delimited token touching the caret. */
export const getCaptionFragmentAtSelection = (
  value: string,
  selectionStart: number,
  _selectionEnd = selectionStart
): CaptionFragment => {
  const caret = Math.max(0, Math.min(value.length, selectionStart));
  const previousComma = caret === 0 ? -1 : Math.max(value.lastIndexOf(',', caret - 1), value.lastIndexOf('\n', caret - 1), value.lastIndexOf('\r', caret - 1));
  const nextCommaCandidates = [value.indexOf(',', caret), value.indexOf('\n', caret), value.indexOf('\r', caret)].filter((index) => index >= 0);
  let start = previousComma + 1;
  let end = nextCommaCandidates.length ? Math.min(...nextCommaCandidates) : value.length;
  while (start < end && /\s/.test(value[start])) start += 1;
  while (end > start && /\s/.test(value[end - 1])) end -= 1;
  return { start, end, text: value.slice(start, end).trim() };
};

export const getCaptionTags = (value: string): string[] =>
  value.split(/[,\r\n]/).map((tag) => tag.trim()).filter(Boolean);

/** Replaces the active token (and any selection within it), preserving surrounding tokens. */
export const replaceCaptionFragment = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
  replacement: string
): { value: string; caret: number } => {
  const fragment = getCaptionFragmentAtSelection(value, selectionStart, selectionEnd);
  const token = replacement.trim();
  const nextValue = `${value.slice(0, fragment.start)}${token}${value.slice(fragment.end)}`;
  return { value: nextValue, caret: fragment.start + token.length };
};

export const getCaptionSuggestionMatches = (
  fragment: string,
  suggestions: string[],
  value: string,
  limit = 6
): string[] => {
  const query = normalizeCaptionTag(fragment);
  if (!query) return [];
  const existing = new Set(getCaptionTags(value).map(normalizeCaptionTag));
  const unique = new Map<string, string>();
  for (const suggestion of suggestions) {
    const key = normalizeCaptionTag(suggestion);
    if (key && !existing.has(key) && !unique.has(key)) unique.set(key, suggestion.trim());
  }
  return [...unique.entries()]
    .filter(([key]) => key.includes(query))
    .sort(([a], [b]) => {
      const rank = (key: string) => key === query ? 0 : key.startsWith(query) ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    })
    .slice(0, limit)
    .map(([, suggestion]) => suggestion);
};
