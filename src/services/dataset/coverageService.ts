import type { SemanticFeature } from '../analysis/semanticFeatureService';

export type CoverageAsset = { key: string; feature: SemanticFeature };
export type CoverageMetrics = { visual: number; text: number | null; context: number | null; total: number };

const cosine = (left: Float32Array, right: Float32Array): number => {
  let value = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) value += left[index] * right[index];
  return Math.max(0, Math.min(1, value));
};

export const measureCoverage = (selected: CoverageAsset[], universe: CoverageAsset[]): CoverageMetrics => {
  if (!universe.length || !selected.length) return { visual: 0, text: null, context: null, total: 0 };
  const visual = universe.reduce((sum, target) => sum + selected.reduce((best, item) => Math.max(best, cosine(target.feature.image, item.feature.image)), 0), 0) / universe.length;
  const textUniverse = universe.filter((item) => item.feature.caption.trim());
  const textSelected = selected.filter((item) => item.feature.caption.trim());
  const text = textUniverse.length && textSelected.length
    ? textUniverse.reduce((sum, target) => sum + textSelected.reduce((best, item) => Math.max(best, cosine(target.feature.text, item.feature.text)), 0), 0) / textUniverse.length
    : null;
  const contexts = new Set(universe.flatMap((item) => item.feature.contexts));
  const coveredContexts = new Set(selected.flatMap((item) => item.feature.contexts));
  const context = contexts.size ? [...contexts].filter((value) => coveredContexts.has(value)).length / contexts.size : null;
  const weighted = [[visual, 0.6], [text, 0.25], [context, 0.15]] as const;
  const weight = weighted.reduce((sum, [value, next]) => sum + (value === null ? 0 : next), 0);
  const total = weighted.reduce((sum, [value, next]) => sum + (value ?? 0) * next, 0) / Math.max(weight, 0.01);
  return { visual, text, context, total };
};

