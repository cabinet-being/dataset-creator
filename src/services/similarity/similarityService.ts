/**
 * Similarity service
 * Computes similarity between images and performs clustering
 */

import { SimilarityResult, SimilarityCluster } from '../../types';
import { computeSimilarity } from '../image/embeddingService';
import { classifySimilarity, type SimilarityBasis, type SimilarityLevel } from './similarityLevels';

/**
 * Compute pairwise distances between all embeddings
 */
export const computeDistanceMatrix = (
  embeddings: Map<string, Float32Array>
): Map<string, SimilarityResult[]> => {
  const results = new Map<string, SimilarityResult[]>();
  const imageIds = Array.from(embeddings.keys());

  for (let i = 0; i < imageIds.length; i++) {
    const id1 = imageIds[i];
    const emb1 = embeddings.get(id1)!;
    const distances: SimilarityResult[] = [];

    for (let j = i + 1; j < imageIds.length; j++) {
      const id2 = imageIds[j];
      const emb2 = embeddings.get(id2)!;

      const distance = computeSimilarity(emb1, emb2);
      const similarity = 1 - distance;

      distances.push({
        imageId1: id1,
        imageId2: id2,
        distance,
        similarity,
      });
    }

    results.set(id1, distances);
  }

  return results;
};

/** Similarity of two members by index, or null when the pair was not measured. */
type SimilarityAt = (left: number, right: number) => number | null;

/**
 * Core of the agglomerative clustering. Reads similarity through `similarityAt` and yields between
 * steps so the synchronous and the time-sliced entry points share one implementation.
 * One threshold (take it from `similarityLevels`) governs the anchor pair, the cluster
 * representative and the average similarity; 70% of member links must also pass it.
 */
function* clusterSteps(
  ids: readonly string[],
  similarityAt: SimilarityAt,
  threshold: number
): Generator<void, SimilarityCluster[], void> {
  const clusters: number[][] = [];
  const assignment = new Map<number, number>();
  const candidatePairs: Array<{ left: number; right: number; similarity: number }> = [];
  for (let left = 0; left < ids.length; left++) {
    for (let right = left + 1; right < ids.length; right++) {
      const similarity = similarityAt(left, right);
      if (similarity != null && similarity >= threshold) candidatePairs.push({ left, right, similarity });
    }
    yield;
  }
  candidatePairs.sort((a, b) => b.similarity - a.similarity);
  yield;
  const representativeThreshold = threshold;
  const clusterThreshold = threshold;
  const averageThreshold = threshold;

  for (const { left: index1, right: index2, similarity } of candidatePairs) {
    yield;
    const clusterIndex1 = assignment.get(index1);
    const clusterIndex2 = assignment.get(index2);

    if (clusterIndex1 == null && clusterIndex2 == null) {
      clusters.push([index1, index2]);
      const newIndex = clusters.length - 1;
      assignment.set(index1, newIndex);
      assignment.set(index2, newIndex);
      continue;
    }

    if (clusterIndex1 != null && clusterIndex2 != null) {
      if (clusterIndex1 === clusterIndex2) {
        continue;
      }

      const left = clusters[clusterIndex1];
      const right = clusters[clusterIndex2];
      if (!left || !right) {
        continue;
      }

      if (canMergeClusters(left, right, similarityAt, clusterThreshold, representativeThreshold, averageThreshold)) {
        const merged = [...left, ...right];
        clusters[clusterIndex1] = merged;
        clusters[clusterIndex2] = [];

        for (const member of merged) {
          assignment.set(member, clusterIndex1);
        }
      }
      continue;
    }

    const existingClusterIndex = clusterIndex1 ?? clusterIndex2!;
    const existingCluster = clusters[existingClusterIndex];
    const candidate = clusterIndex1 == null ? index1 : index2;
    const anchor = clusterIndex1 == null ? index2 : index1;

    if (!existingCluster) {
      continue;
    }

    if (
      canJoinCluster(
        candidate,
        existingCluster,
        anchor,
        similarityAt,
        similarity,
        clusterThreshold,
        representativeThreshold,
        averageThreshold
      )
    ) {
      existingCluster.push(candidate);
      assignment.set(candidate, existingClusterIndex);
    }
  }

  return clusters
    .filter((cluster) => cluster.length > 0)
    .map((cluster, index) => ({
      id: `cluster-${index}`,
      imageIds: cluster.map((member) => ids[member]),
      avgSimilarity: computeAverageSimilarity(cluster, similarityAt),
    }));
}

const runSync = <T>(generator: Generator<void, T, void>): T => {
  for (;;) {
    const step = generator.next();
    if (step.done) return step.value;
  }
};

/**
 * Simple agglomerative clustering based on similarity.
 * One threshold (take it from `similarityLevels`) governs the anchor pair, the cluster
 * representative and the average similarity; 70% of member links must also pass it.
 */
export const performClustering = (
  _imageIds: string[],
  distanceMatrix: Map<string, SimilarityResult[]>,
  threshold: number
): SimilarityCluster[] => {
  const ids = Array.from(distanceMatrix.keys());
  const pairMap = buildPairMap(distanceMatrix);
  const similarityAt: SimilarityAt = (left, right) => getPairSimilarity(pairMap, ids[left], ids[right]);
  return runSync(clusterSteps(ids, similarityAt, threshold));
};

export type SlicedClusteringOptions = {
  signal?: AbortSignal;
  yieldToUi?: () => Promise<void>;
  /** Longest stretch of synchronous work between yields. */
  sliceMs?: number;
};

/**
 * Same result as `performClustering` for a dense row-major n×n similarity matrix (`ids.length`²),
 * but hands control back to the UI between slices and honours `signal`.
 */
