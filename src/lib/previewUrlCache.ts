import { useEffect, useMemo, useRef, useState } from 'react';
import { isImageWorkerSupported, resizeImageInWorker } from '../services/image/imageWorkerClient';

type PreviewItem = {
  id: string;
  imageData: Blob;
  previewUrl?: string;
  allowObjectPreviewUrl?: boolean;
};

type CachedPreviewUrl = {
  blob: Blob;
  url: string;
};

const previewUrlCache = new Map<string, CachedPreviewUrl>();
const previewUrlConsumers = new Map<symbol, Set<string>>();

export const getCachedPreviewUrl = (id: string, blob: Blob): string => {
  const cached = previewUrlCache.get(id);
  if (cached?.blob === blob) {
    return cached.url;
  }

  if (cached) {
    URL.revokeObjectURL(cached.url);
  }

  const url = URL.createObjectURL(blob);
  previewUrlCache.set(id, { blob, url });
  return url;
};

export const pruneCachedPreviewUrls = (activeIds: Set<string>): void => {
  for (const [id, cached] of previewUrlCache.entries()) {
    if (activeIds.has(id)) {
      continue;
    }

    URL.revokeObjectURL(cached.url);
    previewUrlCache.delete(id);
  }
};

const pruneUnusedPreviewUrls = (): void => {
  const activeIds = new Set<string>();

  for (const ids of previewUrlConsumers.values()) {
    for (const id of ids) {
      activeIds.add(id);
    }
  }

  pruneCachedPreviewUrls(activeIds);
};

export const useWorkspacePreviewUrls = (items: PreviewItem[]): Record<string, string> => {
  const consumerIdRef = useRef<symbol | null>(null);
  if (!consumerIdRef.current) {
    consumerIdRef.current = Symbol('workspace-preview-consumer');
  }
  const consumerId = consumerIdRef.current;

  const previewUrls = useMemo(() => {
    const nextPreviewUrls: Record<string, string> = {};

    for (const item of items) {
      if (item.previewUrl) {
        nextPreviewUrls[item.id] = item.previewUrl;
        continue;
      }

      if (item.allowObjectPreviewUrl !== false) {
        nextPreviewUrls[item.id] = getCachedPreviewUrl(item.id, item.imageData);
      }
    }

    return nextPreviewUrls;
  }, [items]);

  const activeIds = useMemo(
    () => new Set(items.filter((item) => item.allowObjectPreviewUrl !== false && !item.previewUrl).map((item) => item.id)),
    [items]
  );

  previewUrlConsumers.set(consumerId, activeIds);

  useEffect(() => {
    pruneUnusedPreviewUrls();
  }, [activeIds]);

  useEffect(() => {
    return () => {
      previewUrlConsumers.delete(consumerId);
      pruneUnusedPreviewUrls();
    };
  }, [consumerId]);

  return previewUrls;
};

/* Downscaled previews: generated off the main thread, kept in a bounded LRU, revoked here like every other preview URL. */

export type PreviewSize = 'thumb' | 'large';
const SIZED_CONFIG: Record<PreviewSize, { maxSide: number; limit: number; minBytes: number; quality: number }> = {
  thumb: { maxSide: 256, limit: 400, minBytes: 120_000, quality: 0.78 },
  large: { maxSide: 2048, limit: 12, minBytes: 600_000, quality: 0.85 },
};

/** `ready` without a URL means the original is already small enough and is used as is. */
type SizedEntry = { source: Blob; size: PreviewSize; state: 'pending' | 'ready' | 'failed'; url?: string };
const sizedCache = new Map<string, SizedEntry>();
const sizedConsumers = new Map<symbol, Set<string>>();
const sizedListeners = new Set<() => void>();
let sizedNotifyTimer: ReturnType<typeof setTimeout> | undefined;

const sizedKey = (size: PreviewSize, id: string) => `${size}:${id}`;
const notifySized = () => {
  if (sizedNotifyTimer) return;
  sizedNotifyTimer = setTimeout(() => { sizedNotifyTimer = undefined; for (const listener of sizedListeners) listener(); }, 40);
};
const isSizedActive = (key: string) => { for (const keys of sizedConsumers.values()) if (keys.has(key)) return true; return false; };
const dropSized = (key: string, entry: SizedEntry) => { if (entry.url) URL.revokeObjectURL(entry.url); if (sizedCache.get(key) === entry) sizedCache.delete(key); };
const evictSized = (size: PreviewSize) => {
  const { limit } = SIZED_CONFIG[size];
  let count = 0;
  for (const entry of sizedCache.values()) if (entry.size === size && entry.url) count += 1;
  for (const [key, entry] of sizedCache) {
    if (count <= limit) return;
    if (entry.size !== size || !entry.url || isSizedActive(key)) continue;
    dropSized(key, entry); count -= 1;
  }
};

