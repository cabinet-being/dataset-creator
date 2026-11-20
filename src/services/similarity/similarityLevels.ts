/**
 * Single source of truth for visual similarity levels.
 *
 * Similarity is the cosine similarity of image features. The preferred basis is the DINOv2 image
 * embedding from `semanticFeatureService`; a grayscale histogram is only a fallback while the
 * model is not downloaded, and it needs its own (inflated) thresholds because unrelated images
 * share similar brightness histograms. Analysis, Remove Duplicates and Dataset assembly all read
 * their thresholds from this table.
 */

export type SimilarityBasis = 'dinov2' | 'histogram';
export type SimilarityLevelId = 'duplicate' | 'near-copy' | 'similar' | 'related';

export type SimilarityLevel = {
  id: SimilarityLevelId;
  label: string;
  description: string;
  /** Minimum cosine similarity per feature basis. */
  minSimilarity: Record<SimilarityBasis, number>;
};

/** Ordered from the strictest level to the loosest one. */
export const SIMILARITY_LEVELS: readonly SimilarityLevel[] = [
  {
    id: 'duplicate',
    label: 'Duplicate',
    description: 'Same image: identical file, resized or re-encoded copy.',
    minSimilarity: { dinov2: 0.995, histogram: 0.995 },
  },
  {
    id: 'near-copy',
    label: 'Near copy',
    description: 'Almost the same shot with tiny crop, color or detail changes.',
    minSimilarity: { dinov2: 0.985, histogram: 0.96 },
  },
  {
    id: 'similar',
    label: 'Similar',
    description: 'Same subject, pose and framing; adds little variety.',
    minSimilarity: { dinov2: 0.93, histogram: 0.94 },
  },
  {
    id: 'related',
    label: 'Related',
    description: 'Same subject or scene with visible variation.',
    minSimilarity: { dinov2: 0.85, histogram: 0.9 },
  },
];

/** aHash (8×8 average hash) Hamming distance at or below which two images are treated as duplicates. */
export const DUPLICATE_HASH_DISTANCE = 4;

export const getSimilarityLevel = (id: SimilarityLevelId): SimilarityLevel => {
  const level = SIMILARITY_LEVELS.find((entry) => entry.id === id);
  if (!level) {
    throw new Error(`Unknown similarity level: ${id}`);
  }
  return level;
};

export const getSimilarityThreshold = (id: SimilarityLevelId, basis: SimilarityBasis): number =>
  getSimilarityLevel(id).minSimilarity[basis];

/** Auto-select never picks an image this visually similar (DINOv2 cosine) to the Dataset or to an already shortlisted image. */
export const SELECTION_DUPLICATE_SIMILARITY = getSimilarityThreshold('similar', 'dinov2');

/** Strictest level reached by a similarity value, or null when the pair is not even related. */
export const classifySimilarity = (similarity: number, basis: SimilarityBasis): SimilarityLevel | null =>
  SIMILARITY_LEVELS.find((level) => similarity >= level.minSimilarity[basis]) ?? null;

export const hammingDistance = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  let distance = Math.abs(left.length - right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      distance += 1;
    }
  }
  return distance;
};

export type ExactDuplicateKeys = { sha256?: string; aHash?: string };

/** Exact duplicates are decided by file content (SHA-256) or perceptual aHash, never by embeddings. */
export const isExactDuplicate = (left: ExactDuplicateKeys, right: ExactDuplicateKeys): boolean => {
  if (left.sha256 && right.sha256 && left.sha256 === right.sha256) {
    return true;
  }
  return Boolean(left.aHash && right.aHash && hammingDistance(left.aHash, right.aHash) <= DUPLICATE_HASH_DISTANCE);
};

/** Pair level combining exact keys with feature similarity. */
export const classifyPair = (
  keys: [ExactDuplicateKeys, ExactDuplicateKeys],
  similarity: number | null,
  basis: SimilarityBasis
): SimilarityLevel | null => {
  if (isExactDuplicate(keys[0], keys[1])) {
    return getSimilarityLevel('duplicate');
  }
  return similarity == null ? null : classifySimilarity(similarity, basis);
};

export type SimilarityStrictnessId = 'strict' | 'balanced' | 'loose';
export type SimilarityStrictness = {
  id: SimilarityStrictnessId;
  label: string;
  /** Loosest level still grouped at this strictness. */
  level: SimilarityLevelId;
};

/** Stops of the single "Strictness" slider, from the strictest to the loosest. */
export const SIMILARITY_STRICTNESS: readonly SimilarityStrictness[] = [
  { id: 'strict', label: 'Strict', level: 'near-copy' },
  { id: 'balanced', label: 'Balanced', level: 'similar' },
  { id: 'loose', label: 'Loose', level: 'related' },
];

export const getStrictness = (id: SimilarityStrictnessId): SimilarityStrictness =>
  SIMILARITY_STRICTNESS.find((entry) => entry.id === id) ?? SIMILARITY_STRICTNESS[0];

export const getStrictnessThreshold = (id: SimilarityStrictnessId, basis: SimilarityBasis): number =>
  getSimilarityThreshold(getStrictness(id).level, basis);

export const SIMILARITY_BASIS_LABELS: Record<SimilarityBasis, string> = {
  dinov2: 'DINOv2 image features',
  histogram: 'Brightness histogram (fallback)',
};