export const performClusteringSliced = async (
  ids: string[],
  matrix: Float32Array,
  threshold: number,
  options: SlicedClusteringOptions = {}
): Promise<SimilarityCluster[]> => {
  const { signal, sliceMs = 12 } = options;
  const yieldToUi = options.yieldToUi ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const count = ids.length;
  const generator = clusterSteps(ids, (left, right) => matrix[left * count + right], threshold);
  let sliceStart = performance.now();
  for (;;) {
    signal?.throwIfAborted();
    const step = generator.next();
    if (step.done) return step.value;
    if (performance.now() - sliceStart >= sliceMs) {
      await yieldToUi();
      signal?.throwIfAborted();
      sliceStart = performance.now();
    }
  }
};

const buildPairMap = (
  distanceMatrix: Map<string, SimilarityResult[]>
): Map<string, SimilarityResult> => {
  const pairMap = new Map<string, SimilarityResult>();

  for (const results of distanceMatrix.values()) {
    for (const result of results) {
      pairMap.set(createPairKey(result.imageId1, result.imageId2), result);
    }
  }

  return pairMap;
};

const createPairKey = (left: string, right: string): string =>
  left < right ? `${left}::${right}` : `${right}::${left}`;

const getPairSimilarity = (
  pairMap: Map<string, SimilarityResult>,
  left: string,
  right: string
): number | null => {
  const pair = pairMap.get(createPairKey(left, right));
  return pair ? pair.similarity : null;
};

const canJoinCluster = (
  candidate: number,
  cluster: number[],
  anchor: number,
  similarityAt: SimilarityAt,
  anchorSimilarity: number,
  clusterThreshold: number,
  representativeThreshold: number,
  averageThreshold: number
): boolean => {
  if (anchorSimilarity < clusterThreshold) {
    return false;
  }

  const representative = cluster[0] ?? anchor;
  const representativeSimilarity = similarityAt(candidate, representative);
  if (representativeSimilarity == null || representativeSimilarity < representativeThreshold) {
    return false;
  }

  let strongConnections = 0;
  let similaritySum = 0;
  let similarityCount = 0;

  for (const member of cluster) {
    const similarity = similarityAt(candidate, member);
    if (similarity == null) {
      continue;
    }

    similaritySum += similarity;
    similarityCount++;

    if (similarity >= clusterThreshold) {
      strongConnections++;
    }
  }

  if (similarityCount === 0) {
    return false;
  }

  const averageSimilarity = similaritySum / similarityCount;
  return strongConnections >= Math.max(1, Math.ceil(cluster.length * 0.7)) && averageSimilarity >= averageThreshold;
};

const canMergeClusters = (
  left: number[],
  right: number[],
  similarityAt: SimilarityAt,
  clusterThreshold: number,
  representativeThreshold: number,
  averageThreshold: number
): boolean => {
  const representativeSimilarity = similarityAt(left[0], right[0]);

  if (representativeSimilarity == null || representativeSimilarity < representativeThreshold) {
    return false;
  }

  let strongConnections = 0;
  let similaritySum = 0;
  let similarityCount = 0;

  for (const leftMember of left) {
    for (const rightMember of right) {
      const similarity = similarityAt(leftMember, rightMember);
      if (similarity == null) {
        continue;
      }

      similaritySum += similarity;
      similarityCount++;

      if (similarity >= clusterThreshold) {
        strongConnections++;
      }
    }
  }

  if (similarityCount === 0) {
    return false;
  }

  const averageSimilarity = similaritySum / similarityCount;
  const minimumStrongConnections = Math.max(1, Math.ceil(left.length * right.length * 0.7));
  return strongConnections >= minimumStrongConnections && averageSimilarity >= averageThreshold;
};

/**
 * Compute average similarity within a cluster. Pairs are summed in the same order as the
 * distance-matrix layout (each member against the later-indexed members).
 */
const computeAverageSimilarity = (members: number[], similarityAt: SimilarityAt): number => {
  if (members.length < 2) return 1;

  const sorted = [...members].sort((a, b) => a - b);
  let sumSimilarity = 0;
  let count = 0;

  for (const member of members) {
    for (const other of sorted) {
      if (other <= member) continue;
      const similarity = similarityAt(member, other);
      if (similarity == null) continue;
      sumSimilarity += similarity;
      count++;
    }
  }

  return count > 0 ? sumSimilarity / count : 0;
};

/**
 * Weakest link inside a cluster, i.e. the level every member pair reaches at least.
 */
export const getClusterLevel = (
  imageIds: string[],
  distanceMatrix: Map<string, SimilarityResult[]>,
  basis: SimilarityBasis
): SimilarityLevel | null => {
  const pairMap = buildPairMap(distanceMatrix);
  let weakest = Infinity;
  for (let left = 0; left < imageIds.length; left += 1) {
    for (let right = left + 1; right < imageIds.length; right += 1) {
      weakest = Math.min(weakest, getPairSimilarity(pairMap, imageIds[left], imageIds[right]) ?? 0);
    }
  }
  return Number.isFinite(weakest) ? classifySimilarity(weakest, basis) : null;
};

/**
 * Find most similar pairs (potential duplicates)
 */
export const findSimilarPairs = (
  distanceMatrix: Map<string, SimilarityResult[]>,
  threshold: number
): SimilarityResult[] => {
  const pairs: SimilarityResult[] = [];

  for (const results of distanceMatrix.values()) {
    for (const result of results) {
      if (result.similarity >= threshold) {
        pairs.push(result);
      }
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
};

/**
 * Get similar images for a specific image
 */
export const getSimilarImages = (
  imageId: string,
  distanceMatrix: Map<string, SimilarityResult[]>,
  limit: number,
  threshold: number
): SimilarityResult[] => {
  const results = distanceMatrix.get(imageId) || [];
  return results
    .filter((r) => r.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
};
