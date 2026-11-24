import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { SemanticFeature } from '../analysis/semanticFeatureService';
import { SEMANTIC_FEATURE_MODEL_KEY, isSemanticModelError } from '../analysis/semanticFeatureService';
import { cosineSimilarity, type CoverageAsset, type CoverageMetrics } from './coverageService';
import { resolveAssetCaption } from '../caption/captionResolver';
import { normalizeDatasetPath } from './datasetMembershipResolver';
import { getSimilarityThreshold } from '../similarity/similarityLevels';

export const DATASET_ASSEMBLY_VERSION = 'diversity-v3';
export const DATASET_ASSEMBLY_CACHE_VERSION = `${DATASET_ASSEMBLY_VERSION}:${SEMANTIC_FEATURE_MODEL_KEY}`;
export const NEAR_DUPLICATE_THRESHOLD = getSimilarityThreshold('near-copy', 'dinov2');
export type AssemblyMode =
  | { kind: 'auto'; saturationGain?: number }
  | { kind: 'total'; target: number; saturationGain?: number }
  | { kind: 'range'; min: number; max: number; saturationGain?: number }
  | { kind: 'max-new'; maxNew: number; saturationGain?: number }
  /** @deprecated Compatibility for previews created before diversity-v2. */
  | { kind: 'limit'; limit: number; saturationGain?: number };
export type AssemblyInputAsset = { item: WorkspaceImage; feature: SemanticFeature; caption: string; quality?: number };
export type AssemblyStep = { key: string; path: string; gain: number; reason: string; coverage: CoverageMetrics; sceneGroup: string };
export type DuplicatePair = { kept: string; rejected: string; kind: 'exact' | 'near'; similarity: number };
export type RejectedCandidate = { path: string; reason: 'excluded' | 'exact-duplicate' | 'near-duplicate' | 'not-selected' };
export type DatasetAssemblyPlan = {
  projectId: string; datasetId: string; fingerprint: string; algorithm: string; model: string; mode: AssemblyMode;
  baselineCount: number; candidateCount: number; selected: AssemblyStep[]; rejectedDuplicates: string[]; duplicatePairs: DuplicatePair[];
  rejectedCandidates: RejectedCandidate[]; sceneGroups: Array<{ id: string; baseline: number; pool: number; selected: number }>;
  funnel: { baseline: number; pool: number; excluded: number; exactDuplicates: number; nearDuplicates: number; eligible: number; evaluated: number; selected: number };
  before: CoverageMetrics; after: CoverageMetrics;
  stoppedBecause: 'target-reached' | 'range-max' | 'max-new' | 'saturated' | 'exhausted' | 'insufficient-pool';
  shortfall: number;
};

export type SkippedAssemblyItem = { item: WorkspaceImage; reason: string };

/** Encodes images and captions for assembly; yields to the event loop between items. An item that cannot be encoded is skipped (reported via `onSkip`), never aborting the run. */
export async function encodeAssemblyInputs(items: WorkspaceImage[], options: {
  triggerWord: string;
  encoder: { encode(item: WorkspaceImage, caption: string): Promise<SemanticFeature> };
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  onSkip?: (skipped: SkippedAssemblyItem) => void;
}): Promise<AssemblyInputAsset[]> {
  const features: AssemblyInputAsset[] = [];
  for (let index = 0; index < items.length; index += 1) {
    options.signal?.throwIfAborted();
    const item = items[index];
    options.onProgress?.(index, items.length);
    try {
      const caption = resolveAssetCaption(item, options.triggerWord).normalized;
      features.push({ item, caption, feature: await options.encoder.encode(item, caption), quality: item.dimensionsKnown === false ? 0 : Math.min(1, Math.sqrt(item.width * item.height) / 1024) });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isSemanticModelError(error)) throw error;
      options.onSkip?.({ item, reason: error instanceof Error && error.message ? error.message : 'Could not be read' });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return features;
}

export const stableKey = (asset: AssemblyInputAsset) => normalizeDatasetPath(asset.item.assetPath ?? asset.item.id);
export const coverageAsset = (asset: AssemblyInputAsset): CoverageAsset => ({ key: stableKey(asset), feature: asset.feature });
const SLICE_MS = 16;
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export const createSlicer = (signal?: AbortSignal) => {
  let sliceStart = performance.now();
  return async () => {
    signal?.throwIfAborted();
    if (performance.now() - sliceStart < SLICE_MS) return;
    await nextTask();
    signal?.throwIfAborted();
    sliceStart = performance.now();
  };
};
/** Row-major n×n clamped cosine similarity (Float32Array, computed once; 2000² = 16 MB). */
export const pairwiseSimilarity = async (vectors: readonly Float32Array[], slice: () => Promise<void>): Promise<Float32Array> => {
  const size = vectors.length;
  const matrix = new Float32Array(size * size);
  for (let left = 0; left < size; left += 1) {
    for (let right = left; right < size; right += 1) {
      const value = cosineSimilarity(vectors[left], vectors[right]);
      matrix[left * size + right] = value; matrix[right * size + left] = value;
    }
    await slice();
  }
  return matrix;
};

export type AssemblyProgress = { phase: 'similarity' | 'selecting'; completed: number; total: number };
