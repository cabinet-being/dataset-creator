import type { ImageQualitySummary } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { SemanticFeature } from '../analysis/semanticFeatureService';
import { SELECTION_DUPLICATE_SIMILARITY } from '../similarity/similarityLevels';
import { QUALITY_THRESHOLDS } from '../quality/metrics/thresholds';
import { findMedoid } from '../build/buildClusterService';
import {
  createSlicer, encodeAssemblyInputs, pairwiseSimilarity, stableKey, type AssemblyInputAsset, type SkippedAssemblyItem,
} from './datasetAssemblyService';

/**
 * Two-pass selection for a Dataset: pass 1 picks a visually diverse shortlist (~1.75× the need), pass 2 narrows
 * it to the target using tag coverage plus visual diversity. Neither pass changes Dataset membership; duplicates
 * are judged by visual similarity only (never by file or post names).
 */
export const SHORTLIST_FACTOR = 1.75;
export const SHORTLIST_DUPLICATE_THRESHOLD = SELECTION_DUPLICATE_SIMILARITY;
/** Weight of the visual facility-location gain relative to tag coverage in pass 2. */
export const NARROW_VISUAL_WEIGHT = 0.5;

export type ShortlistProgress = { phase: 'similarity' | 'clustering' | 'selecting'; completed: number; total: number };
export type ShortlistItem = { key: string; path: string; item: WorkspaceImage; cluster: string; gain: number; rank: number; reason: string };
export type ShortlistDuplicate = {
  key: string; path: string; keptKey: string; keptPath: string; similarity: number; kind: 'exact' | 'near'; against: 'dataset' | 'shortlist';
};
export type ShortlistCluster = { id: string; size: number; quota: number; selected: number };
export type ShortlistResult = {
  /** Wanted shortlist size (before clamping to the eligible pool). */
  requested: number;
  /** Number of images the Dataset still needs (0 in Auto mode, which has no target). */
  needed: number;
  /** `auto`: one representative per group of similar images, no size limit. */
  mode?: 'auto';
  baselineCount: number;
  poolCount: number;
  eligibleCount: number;
  items: ShortlistItem[];
  duplicates: ShortlistDuplicate[];
  clusters: ShortlistCluster[];
};

const pathOf = (asset: AssemblyInputAsset) => asset.item.assetPath ?? asset.item.id;

export const getShortlistSize = (needed: number, factor = SHORTLIST_FACTOR) => Math.max(0, Math.ceil(needed * factor));

/** Quality tie-break in 0..1 from the triage summary (resolution relative to the target minimum, penalising dark frames). */
export const qualityScoreFromSummary = (summary: ImageQualitySummary | undefined, fallback?: number): number => {
  if (!summary) return fallback ?? 0.5;
  const resolution = Math.min(1, summary.shortSide / Math.max(1, summary.minShortSide * 2));
  return Math.max(0, Math.min(1, resolution * (summary.dark ? 0.25 : 1)));
};

/** Deterministic k-medoids over a similarity matrix: farthest-first seeding from the densest member, then a few refinements. */
const clusterBySimilarity = async (members: readonly number[], matrix: Float32Array, size: number, count: number, slice: () => Promise<void>): Promise<number[][]> => {
  const k = Math.max(1, Math.min(count, members.length));
  let densest = members[0]; let densestSum = -Infinity;
  for (const member of members) {
    let sum = 0;
    for (const other of members) sum += matrix[member * size + other];
    if (sum > densestSum + 1e-9) { densestSum = sum; densest = member; }
    await slice();
  }
  let medoids = [densest];
  const nearest = new Float64Array(members.length);
  members.forEach((member, index) => { nearest[index] = matrix[densest * size + member]; });
  while (medoids.length < k) {
    let pick = -1; let lowest = Infinity;
    members.forEach((member, index) => { if (!medoids.includes(member) && nearest[index] < lowest - 1e-9) { lowest = nearest[index]; pick = index; } });
    if (pick < 0) break;
    medoids.push(members[pick]);
    members.forEach((member, index) => { nearest[index] = Math.max(nearest[index], matrix[members[pick] * size + member]); });
    await slice();
  }
  let groups: number[][] = [];
  for (let round = 0; round < 6; round += 1) {
    groups = medoids.map(() => []);
    for (const member of members) {
      let best = 0; let bestSimilarity = -Infinity;
      medoids.forEach((medoid, index) => {
        const similarity = member === medoid ? 2 : matrix[member * size + medoid];
        if (similarity > bestSimilarity + 1e-9) { bestSimilarity = similarity; best = index; }
      });
      groups[best].push(member);
    }
    const next = groups.map((group, index) => group.length ? findMedoid(group, matrix, size) : medoids[index]);
    await slice();
    if (next.every((medoid, index) => medoid === medoids[index])) break;
    medoids = next;
  }
  return groups.filter((group) => group.length);
};

