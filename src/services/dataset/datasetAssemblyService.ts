import type { Dataset, ProjectType } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { SemanticFeature } from '../analysis/semanticFeatureService';
import { SEMANTIC_FEATURE_MODEL_KEY, isSemanticModelError } from '../analysis/semanticFeatureService';
import { cosineSimilarity, createCoverageUniverse, getStableSceneGroup, type CoverageAsset, type CoverageMetrics } from './coverageService';
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
const stableSet = (values?: ReadonlySet<string>) => [...(values ?? [])].sort();

export const createAssemblyFingerprint = async (
  dataset: Pick<Dataset, 'id'>,
  assets: AssemblyInputAsset[],
  request: { mode?: AssemblyMode; excludedKeys?: ReadonlySet<string>; pinnedKeys?: ReadonlySet<string> }
) => {
  const options = request;
  const value = JSON.stringify({
    version: DATASET_ASSEMBLY_CACHE_VERSION, datasetId: dataset.id,
    assets: assets.map((asset) => [stableKey(asset), asset.feature.imageHash, asset.caption]),
    mode: options.mode,
    excluded: stableSet(options.excludedKeys), pinned: stableSet(options.pinnedKeys),
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const limitsFor = (mode: AssemblyMode, baseline: number) => {
  if (mode.kind === 'total') return { minimum: Math.max(0, mode.target - baseline), capacity: Math.max(0, mode.target - baseline) };
  if (mode.kind === 'range') return { minimum: Math.max(0, mode.min - baseline), capacity: Math.max(0, mode.max - baseline) };
  if (mode.kind === 'max-new') return { minimum: 0, capacity: Math.max(0, mode.maxNew) };
  if (mode.kind === 'limit') return { minimum: 0, capacity: Math.max(0, mode.limit) };
  return { minimum: 0, capacity: Infinity };
};

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

export async function assembleDataset(options: {
  projectId: string; projectType: ProjectType; dataset: Dataset; baseline: AssemblyInputAsset[]; candidates: AssemblyInputAsset[];
  mode: AssemblyMode; excludedKeys?: ReadonlySet<string>; pinnedKeys?: ReadonlySet<string>;
  signal?: AbortSignal; onProgress?: (progress: AssemblyProgress) => void;
}): Promise<DatasetAssemblyPlan> {
  const slice = createSlicer(options.signal);
  const sorted = [...options.candidates].sort((left, right) => stableKey(left).localeCompare(stableKey(right), undefined, { numeric:true, sensitivity:'base' }));
  const accepted: AssemblyInputAsset[] = [];
  const duplicatePairs: DuplicatePair[] = [];
  const rejectedCandidates: RejectedCandidate[] = [];
  let excludedCount = 0;
  // Visual similarities of baseline + non-excluded candidates are computed once and reused for duplicates and coverage.
  const poolAssets = [...options.baseline, ...sorted.filter((candidate) => !options.excludedKeys?.has(stableKey(candidate)))];
  options.onProgress?.({ phase: 'similarity', completed: 0, total: poolAssets.length });
  const pool = poolAssets.length;
  const visual = await pairwiseSimilarity(poolAssets.map((asset) => asset.feature.image), slice);
  const reference: Array<{ asset: AssemblyInputAsset; pool: number }> = options.baseline.map((asset, index) => ({ asset, pool: index }));
  const byHash = new Map<string, AssemblyInputAsset>();
  for (const { asset } of reference) if (!byHash.has(asset.feature.imageHash)) byHash.set(asset.feature.imageHash, asset);
  const acceptedPool: number[] = [];
  let nextPool = options.baseline.length;
  for (const candidate of sorted) {
    const key = stableKey(candidate);
    if (options.excludedKeys?.has(key)) { excludedCount += 1; rejectedCandidates.push({path:key,reason:'excluded'}); continue; }
    const poolIndex = nextPool; nextPool += 1;
    const exact = byHash.get(candidate.feature.imageHash);
    if (exact) { duplicatePairs.push({kept:stableKey(exact),rejected:key,kind:'exact',similarity:1}); rejectedCandidates.push({path:key,reason:'exact-duplicate'}); continue; }
    let nearest: { asset: AssemblyInputAsset; similarity: number } | null = null;
    for (const entry of reference) {
      const similarity = visual[poolIndex * pool + entry.pool];
      if (!nearest || similarity > nearest.similarity) nearest = { asset: entry.asset, similarity };
    }
    if (nearest && nearest.similarity >= NEAR_DUPLICATE_THRESHOLD) {
      duplicatePairs.push({kept:stableKey(nearest.asset),rejected:key,kind:'near',similarity:nearest.similarity});
      rejectedCandidates.push({path:key,reason:'near-duplicate'}); continue;
    }
    accepted.push(candidate); acceptedPool.push(poolIndex);
    reference.push({ asset: candidate, pool: poolIndex }); byHash.set(candidate.feature.imageHash, candidate);
  }
  const baselineCount = options.baseline.length;
  const universe = createCoverageUniverse([...options.baseline, ...accepted].map(coverageAsset));
  const size = universe.assets.length;
  const universePool = [...options.baseline.map((_, index) => index), ...acceptedPool];
  const weights = universe.weights;
  const visualDenominator = Math.max(universe.denominator, 0.0001);
  const hasText = universe.textDenominator > 0;
  const hasContext = universe.contexts.length > 0;
  const captioned = universe.assets.map((asset) => Boolean(asset.feature.caption.trim()));
  const text = hasText ? await pairwiseSimilarity(universe.assets.map((asset) => asset.feature.text), slice) : null;
  const normalizer = Math.max(0.6 + (hasText ? 0.25 : 0) + (hasContext ? 0.15 : 0), 0.01);
  const sceneGroups = universe.assets.map(getStableSceneGroup);
  const groupCounts = new Map<string, number>();
  // Incremental coverage state: best similarity of every universe asset to the selected set.
  const bestVisual = new Float64Array(size);
  const bestText = new Float64Array(size);
  const covered = new Set<string>();
  let visualSum = 0; let textSum = 0;
  const visualAt = (target: number, selected: number) => visual[universePool[selected] * pool + universePool[target]];
  const select = (selected: number) => {
    for (let target = 0; target < size; target += 1) {
      const similarity = visualAt(target, selected);
      if (similarity > bestVisual[target]) { visualSum += weights[target] * (similarity - bestVisual[target]); bestVisual[target] = similarity; }
      if (text && captioned[selected] && captioned[target]) {
        const textSimilarity = text[selected * size + target];
        if (textSimilarity > bestText[target]) { textSum += weights[target] * (textSimilarity - bestText[target]); bestText[target] = textSimilarity; }
      }
    }
    for (const context of universe.assets[selected].feature.contexts) covered.add(context);
    groupCounts.set(sceneGroups[selected], (groupCounts.get(sceneGroups[selected]) ?? 0) + 1);
  };
  const measure = (): CoverageMetrics => {
    if (!size) return { visual: 0, text: null, context: null, total: 0 };
    const visualValue = visualSum / visualDenominator;
    const textValue = hasText ? textSum / universe.textDenominator : null;
    const contextValue = hasContext ? universe.contexts.filter((context) => covered.has(context)).length / universe.contexts.length : null;
    return { visual: visualValue, text: textValue, context: contextValue, total: (visualValue * 0.6 + (textValue ?? 0) * 0.25 + (contextValue ?? 0) * 0.15) / normalizer };
  };
  for (let index = 0; index < baselineCount; index += 1) { select(index); await slice(); }
  const steps: AssemblyStep[] = [];
  const saturationGain = options.mode.saturationGain ?? 0.0025;
  let metrics = measure();
  const before = metrics;
  const { minimum, capacity } = limitsFor(options.mode, options.baseline.length);
  const remaining = accepted.map((asset, index) => ({ asset, index: baselineCount + index }));
  const progressTotal = Math.min(capacity, remaining.length);
  let evaluated = 0; let saturated = false;
  while (remaining.length && steps.length < capacity) {
    let bestIndex = -1; let bestGain = -Infinity; let bestCoverageGain = 0;
    for (let position = 0; position < remaining.length; position += 1) {
      evaluated += 1;
      const { asset: candidate, index: universeIndex } = remaining[position];
      // Exact coverage gain of adding this candidate, from the per-target best values.
      let visualGain = 0; let textGain = 0; let newContexts = 0;
      for (let target = 0; target < size; target += 1) {
        const delta = visualAt(target, universeIndex) - bestVisual[target];
        if (delta > 0) visualGain += weights[target] * delta;
      }
      if (text && captioned[universeIndex]) {
        for (let target = 0; target < size; target += 1) {
          if (!captioned[target]) continue;
          const delta = text[universeIndex * size + target] - bestText[target];
          if (delta > 0) textGain += weights[target] * delta;
        }
      }
      if (hasContext) for (const context of new Set(candidate.feature.contexts)) if (!covered.has(context)) newContexts += 1;
      const coverageGain = ((visualGain / visualDenominator) * 0.6 + (hasText ? (textGain / universe.textDenominator) * 0.25 : 0) + (hasContext ? (newContexts / universe.contexts.length) * 0.15 : 0)) / normalizer;
      const pinned = options.pinnedKeys?.has(stableKey(candidate));
      // Bonuses rank useful candidates; they must not let a saturated candidate
      // stop selection while another candidate still improves coverage.
      if (!pinned && steps.length >= minimum && coverageGain < saturationGain) { await slice(); continue; }
      const gain = coverageGain - (groupCounts.get(sceneGroups[universeIndex]) ?? 0) * 0.002 + (pinned ? 1 : 0);
      if (gain > bestGain + 1e-9 || (Math.abs(gain-bestGain)<=1e-9 && stableKey(candidate).localeCompare(stableKey(remaining[bestIndex]?.asset ?? candidate))<0)) {
        bestIndex=position; bestGain=gain; bestCoverageGain=coverageGain;
      }
      await slice();
    }
    if (bestIndex < 0) { saturated = true; break; }
    const { asset: candidate, index: universeIndex } = remaining[bestIndex];
    const actualGain = Math.max(0, bestCoverageGain);
    remaining.splice(bestIndex,1);
    const newContexts = candidate.feature.contexts.filter((context) => !covered.has(context));
    select(universeIndex); metrics = measure();
    const sceneGroup = sceneGroups[universeIndex];
    steps.push({key:stableKey(candidate),path:candidate.item.assetPath ?? candidate.item.id,gain:actualGain,coverage:metrics,sceneGroup,
      reason:newContexts.length ? `Adds ${newContexts.slice(0,3).join(', ')}` : `Balances ${sceneGroup}`});
    options.onProgress?.({ phase: 'selecting', completed: steps.length, total: progressTotal });
    await slice();
  }
  remaining.forEach(({ asset }) => rejectedCandidates.push({path:stableKey(asset),reason:'not-selected'}));
  const desired = options.mode.kind==='total' ? options.mode.target : options.mode.kind==='range' ? options.mode.min : 0;
  const finalTotal = options.baseline.length + steps.length;
  const shortfall = Math.max(0, desired-finalTotal);
  let stoppedBecause: DatasetAssemblyPlan['stoppedBecause'];
  if (shortfall>0 && !remaining.length) stoppedBecause='insufficient-pool';
  else if (options.mode.kind==='total' && finalTotal>=options.mode.target) stoppedBecause='target-reached';
  else if (options.mode.kind==='range' && finalTotal>=options.mode.max) stoppedBecause='range-max';
  else if (options.mode.kind==='max-new' && steps.length>=options.mode.maxNew) stoppedBecause='max-new';
  else if (options.mode.kind==='limit' && steps.length>=options.mode.limit) stoppedBecause='max-new';
  else if (saturated) stoppedBecause='saturated'; else stoppedBecause='exhausted';
  const groups = new Map<string,{id:string;baseline:number;pool:number;selected:number}>();
  const count = (asset:AssemblyInputAsset, field:'baseline'|'pool') => { const id=getStableSceneGroup(coverageAsset(asset)); const row=groups.get(id)??{id,baseline:0,pool:0,selected:0}; row[field]+=1; groups.set(id,row); };
  options.baseline.forEach((asset)=>count(asset,'baseline')); accepted.forEach((asset)=>count(asset,'pool'));
  steps.forEach((step)=>{const row=groups.get(step.sceneGroup)??{id:step.sceneGroup,baseline:0,pool:0,selected:0};row.selected+=1;groups.set(step.sceneGroup,row);});
  return {
    projectId:options.projectId,datasetId:options.dataset.id,
    fingerprint:await createAssemblyFingerprint(options.dataset,[...options.baseline,...options.candidates],{mode:options.mode,excludedKeys:options.excludedKeys,pinnedKeys:options.pinnedKeys}),
    algorithm:DATASET_ASSEMBLY_VERSION,model:SEMANTIC_FEATURE_MODEL_KEY,mode:options.mode,
    baselineCount:options.baseline.length,candidateCount:options.candidates.length,selected:steps,
    rejectedDuplicates:duplicatePairs.map((pair)=>pair.rejected),duplicatePairs,rejectedCandidates,
    sceneGroups:[...groups.values()].sort((left,right)=>left.id.localeCompare(right.id)),
    funnel:{baseline:options.baseline.length,pool:options.candidates.length,excluded:excludedCount,
      exactDuplicates:duplicatePairs.filter((pair)=>pair.kind==='exact').length,nearDuplicates:duplicatePairs.filter((pair)=>pair.kind==='near').length,
      eligible:accepted.length,evaluated,selected:steps.length},before,after:metrics,stoppedBecause,shortfall,
  };
}
