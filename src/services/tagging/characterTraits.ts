import type { CharacterTrait } from '../../types';

const COLORS = new Set([
  'black', 'blue', 'brown', 'green', 'red', 'orange', 'yellow', 'pink', 'purple', 'white', 'grey', 'gray', 'silver',
  'blonde', 'aqua', 'golden', 'amber', 'multicolored', 'light_blue', 'dark_blue', 'light_brown', 'dark_brown',
  'light_green', 'dark_green', 'light_purple', 'dark_purple', 'light_pink', 'dark_pink', 'platinum_blonde', 'teal', 'violet', 'cyan',
]);
const HAIR_LENGTHS = new Set(['very_short_hair', 'short_hair', 'medium_hair', 'long_hair', 'very_long_hair', 'absurdly_long_hair']);
/** Explicit mutually exclusive groups; extend by adding a row. */
const EXPLICIT_GROUPS: Record<string, readonly string[]> = {
  hair_length: [...HAIR_LENGTHS],
  breast_size: ['flat_chest', 'small_breasts', 'medium_breasts', 'large_breasts', 'huge_breasts', 'gigantic_breasts'],
  skin_tone: ['pale_skin', 'dark_skin', 'tan'],
};
const EXPLICIT_LOOKUP = new Map<string, string>(Object.entries(EXPLICIT_GROUPS).flatMap(([group, tags]) => tags.map((tag) => [tag, group] as const)));

/** Same format as the WD tagger: trimmed, lowercase, whitespace as `_`. */
export const normalizeTraitTag = (tag: string): string => tag.trim().toLowerCase().replace(/\s+/g, '_');

/** Group id of a tag whose variants contradict each other, or undefined when the tag has no group. */
export const getTraitGroup = (tag: string): string | undefined => {
  const value = normalizeTraitTag(tag);
  const explicit = EXPLICIT_LOOKUP.get(value);
  if (explicit) return explicit;
  const eyes = /^(.+)_eyes$/.exec(value);
  if (eyes && COLORS.has(eyes[1])) return 'eye_color';
  const hair = /^(.+)_hair$/.exec(value);
  if (hair && COLORS.has(hair[1])) return 'hair_color';
  return undefined;
};

/** Drops invalid entries and duplicates; a missing value means no traits. */
export const normalizeCharacterTraits = (value: unknown): CharacterTrait[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: CharacterTrait[] = [];
  for (const entry of value) {
    const tag = typeof entry?.tag === 'string' ? normalizeTraitTag(entry.tag) : '';
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push({ tag, mode: entry.mode === 'omit' ? 'omit' : 'include' });
  }
  return result;
};

/**
 * Removes tags contradicting a character trait of the same group. `include` also guarantees the tag;
 * `omit` removes the tag and its whole group. Other tags keep their order; no duplicates.
 */
export const applyCharacterTraits = (tags: readonly string[], traits: readonly CharacterTrait[] | undefined): string[] => {
  const list = normalizeCharacterTraits(traits);
  const unique = [...new Set(tags)];
  if (!list.length) return unique;
  const keep = new Map<string, string>();
  const omitted = new Set<string>();
  const omittedGroups = new Set<string>();
  for (const { tag, mode } of list) {
    const group = getTraitGroup(tag);
    if (mode === 'omit') {
      omitted.add(tag);
      if (group) omittedGroups.add(group);
    } else if (group && !keep.has(group)) keep.set(group, tag);
  }
  const included = new Set(list.filter((trait) => trait.mode === 'include').map((trait) => trait.tag));
  const result = unique.filter((tag) => {
    const normalized = normalizeTraitTag(tag);
    if (omitted.has(normalized)) return false;
    const group = getTraitGroup(normalized);
    if (!group) return true;
    if (omittedGroups.has(group)) return false;
    const wanted = keep.get(group);
    return !wanted || wanted === normalized || !included.has(wanted);
  });
  for (const tag of included) if (!result.some((value) => normalizeTraitTag(value) === tag)) result.push(tag);
  return result;
};