/** K between √M and M/3 (never above the number of images); quotas grow with √cluster size so dense groups cannot dominate. */
export const planShortlistClusters = (shortlistSize: number, poolSize: number) => {
  const low = Math.max(1, Math.round(Math.sqrt(shortlistSize)));
  const high = Math.max(low, Math.floor(shortlistSize / 3));
  return Math.max(1, Math.min(poolSize, Math.max(low, Math.min(high, Math.round(1.5 * Math.sqrt(shortlistSize))))));
};

/**
 * Lazy greedy (CELF) over a monotone submodular gain: a candidate's last score is an upper bound of its current one,
 * so only the candidates whose bound can still win are recomputed. Winners and tie-breaks (lowest `stableKey` within
 * 1e-12) match a full scan, but most rounds recompute a handful of candidates instead of all of them.
 */
const createLazyGreedy = (indexes: readonly number[], total: number, score: (index: number) => { score: number; gain: number }, keyOf: (index: number) => string) => {
  const bound = new Float64Array(total).fill(Infinity);
  const gains = new Float64Array(total);
  const stamp = new Int32Array(total).fill(-1);
  let epoch = 0;
  return {
    /** Call after the selection state changed (a pick was made). */
    invalidate: () => { epoch += 1; },
    async pick(isCandidate: (index: number) => boolean, slice: () => Promise<void>): Promise<{ index: number; score: number; gain: number } | null> {
      for (;;) {
        let freshBest = -Infinity; let staleTop = -1; let staleBound = -Infinity;
        for (const index of indexes) {
          if (!isCandidate(index)) continue;
          if (stamp[index] === epoch) { if (bound[index] > freshBest) freshBest = bound[index]; }
          else if (bound[index] > staleBound) { staleBound = bound[index]; staleTop = index; }
        }
        if (staleTop >= 0 && staleBound >= freshBest - 1e-12) {
          const value = score(staleTop);
          bound[staleTop] = value.score; gains[staleTop] = value.gain; stamp[staleTop] = epoch;
          await slice();
          continue;
        }
        let pick = -1; let pickScore = -Infinity;
        for (const index of indexes) {
          if (!isCandidate(index) || stamp[index] !== epoch) continue;
          const value = bound[index];
          if (value > pickScore + 1e-12 || (Math.abs(value - pickScore) <= 1e-12 && pick >= 0 && keyOf(index).localeCompare(keyOf(pick)) < 0)) { pick = index; pickScore = value; }
        }
        return pick < 0 ? null : { index: pick, score: pickScore, gain: gains[pick] };
      }
    },
  };
};

