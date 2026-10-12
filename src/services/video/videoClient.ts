import type { VideoWorkerRequest, VideoWorkerResponse, VideoProgress } from './types';

type Request = VideoWorkerRequest extends infer Value ? Value extends { id: number } ? Omit<Value, 'id'> : never : never;
type Result = Extract<VideoWorkerResponse, { type: 'result' }>;
const busyTabs = new Set<string>();
export const setVideoTabBusy = (id: string, busy: boolean) => { if (busy) busyTabs.add(id); else busyTabs.delete(id); };
export const hasBusyVideoTabs = (ids: string[]) => ids.some((id) => busyTabs.has(id));
export const hasBusyVideoTasks = () => busyTabs.size > 0;

export class VideoClient {
  private worker?: Worker;
  private pending?: { resolve: (result: Result) => void; reject: (error: Error) => void; progress?: (progress: VideoProgress) => void; id: number };
  private sequence = 0;

  request(request: Request, progress?: (progress: VideoProgress) => void): Promise<Result> {
    if (this.pending) return Promise.reject(new Error('A video operation is already running.'));
    this.worker ??= new Worker(new URL('./video.worker.ts', import.meta.url), { type: 'module' });
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, progress, id };
      this.worker!.onmessage = ({ data }: MessageEvent<VideoWorkerResponse>) => {
        if (data.id !== this.pending?.id) return;
        if (data.type === 'progress') { this.pending.progress?.(data.progress); return; }
        const pending = this.pending;
        this.pending = undefined;
        this.worker?.terminate(); this.worker = undefined;
        if (data.type === 'error') pending.reject(new Error(data.message));
        else pending.resolve(data);
      };
      this.worker!.onerror = (event) => {
        this.pending?.reject(new Error(event.message || 'The video worker failed.'));
        this.pending = undefined;
        this.worker?.terminate(); this.worker = undefined;
      };
      this.worker!.postMessage({ ...request, id });
    });
  }
  cancel() {
    this.worker?.terminate(); this.worker = undefined;
    this.pending?.reject(new DOMException('Video operation cancelled.', 'AbortError'));
    this.pending = undefined;
  }
}
