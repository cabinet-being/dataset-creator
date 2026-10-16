import type { Dataset, ProjectType } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { SemanticFeature } from '../analysis/semanticFeatureService';
import { encodeCaptionText, SEMANTIC_FEATURE_MODEL_KEY } from '../analysis/semanticFeatureService';
import { cosineSimilarity, createCoverageUniverse, getStableSceneGroup, measureCoverage, type CoverageAsset, type CoverageMetrics } from './coverageService';
import { normalizeDatasetPath } from './datasetMembershipResolver';

export const DATASET_ASSEMBLY_VERSION = 'diversity-v3';
export const DATASET_ASSEMBLY_CACHE_VERSION = `${DATASET_ASSEMBLY_VERSION}:${SEMANTIC_FEATURE_MODEL_KEY}`;
export const NEAR_DUPLICATE_THRESHOLD = 0.985;
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
  projectId: string; datasetId: string; fingerprint: string; algorithm: string; model: string; mode: AssemblyMode; target: string;
  baselineCount: number; candidateCount: number; selected: AssemblyStep[]; rejectedDuplicates: string[]; duplicatePairs: DuplicatePair[];
  rejectedCandidates: RejectedCandidate[]; sceneGroups: Array<{ id: string; baseline: number; pool: number; selected: number }>;
  funnel: { baseline: number; pool: number; excluded: number; exactDuplicates: number; nearDuplicates: number; eligible: number; evaluated: number; selected: number };
  before: CoverageMetrics; after: CoverageMetrics;
  stoppedBecause: 'target-reached' | 'range-max' | 'max-new' | 'saturated' | 'exhausted' | 'insufficient-pool';
  shortfall: number;
};

const stableKey = (asset: AssemblyInputAsset) => normalizeDatasetPath(asset.item.assetPath ?? asset.item.id);
export const coverageAsset = (asset: AssemblyInputAsset): CoverageAsset => ({ key: stableKey(asset), feature: asset.feature });
const stableSet = (values?: ReadonlySet<string>) => [...(values ?? [])].sort();

