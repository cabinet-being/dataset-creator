import { sha256HexInWorker } from '../image/imageWorkerClient';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { VIDEO_MODEL_KEY, bitmapModelTensor, downloadVideoModel, loadVideoModel } from '../video/videoModel';
import { getCachedTextFeature, readImageFeature, setCachedTextFeature, writeImageFeature } from './semanticFeatureCache';
import { createSemanticWorkerSession, isSemanticWorkerSupported } from './semanticWorkerClient';

export const SEMANTIC_FEATURE_MODEL = {
  visual: VIDEO_MODEL_KEY,
  text: 'unicode-token-hash-256-v1',
  preprocessing: 'dinov2-rgb-short256-center224+nfkc-token-bigrams-v1',
};
export const SEMANTIC_FEATURE_MODEL_KEY = `${SEMANTIC_FEATURE_MODEL.visual}:${SEMANTIC_FEATURE_MODEL.text}:${SEMANTIC_FEATURE_MODEL.preprocessing}`;

export type SemanticFeature = {
  imageHash: string;
  image: Float32Array;
  text: Float32Array;
  contexts: string[];
  caption: string;
};

const digestByBlob = new WeakMap<Blob, string>();
export const hexDigest = async (value: Blob | string): Promise<string> => {
  if (typeof value !== 'string') {
    const known = digestByBlob.get(value);
    if (known) return known;
    const hashed = (await sha256HexInWorker(value)) ?? await hexDigestOnMainThread(value);
    digestByBlob.set(value, hashed);
    return hashed;
  }
  return hexDigestOnMainThread(value);
};
const hexDigestOnMainThread = async (value: Blob | string): Promise<string> => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
const normalize = (vector: Float32Array) => {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (length) for (let index = 0; index < vector.length; index += 1) vector[index] /= length;
  return vector;
};
const hashToken = (token: string) => {
  let hash = 2166136261;
  for (const char of token) { hash ^= char.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};
export const encodeCaptionText = (caption: string): Float32Array => {
  const vector = new Float32Array(256);
  const tokens = caption.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const features = [...tokens, ...tokens.slice(0, -1).map((token, index) => `${token}_${tokens[index + 1]}`)];
  for (const feature of features) {
    const hash = hashToken(feature);
    vector[hash % vector.length] += (hash & 256) ? 1 : -1;
  }
  return normalize(vector);
};
export const extractCaptionContexts = (caption: string): string[] => {
  const tokens = caption.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set([...tokens, ...tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`)])].sort();
};

/** DINOv2 inference backend: a dedicated worker, or the main thread when workers/OffscreenCanvas are unavailable. */
const createInferenceBackend = async (signal: AbortSignal | undefined, progress: ((phase: string) => void) | undefined, allowDownload: boolean) => {
  if (isSemanticWorkerSupported()) {
    const session = await createSemanticWorkerSession(signal, allowDownload, progress);
    return { infer: (blob: Blob) => session.encode(blob, signal), dispose: async () => session.dispose() };
  }
  if (allowDownload) await downloadVideoModel(signal, (value) => progress?.(value.phase));
  progress?.('Loading semantic model');
  const model = await loadVideoModel(signal, (value) => progress?.(value.phase));
  const context = new OffscreenCanvas(224, 224).getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingQuality = 'high';
  return {
    infer: async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob);
      try { return await model.infer(bitmapModelTensor(context, bitmap)); } finally { bitmap.close(); }
    },
    dispose: () => model.dispose(),
  };
};

/** The model could not be downloaded or loaded: fatal for the whole run, not a per-image failure. */
export class SemanticModelError extends Error {
  constructor(message: string) { super(message); this.name = 'SemanticModelError'; }
}
export const isSemanticModelError = (error: unknown): error is SemanticModelError => error instanceof SemanticModelError;

export const createSemanticFeatureEncoder = async (signal?: AbortSignal, progress?: (phase: string) => void, options: { allowDownload?: boolean } = {}) => {
  progress?.('Preparing semantic model');
  // The worker and the 88 MB model start on the first cache miss, so fully cached runs never load them.
  let started: Promise<Awaited<ReturnType<typeof createInferenceBackend>>> | undefined;
  const getBackend = () => started ??= createInferenceBackend(signal, progress, options.allowDownload !== false).catch((error) => {
    started = undefined;
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new SemanticModelError(error instanceof Error && error.message ? error.message : 'The semantic model could not be loaded.');
  });
  const backend = {
    infer: async (blob: Blob) => (await getBackend()).infer(blob),
    dispose: async () => { const current = started; started = undefined; if (current) await (await current.catch(() => undefined))?.dispose(); },
  };
  const encodeImage = async (item: WorkspaceImage): Promise<{ imageHash: string; image: Float32Array }> => {
    signal?.throwIfAborted();
    // A PSD is encoded from its existing preview; the raw file is not decodable by the browser.
    if (item.kind === 'psd' && !item.previewUrl) throw new Error('PSD preview unavailable');
    const imageHash = await hexDigest(item.imageData);
    const imageKey = `${imageHash}:${SEMANTIC_FEATURE_MODEL.visual}`;
    let image = await readImageFeature(imageKey);
    if (!image) {
      signal?.throwIfAborted();
      let visualBlob: Blob = item.imageData;
      if (item.kind === 'psd' && item.previewUrl) {
        try {
          const response = await fetch(item.previewUrl, { signal });
          if (!response.ok) throw new Error('preview request failed');
          visualBlob = await response.blob();
        } catch {
          signal?.throwIfAborted();
          throw new Error('PSD preview unavailable');
        }
      }
      image = await backend.infer(visualBlob);
      writeImageFeature(imageKey, image);
    }
    return { imageHash, image };
  };
  return {
    encodeImage,
    encode: async (item: WorkspaceImage, caption: string): Promise<SemanticFeature> => {
      const { imageHash, image } = await encodeImage(item);
      const captionHash = await hexDigest(caption.normalize('NFKC'));
      const textKey = `${captionHash}:${SEMANTIC_FEATURE_MODEL.text}`;
      let text = getCachedTextFeature(textKey);
      if (!text) { text = encodeCaptionText(caption); setCachedTextFeature(textKey, text); }
      return { imageHash, image, text, contexts: extractCaptionContexts(caption), caption };
    },
    dispose: () => backend.dispose(),
  };
};
