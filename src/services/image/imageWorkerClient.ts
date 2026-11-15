import type { ImageQualityOptions, ImageQualityReport } from '../quality/imageQuality';
import type { ImageWorkerRequest, ImageWorkerResponse, ResizeResult } from './imageWorker.worker';

type Body = ImageWorkerRequest extends infer Value ? Value extends { id: number } ? Omit<Value, 'id'> : never : never;
type Job = {
  body: Body; priority: number; seq: number; signal?: AbortSignal; isWanted?: () => boolean;
  resolve: (value: ImageQualityReport | ResizeResult | string) => void; reject: (error: unknown) => void; onAbort?: () => void;
};
type Slot = { worker: Worker; job?: Job; id: number };

const IDLE_MS = 30_000;
const abortError = () => new DOMException('Image worker job cancelled.', 'AbortError');

export const isImageWorkerSupported = (): boolean => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

/** Small pool: at most `size` images are decoded at once, queued jobs run by priority, idle workers are released. */
class ImageWorkerPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private sequence = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly size: number) {}

  run<T>(body: Body, options: { priority?: number; signal?: AbortSignal; isWanted?: () => boolean } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const job: Job = { body, priority: options.priority ?? 0, seq: ++this.sequence, signal: options.signal, isWanted: options.isWanted, resolve: resolve as Job['resolve'], reject };
      if (options.signal) {
        job.onAbort = () => {
          const queued = this.queue.indexOf(job);
          if (queued >= 0) this.queue.splice(queued, 1);
          job.reject(abortError());
          const slot = this.slots.find((candidate) => candidate.job === job);
          if (slot) slot.job = undefined; // result of the running job is ignored
          this.pump();
        };
        options.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private settle(job: Job) { if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort); }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(new URL('./imageWorker.worker.ts', import.meta.url), { type: 'module' }), id: 0 };
    slot.worker.onmessage = ({ data }: MessageEvent<ImageWorkerResponse>) => {
      const job = slot.job;
      if (!job || data.id !== slot.id) return;
      slot.job = undefined; this.settle(job);
      if (data.ok) job.resolve(data.result); else job.reject(new Error(data.message));
      this.pump();
    };
    slot.worker.onerror = (event) => {
      const job = slot.job; slot.job = undefined;
      slot.worker.terminate(); this.slots = this.slots.filter((candidate) => candidate !== slot);
      if (job) { this.settle(job); job.reject(new Error(event.message || 'The image worker failed.')); }
      this.pump();
    };
    this.slots.push(slot);
    return slot;
  }

  private pump() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    for (;;) {
      if (!this.queue.length) break;
      let slot = this.slots.find((candidate) => !candidate.job);
      if (!slot && this.slots.length < this.size) {
        try { slot = this.spawn(); }
        catch (error) { for (const job of this.queue.splice(0)) { this.settle(job); job.reject(error); } return; }
      }
      if (!slot) break;
      let best = 0;
      for (let index = 1; index < this.queue.length; index += 1) {
        const a = this.queue[index]; const b = this.queue[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = index;
      }
      const [job] = this.queue.splice(best, 1);
      if (job.isWanted && !job.isWanted()) { this.settle(job); job.reject(abortError()); continue; }
      slot.job = job; slot.id += 1;
      slot.worker.postMessage({ ...job.body, id: slot.id });
    }
    if (!this.queue.length && this.slots.every((slot) => !slot.job) && this.slots.length) {
      this.idleTimer = setTimeout(() => { for (const slot of this.slots) slot.worker.terminate(); this.slots = []; this.idleTimer = undefined; }, IDLE_MS);
    }
  }
}

// Quality analysis and preview resizing use separate pools so a long analysis never delays previews.
const qualityPool = new ImageWorkerPool(2);
const previewPool = new ImageWorkerPool(1);

export const measureImageQualityInWorker = (blob: Blob, options: ImageQualityOptions, signal?: AbortSignal): Promise<ImageQualityReport> =>
  qualityPool.run<ImageQualityReport>({ type: 'quality', blob, options }, { signal });

export const resizeImageInWorker = (blob: Blob, maxSide: number, options: { priority: number; quality?: number; isWanted?: () => boolean }): Promise<ResizeResult> =>
  previewPool.run<ResizeResult>({ type: 'resize', blob, maxSide, quality: options.quality ?? 0.82 }, { priority: options.priority, isWanted: options.isWanted });

const digestPool = new ImageWorkerPool(1);

/** SHA-256 hex of a blob, read and hashed in a worker so the UI thread never holds the file bytes; null when workers are unavailable. */
export const sha256HexInWorker = async (blob: Blob): Promise<string | null> => {
  if (typeof Worker === 'undefined') return null;
  try { return await digestPool.run<string>({ type: 'digest', blob }); }
  catch { return null; }
};
