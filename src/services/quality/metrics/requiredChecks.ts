import { QUALITY_THRESHOLDS as T, resolveMinShortSide, statusForBadFraction } from './thresholds';
import { captionText, containsTrigger, countFiles, hasCaption, percent } from './text';
import type { ImageQualityVerdict, QualityItemInput, QualityMetric, ResolutionPreset } from './types';
import { dot, normalizeVector } from './vectorMath';

export const checkCount = (count: number, target: { min: number; max: number } = T.count.defaultTarget): QualityMetric => {
  const base = { id: 'count', title: 'Кількість файлів', value: count, display: `${countFiles(count)} (ціль ${target.min}–${target.max})`, evaluated: true } as const;
  if (count < target.min) {
    const status = count < target.min * T.count.failRatio ? 'fail' : 'warn';
    return { ...base, status, explanation: `Бракує ${target.min - count} до мінімуму цілі: замало прикладів, LoRA може не засвоїти концепт.` };
  }
  if (count > target.max) {
    return { ...base, status: 'warn', explanation: `На ${count - target.max} більше за ціль: довше навчання і ризик повторів. Приберіть найсхожіші файли.` };
  }
  return { ...base, status: 'ok', explanation: 'Кількість у межах цілі.' };
};

export const checkResolution = (items: readonly QualityItemInput[], preset: ResolutionPreset = 'sdxl', override?: number): QualityMetric => {
  const minSide = resolveMinShortSide(preset, override);
  const known = items.filter((item) => (item.width ?? 0) > 0 && (item.height ?? 0) > 0);
  const title = `Роздільність (коротша сторона ≥ ${minSide}px)`;
  if (!known.length) {
    return { id: 'resolution', title, value: null, display: 'немає даних', status: 'warn', evaluated: false, explanation: 'Розміри зображень невідомі, перевірку не виконано.' };
  }
  const below = known.filter((item) => Math.min(item.width!, item.height!) < minSide);
  const fraction = below.length / known.length;
  const unknown = items.length - known.length;
  const status = unknown && !below.length ? 'warn' : statusForBadFraction(fraction, T.resolution.warnFraction);
  const parts = [below.length
    ? `${countFiles(below.length)} (${percent(fraction)}) мають коротшу сторону менше ${minSide}px: модель вчитиметься на розмитих деталях.`
    : `Усі файли мають коротшу сторону щонайменше ${minSide}px.`];
  if (unknown) parts.push(`Розмір ${countFiles(unknown)} невідомий.`);
  return {
    id: 'resolution', title, value: fraction, display: below.length ? `${below.length} з ${known.length} замалі` : 'усі достатні',
    status, evaluated: true, explanation: parts.join(' '),
    action: below.length ? { kind: 'review', label: 'Замінити якіснішими або прибрати', ids: below.map((item) => item.id) } : undefined,
  };
};

export type NearDuplicatePair = { kept: string; removed: string; similarity: number; kind: 'exact' | 'near' };

/** Greedy in item order: each item is compared with the already kept ones, like Dataset assembly. */
export const findNearDuplicates = (items: readonly QualityItemInput[], threshold: number = T.nearDuplicates.similarity): NearDuplicatePair[] => {
  const kept: { id: string; vector: Float64Array | null; hash?: string }[] = [];
  const pairs: NearDuplicatePair[] = [];
  for (const item of items) {
    const vector = normalizeVector(item.embedding);
    const exact = item.imageHash ? kept.find((other) => other.hash === item.imageHash) : undefined;
    if (exact) { pairs.push({ kept: exact.id, removed: item.id, similarity: 1, kind: 'exact' }); continue; }
    let best: { id: string; similarity: number } | null = null;
    if (vector) {
      for (const other of kept) {
        if (!other.vector) continue;
        const similarity = dot(vector, other.vector);
        if (!best || similarity > best.similarity) best = { id: other.id, similarity };
      }
    }
    if (best && best.similarity >= threshold) { pairs.push({ kept: best.id, removed: item.id, similarity: best.similarity, kind: 'near' }); continue; }
    kept.push({ id: item.id, vector, hash: item.imageHash });
  }
  return pairs;
};

export type NearDuplicateGroup = { kept: string; removed: string[]; exact: number };

/** Groups kept→removed pairs by the kept anchor; groups are ordered by size, then by first appearance. */
export const groupNearDuplicates = (pairs: readonly NearDuplicatePair[]): NearDuplicateGroup[] => {
  const groups = new Map<string, NearDuplicateGroup>();
  for (const pair of pairs) {
    const group = groups.get(pair.kept) ?? { kept: pair.kept, removed: [], exact: 0 };
    group.removed.push(pair.removed);
    if (pair.kind === 'exact') group.exact += 1;
    groups.set(pair.kept, group);
  }
  return [...groups.values()].map((group, index) => ({ group, index }))
    .sort((left, right) => right.group.removed.length - left.group.removed.length || left.index - right.index)
    .map((entry) => entry.group);
};

