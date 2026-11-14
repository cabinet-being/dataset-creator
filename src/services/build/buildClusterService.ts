import type { BuildReviewDecision, BuildSession, ImageQualitySummary } from '../../types';
import { isProjectDatasetPath } from '../dataset/datasetFolderService';
import { classifyImageQuality } from '../quality/imageQuality';
import { vendiScore } from '../quality/metrics/vendi';
import { normalizeVector } from '../quality/metrics/vectorMath';
import { performClusteringSliced } from '../similarity/similarityService';
import {
  getStrictnessThreshold, isExactDuplicate, type SimilarityBasis, type SimilarityStrictnessId,
} from '../similarity/similarityLevels';
import { getBuildAssetId, getBuildTriageGroup, type BuildCandidate } from './buildSessionService';

/**
 * Clusters of Build candidates by DINOv2 similarity, for reviewing hundreds of frames in groups.
 * No DOM or React: the hook and view live in `components/build`. Member ids are workspace image ids
 * (the keys of `SimilarityFeatures.embeddings`); Build records are reached through `getBuildAssetId`.
 */

export type BuildClusterKind = 'near-duplicate' | 'theme';
export type BuildCluster = {
  id: string;
  kind: BuildClusterKind;
  /** In the order of the input ids. */
  memberIds: string[];
  medoidId: string;
  avgSimilarity: number;
};
export type BuildVendi = { before: number; after: number; removable: number };
export type BuildClusterResult = {
  key: string;
  basis: SimilarityBasis;
  nearDuplicateGroups: BuildCluster[];
  /** Clusters of at least two images at the chosen strictness; empty for the histogram basis. */
  themes: BuildCluster[];
  /** Ids that belong to no theme cluster (DINOv2 only). */
  unclusteredIds: string[];
  vendi: BuildVendi | null;
};
export type BuildClusterOptions = { signal?: AbortSignal; yieldToUi?: () => Promise<void>; sliceMs?: number };
export type BuildClusterInput = {
  ids: string[];
  embeddings: Readonly<Record<string, Float32Array>>;
  sha256ById: Readonly<Record<string, string>>;
  basis: SimilarityBasis;
  strictness: SimilarityStrictnessId;
};

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Depends only on what the clusters are computed from, never on decisions or tags. */
export const createBuildClusterKey = (input: Pick<BuildClusterInput, 'ids' | 'sha256ById' | 'basis' | 'strictness'>): string => {
  const { basis, strictness, ids, sha256ById } = input;
  const members = ids.map((id) => `${id}:${sha256ById[id] ?? ''}`).sort().join(',');
  return `${basis}|${getStrictnessThreshold('strict', basis)}|${getStrictnessThreshold(strictness, basis)}|${members}`;
};

/** Row-major n×n cosine similarity; vectors are normalized once, exact duplicates (SHA-256) are 1. */
export const computeSimilarityMatrix = async (
  input: { ids: readonly string[]; embeddings: Readonly<Record<string, Float32Array>>; sha256ById: Readonly<Record<string, string>> },
  options: BuildClusterOptions = {}
): Promise<Float32Array> => {
  const { ids, embeddings, sha256ById } = input;
  const { signal, sliceMs = 12 } = options;
  const yieldToUi = options.yieldToUi ?? defaultYield;
  const count = ids.length;
  const rows = ids.map((id) => normalizeVector(embeddings[id]));
  const matrix = new Float32Array(count * count);
  let sliceStart = performance.now();
  for (let left = 0; left < count; left += 1) {
    signal?.throwIfAborted();
    matrix[left * count + left] = 1;
    const leftRow = rows[left];
    const leftSha = sha256ById[ids[left]];
    for (let right = left + 1; right < count; right += 1) {
      let value = 0;
      if (isExactDuplicate({ sha256: leftSha }, { sha256: sha256ById[ids[right]] })) value = 1;
      else {
        const rightRow = rows[right];
        if (leftRow && rightRow) {
          const length = Math.min(leftRow.length, rightRow.length);
          for (let index = 0; index < length; index += 1) value += leftRow[index] * rightRow[index];
        }
      }
      matrix[left * count + right] = value;
      matrix[right * count + left] = value;
    }
    if (performance.now() - sliceStart >= sliceMs) {
      await yieldToUi();
      signal?.throwIfAborted();
      sliceStart = performance.now();
    }
  }
  return matrix;
};

