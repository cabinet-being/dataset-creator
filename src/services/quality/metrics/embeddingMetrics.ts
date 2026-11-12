import { cosineSimilarity, measureCoverageCurve, measureRadiusCoverage, type EmbeddedAsset } from '../../dataset/coverageService';
import type { ProjectType } from '../../../types/entities';
import { QUALITY_THRESHOLDS as T, statusForHigherBetter } from './thresholds';
import { countFiles, percent } from './text';
import type { QualityCandidateInput, QualityItemInput, QualityMetric } from './types';
import { dot, median, normalizeVector, toFloat32 } from './vectorMath';
import { vendiScore } from './vendi';

const embedded = (entries: readonly { id: string; embedding?: QualityItemInput['embedding'] }[]): EmbeddedAsset[] =>
  entries.flatMap((entry) => {
    const vector = normalizeVector(entry.embedding);
    return vector ? [{ id: entry.id, vector: toFloat32(vector) }] : [];
  });

const round1 = (value: number) => Math.round(value * 10) / 10;

export const measureEffectiveSize = (items: readonly QualityItemInput[]): QualityMetric => {
  const title = 'Ефективний розмір';
  const vectors = embedded(items);
  if (!vectors.length) {
    return { id: 'effective-size', title, value: null, display: 'немає векторів', status: 'warn', evaluated: false, explanation: 'Потрібні DINOv2-вектори зображень.' };
  }
  const score = vendiScore(vectors.map((entry) => entry.vector));
  const ratio = score / vectors.length;
  const status = statusForHigherBetter(ratio, T.effectiveSize.okRatio, T.effectiveSize.warnRatio);
  const explanation = status === 'ok'
    ? 'Зображення достатньо різноманітні.'
    : `Файли сильно схожі між собою: фактично це приблизно ${round1(score)} різних прикладів. Додайте інші ракурси, освітлення, фони або приберіть повтори.`;
  return {
    id: 'effective-size', title, value: score, display: `${countFiles(vectors.length)} ≈ ${round1(score)} ефективно різних`,
    status, evaluated: true,
    explanation: `${explanation} (Vendi Score за DINOv2-векторами${vectors.length < items.length ? `; без вектора: ${items.length - vectors.length}` : ''}.)`,
  };
};

/** Farthest-first representatives of uncovered candidates, so "what is missing" is not a list of near-identical frames. */
const representativeGaps = (uncovered: readonly EmbeddedAsset[], radius: number, limit: number): string[] => {
  const pending = [...uncovered];
  const picked: string[] = [];
  while (pending.length && picked.length < limit) {
    const next = pending.shift()!;
    picked.push(next.id);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (1 - cosineSimilarity(pending[index].vector, next.vector) <= radius) pending.splice(index, 1);
    }
  }
  return picked;
};

export const measureMaterialCoverage = (
  items: readonly QualityItemInput[],
  candidates: readonly QualityCandidateInput[] | undefined,
  radius: number = T.coverage.radius,
): QualityMetric => {
  const title = 'Покриття матеріалів';
  const pool = candidates ? embedded(candidates) : [];
  const selected = embedded(items);
  if (!pool.length || !selected.length) {
    return { id: 'coverage', title, value: null, display: 'немає даних', status: 'warn', evaluated: false, explanation: 'Потрібні DINOv2-вектори вибраних файлів і матеріалів-кандидатів.' };
  }
  const result = measureRadiusCoverage(pool, selected.map((entry) => entry.vector), radius);
  const status = statusForHigherBetter(result.fraction, T.coverage.okFraction, T.coverage.warnFraction);
  const byId = new Map(pool.map((entry) => [entry.id, entry]));
  const gaps = representativeGaps(result.uncovered.map((entry) => byId.get(entry.id)!), radius, 12);
  return {
    id: 'coverage', title, value: result.fraction,
    display: `${percent(result.fraction)} кандидатів (${result.covered} з ${result.total})`,
    status, evaluated: true,
    explanation: result.uncovered.length
      ? `${countFiles(result.uncovered.length)} матеріалів не мають схожого відповідника в Dataset (косинусна відстань > ${radius}). Нижче — представники пропущених груп.`
      : 'Для кожного кандидата в Dataset є схожий приклад.',
    action: gaps.length ? { kind: 'add', label: 'Чого бракує', ids: gaps } : undefined,
  };
};

