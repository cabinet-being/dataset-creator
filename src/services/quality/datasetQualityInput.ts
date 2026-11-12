import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { BuildSession, ImageQualitySummary, ProjectType, TargetModelId } from '../../types';
import { getBuildAssetId } from '../build/buildSessionService';
import { resolveAssetCaption } from '../caption/captionResolver';
import type { SimilarityBasis } from '../similarity/similarityLevels';
import { DEFAULT_TARGET_MODEL } from '../../lib/projectProfilePresets';
import { classifyImageQuality, type ImageQualityFlag } from './imageQuality';
import { QUALITY_THRESHOLDS, type ImageQualityVerdict, type QualityReportInput } from './metrics';

/**
 * Thin adapter from workspace data to `QualityReportInput`.
 * Captions come from the caption resolver, technical verdicts from Build triage measurements
 * (`imageQuality`), and image vectors from the shared similarity features. Vectors are passed only
 * when they are DINOv2: histogram vectors would make Vendi, coverage and consistency meaningless.
 */

/** Resolution has its own required check driven by the same min-short-side setting. */
const RESOLUTION_FLAGS = new Set<ImageQualityFlag['code']>(['too-small', 'below-target-resolution']);

export const toTechnicalVerdict = (id: string, summary: ImageQualitySummary): ImageQualityVerdict => {
  const report = classifyImageQuality({
    width: summary.width, height: summary.height, sharpness: summary.sharpness, brightness: summary.brightness,
    darkShare: summary.darkShare, brightShare: summary.brightShare, dark: summary.dark ?? false,
    analysisWidth: 0, analysisHeight: 0,
  }, { minShortSide: summary.minShortSide });
  const flags = report.flags.filter((flag) => !RESOLUTION_FLAGS.has(flag.code));
  const verdict = flags.some((flag) => flag.severity === 'reject') ? 'bad' : flags.length ? 'warn' : 'ok';
  return { id, verdict, reasons: flags.map((flag) => flag.message) };
};

/** Quality measurements saved by Build triage, keyed by Build asset id of both the source and its output. */
export const collectBuildQualitySummaries = (session: Pick<BuildSession, 'records'>): Map<string, ImageQualitySummary> => {
  const summaries = new Map<string, ImageQualitySummary>();
  for (const record of Object.values(session.records)) {
    const quality = record.triage?.quality;
    if (!quality) continue;
    summaries.set(record.assetId, quality);
    if (record.outputAssetId && !summaries.has(record.outputAssetId)) summaries.set(record.outputAssetId, quality);
  }
  return summaries;
};

export type DatasetQualitySource = {
  /** Dataset members (files under `dataset/`). */
  items: readonly WorkspaceImage[];
  /** Source materials the Dataset is chosen from; enables coverage and saturation. */
  candidates?: readonly WorkspaceImage[];
  triggerWord?: string;
  /** Build target; the count check uses it as the lower bound. */
  target?: number;
  /** Project target model; owns the one min-short-side setting. */
  targetModel?: TargetModelId;
  projectType?: ProjectType;
  qualitySummaries?: ReadonlyMap<string, ImageQualitySummary>;
  features?: { basis: SimilarityBasis; embeddings: Record<string, Float32Array>; sha256ById?: Record<string, string> };
};

export const buildDatasetQualityInput = (source: DatasetQualitySource): QualityReportInput => {
  const visual = (item: WorkspaceImage) => item.kind !== 'video';
  const embeddings = source.features?.basis === 'dinov2' ? source.features.embeddings : undefined;
  const items = source.items.filter(visual).map((item) => {
    const caption = resolveAssetCaption(item, source.triggerWord ?? '');
    return {
      id: item.id,
      ...(item.dimensionsKnown === false ? {} : { width: item.width, height: item.height }),
      caption: caption.text,
      tags: item.tags,
      ...(embeddings?.[item.id] ? { embedding: embeddings[item.id] } : {}),
      ...(source.features?.sha256ById?.[item.id] ? { imageHash: source.features.sha256ById[item.id] } : {}),
    };
  });
  let technical: ImageQualityVerdict[] | undefined;
  if (source.qualitySummaries?.size) {
    technical = source.items.filter(visual).flatMap((item) => {
      const summary = source.qualitySummaries!.get(getBuildAssetId(item));
      return summary ? [toTechnicalVerdict(item.id, summary)] : [];
    });
  }
  const candidates = embeddings
    ? (source.candidates ?? []).filter(visual).flatMap((item) => embeddings[item.id] ? [{ id: item.id, embedding: embeddings[item.id] }] : [])
    : undefined;
  const defaultTarget = QUALITY_THRESHOLDS.count.defaultTarget;
  return {
    items,
    ...(candidates?.length ? { candidates } : {}),
    triggerWord: source.triggerWord,
    ...(source.target && source.target > 0 ? { target: { min: source.target, max: Math.max(source.target, defaultTarget.max) } } : {}),
    resolutionPreset: source.targetModel ?? DEFAULT_TARGET_MODEL,
    ...(technical ? { technical } : {}),
    projectType: source.projectType,
  };
};