export const checkNearDuplicates = (items: readonly QualityItemInput[]): QualityMetric => {
  const title = 'Майже-дублікати';
  const withSignal = items.filter((item) => normalizeVector(item.embedding) || item.imageHash);
  if (!withSignal.length) {
    return { id: 'near-duplicates', title, value: null, display: 'немає векторів', status: 'warn', evaluated: false, explanation: 'Для файлів ще немає DINOv2-векторів, дублікати не перевірено.' };
  }
  const pairs = findNearDuplicates(items);
  const fraction = pairs.length / items.length;
  const missing = items.length - withSignal.length;
  const status = missing && !pairs.length ? 'warn' : statusForBadFraction(fraction, T.nearDuplicates.warnFraction);
  const parts = [pairs.length
    ? `${countFiles(pairs.length)} майже повторюють інші (схожість ≥ ${T.nearDuplicates.similarity}): вони підсилюють перенавчання на конкретних кадрах.`
    : 'Майже-дублікатів не знайдено.'];
  if (missing) parts.push(`${countFiles(missing)} без вектора не перевірено.`);
  return {
    id: 'near-duplicates', title, value: pairs.length, display: pairs.length ? `${pairs.length} зайвих` : 'немає',
    status, evaluated: true, explanation: parts.join(' '),
    action: pairs.length ? { kind: 'remove', label: 'Прибрати повтори', ids: pairs.map((pair) => pair.removed) } : undefined,
  };
};

export const checkCaptions = (items: readonly QualityItemInput[]): QualityMetric => {
  const missing = items.filter((item) => !hasCaption(item));
  const fraction = items.length ? missing.length / items.length : 0;
  return {
    id: 'captions', title: 'Підписи', value: fraction,
    display: missing.length ? `${missing.length} без підпису` : 'усі підписані',
    status: statusForBadFraction(fraction, T.captions.warnFraction), evaluated: true,
    explanation: missing.length
      ? `${countFiles(missing.length)} без підпису: тренер побачить лише тригер або порожній текст.`
      : 'Кожен файл має підпис.',
    action: missing.length ? { kind: 'caption', label: 'Додати підписи', ids: missing.map((item) => item.id) } : undefined,
  };
};

export const checkTrigger = (items: readonly QualityItemInput[], triggerWord = ''): QualityMetric => {
  const trigger = triggerWord.trim();
  if (!trigger) {
    return { id: 'trigger', title: 'Тригер-слово', value: null, display: 'не задано', status: 'ok', evaluated: false, explanation: 'Тригер-слово не задано, перевірку пропущено.' };
  }
  const missing = items.filter((item) => !containsTrigger(captionText(item), trigger));
  const fraction = items.length ? missing.length / items.length : 0;
  return {
    id: 'trigger', title: `Тригер «${trigger}»`, value: 1 - fraction,
    display: `${percent(1 - fraction)} підписів`,
    status: statusForBadFraction(fraction, T.trigger.warnFraction), evaluated: true,
    explanation: missing.length
      ? `У ${countFiles(missing.length)} немає тригер-слова: концепт не прив'яжеться до нього надійно.`
      : 'Тригер-слово є в кожному підписі.',
    action: missing.length ? { kind: 'caption', label: 'Додати тригер', ids: missing.map((item) => item.id) } : undefined,
  };
};

export const checkTechnical = (items: readonly QualityItemInput[], verdicts?: readonly ImageQualityVerdict[]): QualityMetric => {
  const title = 'Технічна якість';
  if (!verdicts) {
    return { id: 'technical', title, value: null, display: 'не перевірено', status: 'warn', evaluated: false, explanation: 'Технічну перевірку (розмиття, шум, артефакти) ще не запускали.' };
  }
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const bad = items.filter((item) => byId.get(item.id)?.verdict === 'bad');
  const doubtful = items.filter((item) => byId.get(item.id)?.verdict === 'warn');
  const unchecked = items.filter((item) => !byId.has(item.id));
  const fraction = items.length ? bad.length / items.length : 0;
  const base = statusForBadFraction(fraction, T.technical.warnFraction);
  const status = base === 'ok' && unchecked.length ? 'warn' : base;
  const reasons = [...new Set(bad.flatMap((item) => byId.get(item.id)?.reasons ?? []))].slice(0, 4);
  const parts = [bad.length
    ? `${countFiles(bad.length)} (${percent(fraction)}) технічно погані${reasons.length ? `: ${reasons.join(', ')}` : ''}.`
    : 'Технічно поганих файлів немає.'];
  if (doubtful.length) parts.push(`Ще ${countFiles(doubtful.length)} під сумнівом.`);
  if (unchecked.length) parts.push(`${countFiles(unchecked.length)} не перевірено.`);
  return {
    id: 'technical', title, value: fraction, display: bad.length ? `${percent(fraction)} поганих` : 'без проблем',
    status, evaluated: true, explanation: parts.join(' '),
    action: bad.length ? { kind: 'remove', label: 'Прибрати погані', ids: bad.map((item) => item.id) } : undefined,
  };
};
