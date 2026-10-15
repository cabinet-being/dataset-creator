import type { WorkspaceImage } from '../../lib/workspaceImages';
import { VIDEO_MODEL_KEY, downloadVideoModel, loadVideoModel, rgbModelTensor } from '../video/videoModel';
import { getCachedImageFeature, getCachedTextFeature, setCachedImageFeature, setCachedTextFeature } from './semanticFeatureCache';

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

const hexDigest = async (value: Blob | string): Promise<string> => {
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

export const createSemanticFeatureEncoder = async (signal?: AbortSignal, progress?: (phase: string) => void) => {
  progress?.('Preparing semantic model');
  await downloadVideoModel(signal, (value) => progress?.(value.phase));
  progress?.('Loading semantic model');
  const model = await loadVideoModel(signal, (value) => progress?.(value.phase));
  const canvas = new OffscreenCanvas(224, 224);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingQuality = 'high';
  return {
    encode: async (item: WorkspaceImage, caption: string): Promise<SemanticFeature> => {
      signal?.throwIfAborted();
      const imageHash = await hexDigest(item.imageData);
      const imageKey = `${imageHash}:${SEMANTIC_FEATURE_MODEL.visual}`;
      let image = getCachedImageFeature(imageKey);
      if (!image) {
        const visualBlob = item.kind === 'psd' && item.previewUrl
          ? await fetch(item.previewUrl, { signal }).then((response) => response.blob())
          : item.imageData;
        const bitmap = await createImageBitmap(visualBlob);
        try {
          const scale = 256 / Math.min(bitmap.width, bitmap.height);
          const width = Math.floor(bitmap.width * scale);
          const height = Math.floor(bitmap.height * scale);
          context.fillStyle = 'black'; context.fillRect(0, 0, 224, 224);
          context.drawImage(bitmap, -Math.floor((width - 224) / 2), -Math.floor((height - 224) / 2), width, height);
          image = await model.infer(rgbModelTensor(context.getImageData(0, 0, 224, 224).data));
          setCachedImageFeature(imageKey, image);
        } finally { bitmap.close(); }
      }
      const captionHash = await hexDigest(caption.normalize('NFKC'));
      const textKey = `${captionHash}:${SEMANTIC_FEATURE_MODEL.text}`;
      let text = getCachedTextFeature(textKey);
      if (!text) { text = encodeCaptionText(caption); setCachedTextFeature(textKey, text); }
      return { imageHash, image, text, contexts: extractCaptionContexts(caption), caption };
    },
    dispose: () => model.dispose(),
  };
};
