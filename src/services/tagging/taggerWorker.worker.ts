import type { InferenceSession } from 'onnxruntime-web';
import { createSession, scoreImageWithSession, type TaggerInputSpec } from './localTaggerService';

export type TaggerWorkerRequest =
  | { id: number; type: 'init'; modelFile: File }
  | { id: number; type: 'score'; image: Blob; spec: TaggerInputSpec };
export type TaggerWorkerResponse =
  | { id: number; type: 'ready' }
  | { id: number; type: 'scores'; scores: Float32Array }
  | { id: number; type: 'error'; message: string };

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<TaggerWorkerRequest>) => void) | null; postMessage: (message: TaggerWorkerResponse, transfer?: Transferable[]) => void };
let session: Promise<InferenceSession> | undefined;
let queue: Promise<unknown> = Promise.resolve();

const handle = async (data: TaggerWorkerRequest) => {
  try {
    if (data.type === 'init') {
      session ??= (async () => {
        const ort = await import('onnxruntime-web/all');
        return (await createSession(ort, await data.modelFile.arrayBuffer())).session;
      })();
      try { await session; } catch (error) { session = undefined; throw error; }
      scope.postMessage({ id: data.id, type: 'ready' });
      return;
    }
    if (!session) throw new Error('The tagger model is not loaded.');
    const scores = await scoreImageWithSession(await session, data.spec, data.image);
    scope.postMessage({ id: data.id, type: 'scores', scores }, [scores.buffer]);
  } catch (error) {
    scope.postMessage({ id: data.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
scope.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
