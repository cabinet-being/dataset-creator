import type { ProjectType, TargetModelId } from '../../../types/entities';

export type QualityStatus = 'ok' | 'warn' | 'fail';

export type QualityMetricId =
  | 'count'
  | 'resolution'
  | 'near-duplicates'
  | 'captions'
  | 'trigger'
  | 'technical'
  | 'effective-size'
  | 'coverage'
  | 'saturation'
  | 'common-tags'
  | 'rare-tags'
  | 'caption-length'
  | 'consistency'
  | 'axis-framing'
  | 'axis-orientation'
  | 'axis-setting'
  | 'axis-lighting'
  | 'axis-subject'
  | 'axis-aspect';

export type QualityAction = {
  kind: 'remove' | 'add' | 'review' | 'caption';
  label: string;
  /** Item or candidate ids the action applies to. */
  ids?: string[];
  /** Tags the action applies to. */
  tags?: string[];
};

export type QualityBucket = {
  id: string; label: string; count: number; recommended?: number;
  /** How `recommended` was derived, with the actual numbers. */
  recommendedFrom?: string;
};

export type QualityMetric = {
  id: QualityMetricId;
  title: string;
  /** Raw value used for the status; null when the metric could not be evaluated. */
  value: number | null;
  /** Short human-readable value, e.g. "42 files ≈ 17 effectively distinct". */
  display: string;
  status: QualityStatus;
  /** False when inputs were missing or the check does not apply. */
  evaluated: boolean;
  explanation: string;
  action?: QualityAction;
  /** Optional series for charts, e.g. the coverage saturation curve. */
  series?: number[];
  /** Per-bucket counts of a profile coverage axis. */
  buckets?: QualityBucket[];
  /** Files that carry no signal for this axis (no axis tags / unknown size); never counted in a bucket. */
  unlabeled?: number;
};

/** Per-image verdict produced by the technical-quality stream (src/services/quality/imageQuality.ts). */
export type ImageQualityVerdict = {
  id: string;
  verdict: 'ok' | 'warn' | 'bad';
  reasons?: string[];
};

export type QualityItemInput = {
  id: string;
  width?: number;
  height?: number;
  /** Final caption text as exported. */
  caption?: string;
  /** Resolved tags. Undefined means "derive from caption"; [] means "explicitly no tags". */
  tags?: string[];
  /** DINOv2 image embedding; normalized internally. */
  embedding?: Float32Array | readonly number[];
  imageHash?: string;
};

export type QualityCandidateInput = { id: string; embedding: Float32Array | readonly number[] };

export type ResolutionPreset = TargetModelId;

export type QualityReportInput = {
  items: QualityItemInput[];
  /** Pool of source materials the Dataset was chosen from. Enables coverage metrics. */
  candidates?: QualityCandidateInput[];
  /** Item ids in the order they were added; enables the saturation curve. Defaults to `items` order. */
  selectionOrder?: string[];
  triggerWord?: string;
  target?: { min: number; max: number };
  resolutionPreset?: ResolutionPreset;
  /** Overrides the preset's minimum shorter side. */
  minShortSide?: number;
  /** Undefined means technical checks have not run yet. */
  technical?: ImageQualityVerdict[];
  projectType?: ProjectType;
};

export type QualityReport = {
  /** Worst status among required checks. */
  readiness: QualityStatus;
  required: QualityMetric[];
  insights: QualityMetric[];
  /** Profile coverage axes (insights only, never affect readiness). */
  coverage?: QualityMetric[];
  /** Actionable gaps derived from the computed results. */
  hints?: QualityHint[];
};

/** A concrete gap with the origin of its numbers in `explanation`. */
export type QualityHint = {
  id: string;
  metricId: QualityMetricId;
  text: string;
  explanation: string;
  action?: QualityAction;
};
