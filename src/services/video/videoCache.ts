import { checkVideoAbort, type FrameRecord } from './types';

const DATABASE = 'dataset-creator-video-frames-v1';
let connection: Promise<IDBDatabase> | undefined;
const database = () => connection ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('frames', { keyPath: ['run', 'timestamp'] });
    request.result.createObjectStore('thumbnails', { keyPath: ['run', 'timestamp'] });
    request.result.createObjectStore('meta');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { connection = undefined; reject(request.error); };
});
const requestValue = <Value>(request: IDBRequest<Value>) => new Promise<Value>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = transaction.onerror = () => reject(new Error(transaction.error?.name === 'QuotaExceededError'
    ? 'Video cache storage is full. Clear the video cache or free browser storage, then retry.'
    : transaction.error?.message ?? 'Video cache could not be saved.'));
});
export const getVideoMeta = async <Value>(key: string): Promise<Value | undefined> =>
  requestValue((await database()).transaction('meta').objectStore('meta').get(key));
export const hasVideoModel = async () => (await requestValue((await database()).transaction('meta').objectStore('meta').getKey('model'))) !== undefined;
export const setVideoMeta = async (key: string, value: unknown) => {
  const transaction = (await database()).transaction('meta', 'readwrite');
  const done = committed(transaction);
  transaction.objectStore('meta').put(value, key);
  await done;
};
export const putVideoFrames = async (frames: FrameRecord[], thumbnails: { run: string; timestamp: number; blob: Blob }[]) => {
  const transaction = (await database()).transaction(['frames', 'thumbnails'], 'readwrite');
  const done = committed(transaction);
  for (const frame of frames) transaction.objectStore('frames').put(frame);
  for (const thumbnail of thumbnails) transaction.objectStore('thumbnails').put(thumbnail);
  await done;
};
export async function* videoFrameBatches(run: string, signal?: AbortSignal): AsyncGenerator<FrameRecord[]> {
  let after = -Infinity;
  while (true) {
    checkVideoAbort(signal);
    const range = IDBKeyRange.bound([run, after], [run, Infinity], true);
    const batch: FrameRecord[] = await requestValue((await database()).transaction('frames').objectStore('frames').getAll(range, 256));
    if (!batch.length) return;
    yield batch;
    after = batch[batch.length - 1].timestamp;
  }
}
export const getVideoThumbnail = async (run: string, timestamp: number): Promise<Blob | undefined> => {
  const record = await requestValue((await database()).transaction('thumbnails').objectStore('thumbnails').get([run, timestamp]));
  return record?.blob;
};
/** Clears cached frames and analyses. The downloaded model is kept; it is expensive to fetch again. */
export const clearVideoCache = async () => {
  const transaction = (await database()).transaction(['frames', 'thumbnails', 'meta'], 'readwrite');
  const done = committed(transaction);
  const meta = transaction.objectStore('meta');
  const model = await requestValue(meta.get('model'));
  transaction.objectStore('frames').clear();
  transaction.objectStore('thumbnails').clear();
  meta.clear();
  if (model !== undefined) meta.put(model, 'model');
  await done;
};
let persistRequest: Promise<boolean> | undefined;
/** Asks the browser once per session not to evict stored models. Silent when unsupported or refused. */
export const requestPersistentStorage = (): Promise<boolean> => persistRequest ??= (async () => {
  try { return typeof navigator !== 'undefined' && !!navigator.storage?.persist && await navigator.storage.persist(); }
  catch { return false; }
})();
export const videoFingerprint = async (file: Blob, signal?: AbortSignal, progress?: (read: number) => void) => {
  const hashes: Uint8Array[] = [];
  for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
    checkVideoAbort(signal);
    const chunk = await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer();
    hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk)));
    progress?.(Math.min(file.size, offset + chunk.byteLength));
  }
  const combined = new Uint8Array(hashes.length * 32);
  hashes.forEach((hash, index) => combined.set(hash, index * 32));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
  return `chunk-sha256-v1:${file.size}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
