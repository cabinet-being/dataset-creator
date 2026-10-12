import type { InferenceSession } from 'onnxruntime-web';
import type { VideoSample } from 'mediabunny';
import { getVideoMeta, setVideoMeta } from './videoCache';
import { normalizeFrameEmbedding } from './frameSelection';
import { checkVideoAbort, type VideoProgress } from './types';

export const VIDEO_MODEL = {
  revision: '560a572cedd01ab59cf1a614c2d9673397b65ef2',
  sha256: '83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea',
  bytes: 88459888,
  preprocessing: 'rgb-short256-center224-canvas-high-imagenet-cls-l2-v1',
};
export const VIDEO_MODEL_KEY = `dinov2-small:${VIDEO_MODEL.sha256}:${VIDEO_MODEL.preprocessing}`;
const MODEL_URL = `https://huggingface.co/Xenova/dinov2-small/resolve/${VIDEO_MODEL.revision}/onnx/model.onnx`;
const WASM_URL = new URL('../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href;

export const verifyVideoModel = async (buffer: ArrayBuffer) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (buffer.byteLength !== VIDEO_MODEL.bytes || hash !== VIDEO_MODEL.sha256) throw new Error('DINOv2 download failed its integrity check. Clear the video cache and download again.');
};
export const downloadVideoModel = async (signal?: AbortSignal, progress?: (progress: VideoProgress) => void) => {
  const existing = await getVideoMeta<ArrayBuffer>('model');
  if (existing) { await verifyVideoModel(existing); return; }
  const response = await fetch(MODEL_URL, { signal, credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error(`DINOv2 download failed (${response.status}). No video data was uploaded.`);
  const buffer = new Uint8Array(VIDEO_MODEL.bytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      checkVideoAbort(signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > buffer.byteLength) throw new Error('Unexpected DINOv2 model size.');
      buffer.set(value, offset);
      offset += value.byteLength;
      progress?.({ phase: 'Downloading DINOv2', completed: offset, total: VIDEO_MODEL.bytes });
    }
  } finally { await reader.cancel(); }
  if (offset !== buffer.byteLength) throw new Error('Incomplete DINOv2 download. Please retry.');
  await verifyVideoModel(buffer.buffer);
  checkVideoAbort(signal);
  await setVideoMeta('model', buffer.buffer);
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
export const loadVideoModel = async (signal?: AbortSignal, progress?: (progress: VideoProgress) => void, preferred: 'auto' | 'wasm' | 'webgpu' = 'auto') => {
  const buffer = await getVideoMeta<ArrayBuffer>('model');
  if (!buffer) throw new Error('Download the DINOv2 model before starting automatic analysis.');
  await verifyVideoModel(buffer);
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
