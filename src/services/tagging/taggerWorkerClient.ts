import type { LocalTaggerBundle } from './localTaggerService';
import type { TaggerWorkerRequest, TaggerWorkerResponse } from './taggerWorker.worker';

type Body = TaggerWorkerRequest extends infer Value ? Value extends { id: number } ? Omit<Value, 'id'> : never : never;
const IDLE_MS = 5 * 60 * 1000;

export const isTaggerWorkerSupported = (): boolean => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

// One tagger worker at a time. It holds the ONNX session of `owner` and is terminated when idle or when the bundle is released.
let worker: Worker | undefined;
let owner: LocalTaggerBundle | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (response: TaggerWorkerResponse) => void; reject: (error: Error) => void }>();

const terminate = (error?: Error) => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  worker?.terminate(); worker = undefined; owner = undefined;
  for (const entry of pending.values()) entry.reject(error ?? new Error('The tagger worker was released.'));
  pending.clear();
};
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
    if (data.type === 'error') entry.reject(new Error(data.message)); else entry.resolve(data);
  };
  created.onerror = (event) => { if (worker === created) terminate(new Error(event.message || 'The tagger worker failed.')); };
  return created;
};

let starting: Promise<void> | undefined;
const ensureWorker = async (bundle: LocalTaggerBundle) => {
  if (owner !== bundle) terminate();
  if (!worker) {
    worker = spawn(); owner = bundle;
    starting = send({ type: 'init', modelFile: bundle.modelFile }).then(() => undefined);
    starting.catch(() => { if (owner === bundle) terminate(); });
  }
  await starting;
};

export const scoreImageInTaggerWorker = async (bundle: LocalTaggerBundle, image: Blob): Promise<Float32Array> => {
  await ensureWorker(bundle);
  if (idleTimer) clearTimeout(idleTimer);
  try {
    const response = await send({ type: 'score', image, spec: { inputName: bundle.inputName, outputName: bundle.outputName, inputWidth: bundle.inputWidth, inputHeight: bundle.inputHeight, layout: bundle.layout, inputChannelOrder: bundle.inputChannelOrder } });
    if (response.type !== 'scores') throw new Error('Unexpected tagger worker response.');
    return response.scores;
  } finally {
    if (worker) { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => terminate(), IDLE_MS); }
  }
};

export const releaseTaggerWorker = (bundle: LocalTaggerBundle) => { if (owner === bundle) terminate(); };
