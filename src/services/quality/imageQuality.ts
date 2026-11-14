import type { ImageQualitySummary, TargetModelId } from '../../types';
import { DEFAULT_TARGET_MODEL, TARGET_MODEL_PRESETS } from '../../lib/projectProfilePresets';
import { inspectFramePixels } from '../video/frameQuality';

export const IMAGE_QUALITY_VERSION = 1;
export const DEFAULT_MIN_SHORT_SIDE = TARGET_MODEL_PRESETS[DEFAULT_TARGET_MODEL].minShortSide;
export const DEFAULT_ANALYSIS_MAX_SIDE = 512;

/** Thresholds that decide reject/review flags. Sharpness values are Laplacian energy at analysis size. */
export const IMAGE_QUALITY_THRESHOLDS = {
  /** shortSide < rejectResolutionRatio * minShortSide => reject `too-small`. */
  rejectResolutionRatio: 0.75,
  /** sharpness below this => reject `blurry`. */
  rejectSharpness: 0.0004,
  /** sharpness below this (inspectFramePixels `blurry`) => review `soft`. */
  reviewSharpness: 0.001,
  /** mean luminance (0..1) below this => review `underexposed`. */
  underexposedBrightness: 0.12,
  /** share of samples in the darkest histogram bin above this => review `underexposed`. */
  underexposedDarkShare: 0.6,
  /** share of samples in the brightest histogram bin above this => review `overexposed`. */
  overexposedBrightShare: 0.5,
} as const;

export type ImageQualityOptions = { minShortSide?: number; analysisMaxSide?: number };

export type ImageQualityFlag = {
  code: 'too-small' | 'below-target-resolution' | 'blurry' | 'soft' | 'dark' | 'underexposed' | 'overexposed';
  severity: 'reject' | 'review';
  message: string;
  value: number;
  threshold: number;
};

export type ImageQualityReport = {
  version: 1;
  width: number;
  height: number;
  shortSide: number;
  analysisWidth: number;
  analysisHeight: number;
  sharpness: number;
  brightness: number;
  darkShare: number;
  brightShare: number;
  minShortSide: number;
  flags: ImageQualityFlag[];
  verdict: 'pass' | 'review' | 'reject';
};

export type ImageQualityMetrics = {
  width: number; height: number; sharpness: number; brightness: number; darkShare: number; brightShare: number;
  dark: boolean; analysisWidth: number; analysisHeight: number;
};

const resolveMinShortSide = (options: ImageQualityOptions) =>
  options.minShortSide && options.minShortSide > 0 ? Math.floor(options.minShortSide) : DEFAULT_MIN_SHORT_SIDE;
const fixed = (value: number) => value.toFixed(value < 0.01 ? 5 : 2);

export const classifyImageQuality = (metrics: ImageQualityMetrics, options: ImageQualityOptions = {}): ImageQualityReport => {
  const t = IMAGE_QUALITY_THRESHOLDS;
  const minShortSide = resolveMinShortSide(options);
  const shortSide = Math.min(metrics.width, metrics.height);
  const flags: ImageQualityFlag[] = [];
  const rejectSide = t.rejectResolutionRatio * minShortSide;
  if (shortSide < rejectSide) flags.push({ code: 'too-small', severity: 'reject', value: shortSide, threshold: rejectSide, message: `Short side ${shortSide}px is far below the ${minShortSide}px minimum (reject under ${Math.round(rejectSide)}px)` });
  else if (shortSide < minShortSide) flags.push({ code: 'below-target-resolution', severity: 'review', value: shortSide, threshold: minShortSide, message: `Short side ${shortSide}px is below ${minShortSide}px minimum` });
  if (metrics.sharpness < t.rejectSharpness) flags.push({ code: 'blurry', severity: 'reject', value: metrics.sharpness, threshold: t.rejectSharpness, message: `Image is blurry (sharpness ${fixed(metrics.sharpness)} < ${t.rejectSharpness})` });
  else if (metrics.sharpness < t.reviewSharpness) flags.push({ code: 'soft', severity: 'review', value: metrics.sharpness, threshold: t.reviewSharpness, message: `Image looks soft (sharpness ${fixed(metrics.sharpness)} < ${t.reviewSharpness})` });
  if (metrics.dark) flags.push({ code: 'dark', severity: 'reject', value: metrics.darkShare, threshold: 0.98, message: 'Image is almost entirely black' });
  else if (metrics.brightness < t.underexposedBrightness || metrics.darkShare > t.underexposedDarkShare) {
    const byBrightness = metrics.brightness < t.underexposedBrightness;
    flags.push({ code: 'underexposed', severity: 'review', value: byBrightness ? metrics.brightness : metrics.darkShare, threshold: byBrightness ? t.underexposedBrightness : t.underexposedDarkShare,
      message: byBrightness ? `Image is underexposed (brightness ${fixed(metrics.brightness)} < ${t.underexposedBrightness})` : `Image is underexposed (${Math.round(metrics.darkShare * 100)}% very dark samples)` });
  }
  if (metrics.brightShare > t.overexposedBrightShare) flags.push({ code: 'overexposed', severity: 'review', value: metrics.brightShare, threshold: t.overexposedBrightShare, message: `Image is overexposed (${Math.round(metrics.brightShare * 100)}% very bright samples)` });
  const verdict = flags.some((flag) => flag.severity === 'reject') ? 'reject' : flags.length ? 'review' : 'pass';
  return {
    version: 1, width: metrics.width, height: metrics.height, shortSide,
    analysisWidth: metrics.analysisWidth, analysisHeight: metrics.analysisHeight,
    sharpness: metrics.sharpness, brightness: metrics.brightness, darkShare: metrics.darkShare, brightShare: metrics.brightShare,
    minShortSide, flags, verdict,
  };
};

