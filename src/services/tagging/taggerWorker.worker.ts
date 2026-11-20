import type { InferenceSession } from 'onnxruntime-web';
import { createSession, describeSession, scoreImageWithSession, WebGpuSessionError, type TaggerInputSpec, type TaggerModelInfo } from './localTaggerService';

export type TaggerWorkerRequest =
  | { id: number; type: 'init'; modelFile: File; disableWebGpu?: boolean }
  | { id: number; type: 'score'; image: Blob; spec: TaggerInputSpec };
export type TaggerWorkerErrorCode = 'webgpu' | 'memory';
export type TaggerWorkerResponse =
  | { id: number; type: 'ready'; info: TaggerModelInfo }
  | { id: number; type: 'scores'; scores: Float32Array }
  | { id: number; type: 'error'; message: string; code?: TaggerWorkerErrorCode };

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<TaggerWorkerRequest>) => void) | null; postMessage: (message: TaggerWorkerResponse, transfer?: Transferable[]) => void };
let session: Promise<{ session: InferenceSession; info: TaggerModelInfo }> | undefined;
let queue: Promise<unknown> = Promise.resolve();

const isMemoryError = (error: unknown) =>
  error instanceof RangeError || /memory|alloc/i.test(error instanceof Error ? error.message : String(error));

const handle = async (data: TaggerWorkerRequest) => {
  try {
    if (data.type === 'init') {
      session ??= (async () => {
        const ort = await import('onnxruntime-web/all');
        // The buffer is only referenced by this call, so it can be collected as soon as the session exists.
        const created = await createSession(ort, await data.modelFile.arrayBuffer(), undefined, { disableWebGpu: data.disableWebGpu, failOnWebGpuError: true });
        return { session: created.session, info: describeSession(created.session, created.runtime) };
      })();
      let ready;
      try { ready = await session; } catch (error) { session = undefined; throw error; }
      scope.postMessage({ id: data.id, type: 'ready', info: ready.info });
      return;
    }
    if (!session) throw new Error('The tagger model is not loaded.');
    const scores = await scoreImageWithSession((await session).session, data.spec, data.image);
    scope.postMessage({ id: data.id, type: 'scores', scores }, [scores.buffer]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: TaggerWorkerErrorCode | undefined = error instanceof WebGpuSessionError ? 'webgpu' : isMemoryError(error) ? 'memory' : undefined;
    scope.postMessage({ id: data.id, type: 'error', message, code });
  }
};
scope.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
