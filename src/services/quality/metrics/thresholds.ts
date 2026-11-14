import { getSimilarityThreshold } from '../../similarity/similarityLevels';
import { TARGET_MODEL_PRESETS } from '../../../lib/projectProfilePresets';
import type { QualityStatus, ResolutionPreset } from './types';

/**
 * Single source of thresholds for every quality metric.
 * Embedding thresholds assume L2-normalized DINOv2 vectors and are heuristics
 * to calibrate on real datasets.
 */
export const QUALITY_THRESHOLDS = {
  count: {
    /** Default target range when the caller does not pass one. */
    defaultTarget: { min: 15, max: 200 },
    /** Below min * failRatio fails; between that and min warns. */
    failRatio: 0.5,
  },
  resolution: {
    presets: Object.fromEntries(Object.entries(TARGET_MODEL_PRESETS).map(([id, preset]) => [id, preset.minShortSide])) as Record<ResolutionPreset, number>,
    /** Fraction of images below the minimum that still only warns. */
    warnFraction: 0.1,
  },
  nearDuplicates: {
    /** Cosine similarity at or above which two images are near-duplicates: the shared DINOv2 near-copy level used by Dataset assembly and Build triage. */
    similarity: getSimilarityThreshold('near-copy', 'dinov2'),
    /** Fraction of items in duplicate pairs that still only warns. */
    warnFraction: 0.05,
  },
  captions: { warnFraction: 0 },
  trigger: { warnFraction: 0 },
  technical: {
    /** Fraction of `bad` images: ≤ warn → warn, > warn → fail; 0 → ok. */
    warnFraction: 0.1,
  },
  effectiveSize: {
    /** Vendi / N ratio. */
    okRatio: 0.35,
    warnRatio: 0.15,
  },
  coverage: {
    /** Cosine distance radius within which a candidate counts as covered. */
    radius: 0.25,
    okFraction: 0.9,
    warnFraction: 0.7,
  },
  saturation: {
    /** Coverage gained by the last k additions. */
    lastK: 5,
    okGain: 0.02,
    warnGain: 0.08,
  },
  tags: {
    /** Tags present in at least this fraction of files are "almost everywhere". */
    commonFraction: 0.9,
    /** Tags in at most this many files are rare once the dataset has enough files. */
    rareMaxFiles: 1,
    rareMinDataset: 10,
    /** Rare tags fraction of all distinct tags that warns. */
    rareWarnFraction: 0.5,
  },
  captionLength: {
    /** Median token (tag/word) count bounds. */
    minMedianTokens: 3,
    /** CLIP text encoders truncate at 77 tokens; words are a conservative proxy. */
    maxTokens: 70,
  },
  consistency: {
    /** Outlier when distance to centroid exceeds median + k·MAD and the absolute floor. */
    madK: 3,
    minDistance: 0.25,
    warnFraction: 0.1,
  },
  /**
   * Profile coverage axes. Heuristics to calibrate on real datasets, not
   * measured optima: shares are the minimum fraction of the recommended
   * dataset size (max of file count and target minimum) each bucket should hold.
   */
  profileCoverage: {
    /** Axes are not evaluated below this many files. */
    minItems: 8,
    /** Axes are not evaluated when fewer files than this fraction carry the axis signal. */
    minLabeledFraction: 0.5,
    /** Longer side / shorter side above this is portrait or landscape, otherwise square. */
    orientationTolerance: 1.1,
    /** Max |ln(w/h) difference| to the nearest model bucket; beyond it the image is "other". */
    aspectMaxLogDistance: 0.2,
    /** Share of images outside every model bucket that warns. */
    aspectOtherWarnFraction: 0.3,
    bucketMinShare: {
      framing: { close: 0.2, mid: 0.3, full: 0.2 },
      orientation: { portrait: 0.2, landscape: 0.2 },
      setting: { simple: 0.2, indoors: 0.2, outdoors: 0.2 },
      lighting: { day: 0.3, evening: 0.1, night: 0.1 },
      subject: { people: 0.2, 'no-humans': 0.1 },
      aspect: {},
    } as Record<string, Record<string, number>>,
  },
} as const;

const RANK: Record<QualityStatus, number> = { ok: 0, warn: 1, fail: 2 };

export const worstStatus = (statuses: readonly QualityStatus[]): QualityStatus =>
  statuses.reduce<QualityStatus>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), 'ok');

/** Status for "bad fraction" style checks: 0 → ok, ≤ warn → warn, otherwise fail. */
export const statusForBadFraction = (fraction: number, warnFraction: number): QualityStatus =>
  fraction <= 0 ? 'ok' : fraction <= warnFraction ? 'warn' : 'fail';

/** Status for "higher is better" values. */
export const statusForHigherBetter = (value: number, ok: number, warn: number): QualityStatus =>
  value >= ok ? 'ok' : value >= warn ? 'warn' : 'fail';

export const resolveMinShortSide = (preset: ResolutionPreset = 'sdxl', override?: number): number =>
  override && override > 0 ? override : QUALITY_THRESHOLDS.resolution.presets[preset];