/** Index (from `members`) with the highest summed similarity to the others; ties go to the earlier member. */
export const findMedoid = (members: readonly number[], matrix: Float32Array, size: number): number => {
  let best = members[0];
  let bestSum = -Infinity;
  for (const member of members) {
    let sum = 0;
    for (const other of members) if (other !== member) sum += matrix[member * size + other];
    if (sum > bestSum) { bestSum = sum; best = member; }
  }
  return best;
};

const sortClusters = (clusters: BuildCluster[]): BuildCluster[] =>
  clusters.sort((left, right) => right.memberIds.length - left.memberIds.length);

const toBuildClusters = (
  kind: BuildClusterKind,
  clusters: Array<{ imageIds: string[]; avgSimilarity: number }>,
  ids: readonly string[],
  matrix: Float32Array
): BuildCluster[] => {
  const indexById = new Map(ids.map((id, index) => [id, index]));
  return sortClusters(clusters.filter((cluster) => cluster.imageIds.length >= 2).map((cluster) => {
    const members = cluster.imageIds.map((id) => indexById.get(id)!).sort((a, b) => a - b);
    const medoid = ids[findMedoid(members, matrix, ids.length)];
    return { id: `${kind}:${medoid}`, kind, memberIds: members.map((index) => ids[index]), medoidId: medoid, avgSimilarity: cluster.avgSimilarity };
  }));
};

const exactDuplicateGroups = (ids: readonly string[], sha256ById: Readonly<Record<string, string>>): BuildCluster[] => {
  const bySha = new Map<string, string[]>();
  for (const id of ids) {
    const sha = sha256ById[id];
    if (sha) bySha.set(sha, [...(bySha.get(sha) ?? []), id]);
  }
  return sortClusters([...bySha.values()].filter((group) => group.length >= 2)
    .map((group) => ({ id: `near-duplicate:${group[0]}`, kind: 'near-duplicate' as const, memberIds: group, medoidId: group[0], avgSimilarity: 1 })));
};

export const computeBuildClusters = async (input: BuildClusterInput, options: BuildClusterOptions = {}): Promise<BuildClusterResult> => {
  const { basis, strictness, embeddings, sha256ById } = input;
  const key = createBuildClusterKey(input);
  const yieldToUi = options.yieldToUi ?? defaultYield;
  if (basis !== 'dinov2') {
    return { key, basis, nearDuplicateGroups: exactDuplicateGroups(input.ids, sha256ById), themes: [], unclusteredIds: [], vendi: null };
  }
  const ids = input.ids.filter((id) => embeddings[id]);
  const matrix = await computeSimilarityMatrix({ ids, embeddings, sha256ById }, options);
  const nearThreshold = getStrictnessThreshold('strict', basis);
  const themeThreshold = getStrictnessThreshold(strictness, basis);
  const near = toBuildClusters('near-duplicate', await performClusteringSliced(ids, matrix, nearThreshold, options), ids, matrix);
  // At the strictest setting a theme would repeat the near-duplicate groups.
  const themes = themeThreshold === nearThreshold
    ? []
    : toBuildClusters('theme', await performClusteringSliced(ids, matrix, themeThreshold, options), ids, matrix);
  const inTheme = new Set(themes.flatMap((cluster) => cluster.memberIds));
  const unclusteredIds = themes.length ? ids.filter((id) => !inTheme.has(id)) : [];

  await yieldToUi();
  options.signal?.throwIfAborted();
  const before = vendiScore(ids.map((id) => embeddings[id]));
  const dropped = new Set(near.flatMap((group) => group.memberIds.filter((id) => id !== group.medoidId)));
  let after = before;
  if (dropped.size) {
    await yieldToUi();
    options.signal?.throwIfAborted();
    after = vendiScore(ids.filter((id) => !dropped.has(id)).map((id) => embeddings[id]));
  }
  return { key, basis, nearDuplicateGroups: near, themes, unclusteredIds, vendi: { before, after, removable: dropped.size } };
};

export type KeepCandidate = { id: string; quality?: ImageQualitySummary; inDataset: boolean };

/**
 * Best first: no reject-level quality flags, then sharpness, short side, already in Dataset, session order
 * (the order of `entries`). Entries without a triage measurement come last.
 */