export const createAssemblyFingerprint = async (
  dataset: Pick<Dataset, 'id'>,
  assets: AssemblyInputAsset[],
  request: string | { target?: string; mode?: AssemblyMode; excludedKeys?: ReadonlySet<string>; pinnedKeys?: ReadonlySet<string> }
) => {
  const options = typeof request === 'string' ? { target: request } : request;
  const value = JSON.stringify({
    version: DATASET_ASSEMBLY_CACHE_VERSION, datasetId: dataset.id,
    assets: assets.map((asset) => [stableKey(asset), asset.feature.imageHash, asset.caption]),
    target: options.target?.trim() ?? '', mode: options.mode,
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

export async function assembleDataset(options: {
  projectId: string; projectType: ProjectType; dataset: Dataset; baseline: AssemblyInputAsset[]; candidates: AssemblyInputAsset[];
  mode: AssemblyMode; target?: string; excludedKeys?: ReadonlySet<string>; pinnedKeys?: ReadonlySet<string>;
}): Promise<DatasetAssemblyPlan> {
  const target = options.target?.trim() ?? '';
  const targetFeature = target ? encodeCaptionText(target) : null;
  const sorted = [...options.candidates].sort((left, right) => stableKey(left).localeCompare(stableKey(right), undefined, { numeric:true, sensitivity:'base' }));
  const accepted: AssemblyInputAsset[] = [];
  const reference = [...options.baseline];
  const duplicatePairs: DuplicatePair[] = [];
  const rejectedCandidates: RejectedCandidate[] = [];
  let excludedCount = 0;
  for (const candidate of sorted) {
    const key = stableKey(candidate);
    if (options.excludedKeys?.has(key)) { excludedCount += 1; rejectedCandidates.push({path:key,reason:'excluded'}); continue; }
    const exact = reference.find((item) => item.feature.imageHash === candidate.feature.imageHash);
    if (exact) { duplicatePairs.push({kept:stableKey(exact),rejected:key,kind:'exact',similarity:1}); rejectedCandidates.push({path:key,reason:'exact-duplicate'}); continue; }
    const nearest = reference.reduce<{asset:AssemblyInputAsset;similarity:number}|null>((best, item) => {
      const similarity = cosineSimilarity(item.feature.image, candidate.feature.image);
      return !best || similarity > best.similarity ? {asset:item,similarity} : best;
    }, null);
    if (nearest && nearest.similarity >= NEAR_DUPLICATE_THRESHOLD) {
      duplicatePairs.push({kept:stableKey(nearest.asset),rejected:key,kind:'near',similarity:nearest.similarity});
      rejectedCandidates.push({path:key,reason:'near-duplicate'}); continue;
    }
    accepted.push(candidate); reference.push(candidate);
  }
  const universe = createCoverageUniverse([...options.baseline, ...accepted].map(coverageAsset));
  const selectedAssets = [...options.baseline];
  const remaining = [...accepted];
  const steps: AssemblyStep[] = [];
  const saturationGain = options.mode.saturationGain ?? 0.0025;
  let metrics = measureCoverage(selectedAssets.map(coverageAsset), universe);
  const before = metrics;
  const { minimum, capacity } = limitsFor(options.mode, options.baseline.length);
  let evaluated = 0; let saturated = false;
  while (remaining.length && steps.length < capacity) {
    let bestIndex = -1; let bestGain = -Infinity; let bestMetrics = metrics;
    for (let index = 0; index < remaining.length; index += 1) {
      evaluated += 1;
      const candidate = remaining[index];
      const nextMetrics = measureCoverage([...selectedAssets, candidate].map(coverageAsset), universe);
      const pinned = options.pinnedKeys?.has(stableKey(candidate));
      // Bonuses rank useful candidates; they must not let a saturated candidate
      // stop selection while another candidate still improves coverage.
      if (!pinned && steps.length >= minimum && nextMetrics.total - metrics.total < saturationGain) continue;
      const targetRelevance = targetFeature && candidate.caption ? cosineSimilarity(targetFeature, candidate.feature.text) : 0;
      const group = getStableSceneGroup(coverageAsset(candidate));
      const repeatedSeries = selectedAssets.filter((asset) => getStableSceneGroup(coverageAsset(asset)) === group).length;
      const gain = nextMetrics.total - metrics.total + targetRelevance * 0.04 - repeatedSeries * 0.002 + (pinned ? 1 : 0);
      if (gain > bestGain + 1e-9 || (Math.abs(gain-bestGain)<=1e-9 && stableKey(candidate).localeCompare(stableKey(remaining[bestIndex] ?? candidate))<0)) {
        bestIndex=index; bestGain=gain; bestMetrics=nextMetrics;
      }
    }
    if (bestIndex < 0) { saturated = true; break; }
    const candidate = remaining[bestIndex];
    const actualGain = Math.max(0, bestMetrics.total - metrics.total);
    remaining.splice(bestIndex,1); selectedAssets.push(candidate); metrics=bestMetrics;
    const sceneGroup = getStableSceneGroup(coverageAsset(candidate));
    const newContexts = candidate.feature.contexts.filter((context) => !selectedAssets.slice(0,-1).some((asset) => asset.feature.contexts.includes(context)));
    steps.push({key:stableKey(candidate),path:candidate.item.assetPath ?? candidate.item.id,gain:actualGain,coverage:metrics,sceneGroup,
      reason:newContexts.length ? `Adds ${newContexts.slice(0,3).join(', ')}` : `Balances ${sceneGroup}`});
  }
  remaining.forEach((candidate) => rejectedCandidates.push({path:stableKey(candidate),reason:'not-selected'}));
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
    fingerprint:await createAssemblyFingerprint(options.dataset,[...options.baseline,...options.candidates],{target,mode:options.mode,excludedKeys:options.excludedKeys,pinnedKeys:options.pinnedKeys}),
    algorithm:DATASET_ASSEMBLY_VERSION,model:SEMANTIC_FEATURE_MODEL_KEY,mode:options.mode,target,
    baselineCount:options.baseline.length,candidateCount:options.candidates.length,selected:steps,
    rejectedDuplicates:duplicatePairs.map((pair)=>pair.rejected),duplicatePairs,rejectedCandidates,
    sceneGroups:[...groups.values()].sort((left,right)=>left.id.localeCompare(right.id)),
    funnel:{baseline:options.baseline.length,pool:options.candidates.length,excluded:excludedCount,
      exactDuplicates:duplicatePairs.filter((pair)=>pair.kind==='exact').length,nearDuplicates:duplicatePairs.filter((pair)=>pair.kind==='near').length,
      eligible:accepted.length,evaluated,selected:steps.length},before,after:metrics,stoppedBecause,shortfall,
  };
}