export async function buildShortlist(options: {
  baseline: AssemblyInputAsset[]; candidates: AssemblyInputAsset[]; needed: number | 'auto'; factor?: number;
  /** Cosine similarity from which two images count as the same group; defaults to `SHORTLIST_DUPLICATE_THRESHOLD`. */
  duplicateThreshold?: number;
  signal?: AbortSignal; onProgress?: (progress: ShortlistProgress) => void;
}): Promise<ShortlistResult> {
  const slice = createSlicer(options.signal);
  const threshold = options.duplicateThreshold ?? SHORTLIST_DUPLICATE_THRESHOLD;
  const sorted = [...options.candidates].sort((left, right) => stableKey(left).localeCompare(stableKey(right), undefined, { numeric: true, sensitivity: 'base' }));
  const baselineCount = options.baseline.length;
  const assets = [...options.baseline, ...sorted];
  const total = assets.length;
  options.onProgress?.({ phase: 'similarity', completed: 0, total });
  const matrix = await pairwiseSimilarity(assets.map((asset) => asset.feature.image), slice);
  const duplicates: ShortlistDuplicate[] = [];
  const duplicate = (target: number, kept: number, similarity: number, against: ShortlistDuplicate['against']) => duplicates.push({
    key: stableKey(assets[target]), path: pathOf(assets[target]), keptKey: stableKey(assets[kept]), keptPath: pathOf(assets[kept]),
    similarity, kind: assets[target].feature.imageHash === assets[kept].feature.imageHash ? 'exact' : 'near', against,
  });
  // Dataset members are already selected: they count toward coverage and toward the duplicate cutoff.
  const best = new Float64Array(total);
  for (let index = 0; index < baselineCount; index += 1) for (let target = 0; target < total; target += 1) best[target] = Math.max(best[target], matrix[index * total + target]);
  const alive = new Uint8Array(total);
  let eligibleCount = 0;
  for (let index = baselineCount; index < total; index += 1) {
    let nearest = -1; let nearestSimilarity = -Infinity;
    for (let member = 0; member < baselineCount; member += 1) {
      const similarity = assets[member].feature.imageHash === assets[index].feature.imageHash ? 1 : matrix[index * total + member];
      if (similarity > nearestSimilarity) { nearestSimilarity = similarity; nearest = member; }
    }
    if (nearest >= 0 && nearestSimilarity >= threshold) duplicate(index, nearest, nearestSimilarity, 'dataset');
    else { alive[index] = 1; eligibleCount += 1; }
    await slice();
  }
  const auto = options.needed === 'auto';
  const requested = auto ? eligibleCount : getShortlistSize(options.needed as number, options.factor);
  const size = Math.min(requested, eligibleCount);
  const empty: ShortlistResult = { requested, needed: auto ? 0 : options.needed as number, ...(auto ? { mode: 'auto' as const } : {}), baselineCount, poolCount: sorted.length, eligibleCount, items: [], duplicates, clusters: [] };
  if (size <= 0) return empty;

  const eligible = Array.from({ length: total - baselineCount }, (_, index) => baselineCount + index).filter((index) => alive[index]);
  // Auto mode has no quotas: every group of similar images is represented once, so the greedy loop runs until nobody is left.
  let clusters: ShortlistCluster[] = [];
  const clusterOf = new Int32Array(total).fill(-1);
  if (!auto) {
    options.onProgress?.({ phase: 'clustering', completed: 0, total: eligibleCount });
    const groups = (await clusterBySimilarity(eligible, matrix, total, planShortlistClusters(size, eligible.length), slice))
      .map((members) => ({ members, medoidKey: stableKey(assets[findMedoid(members, matrix, total)]) }))
      .sort((left, right) => right.members.length - left.members.length || left.medoidKey.localeCompare(right.medoidKey));
    const weightSum = groups.reduce((sum, group) => sum + Math.sqrt(group.members.length), 0);
    clusters = groups.map((group, index) => ({
      id: `c${index + 1}`, size: group.members.length, quota: Math.max(1, Math.ceil(size * Math.sqrt(group.members.length) / weightSum)), selected: 0,
    }));
    groups.forEach((group, index) => group.members.forEach((member) => { clusterOf[member] = index; }));
  }

  const greedy = createLazyGreedy(eligible, total, (index) => {
    let gain = 0;
    for (let target = 0; target < total; target += 1) { const delta = matrix[index * total + target] - best[target]; if (delta > 0) gain += delta; }
    gain /= total;
    // Quality only nudges: it decides between near-equal gains and never overrides coverage.
    return { gain, score: gain * (1 + 0.15 * (assets[index].quality ?? 0.5)) };
  }, (index) => stableKey(assets[index]));
  const items: ShortlistItem[] = [];
  // Round 2 only runs when duplicates and quotas leave the shortlist short: quotas are doubled, the cutoff stays.
  for (let round = 1; round <= (auto ? 1 : 2) && items.length < size; round += 1) {
    while (items.length < size) {
      const found = await greedy.pick((index) => alive[index] === 1 && (auto || clusters[clusterOf[index]].selected < clusters[clusterOf[index]].quota * round), slice);
      if (!found) break;
      const { index: pick, gain: pickGain } = found;
      const cluster = auto ? null : clusters[clusterOf[pick]];
      if (cluster) cluster.selected += 1;
      alive[pick] = 0;
      for (let target = 0; target < total; target += 1) best[target] = Math.max(best[target], matrix[pick * total + target]);
      let skipped = 0;
      for (const index of eligible) {
        if (!alive[index]) continue;
        const similarity = assets[index].feature.imageHash === assets[pick].feature.imageHash ? 1 : matrix[pick * total + index];
        if (similarity >= threshold) { alive[index] = 0; skipped += 1; duplicate(index, pick, similarity, 'shortlist'); }
      }
      greedy.invalidate();
      items.push({
        key: stableKey(assets[pick]), path: pathOf(assets[pick]), item: assets[pick].item, cluster: cluster ? cluster.id : `g${items.length + 1}`, gain: pickGain, rank: items.length + 1,
        reason: cluster ? `Cluster ${cluster.id} (${cluster.size} similar, quota ${cluster.quota}): +${(pickGain * 100).toFixed(1)}% coverage`
          : skipped ? `Group of ${skipped + 1} similar` : 'Unique image',
      });
      options.onProgress?.({ phase: 'selecting', completed: items.length, total: size });
    }
  }
  return { ...empty, items, clusters };
}

