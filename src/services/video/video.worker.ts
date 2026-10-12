import { analyzeVideo, includeVideoFrame } from './videoAnalysis';
import { downloadVideoModel, loadVideoModel } from './videoModel';
import { videoFrameBatches } from './videoCache';
import { selectVideoFrames } from './frameSelection';
import type { VideoWorkerRequest, VideoWorkerResponse, VideoProgress } from './types';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<VideoWorkerRequest>) => void) | null; postMessage: (message: VideoWorkerResponse) => void };
let running: AbortController | undefined;
scope.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { running?.abort(); return; }
  if (running) { scope.postMessage({ id: data.id, type: 'error', message: 'Another video operation is still running.' }); return; }
  const controller = new AbortController();
  running = controller;
  let lastProgress = 0;
  const progress = (value: VideoProgress) => {
    if (performance.now() - lastProgress < 150 && value.completed < value.total) return;
    lastProgress = performance.now();
    scope.postMessage({ id: data.id, type: 'progress', progress: value });
  };
  try {
    if (data.type === 'model') {
      await downloadVideoModel(controller.signal, progress);
      const model = await loadVideoModel(controller.signal, progress);
      const runtime = model.runtime;
      await model.dispose();
      scope.postMessage({ id: data.id, type: 'result', runtime });
    } else if (data.type === 'analyze') {
      const result = await analyzeVideo(data.file, data.options, data.selection, controller.signal, progress);
      scope.postMessage({ id: data.id, type: 'result', ...result });
    } else if (data.type === 'select') {
      const frames = await selectVideoFrames(() => videoFrameBatches(data.run, controller.signal), data.selection, controller.signal,
        (completed) => progress({ phase: 'Selecting diverse frames', completed, total: data.selection.limit }));
      scope.postMessage({ id: data.id, type: 'result', run: data.run, frames });
    } else {
      const frame = await includeVideoFrame(data.file, data.run, data.timestamp, controller.signal);
      scope.postMessage({ id: data.id, type: 'result', run: data.run, frames: [frame] });
    }
  } catch (error) {
    scope.postMessage({ id: data.id, type: 'error', message: controller.signal.aborted ? 'Video operation cancelled.' : error instanceof Error ? error.message : String(error) });
  } finally { running = undefined; }
};
