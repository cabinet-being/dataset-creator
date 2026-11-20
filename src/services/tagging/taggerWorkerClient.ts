import type { LocalTaggerBundle, TaggerModelInfo } from './localTaggerService';
import type { TaggerWorkerRequest, TaggerWorkerResponse } from './taggerWorker.worker';

type Body = TaggerWorkerRequest extends infer Value ? Value extends { id: number } ? Omit<Value, 'id'> : never : never;
const IDLE_MS = 5 * 60 * 1000;
export const TAGGER_MEMORY_MESSAGE = 'Not enough memory to run the caption model. Close other tabs and try again.';

export const isTaggerWorkerSupported = (): boolean => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

class WorkerFailure extends Error {
  constructor(message: string, readonly code?: 'webgpu' | 'memory') { super(code === 'memory' ? TAGGER_MEMORY_MESSAGE : message); }
}
const asFailure = (message: string) => new WorkerFailure(message, /memory|alloc/i.test(message) ? 'memory' : undefined);

// One tagger worker at a time. It holds the ONNX session of `owner` (a key on the bundle) and is terminated when idle or when the bundle is released.
let worker: Worker | undefined;
let owner: object | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (response: TaggerWorkerResponse) => void; reject: (error: Error) => void }>();
// Keys for which WebGPU session creation failed: their workers start with WebGPU disabled.
const wasmOnly = new WeakSet<object>();

const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
const terminate = (error?: Error) => {
  clearIdle();
  worker?.terminate(); worker = undefined; owner = undefined;
  for (const entry of pending.values()) entry.reject(error ?? new Error('The tagger worker was released.'));
  pending.clear();
};
const armIdle = () => { clearIdle(); if (worker) idleTimer = setTimeout(() => terminate(), IDLE_MS); };
const send = (body: Body) => new Promise<TaggerWorkerResponse>((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  worker!.postMessage({ ...body, id });
});
const spawn = () => {
  const created = new Worker(new URL('./taggerWorker.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = ({ data }: MessageEvent<TaggerWorkerResponse>) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === 'error') entry.reject(new WorkerFailure(data.message, data.code)); else entry.resolve(data);
  };
  created.onerror = (event) => { if (worker === created) terminate(asFailure(event.message || 'The tagger worker failed.')); };
  return created;
};

let starting: Promise<TaggerModelInfo> | undefined;
/** Starts a worker for `key` and loads the model. On a WebGPU failure the worker is discarded (freeing its heap) and a fresh WASM-only one is started. */
const startWorker = async (key: object, modelFile: File): Promise<TaggerModelInfo> => {
  for (;;) {
    const created = spawn(); worker = created; owner = key;
    try {
      const response = await send({ type: 'init', modelFile, disableWebGpu: wasmOnly.has(key) });
      if (response.type !== 'ready') throw new Error('Unexpected tagger worker response.');
      if (worker !== created) throw new Error('The tagger worker was released.');
      return response.info;
    } catch (error) {
      const retry = error instanceof WorkerFailure && error.code === 'webgpu' && !wasmOnly.has(key) && worker === created;
      if (worker === created) terminate();
      if (!retry) throw error;
      wasmOnly.add(key);
    }
  }
};

const ensureWorker = async (bundle: LocalTaggerBundle) => {
  if (owner !== bundle.workerKey) terminate();
  if (!worker) {
    const begun = startWorker(bundle.workerKey, bundle.modelFile);
    starting = begun;
    void begun.catch(() => {});
  }
  const info = await starting!;
  bundle.runtime = info.runtime;
};

/**
 * Loads the model in a worker owned by `key` and lets `validate` inspect it. Nothing about the model is instantiated on the calling thread.
 * With `keepWarm` false the worker is terminated afterwards (it is re-created lazily on first scoring).
 */
export const validateModelInTaggerWorker = async (
  key: object,
  modelFile: File,
  validate: (info: TaggerModelInfo) => void,
  keepWarm: boolean
): Promise<TaggerModelInfo> => {
  terminate();
  const begun = startWorker(key, modelFile);
  starting = begun;
  const info = await begun;
  try {
    validate(info);
  } catch (error) {
    if (owner === key) terminate();
    throw error;
  }
  if (owner === key) { if (keepWarm) armIdle(); else terminate(); }
  return info;
};

export const scoreImageInTaggerWorker = async (bundle: LocalTaggerBundle, image: Blob): Promise<Float32Array> => {
  clearIdle();
  try {
    await ensureWorker(bundle);
  } catch (error) {
    armIdle();
    throw error;
  }
  try {
    const response = await send({ type: 'score', image, spec: { inputName: bundle.inputName, outputName: bundle.outputName, inputWidth: bundle.inputWidth, inputHeight: bundle.inputHeight, layout: bundle.layout, inputChannelOrder: bundle.inputChannelOrder } });
    if (response.type !== 'scores') throw new Error('Unexpected tagger worker response.');
    return response.scores;
  } finally {
    armIdle();
  }
};

export const releaseTaggerWorker = (bundle: LocalTaggerBundle) => { if (owner === bundle.workerKey) terminate(); };
