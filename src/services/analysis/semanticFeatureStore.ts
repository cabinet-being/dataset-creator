// Persistent image-embedding cache (IndexedDB), keyed by `${sha256}:${model id}`. Deliberately separate from the
// video cache so "Clear video cache" keeps it; it is bounded and evicts the least recently written entries.
const DATABASE = 'dataset-creator-embeddings-v1';
const STORE = 'image';
export const MAX_STORED_EMBEDDINGS = 20_000;
const EVICT_TO = Math.floor(MAX_STORED_EMBEDDINGS * 0.9);
const CHECK_EVERY = 200;

type Entry = { vector: Float32Array; at: number };
let connection: Promise<IDBDatabase> | undefined;
let writesSinceCheck = 0;
const database = () => connection ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE).createIndex('at', 'at');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { connection = undefined; reject(request.error); };
});
const requestValue = <Value>(request: IDBRequest<Value>) => new Promise<Value>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Embedding cache could not be saved.'));
});

export const getStoredImageFeature = async (key: string): Promise<Float32Array | undefined> => {
  if (typeof indexedDB === 'undefined') return undefined;
  const entry = await requestValue<Entry | undefined>((await database()).transaction(STORE).objectStore(STORE).get(key));
  return entry?.vector instanceof Float32Array ? entry.vector : undefined;
};

const evictOldest = async (db: IDBDatabase) => {
  const total = await requestValue(db.transaction(STORE).objectStore(STORE).count());
  if (total <= MAX_STORED_EMBEDDINGS) return;
  const transaction = db.transaction(STORE, 'readwrite');
  const done = committed(transaction);
  let remaining = total - EVICT_TO;
  const cursor = transaction.objectStore(STORE).index('at').openKeyCursor();
  cursor.onsuccess = () => {
    const position = cursor.result;
    if (!position || remaining-- <= 0) return;
    transaction.objectStore(STORE).delete(position.primaryKey);
    position.continue();
  };
  await done;
};

export const putStoredImageFeature = async (key: string, vector: Float32Array): Promise<void> => {
  if (typeof indexedDB === 'undefined') return;
  const db = await database();
  const transaction = db.transaction(STORE, 'readwrite');
  const done = committed(transaction);
  transaction.objectStore(STORE).put({ vector, at: Date.now() } satisfies Entry, key);
  await done;
  if (++writesSinceCheck >= CHECK_EVERY) { writesSinceCheck = 0; await evictOldest(db); }
};

export const clearStoredImageFeatures = async (): Promise<void> => {
  if (typeof indexedDB === 'undefined') return;
  const transaction = (await database()).transaction(STORE, 'readwrite');
  const done = committed(transaction);
  transaction.objectStore(STORE).clear();
  await done;
};
