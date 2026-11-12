import { QUALITY_THRESHOLDS as T } from './thresholds';
import { captionText, countCaptionTokens, countFiles, hasCaption, normalizeTag, percent, resolveItemTags } from './text';
import type { QualityItemInput, QualityMetric } from './types';
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

export const measureCommonTags = (items: readonly QualityItemInput[], triggerWord = ''): QualityMetric => {
  const title = 'Теги майже в усіх файлах';
  if (items.length < 3) {
    return { id: 'common-tags', title, value: null, display: 'замало файлів', status: 'ok', evaluated: false, explanation: 'Потрібно щонайменше 3 файли.' };
  }
  const common = countTagFrequencies(items, triggerWord).filter((entry) => entry.fraction >= T.tags.commonFraction);
  return {
    id: 'common-tags', title, value: common.length,
    display: common.length ? common.slice(0, 5).map((entry) => entry.tag).join(', ') : 'немає',
    status: common.length ? 'warn' : 'ok', evaluated: true,
    explanation: common.length
      ? `${common.length} тегів є щонайменше в ${percent(T.tags.commonFraction)} файлів. Якщо це незмінна ознака, яку LoRA має прив'язати до тригера, приберіть тег із підписів; якщо ні — тег нічого не розрізняє.`
      : 'Немає тегів, що повторюються майже всюди.',
    action: common.length ? { kind: 'review', label: 'Переглянути теги', tags: common.map((entry) => entry.tag) } : undefined,
  };
};

export const measureRareTags = (items: readonly QualityItemInput[], triggerWord = ''): QualityMetric => {
  const title = 'Поодинокі теги';
  if (items.length < T.tags.rareMinDataset) {
    return { id: 'rare-tags', title, value: null, display: 'замало файлів', status: 'ok', evaluated: false, explanation: `Оцінюється від ${T.tags.rareMinDataset} файлів.` };
  }
  const all = countTagFrequencies(items, triggerWord);
  const rare = all.filter((entry) => entry.files <= T.tags.rareMaxFiles);
  const fraction = all.length ? rare.length / all.length : 0;
  return {
    id: 'rare-tags', title, value: fraction,
    display: `${rare.length} з ${all.length} тегів`,
    status: fraction > T.tags.rareWarnFraction ? 'warn' : 'ok', evaluated: true,
    explanation: rare.length
      ? `${percent(fraction)} тегів трапляються лише в одному файлі: модель не встигне їх вивчити. Уніфікуйте синоніми або приберіть шум.`
      : 'Поодиноких тегів немає.',
    action: rare.length ? { kind: 'review', label: 'Уніфікувати або прибрати', tags: rare.slice(0, 40).map((entry) => entry.tag) } : undefined,
  };
};

export const measureCaptionLength = (items: readonly QualityItemInput[]): QualityMetric => {
  const title = 'Довжина підписів';
  const captioned = items.filter(hasCaption).map((item) => ({ id: item.id, tokens: countCaptionTokens(captionText(item)) }));
  if (!captioned.length) {
    return { id: 'caption-length', title, value: null, display: 'немає підписів', status: 'warn', evaluated: false, explanation: 'Жоден файл не має підпису.' };
  }
  const middle = median(captioned.map((entry) => entry.tokens));
  const longest = Math.max(...captioned.map((entry) => entry.tokens));
  const tooLong = captioned.filter((entry) => entry.tokens > T.captionLength.maxTokens);
  const tooShort = middle < T.captionLength.minMedianTokens;
  const parts: string[] = [];
  if (tooShort) parts.push(`Медіана ${middle} слів: підписи надто короткі, модель не відокремить концепт від фону й деталей.`);
  if (tooLong.length) parts.push(`${countFiles(tooLong.length)} довші за ${T.captionLength.maxTokens} слів: текстовий енкодер обріже кінець.`);
  return {
    id: 'caption-length', title, value: middle,
    display: `медіана ${middle}, макс ${longest} слів`,
    status: tooShort || tooLong.length ? 'warn' : 'ok', evaluated: true,
    explanation: parts.length ? parts.join(' ') : 'Довжина підписів у нормі.',
    action: tooLong.length ? { kind: 'caption', label: 'Скоротити підписи', ids: tooLong.map((entry) => entry.id) } : undefined,
  };
};
