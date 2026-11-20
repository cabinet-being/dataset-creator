import type { InferenceSession } from 'onnxruntime-web';
import type { VideoSample } from 'mediabunny';
import { getVideoMeta, requestPersistentStorage, setVideoMeta } from './videoCache';
import { normalizeFrameEmbedding } from './frameSelection';
import { checkVideoAbort, type VideoProgress } from './types';
import { downloadVerifiedModelAsset, verifyModelAsset } from '../models/verifiedModelDownload';

export const VIDEO_MODEL = {
  revision: '560a572cedd01ab59cf1a614c2d9673397b65ef2',
  sha256: '83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea',
  bytes: 88459888,
  preprocessing: 'rgb-short256-center224-canvas-high-imagenet-cls-l2-v1',
};
export const VIDEO_MODEL_MISSING_MESSAGE = 'Download the DINOv2 model before starting automatic analysis.';
export const VIDEO_MODEL_KEY = `dinov2-small:${VIDEO_MODEL.sha256}:${VIDEO_MODEL.preprocessing}`;
const MODEL_URL = `https://huggingface.co/Xenova/dinov2-small/resolve/${VIDEO_MODEL.revision}/onnx/model.onnx`;
const WASM_URL = new URL('../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href;

const VIDEO_ASSET = { label: 'DINOv2', url: MODEL_URL, bytes: VIDEO_MODEL.bytes, sha256: VIDEO_MODEL.sha256 };
const VIDEO_INTEGRITY_MESSAGE = 'DINOv2 download failed its integrity check. Clear the video cache and download again.';

export const verifyVideoModel = (buffer: ArrayBuffer) => verifyModelAsset(buffer, VIDEO_ASSET, VIDEO_INTEGRITY_MESSAGE);
// The stored model only changes through a verified download, so hashing 88 MB once per session is enough.
let verifiedStoredModel: Promise<void> | undefined;
/** A worker starts without this flag; the main thread tells it the model was already verified this page session. */
export const markStoredVideoModelVerified = () => { verifiedStoredModel = Promise.resolve(); };
const verifyStoredModelOnce = (buffer: ArrayBuffer) => {
  verifiedStoredModel ??= verifyVideoModel(buffer).catch((error) => { verifiedStoredModel = undefined; throw error; });
  return verifiedStoredModel;
};
export const downloadVideoModel = async (signal?: AbortSignal, progress?: (progress: VideoProgress) => void) => {
  const existing = await getVideoMeta<ArrayBuffer>('model');
  if (existing) { await verifyStoredModelOnce(existing); void requestPersistentStorage(); return; }
  const buffer = await downloadVerifiedModelAsset(VIDEO_ASSET, {
    signal, progress, phase: 'Downloading DINOv2',
    messages: {
      http: (status) => `DINOv2 download failed (${status}). No video data was uploaded.`,
      size: 'Unexpected DINOv2 model size.',
      incomplete: 'Incomplete DINOv2 download. Please retry.',
      integrity: VIDEO_INTEGRITY_MESSAGE,
    },
  });
  await setVideoMeta('model', buffer);
  verifiedStoredModel = Promise.resolve();
  void requestPersistentStorage();
};

export const rgbModelTensor = (pixels: Uint8ClampedArray): Float32Array => {
  const means = [0.485, 0.456, 0.406];
  const deviations = [0.229, 0.224, 0.225];
  const area = pixels.length / 4;
  const values = new Float32Array(area * 3);
  for (let pixel = 0; pixel < area; pixel++) {
    for (let channel = 0; channel < 3; channel++) values[channel * area + pixel] = (pixels[pixel * 4 + channel] / 255 - means[channel]) / deviations[channel];
  }
  return values;
};
/** Centre-crops a decoded image to the DINOv2 224x224 input (short side 256) and returns the normalized tensor values. */
export const bitmapModelTensor = (context: OffscreenCanvasRenderingContext2D, bitmap: ImageBitmap): Float32Array => {
  const scale = 256 / Math.min(bitmap.width, bitmap.height);
  const width = Math.floor(bitmap.width * scale);
  const height = Math.floor(bitmap.height * scale);
  context.fillStyle = 'black'; context.fillRect(0, 0, 224, 224);
  context.drawImage(bitmap, -Math.floor((width - 224) / 2), -Math.floor((height - 224) / 2), width, height);
  return rgbModelTensor(context.getImageData(0, 0, 224, 224).data);
};
export const loadVideoModel = async (signal?: AbortSignal, progress?: (progress: VideoProgress) => void, preferred: 'auto' | 'wasm' | 'webgpu' = 'auto') => {
  const buffer = await getVideoMeta<ArrayBuffer>('model');
  if (!buffer) throw new Error(VIDEO_MODEL_MISSING_MESSAGE);
  await verifyStoredModelOnce(buffer);
  checkVideoAbort(signal);
  const ort = await import('onnxruntime-web/all');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: WASM_URL };
  let session: InferenceSession;
  let runtime: 'wasm' | 'webgpu' = 'wasm';
  const create = async (provider: 'wasm' | 'webgpu') => {
    progress?.({ phase: `Loading DINOv2 (${provider})`, completed: 0, total: 1 });
    return ort.InferenceSession.create(buffer, { executionProviders: [provider], graphOptimizationLevel: 'all' });
  };
  if (preferred !== 'wasm' && 'gpu' in navigator) {
    try { session = await create('webgpu'); runtime = 'webgpu'; }
    catch (error) { if (preferred === 'webgpu') throw error; session = await create('wasm'); }
  } else {
    if (preferred === 'webgpu') throw new Error('WebGPU is unavailable.');
    session = await create('wasm');
  }
  const infer = async (values: Float32Array): Promise<Float32Array> => {
    checkVideoAbort(signal);
    const tensor = new ort.Tensor('float32', values, [1, 3, 224, 224]);
    try {
      const outputName = session.outputNames.includes('pooler_output') ? 'pooler_output' : 'last_hidden_state';
      const results = await session.run({ [session.inputNames[0]]: tensor }, [outputName]);
      try {
        checkVideoAbort(signal);
        const output = results[outputName];
        if (!output || output.dims[output.dims.length - 1] !== 384 || !(output.data instanceof Float32Array)) throw new Error('Unexpected DINOv2 output. Expected 384-dimensional visual features.');
        return normalizeFrameEmbedding(output.data.subarray(0, 384));
      } finally { Object.values(results).forEach((output) => output.dispose()); }
    } catch (error) {
      if (runtime !== 'webgpu' || preferred === 'webgpu' || signal?.aborted) throw error;
      await session.release();
      runtime = 'wasm';
      session = await create('wasm');
      return infer(values);
    } finally { tensor.dispose(); }
  };
  try { await infer(new Float32Array(3 * 224 * 224)); }
  catch (error) { await session.release(); throw error; }
  const canvas = new OffscreenCanvas(224, 224);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingQuality = 'high';
  return {
    get runtime() { return runtime; },
    infer,
    embed: async (sample: VideoSample) => {
      const scale = 256 / Math.min(sample.displayWidth, sample.displayHeight);
      const width = Math.floor(sample.displayWidth * scale);
      const height = Math.floor(sample.displayHeight * scale);
      context.fillStyle = 'black';
      context.fillRect(0, 0, 224, 224);
      sample.draw(context, -Math.floor((width - 224) / 2), -Math.floor((height - 224) / 2), width, height);
      return infer(rgbModelTensor(context.getImageData(0, 0, 224, 224).data));
    },
    dispose: () => session.release(),
  };
};
