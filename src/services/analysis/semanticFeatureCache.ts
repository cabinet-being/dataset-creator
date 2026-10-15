export type CachedSemanticFeature = { key: string; vector: Float32Array };

const imageFeatures = new Map<string, Float32Array>();
const textFeatures = new Map<string, Float32Array>();

export const getCachedImageFeature = (key: string) => imageFeatures.get(key);
export const setCachedImageFeature = (key: string, vector: Float32Array) => imageFeatures.set(key, vector);
export const getCachedTextFeature = (key: string) => textFeatures.get(key);
export const setCachedTextFeature = (key: string, vector: Float32Array) => textFeatures.set(key, vector);
export const clearSemanticFeatureCache = () => { imageFeatures.clear(); textFeatures.clear(); };