const requestSizedPreview = (id: string, blob: Blob, size: PreviewSize, priority: number) => {
  const key = sizedKey(size, id);
  const config = SIZED_CONFIG[size];
  const existing = sizedCache.get(key);
  if (existing?.source === blob) { sizedCache.delete(key); sizedCache.set(key, existing); return; } // LRU touch
  if (existing) dropSized(key, existing);
  const entry: SizedEntry = { source: blob, size, state: 'pending' };
  sizedCache.set(key, entry);
  if (blob.size < config.minBytes) { entry.state = 'ready'; return; }
  if (!isImageWorkerSupported()) { entry.state = 'failed'; return; }
  resizeImageInWorker(blob, config.maxSide, { priority, quality: config.quality, isWanted: () => sizedCache.get(key) === entry && isSizedActive(key) })
    .then((result) => {
      if (sizedCache.get(key) !== entry) return;
      if (result) entry.url = URL.createObjectURL(result.blob);
      entry.state = 'ready';
      evictSized(size); notifySized();
    })
    .catch((error: unknown) => {
      if (sizedCache.get(key) !== entry) return;
      if (error instanceof DOMException && error.name === 'AbortError') { sizedCache.delete(key); return; } // not needed any more; may be requested again
      entry.state = 'failed'; notifySized();
    });
};

const readSized = (id: string, blob: Blob, size: PreviewSize): SizedEntry | undefined => {
  const entry = sizedCache.get(sizedKey(size, id));
  return entry?.source === blob ? entry : undefined;
};

type SizedOptions = { focusId?: string; prefetch?: PreviewItem[] };

/**
 * Preview URLs at `thumb` (256px) or `large` (2048px) size. While a downscaled copy is being generated a `large` request shows
 * the thumbnail (or the original as a last resort); a `thumb` request shows nothing until ready. Originals that are already
 * small, or whose resize failed, resolve to the original object URL. `prefetch` items are generated but not returned.
 */
export const useSizedPreviewUrls = (items: PreviewItem[], size: PreviewSize, options: SizedOptions = {}): Record<string, string> => {
  const [version, setVersion] = useState(0);
  const consumerRef = useRef<symbol | null>(null);
  if (!consumerRef.current) consumerRef.current = Symbol('sized-preview-consumer');
  const consumerId = consumerRef.current;
  const { focusId, prefetch } = options;

  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    sizedListeners.add(listener);
    return () => { sizedListeners.delete(listener); };
  }, []);

  useEffect(() => {
    const wanted: { id: string; blob: Blob; size: PreviewSize; priority: number }[] = [];
    const focusIndex = Math.max(0, items.findIndex((item) => item.id === focusId));
    items.forEach((item, index) => {
      if (item.previewUrl || item.allowObjectPreviewUrl === false) return;
      wanted.push({ id: item.id, blob: item.imageData, size, priority: size === 'large' ? 0 : 1 + Math.abs(index - focusIndex) });
      if (size === 'large') wanted.push({ id: item.id, blob: item.imageData, size: 'thumb', priority: 0 });
    });
    prefetch?.forEach((item, index) => { if (!item.previewUrl && item.allowObjectPreviewUrl !== false) wanted.push({ id: item.id, blob: item.imageData, size, priority: 5 + index }); });
    sizedConsumers.set(consumerId, new Set(wanted.map((entry) => sizedKey(entry.size, entry.id))));
    for (const entry of wanted) requestSizedPreview(entry.id, entry.blob, entry.size, entry.priority);
  }, [items, size, focusId, prefetch, consumerId]);

  useEffect(() => () => { sizedConsumers.delete(consumerId); }, [consumerId]);

  const { ready, needOriginal } = useMemo(() => {
    const nextReady: Record<string, string> = {};
    const originals: PreviewItem[] = [];
    for (const item of items) {
      if (item.previewUrl || item.allowObjectPreviewUrl === false) { originals.push(item); continue; }
      const entry = readSized(item.id, item.imageData, size);
      if (entry?.url) { nextReady[item.id] = entry.url; continue; }
      if (entry && entry.state !== 'pending') { originals.push(item); continue; }
      if (size === 'large') {
        const thumb = readSized(item.id, item.imageData, 'thumb');
        if (thumb?.url) { nextReady[item.id] = thumb.url; continue; }
        originals.push(item);
      }
    }
    return { ready: nextReady, needOriginal: originals };
    // `version` invalidates the memo when a background resize completes.
  }, [items, size, version]);
  const originals = useWorkspacePreviewUrls(needOriginal);
  return useMemo(() => ({ ...ready, ...originals }), [ready, originals]);
};
