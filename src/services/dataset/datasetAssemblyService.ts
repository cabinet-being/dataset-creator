import type { Dataset, ProjectType } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { SemanticFeature } from '../analysis/semanticFeatureService';
import { encodeCaptionText, SEMANTIC_FEATURE_MODEL_KEY } from '../analysis/semanticFeatureService';
import { measureCoverage, type CoverageAsset, type CoverageMetrics } from './coverageService';
import { normalizeDatasetPath } from './datasetMembershipResolver';

export const DATASET_ASSEMBLY_VERSION = 'greedy-coverage-v1';
export type AssemblyMode = { kind: 'auto'; saturationGain?: number } | { kind: 'limit'; limit: number; saturationGain?: number };
export type AssemblyInputAsset = { item: WorkspaceImage; feature: SemanticFeature; caption: string; quality?: number };
export type AssemblyStep = { key: string; path: string; gain: number; reason: string; coverage: CoverageMetrics };
export type DatasetAssemblyPlan = {
  projectId: string;
  datasetId: string;
  fingerprint: string;
  algorithm: string;
  model: string;
  mode: AssemblyMode;
  target: string;
  baselineCount: number;
  candidateCount: number;
  selected: AssemblyStep[];
  rejectedDuplicates: string[];
  before: CoverageMetrics;
  after: CoverageMetrics;
  stoppedBecause: 'limit' | 'saturated' | 'exhausted';
};

const stableKey = (asset: AssemblyInputAsset) => normalizeDatasetPath(asset.item.assetPath ?? asset.item.id);
const coverageAsset = (asset: AssemblyInputAsset): CoverageAsset => ({ key: stableKey(asset), feature: asset.feature });
const cosine = (left: Float32Array, right: Float32Array) => {
  let result = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) result += left[index] * right[index];
  return Math.max(0, Math.min(1, result));
};
export const createAssemblyFingerprint = async (dataset: Pick<Dataset, 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'captionOverrides' | 'overwriteCaptions'>, candidates: AssemblyInputAsset[], target: string) => {
  const value = JSON.stringify({
    membership: [dataset.assetIds, dataset.assetPaths, dataset.psdAssetPaths],
    captions: dataset.captionOverrides,
    overwrite: dataset.overwriteCaptions,
    candidates: candidates.map((asset) => [stableKey(asset), asset.feature.imageHash, asset.caption]),
    target,
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export async function assembleDataset(options: {
  projectId: string;
  projectType: ProjectType;
  dataset: Dataset;
  baseline: AssemblyInputAsset[];
  candidates: AssemblyInputAsset[];
  mode: AssemblyMode;
  target?: string;
  excludedKeys?: ReadonlySet<string>;
  pinnedKeys?: ReadonlySet<string>;
}): Promise<DatasetAssemblyPlan> {
  const target = options.target?.trim() ?? '';
  const targetFeature = target ? encodeCaptionText(target) : null;
  const existingHashes = new Set(options.baseline.map((asset) => asset.feature.imageHash));
  const seenHashes = new Set(existingHashes);
  const rejectedDuplicates: string[] = [];
  const eligible = [...options.candidates]
    .sort((left, right) => stableKey(left).localeCompare(stableKey(right), undefined, { numeric: true, sensitivity: 'base' }))
    .filter((asset) => !options.excludedKeys?.has(stableKey(asset)))
    .filter((asset) => {
      if (seenHashes.has(asset.feature.imageHash)) { rejectedDuplicates.push(stableKey(asset)); return false; }
      seenHashes.add(asset.feature.imageHash); return true;
    });
  const universe = [...options.baseline, ...eligible].map(coverageAsset);
  const selectedAssets = [...options.baseline];
  const remaining = [...eligible];
  const steps: AssemblyStep[] = [];
  const saturationGain = options.mode.saturationGain ?? 0.0025;
  let metrics = measureCoverage(selectedAssets.map(coverageAsset), universe);
  const before = metrics;
  const capacity = options.mode.kind === 'limit' ? Math.max(0, Math.floor(options.mode.limit)) : Infinity;
  while (remaining.length && steps.length < capacity) {
    let bestIndex = -1;
    let bestGain = -Infinity;
    let bestMetrics = metrics;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const nextMetrics = measureCoverage([...selectedAssets, candidate].map(coverageAsset), universe);
      const pinned = options.pinnedKeys?.has(stableKey(candidate));
      const targetRelevance = targetFeature && candidate.caption ? cosine(targetFeature, candidate.feature.text) : 0;
      const gain = nextMetrics.total - metrics.total + targetRelevance * 0.08 + (pinned ? 1 : 0);
      if (gain > bestGain + 1e-9 || (Math.abs(gain - bestGain) <= 1e-9 && (candidate.quality ?? 0) > (remaining[bestIndex]?.quality ?? 0))) {
        bestIndex = index; bestGain = gain; bestMetrics = nextMetrics;
      }
    }
    if (bestIndex < 0) break;
    const candidate = remaining[bestIndex];
    const pinned = options.pinnedKeys?.has(stableKey(candidate));
    const actualGain = bestMetrics.total - metrics.total;
    if (!pinned && actualGain < saturationGain) break;
    remaining.splice(bestIndex, 1); selectedAssets.push(candidate); metrics = bestMetrics;
    const newContexts = candidate.feature.contexts.filter((context) => !selectedAssets.slice(0, -1).some((asset) => asset.feature.contexts.includes(context)));
    steps.push({
      key: stableKey(candidate),
      path: candidate.item.assetPath ?? candidate.item.id,
      gain: actualGain,
      coverage: metrics,
      reason: newContexts.length ? `Adds ${newContexts.slice(0, 3).join(', ')}` : `Adds a distinct ${options.projectType} view`,
    });
  }
  const stoppedBecause = steps.length >= capacity ? 'limit' : remaining.length ? 'saturated' : 'exhausted';
  return {
    projectId: options.projectId,
    datasetId: options.dataset.id,
    fingerprint: await createAssemblyFingerprint(options.dataset, options.candidates, target),
    algorithm: DATASET_ASSEMBLY_VERSION,
    model: SEMANTIC_FEATURE_MODEL_KEY,
    mode: options.mode,
    target,
    baselineCount: options.baseline.length,
    candidateCount: options.candidates.length,
    selected: steps,
    rejectedDuplicates,
    before,
    after: metrics,
    stoppedBecause,
  };
}
