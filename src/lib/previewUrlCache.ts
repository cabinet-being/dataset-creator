import { useEffect, useMemo, useRef } from 'react';

type PreviewItem = {
  id: string;
  imageData: Blob;
  previewUrl?: string;
  allowGeneratedPreviewUrl?: boolean;
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

      if (item.allowGeneratedPreviewUrl !== false) {
        nextPreviewUrls[item.id] = getCachedPreviewUrl(item.id, item.imageData);
      }
    }

    return nextPreviewUrls;
  }, [items]);

  const activeIds = useMemo(
    () => new Set(items.filter((item) => item.allowGeneratedPreviewUrl !== false && !item.previewUrl).map((item) => item.id)),
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