export type NarrowInput = { asset: AssemblyInputAsset; tags: readonly string[] };
export type NarrowedItem = { key: string; path: string; item: WorkspaceImage; gain: number; rank: number; newTags: string[]; reason: string };
export type NarrowResult = { target: number; items: NarrowedItem[]; duplicates: ShortlistDuplicate[]; tagged: number; untagged: number };

/** Tags are compared as the quality metrics do: trimmed, lowercase, spaces and underscores equivalent. */
export const normalizeNarrowTag = (tag: string) => tag.trim().replace(/[\s_]+/g, '_').toLocaleLowerCase();

/** Pass 2: greedy maximum of IDF-weighted, saturating tag coverage plus half of the visual facility-location gain. */
export async function narrowShortlist(options: {
  baseline: AssemblyInputAsset[]; baselineTags?: ReadonlyArray<readonly string[]>; items: NarrowInput[]; target: number;
  /** Trigger word and character trait tags: they carry no variety and are ignored. */
  ignoredTags?: Iterable<string>;
  /** Same meaning as in `buildShortlist`. */
  duplicateThreshold?: number;
  signal?: AbortSignal; onProgress?: (progress: ShortlistProgress) => void;
}): Promise<NarrowResult> {
  const slice = createSlicer(options.signal);
  const threshold = options.duplicateThreshold ?? SHORTLIST_DUPLICATE_THRESHOLD;
  const ignored = new Set([...(options.ignoredTags ?? [])].map(normalizeNarrowTag));
  const entries = [...options.items].sort((left, right) => stableKey(left.asset).localeCompare(stableKey(right.asset), undefined, { numeric: true, sensitivity: 'base' }));
  const baselineCount = options.baseline.length;
  const assets = [...options.baseline, ...entries.map((entry) => entry.asset)];
  const total = assets.length;
  options.onProgress?.({ phase: 'similarity', completed: 0, total });
  const matrix = await pairwiseSimilarity(assets.map((asset) => asset.feature.image), slice);
  const tagSets = entries.map((entry) => new Set(entry.tags.map(normalizeNarrowTag).filter((tag) => tag && !ignored.has(tag))));
  // Tags in almost every shortlisted file distinguish nothing (same convention as the common-tags quality metric).
  const documentFrequency = new Map<string, number>();
  for (const tags of tagSets) for (const tag of tags) documentFrequency.set(tag, (documentFrequency.get(tag) ?? 0) + 1);
  const weights = new Map<string, number>();
  for (const [tag, files] of documentFrequency) {
    if (entries.length >= 3 && files / entries.length >= QUALITY_THRESHOLDS.tags.commonFraction) continue;
    weights.set(tag, Math.log(1 + entries.length / files));
  }
  const weightTotal = Math.max([...weights.values()].reduce((sum, value) => sum + value, 0), 1e-9);
  const counts = new Map<string, number>();
  for (const tags of options.baselineTags ?? []) for (const tag of new Set(tags.map(normalizeNarrowTag))) if (weights.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);

  const best = new Float64Array(total);
  for (let index = 0; index < baselineCount; index += 1) for (let target = 0; target < total; target += 1) best[target] = Math.max(best[target], matrix[index * total + target]);
  const alive = new Uint8Array(total);
  const duplicates: ShortlistDuplicate[] = [];
  const duplicate = (target: number, kept: number, similarity: number, against: ShortlistDuplicate['against']) => duplicates.push({
    key: stableKey(assets[target]), path: pathOf(assets[target]), keptKey: stableKey(assets[kept]), keptPath: pathOf(assets[kept]),
    similarity, kind: assets[target].feature.imageHash === assets[kept].feature.imageHash ? 'exact' : 'near', against,
  });
  for (let index = baselineCount; index < total; index += 1) {
    let nearest = -1; let nearestSimilarity = -Infinity;
    for (let member = 0; member < baselineCount; member += 1) if (matrix[index * total + member] > nearestSimilarity) { nearestSimilarity = matrix[index * total + member]; nearest = member; }
    if (nearest >= 0 && nearestSimilarity >= threshold) duplicate(index, nearest, nearestSimilarity, 'dataset'); else alive[index] = 1;
  }
  const items: NarrowedItem[] = [];
  const want = Math.max(0, Math.min(options.target, entries.length));
  const narrowIndexes = Array.from({ length: total - baselineCount }, (_, index) => baselineCount + index);
  const greedy = createLazyGreedy(narrowIndexes, total, (index) => {
    let tagGain = 0;
    for (const tag of tagSets[index - baselineCount]) { const weight = weights.get(tag); if (weight) tagGain += weight * 0.5 ** ((counts.get(tag) ?? 0) + 1); }
    let visualGain = 0;
    for (let target = 0; target < total; target += 1) { const delta = matrix[index * total + target] - best[target]; if (delta > 0) visualGain += delta; }
    const gain = tagGain / weightTotal + NARROW_VISUAL_WEIGHT * (visualGain / total);
    return { gain, score: gain * (1 + 0.05 * (assets[index].quality ?? 0.5)) };
  }, (index) => stableKey(assets[index]));
  while (items.length < want) {
    const found = await greedy.pick((index) => alive[index] === 1, slice);
    const pick = found ? found.index : -1;
    const pickGain = found ? found.gain : 0;
    if (pick < 0) break;
    alive[pick] = 0;
    const newTags = [...tagSets[pick - baselineCount]].filter((tag) => weights.has(tag) && !counts.get(tag));
    for (const tag of tagSets[pick - baselineCount]) if (weights.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    for (let target = 0; target < total; target += 1) best[target] = Math.max(best[target], matrix[pick * total + target]);
    for (let index = baselineCount; index < total; index += 1) if (alive[index] && matrix[pick * total + index] >= threshold) { alive[index] = 0; duplicate(index, pick, matrix[pick * total + index], 'shortlist'); }
    greedy.invalidate();
    items.push({
      key: stableKey(assets[pick]), path: pathOf(assets[pick]), item: assets[pick].item, gain: pickGain, rank: items.length + 1, newTags,
      reason: newTags.length ? `Adds ${newTags.slice(0, 3).join(', ')}` : 'Adds visual variety',
    });
    options.onProgress?.({ phase: 'selecting', completed: items.length, total: want });
  }
  const tagged = tagSets.filter((tags) => tags.size > 0).length;
  return { target: options.target, items, duplicates, tagged, untagged: entries.length - tagged };
}

/** Encodes `items` (baseline first) and runs pass 1. Items that cannot be read are reported through `onSkip`, never abort the run. */
export async function computeShortlist(options: {
  baselineItems: WorkspaceImage[]; poolItems: WorkspaceImage[]; needed: number | 'auto'; triggerWord: string;
  encoder: { encode(item: WorkspaceImage, caption: string): Promise<SemanticFeature> };
  qualityOf?: (item: WorkspaceImage) => number | undefined;
  duplicateThreshold?: number;
  signal?: AbortSignal; onEncodeProgress?: (completed: number, total: number) => void; onProgress?: (progress: ShortlistProgress) => void;
  onSkip?: (skipped: SkippedAssemblyItem) => void;
}): Promise<ShortlistResult> {
  const features = await encodeAssemblyInputs([...options.baselineItems, ...options.poolItems], {
    triggerWord: options.triggerWord, encoder: options.encoder, signal: options.signal, onProgress: options.onEncodeProgress, onSkip: options.onSkip,
  });
  const baselineSet = new Set(options.baselineItems);
  const withQuality = (asset: AssemblyInputAsset) => ({ ...asset, quality: options.qualityOf?.(asset.item) ?? asset.quality });
  return buildShortlist({
    baseline: features.filter((entry) => baselineSet.has(entry.item)), candidates: features.filter((entry) => !baselineSet.has(entry.item)).map(withQuality),
    needed: options.needed, duplicateThreshold: options.duplicateThreshold, signal: options.signal, onProgress: options.onProgress,
  });
}

/** Encodes the Dataset and the shortlisted items and runs pass 2; `tagsOf` returns the resolved caption or suggestion tags of an item. */
export async function computeNarrowing(options: {
  baselineItems: WorkspaceImage[]; shortlistItems: WorkspaceImage[]; target: number; triggerWord: string;
  tagsOf: (item: WorkspaceImage) => readonly string[]; ignoredTags?: Iterable<string>;
  encoder: { encode(item: WorkspaceImage, caption: string): Promise<SemanticFeature> };
  qualityOf?: (item: WorkspaceImage) => number | undefined;
  duplicateThreshold?: number;
  signal?: AbortSignal; onEncodeProgress?: (completed: number, total: number) => void; onProgress?: (progress: ShortlistProgress) => void;
  onSkip?: (skipped: SkippedAssemblyItem) => void;
}): Promise<NarrowResult> {
  const features = await encodeAssemblyInputs([...options.baselineItems, ...options.shortlistItems], {
    triggerWord: options.triggerWord, encoder: options.encoder, signal: options.signal, onProgress: options.onEncodeProgress, onSkip: options.onSkip,
  });
  const baselineSet = new Set(options.baselineItems);
  const baseline = features.filter((entry) => baselineSet.has(entry.item));
  return narrowShortlist({
    baseline, baselineTags: baseline.map((entry) => options.tagsOf(entry.item)),
    items: features.filter((entry) => !baselineSet.has(entry.item)).map((asset) => ({ asset: { ...asset, quality: options.qualityOf?.(asset.item) ?? asset.quality }, tags: options.tagsOf(asset.item) })),
    target: options.target, ignoredTags: options.ignoredTags, duplicateThreshold: options.duplicateThreshold, signal: options.signal, onProgress: options.onProgress,
  });
}
