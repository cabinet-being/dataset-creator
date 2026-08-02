import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowUpDown, Check, ChevronDown, Trash2 } from 'lucide-react';
import { ASPECT_RATIOS, ASPECT_RATIO_LABELS } from '../../lib/constants';
import {
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameStyle,
  toWorkspaceImages,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import type { AspectRatio, WorkspaceImageKind } from '../../types';

type PreviewMap = Record<string, string>;
type PreviewCacheEntry = { blob: Blob; url: string };
type FilterMenu = 'aspect' | 'kind' | 'sort' | null;
type SortMode = 'identity-asc' | 'identity-desc' | 'kind' | 'aspect' | 'size-desc' | 'size-asc';

type ReviewCardProps = {
  item: WorkspaceImage;
  previewUrl?: string;
  onDelete: (item: WorkspaceImage) => void;
};

const KIND_LABELS: Record<WorkspaceImageKind, string> = {
  source: 'Source',
  synthetic: 'Synthetic',
};

const SORT_LABELS: Record<SortMode, string> = {
  'identity-asc': 'Image number',
  'identity-desc': 'Image number, descending',
  kind: 'Type',
  aspect: 'Aspect ratio',
  'size-desc': 'Size, largest first',
  'size-asc': 'Size, smallest first',
};

const SORT_OPTIONS: SortMode[] = ['identity-asc', 'identity-desc', 'kind', 'aspect', 'size-desc', 'size-asc'];

const compareDisplayIdentity = (left: WorkspaceImage, right: WorkspaceImage) =>
  left.displayIdentity.localeCompare(right.displayIdentity, undefined, {
    numeric: true,
    sensitivity: 'base',
  });

const ReviewCard = memo(({ item, previewUrl, onDelete }: ReviewCardProps) => {
  return (
    <div className={`gallery-masonry-item group relative overflow-hidden rounded-lg ${getWorkspaceKindFrameClass(item.kind)}`}>
      <div className="relative min-h-[12rem] bg-black flex items-center justify-center">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={`Image ${item.displayIdentity}`}
            className="w-full h-auto object-contain"
          />
        ) : (
          <div className="flex h-48 w-full items-center justify-center text-sm text-muted-foreground">
            Preview unavailable
          </div>
        )}

        <button
          onClick={() => onDelete(item)}
          className="absolute top-2 right-2 p-2 rounded-md bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity"
          title="Remove from review"
        >
          <Trash2 size={14} />
        </button>

        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">Image #{item.displayIdentity}</p>
              <p className="text-xs text-gray-300">
                {ASPECT_RATIO_LABELS[item.aspectRatio]} · {item.width} x {item.height}
              </p>
            </div>
            <span
              className={getWorkspaceKindBadgeClass(item.kind)}
              style={getWorkspaceKindFrameStyle(item.kind)}
            >
              {item.label}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

ReviewCard.displayName = 'ReviewCard';

export const FinalReviewStage = () => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const syntheticImagesById = useProjectStore((state) => state.datasetItems);
  const cleanupStageState = useProjectStore(
    (state) =>
      (state.stageState.clean as
        | { workingEdits?: Record<string, { blob: Blob; previewUrl: string; width: number; height: number }> }
        | undefined) ?? {}
  );
  const softDeleteDatasetItem = useProjectStore((state) => state.softDeleteDatasetItem);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const addNotification = useUIStore((state) => state.addNotification);

  const [selectedAspectRatios, setSelectedAspectRatios] = useState<Set<AspectRatio>>(
    new Set(ASPECT_RATIOS)
  );
  const [selectedKinds, setSelectedKinds] = useState<Set<WorkspaceImageKind>>(
    new Set(['source', 'synthetic'])
  );
  const [openMenu, setOpenMenu] = useState<FilterMenu>(null);
  const [sortMode, setSortMode] = useState<SortMode>('identity-asc');
  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const previewCacheRef = useRef<Record<string, PreviewCacheEntry>>({});

  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const syntheticImages = useMemo(
    () => Object.values(syntheticImagesById).filter((item) => !item.deleted),
    [syntheticImagesById]
  );
  const items = useMemo(
    () => toWorkspaceImages(sourceImages, syntheticImages, cleanupStageState.workingEdits),
    [cleanupStageState.workingEdits, sourceImages, syntheticImages]
  );

  useEffect(() => {
    setPreviewUrls((previous) => {
      const next: PreviewMap = {};
      const activeIds = new Set(items.map((item) => item.id));

      for (const item of items) {
        const cached = previewCacheRef.current[item.id];
        if (cached && cached.blob === item.imageData) {
          next[item.id] = cached.url;
          continue;
        }

        if (cached) {
          URL.revokeObjectURL(cached.url);
        }

        try {
          const url = URL.createObjectURL(item.imageData);
          previewCacheRef.current[item.id] = { blob: item.imageData, url };
          next[item.id] = url;
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn(`[review] failed preview generation: ${item.id}`, error);
          }
        }
      }

      for (const [id, cached] of Object.entries(previewCacheRef.current)) {
        if (activeIds.has(id)) {
          continue;
        }
        URL.revokeObjectURL(cached.url);
        delete previewCacheRef.current[id];
      }

      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      const changed =
        previousKeys.length !== nextKeys.length ||
        nextKeys.some((id) => previous[id] !== next[id]);

      return changed ? next : previous;
    });
  }, [items]);

  useEffect(() => {
    return () => {
      Object.values(previewCacheRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
      previewCacheRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!openMenu) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openMenu]);

  const aspectRatioCounts = useMemo(
    () =>
      Object.fromEntries(
        ASPECT_RATIOS.map((ratio) => [
          ratio,
          items.filter((item) => item.aspectRatio === ratio).length,
        ])
      ) as Record<AspectRatio, number>,
    [items]
  );

  const kindCounts = useMemo(
    () => ({
      source: items.filter((item) => item.kind === 'source').length,
      synthetic: items.filter((item) => item.kind === 'synthetic').length,
    }),
    [items]
  );

  const filteredItems = useMemo(
    () =>
      items.filter(
        (item) => selectedAspectRatios.has(item.aspectRatio) && selectedKinds.has(item.kind)
      ),
    [items, selectedAspectRatios, selectedKinds]
  );

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((left, right) => {
      switch (sortMode) {
        case 'identity-desc':
          return compareDisplayIdentity(right, left);
        case 'kind':
          return left.kind.localeCompare(right.kind) || compareDisplayIdentity(left, right);
        case 'aspect':
          return (
            ASPECT_RATIO_LABELS[left.aspectRatio].localeCompare(ASPECT_RATIO_LABELS[right.aspectRatio]) ||
            compareDisplayIdentity(left, right)
          );
        case 'size-desc':
          return right.width * right.height - left.width * left.height || compareDisplayIdentity(left, right);
        case 'size-asc':
          return left.width * left.height - right.width * right.height || compareDisplayIdentity(left, right);
        case 'identity-asc':
        default:
          return compareDisplayIdentity(left, right);
      }
    });
  }, [filteredItems, sortMode]);

  const toggleAspectRatio = (ratio: AspectRatio) => {
    setSelectedAspectRatios((previous) => {
      const next = new Set(previous);
      if (next.has(ratio)) {
        next.delete(ratio);
      } else {
        next.add(ratio);
      }
      return next;
    });
  };

  const toggleKind = (kind: WorkspaceImageKind) => {
    setSelectedKinds((previous) => {
      const next = new Set(previous);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  };

  const handleDeleteItem = (item: WorkspaceImage) => {
    if (item.kind === 'source' && item.sourceImageId) {
      updateSourceImage(item.sourceImageId, { hidden: true });
    } else if (item.syntheticImageId) {
      softDeleteDatasetItem(item.syntheticImageId);
    }
    addNotification('info', 'Image removed from review');
  };

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground">No Source or Synthetic images to review.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="relative z-20 rounded-lg border border-border bg-card px-3 py-2">
        {openMenu && (
          <button
            type="button"
            aria-label="Close review menu"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpenMenu(null)}
          />
        )}

        <div className="relative z-30 flex flex-wrap items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu((menu) => (menu === 'aspect' ? null : 'aspect'))}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                openMenu === 'aspect' ? 'bg-secondary' : 'hover:bg-secondary'
              }`}
            >
              Aspect
              <span className="font-mono text-xs text-muted-foreground">{selectedAspectRatios.size}/3</span>
              <ChevronDown className="h-4 w-4" />
            </button>
            {openMenu === 'aspect' && (
              <div className="absolute left-0 top-full mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-xl">
                {ASPECT_RATIOS.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => toggleAspectRatio(ratio)}
                    className="flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-secondary"
                  >
                    <span className="flex h-4 w-4 items-center justify-center">
                      {selectedAspectRatios.has(ratio) && <Check className="h-4 w-4" />}
                    </span>
                    <span className="flex-1">{ASPECT_RATIO_LABELS[ratio]}</span>
                    <span className="font-mono text-xs text-muted-foreground">{aspectRatioCounts[ratio] ?? 0}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu((menu) => (menu === 'kind' ? null : 'kind'))}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                openMenu === 'kind' ? 'bg-secondary' : 'hover:bg-secondary'
              }`}
            >
              Type
              <span className="font-mono text-xs text-muted-foreground">{selectedKinds.size}/2</span>
              <ChevronDown className="h-4 w-4" />
            </button>
            {openMenu === 'kind' && (
              <div className="absolute left-0 top-full mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-xl">
                {(['source', 'synthetic'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => toggleKind(kind)}
                    className="flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-secondary"
                  >
                    <span className="flex h-4 w-4 items-center justify-center">
                      {selectedKinds.has(kind) && <Check className="h-4 w-4" />}
                    </span>
                    <span className="flex-1">{KIND_LABELS[kind]}</span>
                    <span className="font-mono text-xs text-muted-foreground">{kindCounts[kind]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu((menu) => (menu === 'sort' ? null : 'sort'))}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                openMenu === 'sort' ? 'bg-secondary' : 'hover:bg-secondary'
              }`}
            >
              <ArrowUpDown className="h-4 w-4" />
              Sort
              <span className="max-w-36 truncate text-muted-foreground">{SORT_LABELS[sortMode]}</span>
              <ChevronDown className="h-4 w-4" />
            </button>
            {openMenu === 'sort' && (
              <div className="absolute left-0 top-full mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-xl">
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setSortMode(option);
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-secondary"
                  >
                    <span className="flex h-4 w-4 items-center justify-center">
                      {sortMode === option && <Check className="h-4 w-4" />}
                    </span>
                    <span className="flex-1">{SORT_LABELS[option]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ml-auto rounded-md border border-border bg-background px-3 py-2 text-sm">
            <span className="text-muted-foreground">Visible</span>
            <span className="ml-2 font-mono font-medium">{sortedItems.length}</span>
          </div>
        </div>
      </div>

      {sortedItems.length > 0 ? (
        <div className="gallery-masonry">
          {sortedItems.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              previewUrl={previewUrls[item.id]}
              onDelete={handleDeleteItem}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 rounded-lg bg-secondary/50 border border-dashed border-border">
          <p className="text-muted-foreground">No items match the selected filters.</p>
        </div>
      )}
    </div>
  );
};
