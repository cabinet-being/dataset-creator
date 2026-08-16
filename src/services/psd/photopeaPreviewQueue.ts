export type PhotopeaPsdPreviewJob = {
  id: string;
  path: string;
  file: Blob;
  resolve: (preview: Blob | undefined) => void;
  settled: boolean;
  timeoutId?: number;
  onTimeout?: () => void;
};

const queue: PhotopeaPsdPreviewJob[] = [];
const pendingByPath = new Map<string, Promise<Blob | undefined>>();
const events = new EventTarget();
const PHOTOPEA_PREVIEW_TIMEOUT_MS = 90_000;

const createJobId = (path: string): string => `${path}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

const notifyQueueChanged = () => {
  events.dispatchEvent(new Event('queuechange'));
};

export const requestPhotopeaPsdPreview = (file: Blob, path: string): Promise<Blob | undefined> => {
  const pending = pendingByPath.get(path);
  if (pending) {
    return pending;
  }

  const promise = new Promise<Blob | undefined>((resolve) => {
    const job: PhotopeaPsdPreviewJob = {
      id: createJobId(path),
      path,
      file,
      settled: false,
      resolve: (preview) => {
        if (job.settled) {
          return;
        }
        job.settled = true;
        if (job.timeoutId !== undefined) {
          window.clearTimeout(job.timeoutId);
          job.timeoutId = undefined;
        }
        resolve(preview);
      },
    };

    queue.push(job);
    notifyQueueChanged();
  }).finally(() => {
    pendingByPath.delete(path);
  });

  pendingByPath.set(path, promise);
  return promise;
};

export const takePhotopeaPsdPreviewJob = (): PhotopeaPsdPreviewJob | undefined => {
  while (queue.length > 0) {
    const job = queue.shift();
    if (job && !job.settled) {
      return job;
    }
  }
  return undefined;
};

export const startPhotopeaPsdPreviewJobTimeout = (job: PhotopeaPsdPreviewJob): void => {
  if (job.timeoutId !== undefined || job.settled) {
    return;
  }

  job.timeoutId = window.setTimeout(() => {
    if (import.meta.env.DEV) {
      console.warn(`[psd-preview] Photopea preview timed out for ${job.path}`);
    }
    job.resolve(undefined);
    job.onTimeout?.();
    notifyQueueChanged();
  }, PHOTOPEA_PREVIEW_TIMEOUT_MS);
};

export const subscribeToPhotopeaPsdPreviewQueue = (listener: () => void): (() => void) => {
  events.addEventListener('queuechange', listener);
  return () => events.removeEventListener('queuechange', listener);
};

export const completePhotopeaPsdPreviewJob = (
  job: PhotopeaPsdPreviewJob,
  preview: Blob | undefined
): void => {
  if (job.settled) {
    return;
  }
  job.resolve(preview);
  notifyQueueChanged();
};
