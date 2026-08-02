import { useEffect, useMemo } from 'react';

type PreviewItem = {
  id: string;
  imageData: Blob;
  previewUrl?: string;
};

type CachedPreviewUrl = {
  blob: Blob;
  url: string;
};

const previewUrlCache = new Map<string, CachedPreviewUrl>();

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

export const useWorkspacePreviewUrls = (items: PreviewItem[]): Record<string, string> => {
  const previewUrls = useMemo(() => {
    const nextPreviewUrls: Record<string, string> = {};

    for (const item of items) {
      nextPreviewUrls[item.id] = item.previewUrl ?? getCachedPreviewUrl(item.id, item.imageData);
    }

    return nextPreviewUrls;
  }, [items]);

  useEffect(() => {
    pruneCachedPreviewUrls(new Set(items.map((item) => item.id)));
  }, [items]);

  return previewUrls;
};