export const measureSaturation = (
  items: readonly QualityItemInput[],
  candidates: readonly QualityCandidateInput[] | undefined,
  selectionOrder?: readonly string[],
  radius: number = T.coverage.radius,
): QualityMetric => {
  const title = 'Насичення';
  const pool = candidates ? embedded(candidates) : [];
  const byId = new Map(embedded(items).map((entry) => [entry.id, entry]));
  const orderIds = selectionOrder?.length ? selectionOrder : items.map((item) => item.id);
  const ordered = orderIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!.vector] : []));
  if (!pool.length || !ordered.length) {
    return { id: 'saturation', title, value: null, display: 'немає даних', status: 'warn', evaluated: false, explanation: 'Потрібні вектори вибраних файлів і кандидатів.' };
  }
  const curve = measureCoverageCurve(pool, ordered, radius);
  const k = Math.min(T.saturation.lastK, curve.length);
  const last = curve[curve.length - 1];
  const gain = last - (curve.length > k ? curve[curve.length - 1 - k] : 0);
  const status = gain <= T.saturation.okGain ? 'ok' : 'warn';
  return {
    id: 'saturation', title, value: gain, series: curve,
    display: `+${percent(gain)} покриття за останні ${k}`,
    status, evaluated: true,
    explanation: gain <= T.saturation.okGain
      ? 'Останні додані файли майже не розширюють покриття: Dataset насичений, нові схожі файли мало що дадуть.'
      : gain <= T.saturation.warnGain
        ? 'Покриття ще помірно зростає: кілька нових різних файлів можуть допомогти.'
        : 'Покриття стрімко зростає з кожним файлом: варто додати ще матеріалів.',
  };
};

export const measureConsistency = (items: readonly QualityItemInput[], projectType?: ProjectType): QualityMetric => {
  const title = 'Узгодженість персонажа';
  if (projectType !== 'character') {
    return { id: 'consistency', title, value: null, display: 'не застосовується', status: 'ok', evaluated: false, explanation: 'Перевірка викидів застосовується лише до проєктів типу Character.' };
  }
  const vectors = embedded(items);
  if (vectors.length < 5) {
    return { id: 'consistency', title, value: null, display: 'замало даних', status: 'warn', evaluated: false, explanation: 'Потрібно щонайменше 5 файлів із DINOv2-векторами.' };
  }
  const centroid = new Float64Array(vectors[0].vector.length);
  for (const entry of vectors) for (let index = 0; index < centroid.length; index += 1) centroid[index] += entry.vector[index];
  const unit = normalizeVector(centroid);
  if (!unit) {
    return { id: 'consistency', title, value: null, display: 'немає центру', status: 'warn', evaluated: false, explanation: 'Вектори взаємно компенсуються, центр не визначено.' };
  }
  const distances = vectors.map((entry) => ({ id: entry.id, distance: 1 - dot(entry.vector, unit) }));
  const middle = median(distances.map((entry) => entry.distance));
  const mad = median(distances.map((entry) => Math.abs(entry.distance - middle)));
  const limit = Math.max(T.consistency.minDistance, middle + T.consistency.madK * mad);
  const outliers = distances.filter((entry) => entry.distance > limit).sort((left, right) => right.distance - left.distance);
  const fraction = outliers.length / vectors.length;
  const status = !outliers.length ? 'ok' : fraction <= T.consistency.warnFraction ? 'warn' : 'fail';
  return {
    id: 'consistency', title, value: outliers.length,
    display: outliers.length ? `${outliers.length} викидів` : 'без викидів',
    status, evaluated: true,
    explanation: outliers.length
      ? `${countFiles(outliers.length)} помітно відрізняються від решти (відстань до центру > ${limit.toFixed(2)}): можливо, інший персонаж, костюм або сторонній кадр.`
      : 'Усі файли близькі до спільного центру.',
    action: outliers.length ? { kind: 'review', label: 'Перевірити викиди', ids: outliers.map((entry) => entry.id) } : undefined,
  };
};
