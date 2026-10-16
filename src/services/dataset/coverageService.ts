import type { SemanticFeature } from '../analysis/semanticFeatureService';

export type CoverageAsset = { key: string; feature: SemanticFeature; sceneGroup?: string };
export type CoverageMetrics = { visual: number; text: number | null; context: number | null; total: number };
export type CoverageUniverse = { assets: CoverageAsset[]; weights: number[]; denominator: number; textDenominator: number; contexts: string[] };

export const cosineSimilarity = (left: Float32Array, right: Float32Array): number => {
  let value = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) value += left[index] * right[index];
  return Math.max(0, Math.min(1, value));
};

export const getStableSceneGroup = (asset: CoverageAsset): string => {
  if (asset.sceneGroup) return asset.sceneGroup;
  const contexts = [...new Set(asset.feature.contexts.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  if (contexts.length) return contexts.slice(0, 2).join('|');
  let strongest = 0;
  for (let index = 1; index < asset.feature.image.length; index += 1) if (asset.feature.image[index] > asset.feature.image[strongest]) strongest = index;
  return `visual:${strongest}`;
};

export const createCoverageUniverse = (assets: CoverageAsset[]): CoverageUniverse => {
  const stableAssets = [...assets];
  const groupSizes = new Map<string, number>();
  for (const asset of stableAssets) {
    const group = getStableSceneGroup(asset);
    groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
  }
  const weights = stableAssets.map((asset) => 1 / Math.sqrt(groupSizes.get(getStableSceneGroup(asset)) ?? 1));
  return {
    assets: stableAssets,
    weights,
    denominator: weights.reduce((sum, weight) => sum + weight, 0),
    textDenominator: stableAssets.reduce((sum, asset, index) => sum + (asset.feature.caption.trim() ? weights[index] : 0), 0),
    contexts: [...new Set(stableAssets.flatMap((asset) => asset.feature.contexts))].sort(),
  };
};

export const measureCoverage = (selected: CoverageAsset[], input: CoverageAsset[] | CoverageUniverse): CoverageMetrics => {
  const universe = Array.isArray(input) ? createCoverageUniverse(input) : input;
  if (!universe.assets.length) return { visual: 0, text: null, context: null, total: 0 };
  const visual = universe.assets.reduce((sum, target, index) => sum + universe.weights[index] * selected.reduce(
    (best, item) => Math.max(best, cosineSimilarity(target.feature.image, item.feature.image)), 0
  ), 0) / Math.max(universe.denominator, 0.0001);
  const textSelected = selected.filter((item) => item.feature.caption.trim());
  // Available signals belong to the fixed universe, even before a selected item
  // covers them. Changing the denominator mid-selection can lower coverage.
  const text = universe.textDenominator > 0
    ? universe.assets.reduce((sum, target, index) => target.feature.caption.trim()
      ? sum + universe.weights[index] * textSelected.reduce((best, item) => Math.max(best, cosineSimilarity(target.feature.text, item.feature.text)), 0)
      : sum, 0) / universe.textDenominator
    : null;
  const coveredContexts = new Set(selected.flatMap((item) => item.feature.contexts));
  const context = universe.contexts.length ? universe.contexts.filter((value) => coveredContexts.has(value)).length / universe.contexts.length : null;
  const weighted = [[visual, 0.6], [text, 0.25], [context, 0.15]] as const;
  const weight = weighted.reduce((sum, [value, next]) => sum + (value === null ? 0 : next), 0);
  const total = weighted.reduce((sum, [value, next]) => sum + (value ?? 0) * next, 0) / Math.max(weight, 0.01);
  return { visual, text, context, total };
};
