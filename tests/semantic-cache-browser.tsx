import type { WorkspaceImage } from '../src/lib/workspaceImages';

const result = document.querySelector<HTMLPreElement>('#result')!;
const show = (message: string) => { result.textContent = message; };
const run = (task: () => Promise<void>) => { void task().catch(error => show(`FAIL: ${error instanceof Error ? error.message : String(error)}`)); };
const cache = await import('../src/services/analysis/semanticFeatureCache');
const store = await import('../src/services/analysis/semanticFeatureStore');
const service = await import('../src/services/analysis/semanticFeatureService');

const blob = new Blob(['semantic-cache-fixture-image'], { type: 'image/png' });
const other = new Blob(['semantic-cache-fixture-uncached'], { type: 'image/png' });
const vector = Float32Array.from({ length: 8 }, (_, index) => (index + 1) / 10);
const imageOf = (data: Blob) => ({ id: 'fixture', kind: 'image', imageData: data, width: 1, height: 1 }) as unknown as WorkspaceImage;
const keyOf = async (data: Blob) => `${await service.hexDigest(data)}:${service.SEMANTIC_FEATURE_MODEL.visual}`;
const same = (a: Float32Array | undefined) => !!a && a.length === vector.length && a.every((value, index) => value === vector[index]);

document.querySelector<HTMLButtonElement>('#save')!.onclick = () => run(async () => {
  const key = await keyOf(blob);
  cache.writeImageFeature(key, vector);
  // The IndexedDB write is fire-and-forget; wait until it is visible before reloading.
  for (let attempt = 0; attempt < 100 && !same(await store.getStoredImageFeature(key)); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
  if (!same(await store.getStoredImageFeature(key))) throw new Error('Embedding was not persisted to IndexedDB.');
  location.reload();
});

document.querySelector<HTMLButtonElement>('#verify')!.onclick = () => run(async () => {
  const key = await keyOf(blob);
  if (cache.getCachedImageFeature(key)) throw new Error('Memory cache should be empty after reload.');
  if (!same(await cache.readImageFeature(key))) throw new Error('readImageFeature did not return the persisted vector after reload.');
  cache.clearSemanticFeatureCache();
  // Lazy start: a persisted vector is served without creating the worker or loading a model.
  const encoder = await service.createSemanticFeatureEncoder(undefined, undefined, { allowDownload: false });
  try {
    const encoded = await encoder.encodeImage(imageOf(blob));
    if (!same(encoded.image)) throw new Error('encodeImage did not return the persisted vector.');
    // A miss needs the model; none is available, so it must fail as a SemanticModelError rather than a per-item error.
    let failure: unknown;
    try { await encoder.encodeImage(imageOf(other)); } catch (error) { failure = error; }
    if (!service.isSemanticModelError(failure)) throw new Error(`Cache miss without a model should throw SemanticModelError, got: ${String(failure)}`);
  } finally { await encoder.dispose(); }
  show('PASS: embedding survived reload via IndexedDB; cached encodeImage needs no model; a miss throws SemanticModelError.');
});

document.querySelector<HTMLButtonElement>('#clear')!.onclick = () => run(async () => {
  cache.clearSemanticFeatureCache();
  await store.clearStoredImageFeatures();
  show('Cleared.');
});