export const rankKeepCandidates = (entries: readonly KeepCandidate[], minShortSide: number): string[] => {
  const rows = entries.map((entry, order) => {
    const quality = entry.quality;
    const rejected = quality ? classifyImageQuality({
      width: quality.width, height: quality.height, sharpness: quality.sharpness, brightness: quality.brightness,
      darkShare: quality.darkShare, brightShare: quality.brightShare, dark: quality.dark ?? false,
      analysisWidth: 0, analysisHeight: 0,
    }, { minShortSide }).flags.some((flag) => flag.severity === 'reject') : false;
    return { entry, order, measured: Boolean(quality), rejected };
  });
  rows.sort((a, b) =>
    Number(b.measured) - Number(a.measured)
    || Number(a.rejected) - Number(b.rejected)
    || (b.entry.quality?.sharpness ?? 0) - (a.entry.quality?.sharpness ?? 0)
    || (b.entry.quality?.shortSide ?? 0) - (a.entry.quality?.shortSide ?? 0)
    || Number(b.entry.inDataset) - Number(a.entry.inDataset)
    || a.order - b.order);
  return rows.map((row) => row.entry.id);
};

export type BuildClusterStatus = { total: number; accepted: number; rejected: number; undecided: number; inDataset: number };
type ClusterLike = Pick<BuildCluster, 'memberIds'>;
type ClusterItem = BuildCandidate;

const membersInSessionOrder = <T extends ClusterItem>(cluster: ClusterLike, itemsById: ReadonlyMap<string, T>, session: BuildSession): T[] => {
  const orderOf = new Map(session.order.map((id, index) => [id, index]));
  return cluster.memberIds.flatMap((id) => { const item = itemsById.get(id); return item ? [item] : []; })
    .map((item, index) => ({ item, index, order: orderOf.get(getBuildAssetId(item)) ?? Infinity }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ item }) => item);
};

/** Triage group counts (a manual decision wins over the automatic proposal) plus Dataset membership. */
export const getBuildClusterStatus = <T extends ClusterItem>(cluster: ClusterLike, itemsById: ReadonlyMap<string, T>, session: BuildSession): BuildClusterStatus => {
  const status: BuildClusterStatus = { total: 0, accepted: 0, rejected: 0, undecided: 0, inDataset: 0 };
  for (const id of cluster.memberIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    status.total += 1;
    const record = session.records[getBuildAssetId(item)];
    const group = record ? getBuildTriageGroup(record) : 'pending';
    if (group === 'accepted') status.accepted += 1;
    else if (group === 'rejected') status.rejected += 1;
    else status.undecided += 1;
    if (isProjectDatasetPath(item.assetPath)) status.inDataset += 1;
  }
  return status;
};

export type ClusterAction = 'accept' | 'reject' | 'keep-best';
export type ClusterDecisionEntry<T> = { item: T; decision: BuildReviewDecision };

/** Same target rules as the queue-wide Accept all / Reject all, plus keep-best (best accepted, the rest rejected). */
export const selectClusterActionTargets = <T extends ClusterItem>(
  cluster: ClusterLike, itemsById: ReadonlyMap<string, T>, session: BuildSession, action: ClusterAction, minShortSide: number
): ClusterDecisionEntry<T>[] => {
  const members = membersInSessionOrder(cluster, itemsById, session);
  const recordOf = (item: T) => session.records[getBuildAssetId(item)];
  const canAccept = (item: T) => {
    const record = recordOf(item);
    return item.kind !== 'video' && !(record?.decision === 'accepted' && record.application === 'applied');
  };
  const canReject = (item: T) => recordOf(item)?.decision !== 'skipped';
  if (action === 'accept') return members.filter(canAccept).map((item) => ({ item, decision: 'accepted' as const }));
  if (action === 'reject') return members.filter(canReject).map((item) => ({ item, decision: 'skipped' as const }));
  const candidates = members.filter((item) => item.kind !== 'video');
  const bestId = rankKeepCandidates(candidates.map((item) => ({
    id: item.id, quality: recordOf(item)?.triage?.quality, inDataset: isProjectDatasetPath(item.assetPath),
  })), minShortSide)[0];
  return members.flatMap((item): ClusterDecisionEntry<T>[] => {
    if (item.id === bestId) return canAccept(item) ? [{ item, decision: 'accepted' }] : [];
    return canReject(item) ? [{ item, decision: 'skipped' }] : [];
  });
};

/** Small LRU keyed by `createBuildClusterKey`. */
export const createClusterCache = (limit = 4) => {
  const entries = new Map<string, BuildClusterResult>();
  return {
    get(key: string): BuildClusterResult | undefined {
      const value = entries.get(key);
      if (value) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    set(key: string, value: BuildClusterResult): void {
      entries.delete(key); entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value as string);
    },
    clear(): void { entries.clear(); },
    get size() { return entries.size; },
  };
};
