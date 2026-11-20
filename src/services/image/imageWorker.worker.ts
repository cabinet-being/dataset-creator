import { measureImageQualityLocal, type ImageQualityOptions, type ImageQualityReport } from '../quality/imageQuality';

export type ImageWorkerRequest =
  | { id: number; type: 'quality'; blob: Blob; options: ImageQualityOptions }
  | { id: number; type: 'resize'; blob: Blob; maxSide: number; quality: number }
  | { id: number; type: 'digest'; blob: Blob }
  | { id: number; type: 'probe'; blob: Blob; thumbnailSize: number };
/** Everything the import needs from one decode: oriented size, JPEG thumbnail, 256-bin grayscale histogram and 8x8 average hash. */
export type ProbeResult = { width: number; height: number; thumbnail: Blob; embedding: Float32Array; hash: string };
export type ResizeResult = { blob: Blob; width: number; height: number; sourceWidth: number; sourceHeight: number } | null;
export type ImageWorkerResponse =
  | { id: number; ok: true; result: ImageQualityReport | ResizeResult | ProbeResult | string }
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

const drawSmall = (bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray => {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable for image analysis.');
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
};

const probe = async (blob: Blob, thumbnailSize: number): Promise<ProbeResult> => {
  const bitmap = await decode(blob);
  try {
    const { width, height } = bitmap;
    const ratio = width / height;
    const thumbWidth = ratio > 1 ? thumbnailSize : Math.max(1, Math.round(thumbnailSize * ratio));
    const thumbHeight = ratio > 1 ? Math.max(1, Math.round(thumbnailSize / ratio)) : thumbnailSize;
    const canvas = new OffscreenCanvas(thumbWidth, thumbHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable for image previews.');
    context.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
    const thumbnail = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });

    const embedding = new Float32Array(256);
    const histogramData = drawSmall(bitmap, 32, 32);
    for (let i = 0; i < histogramData.length; i += 4) {
      embedding[Math.max(0, Math.min(255, Math.floor((histogramData[i] + histogramData[i + 1] + histogramData[i + 2]) / 3)))]++;
    }
    const sum = embedding.reduce((a, b) => a + b, 0);
    for (let i = 0; i < embedding.length; i++) embedding[i] /= sum;

    const hashData = drawSmall(bitmap, 8, 8);
    let total = 0;
    for (let i = 0; i < hashData.length; i += 4) total += hashData[i] + hashData[i + 1] + hashData[i + 2];
    const average = total / (hashData.length - hashData.length / 4);
    let hash = '';
    for (let i = 0; i < hashData.length; i += 4) hash += (hashData[i] + hashData[i + 1] + hashData[i + 2]) / 3 > average ? '1' : '0';
    return { width, height, thumbnail, embedding, hash };
  } finally { bitmap.close(); }
};

const sha256Hex = async (blob: Blob): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<ImageWorkerRequest>) => void) | null; postMessage: (message: ImageWorkerResponse) => void };
scope.onmessage = async ({ data }) => {
  try {
    const result = data.type === 'quality' ? await measureImageQualityLocal(data.blob, data.options)
      : data.type === 'digest' ? await sha256Hex(data.blob)
      : data.type === 'probe' ? await probe(data.blob, data.thumbnailSize)
      : await resize(data.blob, data.maxSide, data.quality);
    scope.postMessage({ id: data.id, ok: true, result });
  } catch (error) {
    scope.postMessage({ id: data.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
