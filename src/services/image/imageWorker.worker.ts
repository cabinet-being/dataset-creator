import { measureImageQualityLocal, type ImageQualityOptions, type ImageQualityReport } from '../quality/imageQuality';

export type ImageWorkerRequest =
  | { id: number; type: 'quality'; blob: Blob; options: ImageQualityOptions }
  | { id: number; type: 'resize'; blob: Blob; maxSide: number; quality: number };
export type ResizeResult = { blob: Blob; width: number; height: number; sourceWidth: number; sourceHeight: number } | null;
export type ImageWorkerResponse =
  | { id: number; ok: true; result: ImageQualityReport | ResizeResult }
  | { id: number; ok: false; message: string };

const decode = async (blob: Blob): Promise<ImageBitmap> => {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { return createImageBitmap(blob); }
};

/** Downscales to `maxSide`; null when the source already fits so the caller keeps the original. */
const resize = async (blob: Blob, maxSide: number, quality: number): Promise<ResizeResult> => {
  const bitmap = await decode(blob);
  try {
    const sourceWidth = bitmap.width; const sourceHeight = bitmap.height;
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    if (scale >= 1) return null;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable for image previews.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    let out = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (out.type !== 'image/webp') out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return { blob: out, width, height, sourceWidth, sourceHeight };
  } finally { bitmap.close(); }
};

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<ImageWorkerRequest>) => void) | null; postMessage: (message: ImageWorkerResponse) => void };
scope.onmessage = async ({ data }) => {
  try {
    const result = data.type === 'quality' ? await measureImageQualityLocal(data.blob, data.options) : await resize(data.blob, data.maxSide, data.quality);
    scope.postMessage({ id: data.id, ok: true, result });
  } catch (error) {
    scope.postMessage({ id: data.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
