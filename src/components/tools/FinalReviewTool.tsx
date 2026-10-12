import { MenuSurface } from '../ui/MenuSurface';
import { addAssetsToDataset } from '../../lib/assetActions';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  AlertCircle,
  ArrowUpDown,
  Check,
  ChevronDown,
  Plus,
  X,
} from 'lucide-react';
import { ASPECT_RATIOS, ASPECT_RATIO_LABELS } from '../../lib/constants';
import {
  orderWorkspaceItemsByDatasetOrder,
} from '../../lib/datasetAssets';
import {
  toWorkspaceReviewAssets,
  type WorkspaceFileAsset,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { collectWorkspaceFileAssets, generateMissingWorkspacePsdPreviews } from '../../lib/workspaceFileAssets';
import { appLog } from '../../services/logging/applicationLog';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { AssetGallery } from '../ui/AssetGallery';
import { WorkspacePreviewCard } from '../ui/WorkspacePreviewCard';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import type { AspectRatio, Dataset, WorkspaceImageKind } from '../../types';

type FilterMenu = 'aspect' | 'kind' | 'status' | 'sort' | null;
type SortMode = 'identity-asc' | 'identity-desc' | 'kind' | 'aspect' | 'size-desc' | 'size-asc';
type ExportStatus = 'active' | 'inactive';

type ReviewCardProps = {
  item: WorkspaceImage;
  previewUrl?: string;
  quickActionLabel?: string;
  quickActionVariant?: 'add' | 'remove';
  onQuickAction?: (item: WorkspaceImage) => void;
  onOpenContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
};

type ReviewKind = Extract<WorkspaceImageKind, 'image' | 'edited' | 'video' | 'psd'>;

const KIND_LABELS: Record<ReviewKind, string> = {
  image: 'Image',
  edited: 'Edited',
  video: 'Video',
  psd: 'PSD',
};

const REVIEW_KINDS = ['image', 'edited', 'video', 'psd'] as const satisfies ReviewKind[];
const isReviewKind = (kind: WorkspaceImageKind): kind is ReviewKind =>
  (REVIEW_KINDS as readonly WorkspaceImageKind[]).includes(kind);
const getDatasetQuickActionLabel = (
  item: WorkspaceImage,
  mode: 'add' | 'remove'
): string => {
  const action = mode === 'add' ? 'Add' : 'Remove';
  if (item.kind === 'image' || item.kind === 'edited') {
    return `${action} source group ${mode === 'add' ? 'to' : 'from'} Dataset`;
  }
  return `${action} ${mode === 'add' ? 'to' : 'from'} Dataset`;
};

const STATUS_LABELS: Record<ExportStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
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

const ReviewCard = memo(
  ({
    item,
    previewUrl,
    quickActionLabel,
    quickActionVariant = 'add',
    onQuickAction,
    onOpenContextMenu,
  }: ReviewCardProps) => {
  const QuickActionIcon = quickActionVariant === 'remove' ? X : Plus;
  const quickActionClass =
    quickActionVariant === 'remove'
      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
      : 'bg-primary text-primary-foreground hover:bg-primary/90';

  return (
    <WorkspacePreviewCard
      item={item}
      previewUrl={previewUrl}
      className="gallery-masonry-item"
      imageClassName={item.excludedFromDataset ? 'grayscale' : ''}
      onOpenContextMenu={onOpenContextMenu}
    >
      {quickActionLabel && onQuickAction ? (
        <button
          type="button"
          onClick={() => onQuickAction(item)}
          className={`absolute left-1/2 top-1/2 z-20 inline-flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md shadow-lg transition-colors ${quickActionClass}`}
          aria-label={quickActionLabel}
          title={quickActionLabel}
        >
          <QuickActionIcon className="h-6 w-6" />
        </button>
      ) : null}

      {item.excludedFromDataset && !quickActionLabel && (
        <div className="absolute left-2 top-2 rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white">
          Inactive
        </div>
      )}
    </WorkspacePreviewCard>
  );
  }
);

ReviewCard.displayName = 'ReviewCard';

type FinalReviewToolProps = {
  datasetId?: string;
  mode?: 'review' | 'select';
  active?: boolean;
  onUpdateDataset?: (
    updates: Partial<
      Pick<Dataset, 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'assetOrder' | 'overwriteCaptions' | 'captionOverrides'>
    >
  ) => void | Promise<void>;
  onOpenAssetContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
  onOpenImport?: () => void;
  onAddFiles?: () => void;
};

export const FinalReviewTool = ({
  datasetId,
  mode = 'review',
  active = true,
  onUpdateDataset,
  onOpenAssetContextMenu,
  onOpenImport,
  onAddFiles,
}: FinalReviewToolProps = {}) => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const editedAssetsById = useProjectStore((state) => state.datasetItems);
  const dataset = useProjectStore((state) => state.dataset);
  const cleanupToolState = useProjectStore(
    (state) =>
      (state.toolState.clean as
        | { workingEdits?: Record<string, { blob: Blob; previewUrl: string; width: number; height: number }> }
        | undefined) ?? {}
  );
  const addNotification = useUIStore((state) => state.addNotification);
  const projectDirectoryHandle = useUIStore((state) => state.projectDirectoryHandle);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);

  const [selectedAspectRatios, setSelectedAspectRatios] = useState<Set<AspectRatio>>(
    new Set(ASPECT_RATIOS)
  );
  const [selectedKinds, setSelectedKinds] = useState<Set<ReviewKind>>(
    new Set(REVIEW_KINDS)
  );
  const [selectedStatuses, setSelectedStatuses] = useState<Set<ExportStatus>>(
    new Set(['active', 'inactive'])
  );
  const [openMenu, setOpenMenu] = useState<FilterMenu>(null);
  const [sortMode, setSortMode] = useState<SortMode>('identity-asc');
  const [fileAssets, setFileAssets] = useState<WorkspaceFileAsset[]>([]);
  const psdDiagnosticsKeyRef = useRef('');

  const datasetAssetIds = useMemo(() => new Set(dataset?.assetIds ?? []), [dataset?.assetIds]);
  const datasetAssetPaths = useMemo(
    () => new Set([...(dataset?.assetPaths ?? []), ...(dataset?.psdAssetPaths ?? [])]),
    [dataset?.assetPaths, dataset?.psdAssetPaths]
  );
  const sourceImages = useMemo(() => {
    const allSources = Object.values(sourceImagesById);
    if (!datasetId) {
      return allSources;
    }
    if (mode === 'select') {
      return allSources.filter((image) => !datasetAssetIds.has(image.id));
    }
    return allSources.filter((image) => datasetAssetIds.has(image.id));
  }, [datasetAssetIds, datasetId, mode, sourceImagesById]);
  const editedAssets = useMemo(
    () =>
      Object.values(editedAssetsById).filter(
        (image) => !image.deleted && (!datasetId || datasetAssetIds.has(image.sourceImageId))
      ),
    [datasetAssetIds, datasetId, editedAssetsById]
  );
  const items = useMemo(() => {
    const nextItems = toWorkspaceReviewAssets(
      sourceImages,
      fileAssets,
      cleanupToolState.workingEdits,
      editedAssets
    );
    return dataset && mode !== 'select'
      ? orderWorkspaceItemsByDatasetOrder(nextItems, dataset.assetOrder, dataset.assetIds)
      : nextItems;
  }, [cleanupToolState.workingEdits, dataset, fileAssets, mode, sourceImages, editedAssets]);
  const previewUrls = useWorkspacePreviewUrls(items);
  const psdDiagnostics = useMemo(() => {
    const psdAssets = fileAssets.filter((asset) => asset.kind === 'psd');
    const counts = {
      total: psdAssets.length,
      ready: psdAssets.filter((asset) => Boolean(asset.previewUrl)).length,
      queued: psdAssets.filter((asset) => asset.previewStatus === 'queued').length,
      generating: psdAssets.filter((asset) => asset.previewStatus === 'generating').length,
      failed: psdAssets.filter((asset) => asset.previewStatus === 'failed').length,
      missing: psdAssets.filter((asset) => !asset.previewUrl).length,
      firstMissingPath: psdAssets.find((asset) => !asset.previewUrl)?.path,
    };
    return counts;
  }, [fileAssets]);

  useEffect(() => {
    const key = [
      psdDiagnostics.total,
      psdDiagnostics.ready,
      psdDiagnostics.queued,
      psdDiagnostics.generating,
      psdDiagnostics.failed,
      psdDiagnostics.firstMissingPath ?? '',
    ].join('|');
    if (key === psdDiagnosticsKeyRef.current) {
      return;
    }
    psdDiagnosticsKeyRef.current = key;
    if (psdDiagnostics.total === 0) {
      appLog.info('Review: no PSD assets in current view');
      return;
    }
    appLog.info(
      `Review PSD assets: total ${psdDiagnostics.total}, ready ${psdDiagnostics.ready}, queued ${psdDiagnostics.queued}, generating ${psdDiagnostics.generating}, failed ${psdDiagnostics.failed}`
    );
    if (psdDiagnostics.firstMissingPath) {
      appLog.info(`Review PSD first missing preview: ${psdDiagnostics.firstMissingPath}`);
    }
  }, [psdDiagnostics]);

  useEffect(() => {
    let canceled = false;

    if (!projectDirectoryHandle) {
      setFileAssets([]);
      return;
    }

    const loadFileAssets = async () => {
      try {
        const assets = await collectWorkspaceFileAssets(
          projectDirectoryHandle,
          datasetId && mode !== 'select' ? [...datasetAssetPaths] : undefined
        );
        const nextAssets =
          datasetId && mode === 'select'
            ? assets.filter((asset) => !datasetAssetPaths.has(asset.path))
            : assets;
        const pendingAssets = nextAssets.map((asset) =>
          asset.kind === 'psd' && !asset.previewUrl ? { ...asset, previewStatus: 'queued' as const } : asset
        );
        if (!canceled) {
          setFileAssets(pendingAssets);
          void generateMissingWorkspacePsdPreviews(
            projectDirectoryHandle,
            pendingAssets,
            (path, update) => {
              setFileAssets((currentAssets) =>
                currentAssets.map((asset) => (asset.path === path ? { ...asset, ...update } : asset))
              );
            },
            () => canceled
          );
        }
      } catch (error) {
        if (!canceled) {
          setFileAssets([]);
          addNotification('warning', error instanceof Error ? error.message : 'Unable to read project file assets');
        }
      }
    };

    void loadFileAssets();

    return () => {
      canceled = true;
    };
  }, [addNotification, assetPreviewRefreshKey, datasetAssetPaths, datasetId, mode, projectDirectoryHandle]);

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
    () =>
      Object.fromEntries(
        REVIEW_KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length])
      ) as Record<(typeof REVIEW_KINDS)[number], number>,
    [items]
  );

  const inactiveCount = useMemo(
    () => items.filter((item) => item.excludedFromDataset).length,
    [items]
  );
  const statusCounts = useMemo(
    () => ({
      active: items.filter((item) => !item.excludedFromDataset).length,
      inactive: items.filter((item) => item.excludedFromDataset).length,
    }),
    [items]
  );

  const filteredItems = useMemo(
    () =>
      items.filter(
        (item) =>
          selectedAspectRatios.has(item.aspectRatio) &&
          isReviewKind(item.kind) &&
          selectedKinds.has(item.kind) &&
          selectedStatuses.has(item.excludedFromDataset ? 'inactive' : 'active')
      ),
    [items, selectedAspectRatios, selectedKinds, selectedStatuses]
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

  const toggleKind = (kind: ReviewKind) => {
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

  const toggleStatus = (status: ExportStatus) => {
    setSelectedStatuses((previous) => {
      const next = new Set(previous);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  const addItemsToDataset = useCallback((nextItems: WorkspaceImage[]) => {
    addAssetsToDataset(nextItems);
    void flushProjectSave().catch(error => addNotification('error', error instanceof Error ? error.message : 'Unable to save Dataset'));
  }, [addNotification]);

  const showSelectActions = Boolean(dataset && onUpdateDataset && mode === 'select');
  const reviewControls = (
    <div className="relative z-50 rounded-md border border-border bg-card px-3 py-2">
      {openMenu && (
        <button
          type="button"
          aria-label="Close review menu"
          className="fixed inset-0 z-[900] cursor-default"
          onClick={() => setOpenMenu(null)}
        />
      )}

      <div className="relative z-[1000] flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu" aria-expanded={openMenu === 'aspect'}
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
            <MenuSurface onDismiss={() => setOpenMenu(null)} className="absolute left-0 top-full z-[1000] mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-xl">
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  role="menuitemcheckbox" aria-checked={selectedAspectRatios.has(ratio)}
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
            </MenuSurface>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu" aria-expanded={openMenu === 'kind'}
            onClick={() => setOpenMenu((menu) => (menu === 'kind' ? null : 'kind'))}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              openMenu === 'kind' ? 'bg-secondary' : 'hover:bg-secondary'
            }`}
          >
            Type
            <span className="font-mono text-xs text-muted-foreground">{selectedKinds.size}/{REVIEW_KINDS.length}</span>
            <ChevronDown className="h-4 w-4" />
          </button>
          {openMenu === 'kind' && (
            <MenuSurface onDismiss={() => setOpenMenu(null)} className="absolute left-0 top-full z-[1000] mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-xl">
              {REVIEW_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitemcheckbox" aria-checked={selectedKinds.has(kind)}
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
            </MenuSurface>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu" aria-expanded={openMenu === 'status'}
            onClick={() => setOpenMenu((menu) => (menu === 'status' ? null : 'status'))}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              openMenu === 'status' ? 'bg-secondary' : 'hover:bg-secondary'
            }`}
          >
            Status
            <span className="font-mono text-xs text-muted-foreground">{selectedStatuses.size}/2</span>
            <ChevronDown className="h-4 w-4" />
          </button>
          {openMenu === 'status' && (
            <MenuSurface onDismiss={() => setOpenMenu(null)} className="absolute left-0 top-full z-[1000] mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-xl">
              {(['active', 'inactive'] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  role="menuitemcheckbox" aria-checked={selectedStatuses.has(status)}
                  onClick={() => toggleStatus(status)}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-secondary"
                >
                  <span className="flex h-4 w-4 items-center justify-center">
                    {selectedStatuses.has(status) && <Check className="h-4 w-4" />}
                  </span>
                  <span className="flex-1">{STATUS_LABELS[status]}</span>
                  <span className="font-mono text-xs text-muted-foreground">{statusCounts[status]}</span>
                </button>
              ))}
            </MenuSurface>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu" aria-expanded={openMenu === 'sort'}
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
            <MenuSurface onDismiss={() => setOpenMenu(null)} className="absolute left-0 top-full z-[1000] mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-xl">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemcheckbox" aria-checked={sortMode === option}
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
            </MenuSurface>
          )}
        </div>

        {showSelectActions && sortedItems.length > 0 ? (
          <button
            type="button"
            onClick={() => addItemsToDataset(sortedItems)}
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            <span>Add Visible</span>
          </button>
        ) : null}

        <div className={`${showSelectActions && sortedItems.length > 0 ? '' : 'ml-auto'} rounded-md border border-border bg-background px-3 py-2 text-sm`}>
          <span className="text-muted-foreground">Visible</span>
          <span className="ml-2 font-mono font-medium">{sortedItems.length}</span>
          {psdDiagnostics.total > 0 ? (
            <span className="ml-3 text-muted-foreground">
              PSD <span className="font-mono text-foreground">{psdDiagnostics.ready}/{psdDiagnostics.total}</span>
              {psdDiagnostics.generating > 0 ? (
                <span className="ml-2">Generating <span className="font-mono text-foreground">{psdDiagnostics.generating}</span></span>
              ) : null}
              {psdDiagnostics.failed > 0 ? (
                <span className="ml-2">Failed <span className="font-mono text-foreground">{psdDiagnostics.failed}</span></span>
              ) : null}
            </span>
          ) : null}
          {inactiveCount > 0 && (
            <span className="ml-3 text-muted-foreground">
              Inactive <span className="font-mono text-foreground">{inactiveCount}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
  const reviewInspectorPortal = null;

  if (items.length === 0) {
    return (
      <div className="space-y-6">
        {reviewInspectorPortal}
        {reviewInspectorPortal ? null : reviewControls}
        <div className="flex min-h-[320px] items-center justify-center px-4 text-center">
          <div className="max-w-sm">
            <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">
              {mode === 'select' ? 'No more files to add' : 'No files to review'}
            </p>
            {(mode === 'review' && datasetId ? onAddFiles : onOpenImport) && (
              <button type="button" className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                onClick={mode === 'review' && datasetId ? onAddFiles : onOpenImport}>
                {mode === 'review' && datasetId ? 'Add files' : 'Import files'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {reviewInspectorPortal}
      {reviewInspectorPortal ? null : reviewControls}

      {sortedItems.length > 0 ? (
        <AssetGallery
          active={active}
          showOrder={false}
          items={sortedItems}
          getKey={(item) => item.id}
          getEstimate={(item) => item.height / Math.max(1, item.width)}
          renderItem={(item) => (
            <ReviewCard
              item={item}
              previewUrl={previewUrls[item.id]}
              quickActionLabel={
                showSelectActions
                  ? getDatasetQuickActionLabel(item, 'add')
                  : undefined
              }
              quickActionVariant="add"
              onQuickAction={
                showSelectActions
                  ? (item) => addItemsToDataset([item])
                  : undefined
              }
              onOpenContextMenu={onOpenAssetContextMenu}
            />
          )}
        />
      ) : (
        <div className="flex min-h-[260px] items-center justify-center rounded-md border border-dashed border-border bg-secondary/40 px-4 text-center">
          <div>
            <p className="text-sm font-medium text-muted-foreground">No items match the selected filters</p>
            <button className="mt-3 rounded border border-border px-3 py-2 text-sm" onClick={() => { setSelectedAspectRatios(new Set(ASPECT_RATIOS)); setSelectedKinds(new Set(REVIEW_KINDS)); setSelectedStatuses(new Set(['active', 'inactive'])); }}>Reset filters</button>
          </div>
        </div>
      )}
    </div>
  );
};