export const assessImagePixels = (
  pixels: Uint8ClampedArray, analysisWidth: number, analysisHeight: number,
  source: { width: number; height: number }, options: ImageQualityOptions = {}
): ImageQualityReport => {
  const { histogram, quality } = inspectFramePixels(pixels, analysisWidth, analysisHeight);
  // Each channel's bins sum to 1/3, so multiply by 3 for per-channel means.
  const channelMean = (channel: number) => {
    let mean = 0;
    for (let bin = 0; bin < 16; bin += 1) mean += histogram[channel * 16 + bin] * 3 * ((bin + 0.5) / 16);
    return mean;
  };
  const brightness = 0.2126 * channelMean(0) + 0.7152 * channelMean(1) + 0.0722 * channelMean(2);
  const darkShare = histogram[0] + histogram[16] + histogram[32];
  const brightShare = histogram[15] + histogram[31] + histogram[47];
  return classifyImageQuality({
    width: source.width, height: source.height, sharpness: quality.sharpness, brightness, darkShare, brightShare,
    dark: quality.dark, analysisWidth, analysisHeight,
  }, options);
};

const decodeImage = async (blob: Blob): Promise<ImageBitmap> => {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { return createImageBitmap(blob); }
};

export const measureImageQuality = async (blob: Blob, options: ImageQualityOptions = {}, signal?: AbortSignal): Promise<ImageQualityReport> => {
  signal?.throwIfAborted();
  const bitmap = await decodeImage(blob);
  try {
    signal?.throwIfAborted();
    const maxSide = Math.max(8, Math.floor(options.analysisMaxSide ?? DEFAULT_ANALYSIS_MAX_SIDE));
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const context = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
      : Object.assign(document.createElement('canvas'), { width, height }).getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas is unavailable for image quality analysis.');
    context.drawImage(bitmap, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    return assessImagePixels(data, width, height, { width: bitmap.width, height: bitmap.height }, options);
  } finally { bitmap.close(); }
};

export const summarizeImageQuality = (report: ImageQualityReport): ImageQualitySummary => ({
  version: report.version, width: report.width, height: report.height, shortSide: report.shortSide,
  sharpness: report.sharpness, brightness: report.brightness, darkShare: report.darkShare, brightShare: report.brightShare,
  minShortSide: report.minShortSide,
  ...(report.flags.some((flag) => flag.code === 'dark') ? { dark: true } : {}),
});

/** The one minimum-short-side setting: Build triage and the Dataset quality report both read it. */
/** Minimum short side of the project's target model: the single source for Build triage and the quality report. */
export const getMinShortSide = (targetModel: TargetModelId = DEFAULT_TARGET_MODEL): number =>
  TARGET_MODEL_PRESETS[targetModel].minShortSide;
