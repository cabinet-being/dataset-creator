import { bitmapModelTensor, downloadVideoModel, loadVideoModel, markStoredVideoModelVerified } from '../video/videoModel';

export type SemanticWorkerRequest =
  | { id: number; type: 'init'; allowDownload: boolean; /** The main thread already hashed the stored model this page session. */ verified?: boolean }
  | { id: number; type: 'encode'; blob: Blob };
export type SemanticWorkerResponse =
  | { id: number; type: 'progress'; phase: string }
  | { id: number; type: 'ready' }
  | { id: number; type: 'vector'; vector: Float32Array }
  | { id: number; type: 'error'; message: string };

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<SemanticWorkerRequest>) => void) | null; postMessage: (message: SemanticWorkerResponse, transfer?: Transferable[]) => void };
type Model = Awaited<ReturnType<typeof loadVideoModel>>;
let model: Promise<Model> | undefined;
let context: OffscreenCanvasRenderingContext2D | undefined;
// Requests run one after another: a single ONNX session and one canvas.
let queue: Promise<unknown> = Promise.resolve();

const handle = async (data: SemanticWorkerRequest) => {
  try {
    if (data.type === 'init') {
      const progress = (phase: string) => scope.postMessage({ id: data.id, type: 'progress', phase });
      if (data.verified) markStoredVideoModelVerified();
      model ??= (async () => {
        if (data.allowDownload) await downloadVideoModel(undefined, (value) => progress(value.phase));
        progress('Loading semantic model');
        return loadVideoModel(undefined, (value) => progress(value.phase));
      })();
      try { await model; } catch (error) { model = undefined; throw error; }
      scope.postMessage({ id: data.id, type: 'ready' });
      return;
    }
    const loaded = await model;
    if (!loaded) throw new Error('The semantic model is not loaded.');
    if (!context) {
      context = new OffscreenCanvas(224, 224).getContext('2d', { willReadFrequently: true })!;
      context.imageSmoothingQuality = 'high';
    }
    const bitmap = await createImageBitmap(data.blob);
    try {
      const vector = await loaded.infer(bitmapModelTensor(context, bitmap));
      scope.postMessage({ id: data.id, type: 'vector', vector }, [vector.buffer]);
    } finally { bitmap.close(); }
  } catch (error) {
    scope.postMessage({ id: data.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
scope.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
