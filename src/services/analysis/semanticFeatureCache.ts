import { getStoredImageFeature, putStoredImageFeature } from './semanticFeatureStore';

export type CachedSemanticFeature = { key: string; vector: Float32Array };

const MAX_MEMORY_IMAGE_FEATURES = 5_000;
// Map iteration order is insertion order: re-inserting on read keeps the most recently used entries last.
const imageFeatures = new Map<string, Float32Array>();
const textFeatures = new Map<string, Float32Array>();

export const getCachedImageFeature = (key: string) => {
  const value = imageFeatures.get(key);
  if (value) { imageFeatures.delete(key); imageFeatures.set(key, value); }
  return value;
};
export const setCachedImageFeature = (key: string, vector: Float32Array) => {
  imageFeatures.delete(key); imageFeatures.set(key, vector);
  while (imageFeatures.size > MAX_MEMORY_IMAGE_FEATURES) imageFeatures.delete(imageFeatures.keys().next().value!);
};
/** Memory first, then the persistent IndexedDB cache; a storage failure is treated as a miss. */
export const readImageFeature = async (key: string): Promise<Float32Array | undefined> => {
  const memory = getCachedImageFeature(key);
  if (memory) return memory;
  const stored = await getStoredImageFeature(key).catch(() => undefined);
  if (stored) setCachedImageFeature(key, stored);
  return stored;
};
/** Stores in memory and persists best-effort (quota or private-mode failures do not fail encoding). */
export const writeImageFeature = (key: string, vector: Float32Array) => {
  setCachedImageFeature(key, vector);
  void putStoredImageFeature(key, vector).catch(() => {});
};
export const getCachedTextFeature = (key: string) => textFeatures.get(key);
export const setCachedTextFeature = (key: string, vector: Float32Array) => textFeatures.set(key, vector);
export const clearSemanticFeatureCache = () => { imageFeatures.clear(); textFeatures.clear(); };
