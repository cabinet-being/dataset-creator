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
  const title = 'Effective size';
  const vectors = embedded(items);
  if (!vectors.length) {
    return { id: 'effective-size', title, value: null, display: 'no vectors', status: 'warn', evaluated: false, explanation: 'DINOv2 image vectors are required.' };
  }
  const score = vendiScore(vectors.map((entry) => entry.vector));
  const ratio = score / vectors.length;
  const status = statusForHigherBetter(ratio, T.effectiveSize.okRatio, T.effectiveSize.warnRatio);
  const explanation = status === 'ok'
    ? 'The images are diverse enough.'
    : `The files are very similar to each other: effectively about ${round1(score)} distinct examples. Add other angles, lighting and backgrounds, or remove repeats.`;
  return {
    id: 'effective-size', title, value: score, display: `${countFiles(vectors.length)} ≈ ${round1(score)} effectively distinct`,
    status, evaluated: true,
    explanation: `${explanation} (Vendi Score from DINOv2 vectors${vectors.length < items.length ? `; without a vector: ${items.length - vectors.length}` : ''}.)`,
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
  const title = 'Source coverage';
  const pool = candidates ? embedded(candidates) : [];
  const selected = embedded(items);
  if (!pool.length || !selected.length) {
    return { id: 'coverage', title, value: null, display: 'no data', status: 'warn', evaluated: false, explanation: 'DINOv2 vectors are required for the selected files and candidate sources.' };
  }
  const result = measureRadiusCoverage(pool, selected.map((entry) => entry.vector), radius);
  const status = statusForHigherBetter(result.fraction, T.coverage.okFraction, T.coverage.warnFraction);
  const byId = new Map(pool.map((entry) => [entry.id, entry]));
  const gaps = representativeGaps(result.uncovered.map((entry) => byId.get(entry.id)!), radius, 12);
  return {
    id: 'coverage', title, value: result.fraction,
    display: `${percent(result.fraction)} of candidates (${result.covered} of ${result.total})`,
    status, evaluated: true,
    explanation: result.uncovered.length
      ? `${countFiles(result.uncovered.length)} of the sources have no similar match in the Dataset (cosine distance > ${radius}). Representatives of the missing groups are listed below.`
      : 'Every candidate has a similar example in the Dataset.',
    action: gaps.length ? { kind: 'add', label: 'What is missing', ids: gaps } : undefined,
  };
};

export const measureSaturation = (
  items: readonly QualityItemInput[],
  candidates: readonly QualityCandidateInput[] | undefined,
  selectionOrder?: readonly string[],
  radius: number = T.coverage.radius,
): QualityMetric => {
  const title = 'Saturation';
  const pool = candidates ? embedded(candidates) : [];
  const byId = new Map(embedded(items).map((entry) => [entry.id, entry]));
  const orderIds = selectionOrder?.length ? selectionOrder : items.map((item) => item.id);
  const ordered = orderIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!.vector] : []));
  if (!pool.length || !ordered.length) {
    return { id: 'saturation', title, value: null, display: 'no data', status: 'warn', evaluated: false, explanation: 'Vectors of the selected files and candidates are required.' };
  }
  const curve = measureCoverageCurve(pool, ordered, radius);
  const k = Math.min(T.saturation.lastK, curve.length);
  const last = curve[curve.length - 1];
  const gain = last - (curve.length > k ? curve[curve.length - 1 - k] : 0);
  const status = gain <= T.saturation.okGain ? 'ok' : 'warn';
  return {
    id: 'saturation', title, value: gain, series: curve,
    display: `+${percent(gain)} coverage over the last ${k}`,
    status, evaluated: true,
    explanation: gain <= T.saturation.okGain
      ? 'The latest files barely widen coverage: the Dataset is saturated, and more similar files will add little.'
      : gain <= T.saturation.warnGain
        ? 'Coverage is still growing moderately: a few new, different files may help.'
        : 'Coverage grows quickly with every file: it is worth adding more material.',
  };
};

export const measureConsistency = (items: readonly QualityItemInput[], projectType?: ProjectType): QualityMetric => {
  const title = 'Character consistency';
  if (projectType !== 'character') {
    return { id: 'consistency', title, value: null, display: 'not applicable', status: 'ok', evaluated: false, explanation: 'The outlier check applies only to Character projects.' };
  }
  const vectors = embedded(items);
  if (vectors.length < 5) {
    return { id: 'consistency', title, value: null, display: 'not enough data', status: 'warn', evaluated: false, explanation: 'At least 5 files with DINOv2 vectors are required.' };
  }
  const centroid = new Float64Array(vectors[0].vector.length);
  for (const entry of vectors) for (let index = 0; index < centroid.length; index += 1) centroid[index] += entry.vector[index];
  const unit = normalizeVector(centroid);
  if (!unit) {
    return { id: 'consistency', title, value: null, display: 'no center', status: 'warn', evaluated: false, explanation: 'The vectors cancel each other out, so no center can be determined.' };
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
    display: outliers.length ? `${outliers.length} outliers` : 'no outliers',
    status, evaluated: true,
    explanation: outliers.length
      ? `${countFiles(outliers.length)} differ noticeably from the rest (distance to center > ${limit.toFixed(2)}): possibly a different character, outfit or an unrelated shot.`
      : 'All files are close to the common center.',
    action: outliers.length ? { kind: 'review', label: 'Review outliers', ids: outliers.map((entry) => entry.id) } : undefined,
  };
};
