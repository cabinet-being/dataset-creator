import type { SemanticWorkerRequest, SemanticWorkerResponse } from './semanticWorker.worker';

type Body = SemanticWorkerRequest extends infer Value ? Value extends { id: number } ? Omit<Value, 'id'> : never : never;
type Pending = { resolve: (response: SemanticWorkerResponse) => void; reject: (error: unknown) => void; progress?: (phase: string) => void };

export const isSemanticWorkerSupported = (): boolean => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
// Hashing the stored 88 MB model takes a while; a worker restarted after an idle terminate skips it once it passed.
let storedModelVerified = false;
const abortError = () => new DOMException('Semantic encoding cancelled.', 'AbortError');

/** One dedicated DINOv2 worker. It loads the model bytes from IndexedDB itself and returns transferred vectors. */
export const createSemanticWorkerSession = async (signal: AbortSignal | undefined, allowDownload: boolean, progress?: (phase: string) => void) => {
  signal?.throwIfAborted();
  let worker: Worker | undefined = new Worker(new URL('./semanticWorker.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let sequence = 0;
  const stop = (error: unknown) => {
    worker?.terminate(); worker = undefined;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = ({ data }: MessageEvent<SemanticWorkerResponse>) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    if (data.type === 'progress') { entry.progress?.(data.phase); return; }
    pending.delete(data.id);
    if (data.type === 'error') entry.reject(new Error(data.message)); else entry.resolve(data);
  };
  worker.onerror = (event) => stop(new Error(event.message || 'The semantic model worker failed.'));
  const request = (body: Body, requestSignal?: AbortSignal, onProgress?: (phase: string) => void) => new Promise<SemanticWorkerResponse>((resolve, reject) => {
    if (!worker) { reject(new Error('The semantic model worker was released.')); return; }
    if (requestSignal?.aborted) { reject(abortError()); return; }
    const id = ++sequence;
    const onAbort = () => { pending.delete(id); reject(abortError()); };
    requestSignal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => requestSignal?.removeEventListener('abort', onAbort);
    pending.set(id, { resolve: (value) => { settle(); resolve(value); }, reject: (error) => { settle(); reject(error); }, progress: onProgress });
    worker.postMessage({ ...body, id });
  });
  try { await request({ type: 'init', allowDownload, verified: storedModelVerified }, signal, progress); storedModelVerified = true; }
  catch (error) { stop(error); throw error; }
  return {
    encode: async (blob: Blob, requestSignal?: AbortSignal): Promise<Float32Array> => {
      const response = await request({ type: 'encode', blob }, requestSignal ?? signal);
      if (response.type !== 'vector') throw new Error('Unexpected semantic worker response.');
      return response.vector;
    },
    dispose: () => stop(abortError()),
  };
};
