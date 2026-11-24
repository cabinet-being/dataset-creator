import { TARGET_MODEL_PRESETS } from '../../lib/projectProfilePresets';
import type { TargetModelId } from '../../types/entities';

/**
 * Optional downscale applied to exported copies only; originals are never touched. Images are only made smaller (never upscaled)
 * and keep their aspect ratio and file format.
 */
export type ExportResize =
  | { kind: 'longest'; side: number }
  /** Fits the image into the aspect bucket of the target model that is closest to its own aspect ratio. */
  | { kind: 'bucket'; model: TargetModelId };

/** Stable text for fingerprints and labels. */
export const describeExportResize = (resize: ExportResize): string =>
  resize.kind === 'longest' ? `longest side ${resize.side}px` : `${TARGET_MODEL_PRESETS[resize.model]?.label ?? resize.model} buckets`;

/** Output size for a source size, or null when the image already fits (it is exported unchanged). */
export const resolveExportResize = (width: number, height: number, resize: ExportResize): { width: number; height: number } | null => {
  if (!(width > 0) || !(height > 0)) return null;
  let scale: number;
  if (resize.kind === 'longest') {
    if (!(resize.side > 0)) return null;
    scale = resize.side / Math.max(width, height);
  } else {
    const buckets = TARGET_MODEL_PRESETS[resize.model]?.buckets ?? [];
    if (!buckets.length) return null;
    const ratio = Math.log(width / height);
    const bucket = buckets.reduce((best, candidate) =>
      Math.abs(Math.log(candidate.width / candidate.height) - ratio) < Math.abs(Math.log(best.width / best.height) - ratio) ? candidate : best);
    scale = Math.min(bucket.width / width, bucket.height / height);
  }
  if (scale >= 1) return null;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

const OUTPUT_TYPES: Record<string, { type: string; quality?: number }> = {
  png: { type: 'image/png' }, jpg: { type: 'image/jpeg', quality: 0.95 }, jpeg: { type: 'image/jpeg', quality: 0.95 }, webp: { type: 'image/webp', quality: 0.95 },
};

/** Whether an exported file of this name can be resized (PNG, JPEG and WebP keep their format). */
export const canResizeExportImage = (imageName: string): boolean => Object.prototype.hasOwnProperty.call(OUTPUT_TYPES, imageName.split('.').pop()?.toLowerCase() ?? '');

/** Resamples `blob` for the export named `imageName`; returns the same blob when nothing has to change. */
export async function resizeExportImage(blob: Blob, imageName: string, resize: ExportResize, signal?: AbortSignal): Promise<Blob> {
  const output = OUTPUT_TYPES[imageName.split('.').pop()?.toLowerCase() ?? ''];
  if (!output) return blob;
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const size = resolveExportResize(bitmap.width, bitmap.height, resize);
    if (!size) return blob;
    signal?.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable for resizing the export.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, output.type, output.quality));
    if (!result) throw new Error(`Could not resize ${imageName}.`);
    signal?.throwIfAborted();
    return result;
  } finally { bitmap.close(); }
}
