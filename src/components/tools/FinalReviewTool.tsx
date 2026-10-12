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
  ChevronRight,
  Folder,
  Minus,
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
import type { ReviewScope } from '../../lib/workspaceToolScope';
import { isProjectPathIncluded } from '../../lib/projectCategories';

type FilterMenu = 'aspect' | 'kind' | 'status' | 'sort' | null;
type SortMode = 'name-asc' | 'name-desc' | 'path-asc' | 'path-desc' | 'kind' | 'dimensions-desc' | 'dimensions-asc' | 'bytes-desc' | 'bytes-asc' | 'date-desc' | 'date-asc';
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
  'name-asc': 'Name ↑',
  'name-desc': 'Name ↓',
  'path-asc': 'Path ↑',
  'path-desc': 'Path ↓',
  kind: 'Type',
  'dimensions-desc': 'Image area ↓',
  'dimensions-asc': 'Image area ↑',
  'bytes-desc': 'File size ↓',
  'bytes-asc': 'File size ↑',
  'date-desc': 'Modified ↓',
  'date-asc': 'Modified ↑',
};

const SORT_OPTIONS = Object.keys(SORT_LABELS) as SortMode[];

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
  scope?: ReviewScope;
};

export const FinalReviewTool = ({
  datasetId,
  mode = 'review',
  active = true,
  onUpdateDataset,
  onOpenAssetContextMenu,
  onOpenImport,
  onAddFiles,
  scope,
}: FinalReviewToolProps = {}) => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const editedAssetsById = useProjectStore((state) => state.datasetItems);
  const dataset = useProjectStore((state) => state.dataset);
  const excludedProjectCategories = useProjectStore((state) => state.workspaceSettings.excludedProjectCategories ?? []);
  const updateWorkspaceSettings = useProjectStore((state) => state.updateWorkspaceSettings);
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
  const [sortMode, setSortMode] = useState<SortMode>('name-asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [captionFilter, setCaptionFilter] = useState<'all' | 'present' | 'missing'>('all');
  const [previewFilter, setPreviewFilter] = useState<'all' | 'ready' | 'missing' | 'failed'>('all');
  const [fileAssets, setFileAssets] = useState<WorkspaceFileAsset[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const excludedCategories = useMemo(() => new Set(excludedProjectCategories), [excludedProjectCategories]);
  const psdDiagnosticsKeyRef = useRef('');

  const datasetAssetIds = useMemo(() => new Set(dataset?.assetIds ?? []), [dataset?.assetIds]);
  const datasetAssetPaths = useMemo(
    () => new Set([...(dataset?.assetPaths ?? []), ...(dataset?.psdAssetPaths ?? [])]),
    [dataset?.assetPaths, dataset?.psdAssetPaths]
  );
  const matchesReviewScope = useCallback((path: string | undefined) => {
    if (!scope) return true;
    if (!path || (scope.kind === 'directory' && !scope.path)) return false;
    const normalized = path.startsWith('Project/') ? path : `Project/${path}`;
    return scope.kind === 'directory'
      ? normalized === scope.path || normalized.startsWith(`${scope.path}/`)
      : scope.paths.includes(normalized);
  }, [scope]);
  const sourceImages = useMemo(() => {
    const allSources = Object.values(sourceImagesById).filter((image) => matchesReviewScope(image.originalFilePath));
    if (!datasetId) {
      return allSources;
    }
    if (mode === 'select') {
      return allSources.filter((image) => !datasetAssetIds.has(image.id));
    }
    return allSources.filter((image) => datasetAssetIds.has(image.id));
  }, [datasetAssetIds, datasetId, matchesReviewScope, mode, sourceImagesById]);
  const editedAssets = useMemo(
    () =>
      Object.values(editedAssetsById).filter(
        (image) => !image.deleted && (!datasetId || datasetAssetIds.has(image.sourceImageId)) &&
          (!scope || matchesReviewScope(image.imageDataPath) || matchesReviewScope(sourceImagesById[image.sourceImageId]?.originalFilePath))
      ),
    [datasetAssetIds, datasetId, editedAssetsById, matchesReviewScope, scope, sourceImagesById]
  );
  const allItems = useMemo(() => {
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
  const categoryRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allItems) {
      const path = (item.assetPath?.startsWith('Project/') ? item.assetPath : item.assetPath ? `Project/${item.assetPath}` : 'Project/Without folder');
      const parts = path.split('/').slice(0, -1);
      for (let index = 1; index <= parts.length; index += 1) {
        const directory = parts.slice(0, index).join('/');
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
      }
    }
    return [...counts].map(([path, count]) => ({
      path,
      count,
      depth: Math.max(0, path.split('/').length - 1),
      name: path.split('/').pop() ?? path,
    })).sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  }, [allItems]);
  const isCategoryExcluded = useCallback(
    (path: string | undefined) => !isProjectPathIncluded(path, excludedProjectCategories),
    [excludedProjectCategories]
  );
  const items = useMemo(
    () => !datasetId && !scope ? allItems.filter((item) => !isCategoryExcluded(item.assetPath)) : allItems,
    [allItems, datasetId, isCategoryExcluded, scope]
  );
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
        const scopedAssets = assets.filter((asset) => matchesReviewScope(asset.path));
        const nextAssets =
          datasetId && mode === 'select'
            ? scopedAssets.filter((asset) => !datasetAssetPaths.has(asset.path))
            : scopedAssets;
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
  }, [addNotification, assetPreviewRefreshKey, datasetAssetPaths, datasetId, matchesReviewScope, mode, projectDirectoryHandle]);

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
        (item) => {
          const query = searchQuery.trim().toLocaleLowerCase();
          const matchesQuery = !query || `${item.fileName} ${item.originalFileName ?? ''} ${item.assetPath ?? ''} ${item.tags?.join(' ') ?? ''}`.toLocaleLowerCase().includes(query);
          const hasCaption = Boolean(item.tags?.length);
          const matchesCaption = captionFilter === 'all' || (captionFilter === 'present' ? hasCaption : !hasCaption);
          const previewState = item.previewStatus === 'failed' ? 'failed' : item.previewUrl || item.kind === 'image' || item.kind === 'edited' || item.kind === 'video' ? 'ready' : 'missing';
          return matchesQuery && matchesCaption && (previewFilter === 'all' || previewFilter === previewState) &&
          selectedAspectRatios.has(item.aspectRatio) &&
          isReviewKind(item.kind) &&
          selectedKinds.has(item.kind) &&
          selectedStatuses.has(item.excludedFromDataset ? 'inactive' : 'active');
        }
      ),
    [captionFilter, items, previewFilter, searchQuery, selectedAspectRatios, selectedKinds, selectedStatuses]
  );

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((left, right) => {
      switch (sortMode) {
        case 'name-desc':
          return right.fileName.localeCompare(left.fileName, undefined, { numeric: true }) || compareDisplayIdentity(left, right);
        case 'path-asc':
          return (left.assetPath ?? '').localeCompare(right.assetPath ?? '', undefined, { numeric: true }) || compareDisplayIdentity(left, right);
        case 'path-desc':
          return (right.assetPath ?? '').localeCompare(left.assetPath ?? '', undefined, { numeric: true }) || compareDisplayIdentity(left, right);
        case 'kind':
          return left.kind.localeCompare(right.kind) || compareDisplayIdentity(left, right);
        case 'dimensions-desc':
          return right.width * right.height - left.width * left.height || compareDisplayIdentity(left, right);
        case 'dimensions-asc':
          return left.width * left.height - right.width * right.height || compareDisplayIdentity(left, right);
        case 'bytes-desc':
          return (right.byteSize ?? -1) - (left.byteSize ?? -1) || compareDisplayIdentity(left, right);
        case 'bytes-asc': {
          const leftSize = left.byteSize ?? Number.POSITIVE_INFINITY;
          const rightSize = right.byteSize ?? Number.POSITIVE_INFINITY;
          return leftSize - rightSize || compareDisplayIdentity(left, right);
        }
        case 'date-desc':
          return (right.modifiedAt ?? -1) - (left.modifiedAt ?? -1) || compareDisplayIdentity(left, right);
        case 'date-asc': {
          const leftDate = left.modifiedAt ?? Number.POSITIVE_INFINITY;
          const rightDate = right.modifiedAt ?? Number.POSITIVE_INFINITY;
          return leftDate - rightDate || compareDisplayIdentity(left, right);
        }
        case 'name-asc':
        default:
          return left.fileName.localeCompare(right.fileName, undefined, { numeric: true }) || compareDisplayIdentity(left, right);
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

  const toggleCategory = (path: string) => {
    const next = new Set([...excludedCategories].filter((entry) => entry !== path && !entry.startsWith(`${path}/`)));
    const disabledByAncestor = [...excludedCategories].some((entry) => path.startsWith(`${entry}/`));
    if (!excludedCategories.has(path) && !disabledByAncestor) next.add(path);
    updateWorkspaceSettings({ excludedProjectCategories: [...next] });
  };
  const categoryState = (path: string): 'on' | 'off' | 'partial' => {
    if ([...excludedCategories].some((entry) => path === entry || path.startsWith(`${entry}/`))) return 'off';
    if ([...excludedCategories].some((entry) => entry.startsWith(`${path}/`))) return 'partial';
    return 'on';
  };
  const categoryIsHidden = (path: string) => [...collapsedCategories].some(
    (entry) => path !== entry && path.startsWith(`${entry}/`)
  );

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
        {scope ? <div className="mr-1 rounded-md bg-secondary px-3 py-2 text-sm font-medium">{scope.label}</div> : null}
        <input type="search" aria-label="Search review files" placeholder="Search name, path, caption…" value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)} className="min-w-48 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <select aria-label="Caption filter" value={captionFilter} onChange={(event) => setCaptionFilter(event.target.value as typeof captionFilter)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm">
          <option value="all">All captions</option><option value="present">Has caption</option><option value="missing">Missing caption</option>
        </select>
        <select aria-label="Preview filter" value={previewFilter} onChange={(event) => setPreviewFilter(event.target.value as typeof previewFilter)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm">
          <option value="all">All previews</option><option value="ready">Preview ready</option><option value="missing">Preview missing</option><option value="failed">Preview failed</option>
        </select>
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
        {(searchQuery || captionFilter !== 'all' || previewFilter !== 'all' || selectedAspectRatios.size !== ASPECT_RATIOS.length || selectedKinds.size !== REVIEW_KINDS.length || selectedStatuses.size !== 2) ? (
          <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => {
            setSearchQuery(''); setCaptionFilter('all'); setPreviewFilter('all');
            setSelectedAspectRatios(new Set(ASPECT_RATIOS)); setSelectedKinds(new Set(REVIEW_KINDS)); setSelectedStatuses(new Set(['active', 'inactive']));
          }}>Reset</button>
        ) : null}
      </div>
    </div>
  );
  const reviewInspectorPortal = null;
  const categoryControls = !datasetId && !scope && categoryRows.length > 0 ? (
    <section className="rounded-md border border-border bg-card p-2" aria-label="Project categories">
      <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Project categories</div>
      <div className="max-h-56 overflow-auto">
        {categoryRows.filter((row) => !categoryIsHidden(row.path)).map((row) => {
          const hasChildren = categoryRows.some((candidate) => candidate.path.startsWith(`${row.path}/`));
          const collapsed = collapsedCategories.has(row.path);
          const state = categoryState(row.path);
          return <div key={row.path} className="flex items-center gap-1 rounded px-1 py-1 text-sm hover:bg-secondary/60" style={{ paddingLeft: `${row.depth * 14 + 4}px` }}>
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded hover:bg-secondary" disabled={!hasChildren}
              aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${row.name}`} onClick={() => setCollapsedCategories((previous) => {
                const next = new Set(previous); if (next.has(row.path)) next.delete(row.path); else next.add(row.path); return next;
              })}>
              {hasChildren ? collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" /> : <span className="h-4 w-4" />}
            </button>
            <button type="button" role="checkbox" aria-checked={state === 'partial' ? 'mixed' : state === 'on'}
              className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background" onClick={() => toggleCategory(row.path)}
              title={state === 'off' ? 'Include category' : 'Exclude category'}>
              {state === 'on' ? <Check className="h-4 w-4" /> : state === 'partial' ? <Minus className="h-4 w-4" /> : null}
            </button>
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={row.path}>{row.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{row.count}</span>
          </div>;
        })}
      </div>
    </section>
  ) : null;

  if (items.length === 0) {
    return (
      <div className="space-y-6">
        {reviewInspectorPortal}
        {reviewInspectorPortal ? null : reviewControls}
        {categoryControls}
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
      {categoryControls}

      {sortedItems.length > 0 ? (
        <AssetGallery
          active={active}
          directInteraction
          externalFiltering
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
            <button className="mt-3 rounded border border-border px-3 py-2 text-sm" onClick={() => { setSearchQuery(''); setCaptionFilter('all'); setPreviewFilter('all'); setSelectedAspectRatios(new Set(ASPECT_RATIOS)); setSelectedKinds(new Set(REVIEW_KINDS)); setSelectedStatuses(new Set(['active', 'inactive'])); }}>Reset filters</button>
          </div>
        </div>
      )}
    </div>
  );
};
