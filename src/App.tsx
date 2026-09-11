import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ComponentType, DragEvent, MouseEvent, ReactNode } from 'react';
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BarChart3,
  Brush,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  FilePlus,
  FolderOpen,
  Grip,
  Check,
  Layers3,
  Copy,
  Edit3,
  FileJson,
  Maximize2,
  Minimize2,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  ScanSearch,
  Scissors,
  Sun,
  Tags,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { useProjectStore } from './stores/useProjectStore';
import { useUIStore } from './stores/useUIStore';
import {
  TOOLS,
  TOOL_LABELS,
  TOOL_URL_SLUGS,
  TOOL_DESCRIPTIONS,
  URL_TOOL_ALIASES,
} from './lib/constants';
import {
  createWorkspaceFileAssetId,
  toWorkspaceImages,
  toWorkspaceReviewAssets,
  type WorkspaceFileAsset,
  type WorkspaceImage,
} from './lib/workspaceImages';
import { collectWorkspaceFileAssets, generateMissingWorkspacePsdPreviews } from './lib/workspaceFileAssets';
import { useWorkspacePreviewUrls } from './lib/previewUrlCache';
import {
  createProjectDirectory,
  clearProjectDirectory,
  pickProjectDirectory,
  projectDirectoryHasManifest,
  readProjectDirectory,
  writeProjectPreview,
  writeProjectDirectoryChanges,
  type ProjectDirectoryHandle,
} from './services/project/projectDirectoryService';
import { isHiddenExplorerManifestName } from './services/project/assetManifestService';
import { getImportFilesFromDataTransfer, importImageFiles, type ImportInputFile } from './services/import/importService';
import {
  deleteLocalTaggerFileHandle,
  saveLocalTaggerFileHandle,
  type LocalTaggerFileKey,
} from './services/tagging/localTaggerFileSettings';
import { createOperationLogger } from './services/logging/applicationLog';
import { indexProjectAssets } from './services/project/assetIndexService';
import { isSupportedProjectAsset } from './services/project/assetTypeService';
import {
  filterLegacyProjectAssetPaths,
  isLegacyProjectRootPath,
  LEGACY_PROJECT_ROOT_DIRECTORY_NAMES,
} from './services/project/projectPathFilters';
import { downloadZipFile, exportAsZip, type ExportAsset } from './services/export/exportService';
import {
  createDatasetForFile,
  getDatasetDisplayName,
  getDatasetFileName,
  isDatasetFileName,
  readDatasetFile,
  writeDatasetFile,
} from './services/project/datasetFileService';
import { InternalFileViewer } from './components/InternalFileViewer';
import { BrickMasonry } from './components/ui/BrickMasonry';
import { ContextActionGroups, type ContextAction, type ContextActionGroup } from './components/ui/ContextActions';
import { InspectorSection } from './components/ui/InspectorSection';
import { WorkspacePreviewCard } from './components/ui/WorkspacePreviewCard';
import {
  applyCaptionOverridePathMoves,
  applyExplorerPathMoves,
  applyFileAssetOrderPathMoves,
  createDatasetFileAssetKey,
  createDatasetImageAssetKey,
  normalizeDatasetAssetOrder,
  type ExplorerPathMove,
} from './lib/datasetAssets';
import { CleanupStage as CleanupStageComponent } from './components/stages/CleanupStage';
import { FinalReviewStage } from './components/stages/FinalReviewStage';
import { TaggingStage as TaggingStageComponent } from './components/stages/TaggingStage';
import { PhotopeaPsdPreviewWorker, PSD_TOOL_COMMAND_EVENT } from './components/photopea/PhotopeaFrame';
import {
  canOpenExplorerFile,
  copyExplorerEntries,
  createExplorerDirectory,
  deleteExplorerEntry,
  duplicateExplorerEntries,
  getDirectoryAtExplorerPath,
  getExplorerParentDirectory,
  getExplorerFileKind,
  getUniqueExplorerName,
  isExplorerImageFileName,
  moveExplorerEntries,
  readExplorerFile,
  renameExplorerEntry,
  type ExplorerClipboardEntry,
  type ExplorerFileKind,
} from './services/project/explorerFileService';
import { type BrickColumnCount, type Dataset, type ToolName } from './types';
import './App.css';

const EDIT_TOOL_COMMAND_EVENT = 'dataset-creator-edit-command';
const DATASET_BOARD_DRAG_TYPE = 'application/x-dataset-creator-dataset-board-asset';
const WORKSPACE_TAB_DRAG_TYPE = 'application/x-dataset-creator-workspace-tab';
const BRICK_COLUMN_OPTIONS: BrickColumnCount[] = ['auto', 1, 2, 3, 4, 5];
type InspectorSectionId = 'object' | 'actions' | 'file' | 'dataset' | 'photopea' | 'review' | 'analysis' | 'caption';

type FilePickerWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      excludeAcceptAllOption?: boolean;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };

type ImportDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
};

type FileInspectorMetadata = {
  dimensions?: { width: number; height: number };
  format: string;
  size: string;
  captionEntries: { label: string; tags: string[] }[];
  tags?: string[];
};

type InspectorContext = 'empty' | 'tool' | 'dataset' | 'file' | 'review' | 'analysis' | 'caption' | 'photopea';

const parseBrickColumnCount = (value: string): BrickColumnCount =>
  value === 'auto' ? 'auto' : (Math.min(5, Math.max(1, Number(value))) as BrickColumnCount);

const selectFileNameStem = (input: HTMLInputElement) => {
  const extensionStart = input.value.lastIndexOf('.');
  if (extensionStart > 0) {
    input.setSelectionRange(0, extensionStart);
    return;
  }
  input.select();
};

const WORKSPACE_LAYOUT_STORAGE_KEY = 'dataset-creator-workspace-layout';

type WorkspaceTabState = {
  pinned?: boolean;
  dirty?: boolean;
};

type ToolWorkspaceTab = {
  id: string;
  kind: 'tool';
  stage: ToolName;
  nested?: ToolNestedView;
} & WorkspaceTabState;

type DatasetToolStage = Extract<ToolName, 'select' | 'analysis' | 'review' | 'tagging'>;
type DatasetBoardSortMode = 'manual' | 'name' | 'type' | 'captioned' | 'aspect';
const DATASET_BOARD_SORT_OPTIONS: Array<{ value: DatasetBoardSortMode; label: string }> = [
  { value: 'manual', label: 'Manual order' },
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'captioned', label: 'Captioned' },
  { value: 'aspect', label: 'Aspect ratio' },
];

const getDatasetBoardAssetKey = (item: WorkspaceImage): string =>
  item.kind === 'image'
    ? createDatasetImageAssetKey(item.sourceImageId)
    : createDatasetFileAssetKey(item.assetPath ?? item.id);

const orderDatasetBoardItems = (
  items: WorkspaceImage[],
  assetOrder: string[] | undefined,
  assetIds: string[] = []
): WorkspaceImage[] => {
  const itemByKey = new Map(items.map((item) => [getDatasetBoardAssetKey(item), item]));
  const assetPaths = items.map((item) => item.assetPath).filter((path): path is string => Boolean(path));
  const orderedKeys = normalizeDatasetAssetOrder(assetOrder, assetIds, assetPaths);
  const seenKeys = new Set<string>();
  const orderedItems = orderedKeys
    .map((key) => itemByKey.get(key))
    .filter((item): item is WorkspaceImage => Boolean(item))
    .filter((item) => {
      const key = getDatasetBoardAssetKey(item);
      if (seenKeys.has(key)) {
        return false;
      }
      seenKeys.add(key);
      return true;
    });
  return [...orderedItems, ...items.filter((item) => !seenKeys.has(getDatasetBoardAssetKey(item)))];
};

type ToolNestedView = {
  kind: 'file';
  itemId: string;
};

const DATASET_TOOL_LABELS: Record<DatasetToolStage, string> = {
  select: 'Remove Duplicates',
  analysis: 'Analysis',
  review: 'Review',
  tagging: 'Caption',
};

type DatasetToolWorkspaceTab = {
  id: string;
  kind: 'dataset-tool';
  datasetId: string;
  stage: DatasetToolStage;
  nested?: ToolNestedView;
} & WorkspaceTabState;

type FileWorkspaceTab = {
  id: string;
  kind: 'file-view' | 'file-edit' | 'file-caption' | 'file-analysis';
  path: string;
  name: string;
  fileKind: ExplorerFileKind;
  file: File | Blob;
  workspaceImageId?: string;
} & WorkspaceTabState;

type DatasetWorkspaceTab = {
  id: string;
  kind: 'dataset';
  datasetId: string;
} & WorkspaceTabState;

type WorkspaceTab = ToolWorkspaceTab | DatasetToolWorkspaceTab | FileWorkspaceTab | DatasetWorkspaceTab;

type PersistedWorkspaceTab =
  | {
      kind: 'tool';
      stage: ToolName;
      pinned?: boolean;
    }
  | {
      kind: 'dataset';
      datasetId: string;
      pinned?: boolean;
    }
  | {
      kind: 'dataset-tool';
      datasetId: string;
      stage: DatasetToolStage;
      pinned?: boolean;
    };

const createToolTab = (stage: ToolName): ToolWorkspaceTab => ({
  id: `tool:${stage}`,
  kind: 'tool',
  stage,
});

const createFileTabId = (path: string): string => `file:${path}`;
const createFileModeTabId = (mode: 'edit' | 'caption' | 'analysis', path: string): string => `file:${mode}:${path}`;
const createDatasetTabId = (datasetId: string): string => `dataset:${datasetId}`;
const createDatasetToolTabId = (datasetId: string, stage: DatasetToolStage): string => `dataset:${datasetId}:${stage}`;

const isDatasetToolStage = (stage: unknown): stage is DatasetToolStage =>
  stage === 'select' || stage === 'analysis' || stage === 'review' || stage === 'tagging';

const createWorkspaceTabFromPersisted = (tab: PersistedWorkspaceTab): WorkspaceTab => {
  if (tab.kind === 'tool') {
    return { ...createToolTab(tab.stage), pinned: tab.pinned };
  }
  if (tab.kind === 'dataset') {
    return {
      id: createDatasetTabId(tab.datasetId),
      kind: 'dataset',
      datasetId: tab.datasetId,
      pinned: tab.pinned,
    };
  }
  return {
    id: createDatasetToolTabId(tab.datasetId, tab.stage),
    kind: 'dataset-tool',
    datasetId: tab.datasetId,
    stage: tab.stage,
    pinned: tab.pinned,
  };
};

const persistWorkspaceTab = (tab: WorkspaceTab): PersistedWorkspaceTab | null => {
  if (tab.kind === 'tool') {
    return { kind: 'tool', stage: tab.stage, pinned: tab.pinned };
  }
  if (tab.kind === 'dataset') {
    return { kind: 'dataset', datasetId: tab.datasetId, pinned: tab.pinned };
  }
  if (tab.kind === 'dataset-tool') {
    return { kind: 'dataset-tool', datasetId: tab.datasetId, stage: tab.stage, pinned: tab.pinned };
  }
  return null;
};

const dedupeWorkspaceTabs = (tabs: WorkspaceTab[]): WorkspaceTab[] => {
  const seenIds = new Set<string>();
  return tabs.filter((tab) => {
    if (seenIds.has(tab.id)) {
      return false;
    }
    seenIds.add(tab.id);
    return true;
  });
};

const isDatasetToolTab = (tab: WorkspaceTab): tab is DatasetToolWorkspaceTab => tab.kind === 'dataset-tool';
const isFileBackedTab = (tab: WorkspaceTab): tab is FileWorkspaceTab =>
  tab.kind === 'file-view' || tab.kind === 'file-edit' || tab.kind === 'file-caption' || tab.kind === 'file-analysis';

const getInspectorContext = (tab: WorkspaceTab | null, activeStage: ToolName | null): InspectorContext => {
  if (!tab) {
    return 'empty';
  }

  if (tab.kind === 'dataset') {
    return 'dataset';
  }

  if (tab.kind === 'file-caption' || activeStage === 'tagging') {
    return 'caption';
  }

  if (tab.kind === 'file-analysis') {
    return 'analysis';
  }

  if (tab.kind === 'file-edit' || (tab.kind === 'file-view' && tab.fileKind === 'psd')) {
    return 'photopea';
  }

  if (tab.kind === 'file-view') {
    return 'file';
  }

  if ((tab.kind === 'tool' && tab.stage === 'review') || (tab.kind === 'dataset-tool' && (tab.stage === 'select' || tab.stage === 'review'))) {
    return 'review';
  }

  if ((tab.kind === 'tool' && tab.stage === 'analysis') || (tab.kind === 'dataset-tool' && tab.stage === 'analysis')) {
    return 'analysis';
  }

  return activeStage ? 'tool' : 'empty';
};

type WorkspaceLayout = {
  openTabs: PersistedWorkspaceTab[];
  projectId?: string | null;
  activeTabId?: string | null;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  projectWindow: FloatingPanelState;
  inspectorWindow: FloatingPanelState;
  projectWindowOpen: boolean;
  inspectorWindowOpen: boolean;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const getRestorableWorkspaceTabs = (
  layout: Partial<WorkspaceLayout>,
  projectId?: string | null
): WorkspaceTab[] => {
  const restoreProjectTabs = Boolean(projectId && layout.projectId === projectId);
  return (layout.openTabs ?? [])
    .filter((tab) => tab.kind === 'tool' || restoreProjectTabs)
    .map(createWorkspaceTabFromPersisted);
};

const readWorkspaceLayout = (): Partial<WorkspaceLayout> => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const value = parsed as Record<string, unknown>;
    const openTabs = Array.isArray(value.openTabs)
      ? value.openTabs
          .map((tab): PersistedWorkspaceTab | null => {
            if (typeof tab === 'string' && isToolName(tab)) {
              return { kind: 'tool', stage: tab };
            }
            if (!tab || typeof tab !== 'object') {
              return null;
            }
            const entry = tab as { kind?: unknown; stage?: unknown; datasetId?: unknown; pinned?: unknown };
            const pinned = typeof entry.pinned === 'boolean' ? entry.pinned : undefined;
            if (entry.kind === 'tool' && typeof entry.stage === 'string' && isToolName(entry.stage)) {
              return { kind: 'tool', stage: entry.stage, pinned };
            }
            if (entry.kind === 'dataset' && typeof entry.datasetId === 'string') {
              return { kind: 'dataset', datasetId: entry.datasetId, pinned };
            }
            if (entry.kind === 'dataset-tool' && typeof entry.datasetId === 'string' && isDatasetToolStage(entry.stage)) {
              return { kind: 'dataset-tool', datasetId: entry.datasetId, stage: entry.stage, pinned };
            }
            return null;
          })
          .filter((tab): tab is PersistedWorkspaceTab => Boolean(tab))
      : undefined;
    const readPanel = (panel: unknown, fallback: FloatingPanelState): FloatingPanelState => {
      if (!panel || typeof panel !== 'object') {
        return fallback;
      }
      const value = panel as Record<string, unknown>;
      return {
        x: isFiniteNumber(value.x) ? value.x : fallback.x,
        y: isFiniteNumber(value.y) ? value.y : fallback.y,
        width: isFiniteNumber(value.width) ? value.width : fallback.width,
        height: isFiniteNumber(value.height) ? value.height : fallback.height,
        minimized: typeof value.minimized === 'boolean' ? value.minimized : fallback.minimized,
      };
    };

    return {
      openTabs: openTabs
        ? openTabs.filter(
            (tab, index, tabs) =>
              tabs.findIndex((entry) => {
                if (entry.kind !== tab.kind) {
                  return false;
                }
                if (entry.kind === 'tool' && tab.kind === 'tool') {
                  return entry.stage === tab.stage;
                }
                if (entry.kind === 'dataset' && tab.kind === 'dataset') {
                  return entry.datasetId === tab.datasetId;
                }
                return (
                  entry.kind === 'dataset-tool' &&
                  tab.kind === 'dataset-tool' &&
                  entry.datasetId === tab.datasetId &&
                  entry.stage === tab.stage
                );
              }) === index
          )
        : undefined,
      projectId: typeof value.projectId === 'string' ? value.projectId : null,
      activeTabId: typeof value.activeTabId === 'string' ? value.activeTabId : null,
      leftPanelOpen: typeof value.leftPanelOpen === 'boolean' ? value.leftPanelOpen : undefined,
      rightPanelOpen: typeof value.rightPanelOpen === 'boolean' ? value.rightPanelOpen : undefined,
      bottomPanelOpen: typeof value.bottomPanelOpen === 'boolean' ? value.bottomPanelOpen : undefined,
      leftPanelWidth: isFiniteNumber(value.leftPanelWidth) ? value.leftPanelWidth : undefined,
      rightPanelWidth: isFiniteNumber(value.rightPanelWidth) ? value.rightPanelWidth : undefined,
      bottomPanelHeight: isFiniteNumber(value.bottomPanelHeight) ? value.bottomPanelHeight : undefined,
      projectWindow: readPanel(value.projectWindow, {
        x: 92,
        y: 112,
        width: 300,
        height: 360,
        minimized: false,
      }),
      inspectorWindow: readPanel(value.inspectorWindow, {
        x: 420,
        y: 144,
        width: 300,
        height: 330,
        minimized: false,
      }),
      projectWindowOpen: typeof value.projectWindowOpen === 'boolean' ? value.projectWindowOpen : undefined,
      inspectorWindowOpen: typeof value.inspectorWindowOpen === 'boolean' ? value.inspectorWindowOpen : undefined,
    };
  } catch {
    return {};
  }
};

const ToolHub = lazy(() => import('./components/ToolHub').then((module) => ({ default: module.ToolHub })));
const ImportStage = lazy(() =>
  import('./components/stages/ImportStage').then((module) => ({ default: module.ImportStage }))
);
const SimilarityReviewStage = lazy(() =>
  import('./components/stages/SimilarityReviewStage').then((module) => ({
    default: module.SimilarityReviewStage,
  }))
);
const AnalysisStage = lazy(() =>
  import('./components/stages/AnalysisStage').then((module) => ({ default: module.AnalysisStage }))
);
const ExportStage = lazy(() =>
  import('./components/stages/ExportStage').then((module) => ({ default: module.ExportStage }))
);

const isToolName = (value: string | null): value is ToolName =>
  Boolean(value && (TOOLS as readonly string[]).includes(value));

const getToolFromUrlSlug = (value: string | null): ToolName | null => {
  if (!value) {
    return null;
  }

  return (URL_TOOL_ALIASES[value] ?? null) as ToolName | null;
};

const getUrlSlugForTool = (stage: ToolName): string => TOOL_URL_SLUGS[stage] ?? stage;

const readToolFromUrl = (): ToolName | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const stage = new URL(window.location.href).searchParams.get('tool');
  return getToolFromUrlSlug(stage) ?? (isToolName(stage) ? stage : null);
};

const writeToolToUrl = (stage: ToolName, mode: 'push' | 'replace' = 'replace') => {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  const stageSlug = getUrlSlugForTool(stage);
  if (url.searchParams.get('tool') === stageSlug) {
    return;
  }

  url.searchParams.set('tool', stageSlug);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (mode === 'push') {
    window.history.pushState(null, '', nextUrl);
    return;
  }

  window.history.replaceState(null, '', nextUrl);
};

const toolIcons: Record<string, ComponentType<{ className?: string }>> = {
  import: Upload,
  select: ScanSearch,
  clean: Brush,
  analysis: BarChart3,
  review: Layers3,
  tagging: Tags,
  export: Download,
};

const TOOLS_MENU_ITEMS = TOOLS.filter((stage) => stage !== 'import' && stage !== 'export');

const formatFileSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const getAspectRatioLabel = (width: number, height: number): string => {
  const divisor = (left: number, right: number): number => (right === 0 ? left : divisor(right, left % right));
  const value = divisor(width, height);
  return `${Math.round(width / value)}:${Math.round(height / value)}`;
};

type AssetContextMenuHandler = (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;

type RenderToolOptions = {
  currentStage: ToolName;
  projectDirectoryHandle?: ProjectDirectoryHandle | null;
  onOpenAssetContextMenu?: AssetContextMenuHandler;
  nested?: ToolNestedView;
  onOpenNestedFile?: (itemId: string) => void;
  onOpenTool?: (stage: ToolName) => void;
  onOpenDataset?: (datasetId: string) => void;
  onOpenDatasetTool?: (datasetId: string, stage: DatasetToolStage) => void;
  onCreateDataset?: () => void;
  onExportDataset?: (datasetId: string) => void;
};

const renderTool = ({
  currentStage,
  projectDirectoryHandle,
  onOpenAssetContextMenu,
  nested,
  onOpenNestedFile,
  onOpenTool,
  onOpenDataset,
  onOpenDatasetTool,
  onCreateDataset,
  onExportDataset,
}: RenderToolOptions) => {
  switch (currentStage) {
    case 'hub':
      return (
        <ToolHub
          onOpenTool={onOpenTool}
          onOpenDataset={onOpenDataset}
          onOpenDatasetTool={onOpenDatasetTool}
          onCreateDataset={onCreateDataset}
          onExportDataset={onExportDataset}
        />
      );
    case 'import':
      return <ImportStage />;
    case 'select':
      return <SimilarityReviewStage />;
    case 'clean':
      return (
        <CleanupStageComponent
          selectedImageId={nested?.itemId ?? null}
          onSelectImage={onOpenNestedFile}
          projectDirectoryHandle={projectDirectoryHandle}
        />
      );
    case 'analysis':
      return (
        <AnalysisStage
          active
          projectDirectoryHandle={projectDirectoryHandle}
          onOpenAssetContextMenu={onOpenAssetContextMenu}
        />
      );
    case 'review':
      return <FinalReviewStage active onOpenAssetContextMenu={onOpenAssetContextMenu} />;
    case 'tagging':
      return (
        <TaggingStageComponent
          selectedItemId={nested?.itemId ?? null}
          onOpenItem={onOpenNestedFile}
          onOpenAssetContextMenu={onOpenAssetContextMenu}
        />
      );
    case 'export':
      return <ExportStage />;
    default:
      return (
        <ToolHub
          onOpenTool={onOpenTool}
          onOpenDataset={onOpenDataset}
          onOpenDatasetTool={onOpenDatasetTool}
          onCreateDataset={onCreateDataset}
          onExportDataset={onExportDataset}
        />
      );
  }
};

type FloatingPanelState = {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
};

type FloatingWorkspacePanelProps = {
  title: string;
  icon: ComponentType<{ className?: string }>;
  panel: FloatingPanelState;
  zIndex: number;
  onChange: (next: FloatingPanelState) => void;
  onFocus: () => void;
  onClose: () => void;
  children: ReactNode;
};

const FloatingWorkspacePanel = ({
  title,
  icon: Icon,
  panel,
  zIndex,
  onChange,
  onFocus,
  onClose,
  children,
}: FloatingWorkspacePanelProps) => {
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    originWidth: number;
    originHeight: number;
  } | null>(null);
  const panelHeight = panel.minimized ? 38 : panel.height;

  useEffect(() => {
    const clampPanelToViewport = () => {
      const width = Math.max(240, Math.min(panel.width, Math.max(240, window.innerWidth - 16)));
      const height = panel.minimized
        ? panel.height
        : Math.max(150, Math.min(panel.height, Math.max(150, window.innerHeight - 16)));
      const visibleHeight = panel.minimized ? 38 : height;
      const x = Math.max(8, Math.min(Math.max(8, window.innerWidth - width - 8), panel.x));
      const y = Math.max(8, Math.min(Math.max(8, window.innerHeight - visibleHeight - 8), panel.y));

      if (x !== panel.x || y !== panel.y || width !== panel.width || height !== panel.height) {
        onChange({ ...panel, x, y, width, height });
      }
    };

    clampPanelToViewport();
    window.addEventListener('resize', clampPanelToViewport);
    return () => window.removeEventListener('resize', clampPanelToViewport);
  }, [onChange, panel]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (dragRef.current) {
        const drag = dragRef.current;
        onChange({
          ...panel,
          x: Math.max(
            8,
            Math.min(
              Math.max(8, window.innerWidth - panel.width - 8),
              drag.originX + event.clientX - drag.startX
            )
          ),
          y: Math.max(
            8,
            Math.min(
              Math.max(8, window.innerHeight - panelHeight - 8),
              drag.originY + event.clientY - drag.startY
            )
          ),
        });
      }

      if (resizeRef.current) {
        const resize = resizeRef.current;
        onChange({
          ...panel,
          width: Math.max(
            240,
            Math.min(
              Math.max(240, window.innerWidth - panel.x - 8),
              resize.originWidth + event.clientX - resize.startX
            )
          ),
          height: Math.max(
            150,
            Math.min(
              Math.max(150, window.innerHeight - panel.y - 8),
              resize.originHeight + event.clientY - resize.startY
            )
          ),
        });
      }
    };

    const stopPointerAction = () => {
      dragRef.current = null;
      resizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopPointerAction);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopPointerAction);
    };
  }, [onChange, panel]);

  return (
    <section
      className="workspace-floating-panel fixed z-[1200] flex flex-col overflow-hidden rounded-md border border-border bg-card shadow-2xl"
      style={{
        left: panel.x,
      top: panel.y,
      width: panel.width,
      height: panelHeight,
      zIndex,
    }}
      onPointerDown={onFocus}
    >
      <header
        className="flex h-9 shrink-0 cursor-move items-center gap-2 border-b border-border bg-secondary/80 px-2"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) {
            return;
          }
          dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: panel.x,
            originY: panel.y,
          };
          document.body.style.cursor = 'move';
          document.body.style.userSelect = 'none';
        }}
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</span>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onChange({ ...panel, minimized: !panel.minimized })}
          title={panel.minimized ? 'Restore panel' : 'Minimize panel'}
        >
          {panel.minimized ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
          title="Close panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {!panel.minimized && <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>}
      {!panel.minimized && (
        <button
          type="button"
          aria-label="Resize panel"
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize text-muted-foreground"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            resizeRef.current = {
              startX: event.clientX,
              startY: event.clientY,
              originWidth: panel.width,
              originHeight: panel.height,
            };
            document.body.style.cursor = 'se-resize';
            document.body.style.userSelect = 'none';
          }}
        >
          <Grip className="h-4 w-4" />
        </button>
      )}
    </section>
  );
};

type ExplorerTreeNode = {
  name: string;
  path: string;
  kind: 'folder' | 'file' | 'dataset';
  datasetId?: string;
  children?: ExplorerTreeNode[];
};

type ExplorerItemEntry = {
  path: string;
  name: string;
  kind: ExplorerTreeNode['kind'];
  datasetId?: string;
  workspaceImageId?: string;
};

type ExplorerClipboard = {
  mode: 'copy' | 'cut';
  entries: ExplorerItemEntry[];
};

type FilesystemExplorerItemEntry = ExplorerItemEntry & { kind: 'folder' | 'file' };

const isFilesystemExplorerEntry = (entry: ExplorerItemEntry): entry is FilesystemExplorerItemEntry =>
  entry.kind === 'folder' || entry.kind === 'file';

const sortExplorerNodes = (nodes: ExplorerTreeNode[]): ExplorerTreeNode[] =>
  [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) {
      const order = { folder: 0, dataset: 1, file: 2 };
      return order[a.kind] - order[b.kind];
    }
    return a.name.localeCompare(b.name);
  });

const readExplorerDirectory = async (
  directory: ProjectDirectoryHandle,
  name = 'Project',
  path = 'Project'
): Promise<ExplorerTreeNode> => {
  const children: ExplorerTreeNode[] = [];

  for await (const [entryName, entry] of directory.entries()) {
    if (isHiddenExplorerManifestName(entryName)) {
      continue;
    }
    if (entryName === '.cache' || entryName === '.dataset-creator-data') {
      continue;
    }
    if (path === 'Project' && LEGACY_PROJECT_ROOT_DIRECTORY_NAMES.has(entryName.toLowerCase())) {
      continue;
    }
    const childPath = `${path}/${entryName}`;
    if ('entries' in entry) {
      children.push(await readExplorerDirectory(entry, entryName, childPath));
    } else if (isDatasetFileName(entryName)) {
      children.push({ name: getDatasetDisplayName(entryName), path: childPath, kind: 'dataset' });
    } else if (isSupportedProjectAsset(entryName)) {
      children.push({ name: entryName, path: childPath, kind: 'file' });
    }
  }

  return {
    name,
    path,
    kind: 'folder',
    children: sortExplorerNodes(children),
  };
};

const readProjectDatasetsFromDirectory = async (
  root: ProjectDirectoryHandle,
  directory: ProjectDirectoryHandle = root,
  path = 'Project'
): Promise<Dataset[]> => {
  const datasets: Dataset[] = [];
  for await (const [entryName, entry] of directory.entries()) {
    if (entryName === '.cache' || entryName === '.dataset-creator-data') {
      continue;
    }
    if (path === 'Project' && LEGACY_PROJECT_ROOT_DIRECTORY_NAMES.has(entryName.toLowerCase())) {
      continue;
    }
    const childPath = `${path}/${entryName}`;
    if ('entries' in entry) {
      datasets.push(...await readProjectDatasetsFromDirectory(root, entry, childPath));
    } else if (isDatasetFileName(entryName)) {
      try {
        datasets.push(await readDatasetFile(root, childPath));
      } catch (error) {
        console.warn('Failed to read Dataset file', childPath, error);
      }
    }
  }
  return datasets;
};

const buildEmptyExplorerTree = (projectName: string): ExplorerTreeNode => ({
  name: projectName || 'Project',
  path: 'Project',
  kind: 'folder',
  children: [],
});

const sanitizeExplorerTree = (node: ExplorerTreeNode | null): ExplorerTreeNode | null => {
  if (!node) {
    return null;
  }

  if (node.path !== 'Project' && isLegacyProjectRootPath(node.path)) {
    return null;
  }

  return {
    ...node,
    children: node.children
      ?.map((child) => sanitizeExplorerTree(child))
      .filter((child): child is ExplorerTreeNode => Boolean(child)),
  };
};

type ExplorerTreeProps = {
  node: ExplorerTreeNode;
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  inlineEdit: {
    mode: 'create' | 'rename';
    parentPath: string;
    path?: string;
    kind: 'folder' | 'file' | 'dataset';
    value: string;
  } | null;
  focusedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: ExplorerTreeNode, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void;
  onContextMenu: (node: ExplorerTreeNode, x: number, y: number) => void;
  onInlineChange: (value: string) => void;
  onInlineCommit: () => void;
  onInlineCancel: () => void;
  onDragStartItem: (node: ExplorerTreeNode) => void;
  onDragEndItems: () => void;
  onDropItems: (node: ExplorerTreeNode, event: DragEvent) => void;
  depth?: number;
};

const getExplorerIcon = (node: ExplorerTreeNode): ComponentType<{ className?: string }> => {
  if (node.kind === 'folder') {
    return FolderOpen;
  }
  if (node.kind === 'dataset') {
    return Layers3;
  }
  switch (getExplorerFileKind(node.name)) {
    case 'image':
    case 'psd':
      return File;
    case 'json':
      return FileJson;
    case 'text':
      return File;
    case 'video':
      return Video;
    default:
      return File;
  }
};

const ExplorerTree = ({
  node,
  expandedPaths,
  selectedPaths,
  inlineEdit,
  focusedPath,
  onToggle,
  onSelect,
  onContextMenu,
  onInlineChange,
  onInlineCommit,
  onInlineCancel,
  onDragStartItem,
  onDragEndItems,
  onDropItems,
  depth = 0,
}: ExplorerTreeProps) => {
  const isFolder = node.kind === 'folder';
  const isExpanded = isFolder && expandedPaths.has(node.path);
  const isSelected = selectedPaths.has(node.path);
  const isFocused = focusedPath === node.path;
  const isRenaming = inlineEdit?.mode === 'rename' && inlineEdit.path === node.path;
  const Icon = getExplorerIcon(node);

  return (
    <div>
      <button
        type="button"
        data-explorer-row
        draggable={!isRenaming}
        onClick={(event) => {
          onSelect(node, event);
          if (isFolder && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            onToggle(node.path);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(node, event.clientX, event.clientY);
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'copyMove';
          event.dataTransfer.setData('text/plain', node.path);
          onDragStartItem(node);
        }}
        onDragEnd={onDragEndItems}
        onDragOver={(event) => {
          if (node.kind === 'folder') {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
          }
        }}
        onDrop={(event) => {
          if (node.kind !== 'folder') {
            return;
          }
          event.preventDefault();
          onDropItems(node, event);
        }}
        className={`flex h-7 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-xs hover:bg-secondary ${
          isSelected ? 'bg-primary/15 text-foreground' : ''
        } ${isFocused ? 'outline outline-1 outline-primary/60' : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        title={node.path}
      >
        {isFolder ? (
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {isRenaming ? (
          <input
            value={inlineEdit.value}
            autoFocus
            onFocus={(event) => {
              if (inlineEdit.kind === 'folder') {
                event.currentTarget.select();
                return;
              }
              selectFileNameStem(event.currentTarget);
            }}
            onChange={(event) => onInlineChange(event.target.value)}
            onBlur={onInlineCommit}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onInlineCommit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onInlineCancel();
              }
            }}
            className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        )}
      </button>
      {inlineEdit?.mode === 'create' && inlineEdit.parentPath === node.path && (
        <div style={{ paddingLeft: 4 + (depth + 1) * 12 }} className="flex h-7 items-center gap-1">
          <span className="w-3.5 shrink-0" />
          {inlineEdit.kind === 'dataset' ? (
            <Layers3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <input
            value={inlineEdit.value}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onInlineChange(event.target.value)}
            onBlur={onInlineCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onInlineCommit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onInlineCancel();
              }
            }}
            className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs"
          />
        </div>
      )}
      {isExpanded &&
        node.children?.map((child) => (
          <ExplorerTree
            key={child.path}
            node={child}
            expandedPaths={expandedPaths}
            selectedPaths={selectedPaths}
            inlineEdit={inlineEdit}
            focusedPath={focusedPath}
            onToggle={onToggle}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onInlineChange={onInlineChange}
            onInlineCommit={onInlineCommit}
            onInlineCancel={onInlineCancel}
            onDragStartItem={onDragStartItem}
            onDragEndItems={onDragEndItems}
            onDropItems={onDropItems}
            depth={depth + 1}
          />
        ))}
    </div>
  );
};

const EmptyWorkspacePlaceholder = ({
  onOpenTool,
  onOpenProject,
}: {
  onOpenTool: () => void;
  onOpenProject: () => void;
}) => (
  <div className="flex h-full min-h-[20rem] items-center justify-center text-center">
    <div className="max-w-sm px-6 text-muted-foreground">
      <Archive className="mx-auto mb-3 h-8 w-8 opacity-60" />
      <p className="text-sm font-medium text-foreground">Workspace is ready</p>
      <p className="mt-1 text-xs">Open a tool, Dataset, or file when you need it.</p>
      <div className="mt-4 flex justify-center gap-2">
        <button
          type="button"
          onClick={onOpenTool}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
        >
          <Plus className="h-3.5 w-3.5" />
          Open Tool
        </button>
        <button
          type="button"
          onClick={onOpenProject}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Open Project
        </button>
      </div>
    </div>
  </div>
);

function App() {
  const projectId = useProjectStore((state) => state.id);
  const projectName = useProjectStore((state) => state.name);
  const currentStage = useProjectStore((state) => state.currentStage);
  const initializeProject = useProjectStore((state) => state.initializeProject);
  const loadProject = useProjectStore((state) => state.loadProject);
  const renameProject = useProjectStore((state) => state.renameProject);
  const setCurrentTool = useProjectStore((state) => state.setCurrentTool);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const updateWorkspaceSettings = useProjectStore((state) => state.updateWorkspaceSettings);
  const addSourceImage = useProjectStore((state) => state.addSourceImage);
  const removeSourceImage = useProjectStore((state) => state.removeSourceImage);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const upsertProjectDataset = useProjectStore((state) => state.upsertDataset);
  const updateProjectDataset = useProjectStore((state) => state.updateDataset);
  const removeProjectDataset = useProjectStore((state) => state.removeDataset);
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const datasetItemsById = useProjectStore((state) => state.datasetItems);
  const datasetsById = useProjectStore((state) => state.datasets);
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const datasetItems = useMemo(
    () => Object.values(datasetItemsById).filter((item) => !item.deleted),
    [datasetItemsById]
  );
  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, datasetItems),
    [datasetItems, sourceImages]
  );
  const {
    darkMode,
    setDarkMode,
    editToolbar,
    taggingToolbar,
    addNotification,
    notifications,
    operationLogs,
    removeNotification,
    projectDirectoryHandle,
    projectDirectoryName,
    setProjectDirectory,
  } = useUIStore();
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [windowsMenuOpen, setWindowsMenuOpen] = useState(false);
  const [isWorkspaceSettingsOpen, setIsWorkspaceSettingsOpen] = useState(false);
  const [isProjectDirectoryBusy, setIsProjectDirectoryBusy] = useState(false);
  const [isUrlStageReady, setIsUrlStageReady] = useState(false);
  const [storedWorkspaceLayout] = useState(readWorkspaceLayout);
  const [initialWorkspaceTabs] = useState<WorkspaceTab[]>(() =>
    getRestorableWorkspaceTabs(storedWorkspaceLayout)
  );
  const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>(initialWorkspaceTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    initialWorkspaceTabs.some((tab) => tab.id === storedWorkspaceLayout.activeTabId)
      ? storedWorkspaceLayout.activeTabId ?? null
      : initialWorkspaceTabs[0]?.id ?? null
  );
  const [leftPanelOpen, setLeftPanelOpen] = useState(storedWorkspaceLayout.leftPanelOpen ?? true);
  const [rightPanelOpen, setRightPanelOpen] = useState(storedWorkspaceLayout.rightPanelOpen ?? true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(storedWorkspaceLayout.bottomPanelOpen ?? false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(storedWorkspaceLayout.leftPanelWidth ?? 260);
  const [rightPanelWidth, setRightPanelWidth] = useState(storedWorkspaceLayout.rightPanelWidth ?? 280);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(storedWorkspaceLayout.bottomPanelHeight ?? 190);
  const [explorerTree, setExplorerTree] = useState<ExplorerTreeNode | null>(null);
  const visibleExplorerTree = useMemo(() => sanitizeExplorerTree(explorerTree), [explorerTree]);
  const [, setExplorerStatus] = useState<'ready' | 'loading' | 'error'>('ready');
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [expandedExplorerPaths, setExpandedExplorerPaths] = useState<Set<string>>(
    () => new Set(['Project'])
  );
  const [projectWindow, setProjectWindow] = useState<FloatingPanelState>({
    ...storedWorkspaceLayout.projectWindow,
    x: storedWorkspaceLayout.projectWindow?.x ?? 92,
    y: storedWorkspaceLayout.projectWindow?.y ?? 112,
    width: storedWorkspaceLayout.projectWindow?.width ?? 300,
    height: storedWorkspaceLayout.projectWindow?.height ?? 360,
    minimized: storedWorkspaceLayout.projectWindow?.minimized ?? false,
  });
  const [inspectorWindow, setInspectorWindow] = useState<FloatingPanelState>({
    ...storedWorkspaceLayout.inspectorWindow,
    x: storedWorkspaceLayout.inspectorWindow?.x ?? 420,
    y: storedWorkspaceLayout.inspectorWindow?.y ?? 144,
    width: storedWorkspaceLayout.inspectorWindow?.width ?? 300,
    height: storedWorkspaceLayout.inspectorWindow?.height ?? 330,
    minimized: storedWorkspaceLayout.inspectorWindow?.minimized ?? false,
  });
  const [projectWindowOpen, setProjectWindowOpen] = useState(storedWorkspaceLayout.projectWindowOpen ?? false);
  const [inspectorWindowOpen, setInspectorWindowOpen] = useState(
    storedWorkspaceLayout.inspectorWindowOpen ?? false
  );
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [closedTabs, setClosedTabs] = useState<WorkspaceTab[]>([]);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const [floatingPanelOrder, setFloatingPanelOrder] = useState<Array<'project' | 'inspector'>>([
    'project',
    'inspector',
  ]);
  const taggerModelInputRef = useRef<HTMLInputElement | null>(null);
  const taggerTagsInputRef = useRef<HTMLInputElement | null>(null);
  const explorerPanelRef = useRef<HTMLDivElement | null>(null);
  const outputLogRef = useRef<HTMLDivElement | null>(null);
  const outputAutoFollowRef = useRef(true);
  const autoSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectSessionRef = useRef(0);
  const projectOperationBusyRef = useRef(false);
  const dockResizeRef = useRef<{
    kind: 'left' | 'right' | 'bottom';
    startX: number;
    startY: number;
    origin: number;
  } | null>(null);
  const draggedTabRef = useRef<string | null>(null);
  const [explorerContextMenu, setExplorerContextMenu] = useState<{
    node: ExplorerTreeNode;
    x: number;
    y: number;
    actionGroups?: ContextActionGroup[];
  } | null>(null);
  const [inspectorRenameValue, setInspectorRenameValue] = useState('');
  const [inspectorRenaming, setInspectorRenaming] = useState(false);
  const [inspectorSectionsOpen, setInspectorSectionsOpen] = useState<Record<InspectorSectionId, boolean>>({
    object: true,
    actions: true,
    file: true,
    dataset: true,
    photopea: true,
    review: true,
    analysis: true,
    caption: true,
  });
  const [fileInspectorMetadata, setFileInspectorMetadata] = useState<FileInspectorMetadata | null>(null);
  const [datasetWorkspaceFileAssets, setDatasetWorkspaceFileAssets] = useState<WorkspaceFileAsset[]>([]);
  const [datasetBoardSortMode, setDatasetBoardSortMode] = useState<DatasetBoardSortMode>('manual');
  const [draggedDatasetAssetId, setDraggedDatasetAssetId] = useState<string | null>(null);
  const [datasetDropTargetAssetId, setDatasetDropTargetAssetId] = useState<string | null>(null);
  const [datasetDropActive, setDatasetDropActive] = useState(false);
  const [explorerClipboard, setExplorerClipboard] = useState<ExplorerClipboard | null>(null);
  const [selectedExplorerPaths, setSelectedExplorerPaths] = useState<Set<string>>(new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [focusedExplorerPath, setFocusedExplorerPath] = useState<string | null>(null);
  const [draggedExplorerEntries, setDraggedExplorerEntries] = useState<ExplorerItemEntry[] | null>(null);
  const draggedExplorerEntriesRef = useRef<ExplorerItemEntry[] | null>(null);
  const [activeExplorerDirectoryPath, setActiveExplorerDirectoryPath] = useState('Project');
  const [inlineExplorerEdit, setInlineExplorerEdit] = useState<{
    mode: 'create' | 'rename';
    parentPath: string;
    path?: string;
    kind: 'folder' | 'file' | 'dataset';
    value: string;
  } | null>(null);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);

  const focusFloatingPanel = (panel: 'project' | 'inspector') => {
    setFloatingPanelOrder((order) => [...order.filter((item) => item !== panel), panel]);
  };

  const openFloatingInspector = () => {
    setInspectorWindowOpen(true);
    focusFloatingPanel('inspector');
  };

  const setInspectorSectionOpen = (section: InspectorSectionId, open: boolean) => {
    setInspectorSectionsOpen((sections) =>
      sections[section] === open ? sections : { ...sections, [section]: open }
    );
  };

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDarkMode(prefersDark);
  }, [setDarkMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    const outputLog = outputLogRef.current;
    if (!outputLog || !outputAutoFollowRef.current) {
      return;
    }

    outputLog.scrollTop = outputLog.scrollHeight;
  }, [operationLogs.length, bottomPanelOpen]);

  useEffect(() => {
    const stageFromUrl = readToolFromUrl();
    if (stageFromUrl) {
      setCurrentTool(stageFromUrl);
      setOpenTabs((tabs) =>
        tabs.some((tab) => tab.kind === 'tool' && tab.stage === stageFromUrl)
          ? tabs
          : [...tabs, createToolTab(stageFromUrl)]
      );
      setActiveTabId(createToolTab(stageFromUrl).id);
    }
    setIsUrlStageReady(true);

    const handlePopState = () => {
      const nextStage = readToolFromUrl();
      if (nextStage) {
        setCurrentTool(nextStage);
        setOpenTabs((tabs) =>
          tabs.some((tab) => tab.kind === 'tool' && tab.stage === nextStage)
            ? tabs
            : [...tabs, createToolTab(nextStage)]
        );
        setActiveTabId(createToolTab(nextStage).id);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setCurrentTool]);

  useEffect(() => {
    if (isUrlStageReady) {
      writeToolToUrl(currentStage);
    }
  }, [currentStage, isUrlStageReady]);

  useEffect(() => {
    if (!projectDirectoryHandle) {
      return;
    }

    const sessionId = projectSessionRef.current;
    const directoryHandle = projectDirectoryHandle;
    let previousProject = useProjectStore.getState();
    let saveTimer: number | undefined;

    const unsubscribe = useProjectStore.subscribe((nextProject) => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        if (
          projectSessionRef.current !== sessionId ||
          useUIStore.getState().projectDirectoryHandle !== directoryHandle
        ) {
          return;
        }

        const projectBeforeChanges = previousProject;
        previousProject = nextProject;
        autoSaveQueueRef.current = autoSaveQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            if (
              projectSessionRef.current !== sessionId ||
              useUIStore.getState().projectDirectoryHandle !== directoryHandle
            ) {
              return;
            }
            await writeProjectDirectoryChanges(nextProject, projectBeforeChanges, directoryHandle);
          })
          .catch((error) => {
            if (
              projectSessionRef.current === sessionId &&
              useUIStore.getState().projectDirectoryHandle === directoryHandle
            ) {
              createOperationLogger('Project').error(
                error instanceof Error ? error.message : 'failed to auto-save project directory'
              );
              addNotification(
                'error',
                error instanceof Error ? error.message : 'Failed to auto-save project directory'
              );
            }
          });
      }, 250);
    });

    return () => {
      window.clearTimeout(saveTimer);
      unsubscribe();
    };
  }, [addNotification, projectDirectoryHandle]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = dockResizeRef.current;
      if (!resize) {
        return;
      }

      if (resize.kind === 'left') {
        setLeftPanelWidth(
          Math.max(200, Math.min(420, resize.origin + (event.clientX - resize.startX)))
        );
      } else if (resize.kind === 'right') {
        setRightPanelWidth(
          Math.max(220, Math.min(460, resize.origin - (event.clientX - resize.startX)))
        );
      } else {
        setBottomPanelHeight(
          Math.max(130, Math.min(360, resize.origin - (event.clientY - resize.startY)))
        );
      }
    };

    const stopResize = () => {
      dockResizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };
  }, []);

  useEffect(() => {
    if (!(TOOLS as readonly string[]).includes(currentStage)) {
      setCurrentTool('hub');
    }
  }, [currentStage, setCurrentTool]);

  useEffect(() => {
    if (!fileMenuOpen && !viewMenuOpen && !toolsMenuOpen && !windowsMenuOpen && !tabMenuOpen && !tabContextMenu) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFileMenuOpen(false);
        setViewMenuOpen(false);
        setToolsMenuOpen(false);
        setWindowsMenuOpen(false);
        setTabMenuOpen(false);
        setTabContextMenu(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fileMenuOpen, tabContextMenu, tabMenuOpen, toolsMenuOpen, viewMenuOpen, windowsMenuOpen]);

  useEffect(() => {
    if (!explorerContextMenu) {
      return;
    }

    const closeMenu = () => setExplorerContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [explorerContextMenu]);

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const tabContextMenuTab = tabContextMenu
    ? openTabs.find((tab) => tab.id === tabContextMenu.tabId) ?? null
    : null;
  const tabContextMenuDataset =
    tabContextMenuTab?.kind === 'dataset' || tabContextMenuTab?.kind === 'dataset-tool'
      ? datasetsById[tabContextMenuTab.datasetId]
      : null;
  const tabContextMenuDatasetFilePath = tabContextMenuDataset?.filePath;
  const activeStage = activeTab?.kind === 'tool' || activeTab?.kind === 'dataset-tool' ? activeTab.stage : null;
  const activeDataset =
    activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
      ? datasetsById[activeTab.datasetId]
      : null;
  const activeDatasetFileAssetPaths = useMemo(
    () =>
      activeDataset
        ? filterLegacyProjectAssetPaths([
            ...new Set([...(activeDataset.assetPaths ?? []), ...(activeDataset.psdAssetPaths ?? [])]),
          ])
        : [],
    [activeDataset]
  );
  const activeDatasetWorkspaceAssetPaths = useMemo(
    () =>
      activeTab?.kind === 'dataset' && activeDataset
        ? activeDatasetFileAssetPaths
        : [],
    [activeDataset, activeDatasetFileAssetPaths, activeTab]
  );
  const activeDatasetSourceImages = useMemo(
    () =>
      activeTab?.kind === 'dataset' && activeDataset
        ? activeDataset.assetIds
            .map((assetId) => sourceImagesById[assetId])
            .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
        : [],
    [activeDataset, activeTab, sourceImagesById]
  );
  const activeDatasetPreviewItems = useMemo(
    () =>
      activeDataset
        ? orderDatasetBoardItems(
            toWorkspaceReviewAssets(activeDatasetSourceImages, datasetWorkspaceFileAssets),
            activeDataset.assetOrder,
            activeDataset.assetIds
          )
        : [],
    [activeDataset, activeDatasetSourceImages, datasetWorkspaceFileAssets]
  );
  const activeDatasetPreviewUrls = useWorkspacePreviewUrls(activeDatasetPreviewItems);
  const activeDatasetSummary = useMemo(() => {
    if (!activeDataset) {
      return null;
    }

    const sourceAssetIds = [...new Set(activeDataset.assetIds ?? [])];
    const sourceItems = workspaceImages.filter((item) => sourceAssetIds.includes(item.sourceImageId));
    const sourceCaptionedCount = sourceItems.filter((item) => {
      const overrideTags = activeDataset.overwriteCaptions ? activeDataset.captionOverrides[item.id] : undefined;
      return (overrideTags ?? item.tags ?? []).length > 0;
    }).length;
    const fileCaptionedCount = activeDatasetFileAssetPaths.filter((path) => {
      const tags = activeDataset.captionOverrides[createWorkspaceFileAssetId(path)];
      return tags && tags.length > 0;
    }).length;

    return {
      assets: sourceAssetIds.length + activeDatasetFileAssetPaths.length,
      supported:
        sourceItems.filter((item) => item.kind === 'image' || item.kind === 'synthetic').length +
        filterLegacyProjectAssetPaths(activeDataset.psdAssetPaths ?? []).length,
      sourceRefs: sourceAssetIds.length,
      availableSourceRefs: sourceAssetIds.filter((id) => Boolean(sourceImagesById[id])).length,
      fileAssets: activeDatasetFileAssetPaths.length,
      captioned: sourceCaptionedCount + fileCaptionedCount,
      captionable: sourceItems.length + activeDatasetFileAssetPaths.length,
      triggerWordSet: Boolean(activeDataset.triggerWord.trim()),
    };
  }, [activeDataset, activeDatasetFileAssetPaths, sourceImagesById, workspaceImages]);
  const activeFileWorkspaceItem = useMemo(() => {
    if (!activeTab || !isFileBackedTab(activeTab)) {
      return null;
    }

    const candidates = [...workspaceImages, ...activeDatasetPreviewItems];
    return candidates.find((item) => {
      if (activeTab.workspaceImageId && item.id === activeTab.workspaceImageId) {
        return true;
      }
      return item.assetPath === activeTab.path;
    }) ?? null;
  }, [activeDatasetPreviewItems, activeTab, workspaceImages]);
  const activeFileCaptionEntries = useMemo(() => {
    if (!activeTab || !isFileBackedTab(activeTab)) {
      return [];
    }

    const captionEntries: { label: string; tags: string[] }[] = [];
    const captionKeys = [
      activeFileWorkspaceItem?.id,
      activeTab.workspaceImageId,
      createWorkspaceFileAssetId(activeTab.path),
    ].filter((key): key is string => Boolean(key));
    const orderedDatasets = [
      ...(activeDataset ? [activeDataset] : []),
      ...Object.values(datasetsById).filter((dataset) => dataset.id !== activeDataset?.id),
    ];

    for (const dataset of orderedDatasets) {
      const overrideTags = captionKeys.map((key) => dataset.captionOverrides[key]).find((tags) => tags?.length);
      if (overrideTags?.length) {
        captionEntries.push({
          label: `Dataset: ${dataset.name}`,
          tags: overrideTags,
        });
      }
    }

    const baseTags = activeFileWorkspaceItem?.tags;
    if (baseTags?.length) {
      const alreadyShown = captionEntries.some((entry) => entry.tags.join('\n') === baseTags.join('\n'));
      if (!alreadyShown) {
        captionEntries.unshift({
          label: 'Caption',
          tags: baseTags,
        });
      }
    }

    return captionEntries;
  }, [activeDataset, activeFileWorkspaceItem, activeTab, datasetsById]);
  const activeToolNestedView =
    activeTab?.kind === 'tool' || activeTab?.kind === 'dataset-tool' ? activeTab.nested : undefined;
  const getWorkspaceTabChrome = (tab: WorkspaceTab) => {
    const Icon =
      tab.kind === 'tool'
        ? tab.stage === 'hub'
          ? Archive
          : toolIcons[tab.stage]
        : tab.kind === 'dataset-tool'
          ? toolIcons[tab.stage]
        : tab.kind === 'dataset'
          ? Layers3
          : getExplorerIcon({ name: tab.name, path: tab.path, kind: 'file' });
    const label =
      tab.kind === 'tool'
        ? TOOL_LABELS[tab.stage]
        : tab.kind === 'dataset-tool'
          ? `${DATASET_TOOL_LABELS[tab.stage]}: ${datasetsById[tab.datasetId]?.name ?? 'Dataset'}`
        : tab.kind === 'dataset'
          ? `Dataset: ${datasetsById[tab.datasetId]?.name ?? 'Dataset'}`
        : tab.kind === 'file-edit'
          ? `Photopea: ${tab.name}`
          : tab.kind === 'file-analysis'
            ? `Analysis: ${tab.name}`
          : tab.kind === 'file-caption'
            ? `Caption: ${tab.name}`
            : tab.name;
    const target =
      tab.kind === 'tool'
        ? 'Project tool'
        : tab.kind === 'dataset-tool'
          ? 'Applied to Dataset'
          : tab.kind === 'dataset'
            ? 'Dataset object'
            : 'File';
    const title = `${label} - ${target}`;

    return { Icon, label, target, title };
  };
  const activeInspectorContext = getInspectorContext(activeTab, activeStage);
  const showFileInspector = Boolean(activeTab && isFileBackedTab(activeTab));
  const showDatasetInspector = Boolean(activeDataset);
  const showCaptionInspector = activeInspectorContext === 'caption';
  const showReviewInspector =
    (activeTab?.kind === 'tool' && activeTab.stage === 'review') ||
    (activeTab?.kind === 'dataset-tool' && (activeTab.stage === 'select' || activeTab.stage === 'review'));
  const showAnalysisInspector = activeInspectorContext === 'analysis';
  const floatingInspectorOwnsContent = inspectorWindowOpen && !inspectorWindow.minimized;
  const showPhotopeaInspector =
    activeInspectorContext === 'photopea' &&
    activeTab &&
    isFileBackedTab(activeTab) &&
    (activeTab.kind === 'file-edit' || activeTab.fileKind === 'psd');

  const setToolTabNestedView = (tabId: string, nested: ToolNestedView | undefined) => {
    setOpenTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId && (tab.kind === 'tool' || tab.kind === 'dataset-tool')
          ? { ...tab, nested }
          : tab
      )
    );
  };

  const openActiveToolNestedFile = (itemId: string) => {
    if (!activeTab || (activeTab.kind !== 'tool' && activeTab.kind !== 'dataset-tool')) {
      return;
    }
    setToolTabNestedView(activeTab.id, { kind: 'file', itemId });
  };

  const closeActiveToolNestedView = () => {
    if (!activeTab || (activeTab.kind !== 'tool' && activeTab.kind !== 'dataset-tool')) {
      return;
    }
    setToolTabNestedView(activeTab.id, undefined);
  };

  useEffect(() => {
    setInspectorRenaming(false);
    if (activeTab?.kind === 'dataset') {
      setInspectorRenameValue(activeDataset?.name ?? 'Dataset');
      return;
    }
    if (activeTab && isFileBackedTab(activeTab)) {
      setInspectorRenameValue(activeTab.name);
      return;
    }
    setInspectorRenameValue(activeStage ? TOOL_LABELS[activeStage] : '');
  }, [activeDataset?.name, activeStage, activeTab]);

  useEffect(() => {
    let canceled = false;

    if (!projectDirectoryHandle || activeTab?.kind !== 'dataset' || activeDatasetWorkspaceAssetPaths.length === 0) {
      setDatasetWorkspaceFileAssets([]);
      return;
    }

    const loadDatasetWorkspaceFileAssets = async () => {
      try {
        const assets = await collectWorkspaceFileAssets(projectDirectoryHandle, activeDatasetWorkspaceAssetPaths);
        const pendingAssets = assets.map((asset) =>
          asset.kind === 'psd' && !asset.previewUrl ? { ...asset, previewStatus: 'queued' as const } : asset
        );

        if (canceled) {
          return;
        }

        setDatasetWorkspaceFileAssets(pendingAssets);
        void generateMissingWorkspacePsdPreviews(
          projectDirectoryHandle,
          pendingAssets,
          (path, update) => {
            setDatasetWorkspaceFileAssets((currentAssets) =>
              currentAssets.map((asset) => (asset.path === path ? { ...asset, ...update } : asset))
            );
          },
          () => canceled
        );
      } catch (error) {
        if (!canceled) {
          setDatasetWorkspaceFileAssets([]);
          addNotification('warning', error instanceof Error ? error.message : 'Unable to read Dataset file assets');
        }
      }
    };

    void loadDatasetWorkspaceFileAssets();

    return () => {
      canceled = true;
    };
  }, [activeDatasetWorkspaceAssetPaths, activeTab?.kind, addNotification, assetPreviewRefreshKey, projectDirectoryHandle]);

  useEffect(() => {
    if (!activeTab || !isFileBackedTab(activeTab)) {
      setFileInspectorMetadata(null);
      return;
    }

    const format = activeTab.name.split('.').pop()?.toUpperCase() || activeTab.fileKind.toUpperCase();
    const tags = activeFileCaptionEntries[0]?.tags;
    const metadata: FileInspectorMetadata = {
      format,
      size: 'size' in activeTab.file ? formatFileSize(activeTab.file.size) : 'Unknown',
      captionEntries: activeFileCaptionEntries,
      tags,
    };
    setFileInspectorMetadata(metadata);

    if (activeTab.fileKind !== 'image') {
      return;
    }

    const url = URL.createObjectURL(activeTab.file);
    const image = new Image();
    let canceled = false;
    image.onload = () => {
      if (!canceled) {
        setFileInspectorMetadata({
          ...metadata,
          dimensions: {
            width: image.naturalWidth,
            height: image.naturalHeight,
          },
        });
      }
      URL.revokeObjectURL(url);
    };
    image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;

    return () => {
      canceled = true;
      URL.revokeObjectURL(url);
    };
  }, [activeFileCaptionEntries, activeTab]);

  useEffect(() => {
    if (activeTabId && openTabs.some((tab) => tab.id === activeTabId)) {
      return;
    }
    setActiveTabId(openTabs[0]?.id ?? null);
  }, [activeTabId, openTabs]);
  const showEditToolbar = (activeStage === 'clean' || activeTab?.kind === 'file-edit') && editToolbar.visible;
  const showHeaderEditToolbar = activeStage === 'clean' && editToolbar.visible;
  const showTaggingToolbar = activeStage === 'tagging' || activeTab?.kind === 'file-caption';
  const showFullscreenTagging = showTaggingToolbar && taggingToolbar.visible;

  useEffect(() => {
    if (!activeTab || activeTab.kind !== 'file-edit') {
      return;
    }
    setOpenTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === activeTab.id && tab.kind === 'file-edit'
          ? tab.dirty === editToolbar.canSave
            ? tab
            : { ...tab, dirty: editToolbar.canSave }
          : tab
      )
    );
  }, [activeTab, editToolbar.canSave]);

  const runEditCommand = (command: 'back' | 'save' | 'saveCopy' | 'cancel') => {
    window.dispatchEvent(new CustomEvent(EDIT_TOOL_COMMAND_EVENT, { detail: command }));
  };
  const runPsdCommand = (command: 'save' | 'saveCopy') => {
    window.dispatchEvent(new CustomEvent(PSD_TOOL_COMMAND_EVENT, { detail: command }));
  };
  const navigateToTool = (stage: ToolName) => {
    const nextTab = createToolTab(stage);
    setOpenTabs((tabs) => (tabs.some((tab) => tab.id === nextTab.id) ? tabs : [...tabs, nextTab]));
    setActiveTabId(nextTab.id);
    writeToolToUrl(stage, 'push');
    setCurrentTool(stage);
    setFileMenuOpen(false);
    setViewMenuOpen(false);
    setToolsMenuOpen(false);
    setWindowsMenuOpen(false);
    setTabMenuOpen(false);
  };

  const activateTab = (tab: WorkspaceTab) => {
    setActiveTabId(tab.id);
    if (tab.kind === 'tool') {
      writeToolToUrl(tab.stage, 'push');
      setCurrentTool(tab.stage);
    }
    setFileMenuOpen(false);
    setViewMenuOpen(false);
    setToolsMenuOpen(false);
    setWindowsMenuOpen(false);
    setTabMenuOpen(false);
    setTabContextMenu(null);
  };

  const pushClosedTabs = (tabs: WorkspaceTab[]) => {
    if (tabs.length === 0) {
      return;
    }
    setClosedTabs((current) => [...tabs, ...current.filter((tab) => !tabs.some((closedTab) => closedTab.id === tab.id))].slice(0, 12));
  };

  const closeTab = (tabId: string, keepHistory = true) => {
    const tabIndex = openTabs.findIndex((tab) => tab.id === tabId);
    const closedTab = openTabs[tabIndex];
    if (!closedTab) {
      return;
    }
    if (!confirmClosingTabs([closedTab])) {
      return;
    }
    const nextTabs = openTabs.filter((tab) => tab.id !== tabId);
    const nextTab = nextTabs[Math.max(0, Math.min(tabIndex, nextTabs.length - 1))] ?? null;
    if (keepHistory) {
      pushClosedTabs([closedTab]);
    }
    setOpenTabs(nextTabs);
    setTabContextMenu(null);

    if (activeTabId === tabId) {
      if (nextTab) {
        activateTab(nextTab);
      } else {
        setActiveTabId(null);
      }
    }
  };

  const closeOtherTabs = (tabId: string) => {
    const targetTab = openTabs.find((tab) => tab.id === tabId);
    if (!targetTab) {
      return;
    }
    const nextTabs = openTabs.filter((tab) => tab.id === tabId || tab.pinned);
    const closed = openTabs.filter((tab) => tab.id !== tabId && !tab.pinned);
    if (!confirmClosingTabs(closed)) {
      setTabContextMenu(null);
      return;
    }
    pushClosedTabs(closed);
    setOpenTabs(nextTabs);
    setActiveTabId(tabId);
    setTabContextMenu(null);
  };

  const toggleTabPinned = (tabId: string) => {
    setOpenTabs((tabs) => tabs.map((tab) => (tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab)));
    setTabContextMenu(null);
  };

  const reopenClosedTab = () => {
    const [tabToRestore, ...remainingTabs] = closedTabs;
    if (!tabToRestore) {
      return;
    }
    setClosedTabs(remainingTabs);
    setOpenTabs((tabs) => {
      if (tabs.some((tab) => tab.id === tabToRestore.id)) {
        return tabs;
      }
      return [...tabs, tabToRestore];
    });
    setActiveTabId(tabToRestore.id);
    setTabContextMenu(null);
  };

  const isTabDirty = (tab: WorkspaceTab): boolean =>
    Boolean(tab.dirty || (activeTabId === tab.id && tab.kind === 'file-edit' && editToolbar.canSave));

  const applyWorkspaceTabsForProject = (nextProjectId: string) => {
    const layout = readWorkspaceLayout();
    const datasets = useProjectStore.getState().datasets;
    const restoredTabs = getRestorableWorkspaceTabs(layout, nextProjectId).filter((tab) => {
      if (tab.kind === 'tool') {
        return true;
      }
      if (tab.kind === 'dataset') {
        return Boolean(datasets[tab.datasetId]);
      }
      if (tab.kind === 'dataset-tool') {
        return Boolean(datasets[tab.datasetId]);
      }
      return false;
    });

    const currentToolTabs = openTabs.filter((tab): tab is ToolWorkspaceTab => tab.kind === 'tool');
    const restoredToolTabs = restoredTabs.filter((tab): tab is ToolWorkspaceTab => tab.kind === 'tool');
    const nextTabs = dedupeWorkspaceTabs([
      ...(restoredToolTabs.length > 0 ? restoredToolTabs : currentToolTabs),
      ...restoredTabs.filter((tab) => tab.kind !== 'tool'),
    ]);
    setOpenTabs(nextTabs);

    const restoredActiveTab = nextTabs.find((tab) => tab.id === layout.activeTabId);
    if (restoredActiveTab) {
      setActiveTabId(restoredActiveTab.id);
      return;
    }

    setActiveTabId((current) => {
      if (current && nextTabs.some((tab) => tab.id === current)) {
        return current;
      }
      return nextTabs[0]?.id ?? null;
    });
  };

  const confirmClosingTabs = (tabs: WorkspaceTab[]): boolean => {
    const dirtyCount = tabs.filter(isTabDirty).length;
    if (dirtyCount === 0) {
      return true;
    }
    return window.confirm(
      `Close ${dirtyCount === 1 ? '1 tab' : `${dirtyCount} tabs`} with unsaved changes?`
    );
  };

  const commitInspectorRename = async () => {
    if (!activeTab || !inspectorRenaming) {
      return;
    }
    const nextName = inspectorRenameValue.trim();
    if (!nextName) {
      setInspectorRenaming(false);
      return;
    }

    try {
      if (activeTab.kind === 'dataset') {
        const dataset = datasetsById[activeTab.datasetId];
        if (dataset?.filePath) {
          await renameExplorerItem(dataset.filePath, 'dataset', nextName);
        }
      } else if (isFileBackedTab(activeTab)) {
        if (nextName === activeTab.name) {
          setInspectorRenaming(false);
          return;
        }
        await renameExplorerItem(activeTab.path, 'file', nextName);
      }
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to rename item');
    } finally {
      setInspectorRenaming(false);
    }
  };

  const reorderTabs = (source: string, target: string) => {
    if (source === target) {
      return;
    }

    setOpenTabs((tabs) => {
      const sourceIndex = tabs.findIndex((tab) => tab.id === source);
      const targetIndex = tabs.findIndex((tab) => tab.id === target);
      if (sourceIndex < 0 || targetIndex < 0) {
        return tabs;
      }

      const nextTabs = [...tabs];
      const [sourceTab] = nextTabs.splice(sourceIndex, 1);
      nextTabs.splice(targetIndex, 0, sourceTab);
      return nextTabs;
    });
  };

  useEffect(() => {
    try {
      const persistableActiveTab = openTabs.find((tab) => tab.id === activeTabId);
      const persistedActiveTab = persistableActiveTab ? persistWorkspaceTab(persistableActiveTab) : null;
      const persistedOpenTabs = openTabs
        .map(persistWorkspaceTab)
        .filter((tab): tab is PersistedWorkspaceTab => Boolean(tab));
      const nextOpenTabs = projectDirectoryHandle
        ? persistedOpenTabs
        : [
            ...persistedOpenTabs.filter((tab) => tab.kind === 'tool'),
            ...(storedWorkspaceLayout.openTabs ?? []).filter((tab) => tab.kind !== 'tool'),
          ];
      window.localStorage.setItem(
        WORKSPACE_LAYOUT_STORAGE_KEY,
        JSON.stringify({
          openTabs: nextOpenTabs,
          activeTabId: persistedActiveTab
            ? persistableActiveTab?.id ?? null
            : projectDirectoryHandle
              ? null
              : storedWorkspaceLayout.activeTabId ?? null,
          projectId: projectDirectoryHandle ? projectId : storedWorkspaceLayout.projectId ?? null,
          leftPanelOpen,
          rightPanelOpen,
          bottomPanelOpen,
          leftPanelWidth,
          rightPanelWidth,
          bottomPanelHeight,
          projectWindow,
          inspectorWindow,
          projectWindowOpen,
          inspectorWindowOpen,
        } satisfies WorkspaceLayout)
      );
    } catch {
      // Workspace layout is a convenience; private browsing can disable localStorage.
    }
  }, [
    bottomPanelHeight,
    bottomPanelOpen,
    inspectorWindow,
    inspectorWindowOpen,
    activeTabId,
    leftPanelOpen,
    leftPanelWidth,
    openTabs,
    projectDirectoryHandle,
    projectId,
    projectWindow,
    projectWindowOpen,
    rightPanelOpen,
    rightPanelWidth,
  ]);

  useEffect(() => {
    let canceled = false;

    const loadExplorerTree = async () => {
      if (projectDirectoryHandle) {
        setExplorerStatus('loading');
        setExplorerError(null);
        try {
          const tree = await readExplorerDirectory(
            projectDirectoryHandle,
            projectDirectoryName ?? projectDirectoryHandle.name,
            'Project'
          );
          if (!canceled) {
            setExplorerTree(tree);
            setExplorerStatus('ready');
          }
        } catch (error) {
          if (!canceled) {
            setExplorerTree(buildEmptyExplorerTree(projectName));
            setExplorerStatus('error');
            setExplorerError(error instanceof Error ? error.message : 'Unable to read project files');
          }
        }
        return;
      }

      setExplorerTree(buildEmptyExplorerTree(projectName));
      setExplorerStatus('ready');
      setExplorerError(null);
    };

    void loadExplorerTree();

    return () => {
      canceled = true;
    };
  }, [explorerRefreshKey, projectDirectoryHandle, projectDirectoryName, projectName]);

  const toggleExplorerPath = (path: string) => {
    setExpandedExplorerPaths((paths) => {
      const next = new Set(paths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const getVisibleExplorerNodes = (node: ExplorerTreeNode | null = visibleExplorerTree): ExplorerTreeNode[] => {
    if (!node) {
      return [];
    }

    const nodes: ExplorerTreeNode[] = [];
    const visit = (entry: ExplorerTreeNode) => {
      nodes.push(entry);
      if (entry.kind === 'folder' && expandedExplorerPaths.has(entry.path)) {
        entry.children?.forEach(visit);
      }
    };
    node.children?.forEach(visit);
    return nodes;
  };

  const getAllExplorerNodes = (node: ExplorerTreeNode | null = visibleExplorerTree): ExplorerTreeNode[] => {
    if (!node) {
      return [];
    }

    const nodes: ExplorerTreeNode[] = [];
    const visit = (entry: ExplorerTreeNode) => {
      nodes.push(entry);
      entry.children?.forEach(visit);
    };
    node.children?.forEach(visit);
    return nodes;
  };

  const findExplorerNodeByPath = (path: string, node: ExplorerTreeNode | null = visibleExplorerTree): ExplorerTreeNode | null => {
    if (!node) {
      return null;
    }
    if (node.path === path) {
      return node;
    }
    for (const child of node.children ?? []) {
      const match = findExplorerNodeByPath(path, child);
      if (match) {
        return match;
      }
    }
    return null;
  };

  const getActiveDirectoryChildren = (): ExplorerTreeNode[] => {
    const directory = findExplorerNodeByPath(activeExplorerDirectoryPath);
    return directory?.kind === 'folder' ? directory.children ?? [] : [];
  };

  const getFocusedExplorerNode = (): ExplorerTreeNode | null => {
    if (focusedExplorerPath) {
      return findExplorerNodeByPath(focusedExplorerPath);
    }
    const firstSelectedPath = getVisibleExplorerNodes().find((node) => selectedExplorerPaths.has(node.path))?.path;
    return firstSelectedPath ? findExplorerNodeByPath(firstSelectedPath) : null;
  };

  const getParentExplorerNode = (path: string): ExplorerTreeNode | null => {
    const parentPath = path.split('/').slice(0, -1).join('/') || 'Project';
    return parentPath === path ? null : findExplorerNodeByPath(parentPath);
  };

  const focusExplorerNode = (node: ExplorerTreeNode, extendSelection: boolean) => {
    setActiveExplorerNode(node);
    if (extendSelection) {
      const anchor = selectionAnchorPath ?? focusedExplorerPath ?? node.path;
      setSelectionAnchorPath(anchor);
      selectExplorerRange(anchor, node.path);
      return;
    }
    setSelectedExplorerPaths(new Set([node.path]));
    setSelectionAnchorPath(node.path);
  };

  const moveExplorerKeyboardFocus = (direction: -1 | 1, extendSelection: boolean) => {
    const visibleNodes = getVisibleExplorerNodes();
    if (visibleNodes.length === 0) {
      return;
    }
    const focusedPath = focusedExplorerPath ?? selectedExplorerPaths.values().next().value;
    const currentIndex = Math.max(0, visibleNodes.findIndex((node) => node.path === focusedPath));
    const nextIndex = Math.max(0, Math.min(visibleNodes.length - 1, currentIndex + direction));
    focusExplorerNode(visibleNodes[nextIndex], extendSelection);
  };

  const getTopLevelExplorerEntries = (entries: ExplorerItemEntry[]): ExplorerItemEntry[] =>
    entries.filter(
      (entry) =>
        !entries.some(
          (candidate) =>
            candidate.kind === 'folder' &&
            candidate.path !== entry.path &&
            entry.path.startsWith(`${candidate.path}/`)
        )
    );

  const getSelectedExplorerEntries = (): ExplorerItemEntry[] =>
    getTopLevelExplorerEntries(
      getVisibleExplorerNodes()
        .flatMap((node): ExplorerItemEntry[] =>
          selectedExplorerPaths.has(node.path)
            ? [{
                path: node.path,
                name: node.name,
                kind: node.kind,
                datasetId: node.datasetId,
                workspaceImageId: node.kind === 'file' ? findWorkspaceImageIdForPath(node.path) ?? undefined : undefined,
              }]
            : []
        )
    );

  const getExplorerEntriesForPaths = (paths: Set<string>): ExplorerItemEntry[] =>
    getTopLevelExplorerEntries(
      getVisibleExplorerNodes()
        .flatMap((node): ExplorerItemEntry[] =>
          paths.has(node.path)
            ? [{
                path: node.path,
                name: node.name,
                kind: node.kind,
                datasetId: node.datasetId,
                workspaceImageId: node.kind === 'file' ? findWorkspaceImageIdForPath(node.path) ?? undefined : undefined,
              }]
            : []
        )
    );

  const createExplorerEntryForNode = (node: ExplorerTreeNode): ExplorerItemEntry => ({
    path: node.path,
    name: node.name,
    kind: node.kind,
    datasetId: node.datasetId,
    workspaceImageId: node.kind === 'file' ? findWorkspaceImageIdForPath(node.path) ?? undefined : undefined,
  });

  const getExplorerEntriesFromTransferPath = (path: string): ExplorerItemEntry[] => {
    const node = findExplorerNodeByPath(path);
    return node ? [createExplorerEntryForNode(node)] : [];
  };

  const setCurrentDraggedExplorerEntries = (entries: ExplorerItemEntry[] | null) => {
    draggedExplorerEntriesRef.current = entries;
    setDraggedExplorerEntries(entries);
  };

  useEffect(() => {
    setSelectedExplorerPaths((paths) => {
      const nextPaths = [...paths].filter((path) => !isLegacyProjectRootPath(path));
      return nextPaths.length === paths.size ? paths : new Set(nextPaths);
    });
    setExpandedExplorerPaths((paths) => {
      const nextPaths = [...paths].filter((path) => !isLegacyProjectRootPath(path));
      return nextPaths.length === paths.size ? paths : new Set(nextPaths);
    });
    setFocusedExplorerPath((path) => (path && isLegacyProjectRootPath(path) ? null : path));
    setSelectionAnchorPath((path) => (path && isLegacyProjectRootPath(path) ? null : path));
    setActiveExplorerDirectoryPath((path) => (isLegacyProjectRootPath(path) ? 'Project' : path));
    setExplorerContextMenu((menu) => (menu && isLegacyProjectRootPath(menu.node.path) ? null : menu));
    setOpenTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => !isFileBackedTab(tab) || !isLegacyProjectRootPath(tab.path));
      return nextTabs.length === tabs.length ? tabs : nextTabs;
    });
    setDraggedExplorerEntries((entries) => {
      if (!entries) {
        draggedExplorerEntriesRef.current = null;
        return entries;
      }
      const nextEntries = entries.filter((entry) => !isLegacyProjectRootPath(entry.path));
      draggedExplorerEntriesRef.current = nextEntries.length > 0 ? nextEntries : null;
      return nextEntries.length === entries.length ? entries : draggedExplorerEntriesRef.current;
    });
  }, [explorerRefreshKey, projectDirectoryHandle]);

  const getContextEntries = (node: ExplorerTreeNode): ExplorerItemEntry[] => {
    if (selectedExplorerPaths.has(node.path) && selectedExplorerPaths.size > 1) {
      return getSelectedExplorerEntries();
    }
    return [{ path: node.path, name: node.name, kind: node.kind, datasetId: node.datasetId }];
  };

  const setActiveExplorerNode = (node: ExplorerTreeNode) => {
    setFocusedExplorerPath(node.path);
    setActiveExplorerDirectoryPath(
      node.kind === 'folder'
        ? node.path
        : node.path.split('/').slice(0, -1).join('/') || 'Project'
    );
  };

  const selectExplorerRange = (anchorPath: string, targetPath: string) => {
    const visibleNodes = getVisibleExplorerNodes();
    const anchorIndex = visibleNodes.findIndex((entry) => entry.path === anchorPath);
    const targetIndex = visibleNodes.findIndex((entry) => entry.path === targetPath);
    if (anchorIndex < 0 || targetIndex < 0) {
      return false;
    }
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    setSelectedExplorerPaths(new Set(visibleNodes.slice(start, end + 1).map((entry) => entry.path)));
    return true;
  };

  const selectExplorerNode = (node: ExplorerTreeNode, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
    setActiveExplorerNode(node);
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (node.kind === 'dataset' || node.kind === 'file') {
        void openExplorerFile(node);
      }
    }

    if (event.shiftKey && selectionAnchorPath) {
      if (selectExplorerRange(selectionAnchorPath, node.path)) {
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedExplorerPaths((paths) => {
        const next = new Set(paths);
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
      setSelectionAnchorPath(node.path);
      return;
    }

    setSelectedExplorerPaths(new Set([node.path]));
    setSelectionAnchorPath(node.path);
  };

  const startExplorerDrag = (node: ExplorerTreeNode) => {
    if (selectedExplorerPaths.has(node.path)) {
      setCurrentDraggedExplorerEntries(getSelectedExplorerEntries());
      return;
    }

    const nextSelection = new Set([node.path]);
    setActiveExplorerNode(node);
    setSelectedExplorerPaths(nextSelection);
    setSelectionAnchorPath(node.path);
    setCurrentDraggedExplorerEntries(getExplorerEntriesForPaths(nextSelection));
  };

  const toProjectRelativePath = (path: string): string =>
    path === 'Project' ? '' : path.replace(/^Project\//, '');

  const getProjectDataFileExtension = (fileName: string, mimeType: string): string => {
    const extension = fileName.split('.').pop()?.toLowerCase();
    if (extension && extension !== fileName.toLowerCase()) {
      return extension.replace(/[^a-z0-9]/g, '') || 'bin';
    }

    return mimeType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
  };

  const findWorkspaceImageIdForPath = (path: string): string | null => {
    const projectRelativePath = toProjectRelativePath(path);
    if (isLegacyProjectRootPath(projectRelativePath)) {
      return null;
    }
    const projectState = useProjectStore.getState();
    const source = Object.values(projectState.sourceImages).find(
      (image) =>
        (image.originalFilePath ??
          `.dataset-creator-data/source-images/${image.id}/original.${getProjectDataFileExtension(image.fileName, image.mimeType)}`) ===
        projectRelativePath
    );
    if (source) {
      return `source:${source.id}`;
    }

    const synthetic = Object.values(projectState.datasetItems).find(
      (item) =>
        (item.imageDataPath ?? `.dataset-creator-data/generated-images/${item.id}/image.png`) === projectRelativePath
    );
    if (synthetic) {
      return `synthetic:${synthetic.id}`;
    }

    if (getExplorerFileKind(path.split('/').pop() ?? path) === 'psd') {
      return createWorkspaceFileAssetId(path);
    }

    return null;
  };

  const findSourceImageIdForPath = (path: string): string | null => {
    const projectRelativePath = toProjectRelativePath(path);
    const source = Object.values(useProjectStore.getState().sourceImages).find(
      (image) =>
        (image.originalFilePath ??
          `.dataset-creator-data/source-images/${image.id}/original.${getProjectDataFileExtension(image.fileName, image.mimeType)}`) ===
        projectRelativePath
    );
    return source?.id ?? null;
  };

  const openAssetExplorerContextMenu: AssetContextMenuHandler = (item, event) => {
    const assetPath = item.assetPath;
    if (!assetPath) {
      addNotification('warning', 'This preview item is not linked to an Explorer file.');
      return;
    }

    const path = assetPath.startsWith('Project/') ? assetPath : `Project/${assetPath}`;
    const node = findExplorerNodeByPath(path) ?? {
      name: item.fileName,
      path,
      kind: 'file' as const,
    };
    setActiveExplorerNode(node);
    setSelectedExplorerPaths(new Set([node.path]));
    setSelectionAnchorPath(node.path);
    setExplorerContextMenu({
      node,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const collectDatasetAssetIdsFromExplorerEntries = (entries: ExplorerItemEntry[]): string[] => {
    const assetIds = new Set<string>();
    const nodes = getAllExplorerNodes();
    const logger = entries.some((entry) => entry.kind === 'folder') ? createOperationLogger('Dataset') : null;
    if (logger) {
      logger.info(`Adding assets from Explorer selection to Dataset`);
    }

    for (const entry of entries.filter(isFilesystemExplorerEntry)) {
      if (entry.workspaceImageId?.startsWith('source:')) {
        assetIds.add(entry.workspaceImageId.replace(/^source:/, ''));
        continue;
      }
      if (entry.workspaceImageId?.startsWith('synthetic:')) {
        const synthetic = datasetItemsById[entry.workspaceImageId.replace(/^synthetic:/, '')];
        if (synthetic) {
          assetIds.add(synthetic.sourceImageId);
          continue;
        }
      }

      const candidateNodes =
        entry.kind === 'folder'
          ? nodes.filter((node) => node.kind === 'file' && node.path.startsWith(`${entry.path}/`))
          : nodes.filter((node) => node.path === entry.path && node.kind === 'file');

      for (const node of candidateNodes) {
        const workspaceImageId = findWorkspaceImageIdForPath(node.path);
        const sourceId = workspaceImageId?.startsWith('source:')
          ? workspaceImageId.replace(/^source:/, '')
          : workspaceImageId?.startsWith('synthetic:')
            ? datasetItemsById[workspaceImageId.replace(/^synthetic:/, '')]?.sourceImageId
          : findSourceImageIdForPath(node.path);
        if (sourceId) {
          assetIds.add(sourceId);
        }
      }
    }

    if (logger) {
      logger.success(`Added ${assetIds.size} eligible asset${assetIds.size !== 1 ? 's' : ''}`);
    }

    return [...assetIds];
  };

  const collectDatasetAssetPathsFromExplorerEntries = (entries: ExplorerItemEntry[]): string[] => {
    const assetPaths = new Set<string>();
    const nodes = getAllExplorerNodes();

    for (const entry of entries.filter(isFilesystemExplorerEntry)) {
      const candidateNodes =
        entry.kind === 'folder'
          ? nodes.filter((node) => node.kind === 'file' && node.path.startsWith(`${entry.path}/`))
          : nodes.filter((node) => node.path === entry.path && node.kind === 'file');

      for (const node of candidateNodes) {
        const kind = getExplorerFileKind(node.name);
        if (kind === 'video' || kind === 'psd') {
          assetPaths.add(node.path);
        }
      }
    }

    return [...assetPaths];
  };

  const collectDatasetPsdPathsFromAssetPaths = (assetPaths: string[]): string[] =>
    filterLegacyProjectAssetPaths(assetPaths).filter((path) => getExplorerFileKind(path.split('/').pop() ?? path) === 'psd');

  const indexProjectAssetsForDatasetDrop = async () => {
    if (!projectDirectoryHandle) {
      return;
    }

    await indexProjectAssets(projectDirectoryHandle, {
      logger: createOperationLogger('Index'),
      existingSourceImages: useProjectStore.getState().sourceImages,
      onAssetIndexed: async ({ sourceImage }) => {
        const previousProject = useProjectStore.getState();
        if (sourceImage && !previousProject.sourceImages[sourceImage.id]) {
          addSourceImage(sourceImage);
        }
        await writeProjectDirectoryChanges(useProjectStore.getState(), previousProject, projectDirectoryHandle);
        refreshExplorer();
      },
    });
    await writeProjectDirectoryChanges(useProjectStore.getState(), undefined, projectDirectoryHandle);
    refreshExplorer();
  };

  const importDroppedFilesIntoDataset = async (
    dataTransfer: DataTransfer,
    dataset: Dataset
  ): Promise<{ assetIds: string[]; assetPaths: string[]; psdAssetPaths: string[] }> => {
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Open a project directory before importing files into a Dataset');
      return { assetIds: [], assetPaths: [], psdAssetPaths: [] };
    }

    const files = await getImportFilesFromDataTransfer(dataTransfer);
    if (files.length === 0) {
      return { assetIds: [], assetPaths: [], psdAssetPaths: [] };
    }

    const importedAssetIds: string[] = [];
    const importedAssetPaths: string[] = [];
    const importedPsdPaths: string[] = [];
    const previousProject = useProjectStore.getState();
    const result = await importImageFiles(files, {
      logger: createOperationLogger('Dataset'),
      destination: {
        projectDirectory: projectDirectoryHandle,
        explorerPath: dataset.parentPath ?? 'Project',
      },
      onImageImported: (image) => {
        addSourceImage(image);
        importedAssetIds.push(image.id);
      },
      onAssetImported: (asset) => {
        if (asset.kind === 'video' || asset.kind === 'psd') {
          const assetPath = asset.assetPath.startsWith('Project/') ? asset.assetPath : `Project/${asset.assetPath}`;
          importedAssetPaths.push(assetPath);
          if (asset.kind === 'psd') {
            importedPsdPaths.push(assetPath);
          }
        }
      },
      onError: (fileName) => addNotification('error', `Failed to process ${fileName}`),
    });

    if (result.importedImages.length > 0 || result.importedAssets.length > 0) {
      await writeProjectDirectoryChanges(useProjectStore.getState(), previousProject, projectDirectoryHandle);
      refreshExplorer();
    }

    return { assetIds: importedAssetIds, assetPaths: importedAssetPaths, psdAssetPaths: importedPsdPaths };
  };

  const getUniqueDatasetName = (baseName = 'New Dataset', parentPath?: string): string => {
    const existingNames = new Set(
      Object.values(datasetsById)
        .filter((dataset) => !parentPath || (dataset.parentPath || 'Project') === parentPath)
        .map((dataset) => dataset.name.toLowerCase())
    );
    if (!existingNames.has(baseName.toLowerCase())) {
      return baseName;
    }

    let index = 2;
    while (existingNames.has(`${baseName} ${index}`.toLowerCase())) {
      index += 1;
    }
    return `${baseName} ${index}`;
  };

  const getExplorerPathName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

  const toPhysicalExplorerEntry = (entry: ExplorerItemEntry): ExplorerClipboardEntry => ({
    path: entry.path,
    name: entry.kind === 'dataset' ? getExplorerPathName(entry.path) : entry.name,
    kind: entry.kind === 'folder' ? 'folder' : 'file',
  });

  const readDatasetEntry = async (entry: ExplorerItemEntry): Promise<Dataset> => {
    const directory = requireProjectDirectory();
    if (!directory) {
      throw new Error('Open a project directory before using Datasets.');
    }
    if (!isDatasetFileName(getExplorerPathName(entry.path))) {
      throw new Error('Dataset file is no longer available.');
    }
    const dataset = await readDatasetFile(directory, entry.path);
    upsertProjectDataset(dataset);
    return dataset;
  };

  const createDatasetFileInDirectory = async (
    parentPath: string,
    name: string,
    source?: Pick<Dataset, 'triggerWord' | 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'assetOrder' | 'overwriteCaptions' | 'captionOverrides'>
  ): Promise<Dataset> => {
    const directory = requireProjectDirectory();
    if (!directory) {
      throw new Error('Open a project directory before creating a Dataset.');
    }
    const parentDirectory = await getDirectoryAtExplorerPath(directory, parentPath);
    const fileName = await getUniqueExplorerName(parentDirectory, getDatasetFileName(name));
    const filePath = `${parentPath}/${fileName}`;
    const assetIds = [...new Set(source?.assetIds ?? [])];
    const assetPaths = filterLegacyProjectAssetPaths([...new Set([...(source?.assetPaths ?? []), ...(source?.psdAssetPaths ?? [])])]);
    const dataset = {
      ...createDatasetForFile(getDatasetDisplayName(fileName), filePath),
      triggerWord: source?.triggerWord ?? '',
      assetIds,
      assetPaths,
      psdAssetPaths: filterLegacyProjectAssetPaths([...new Set(source?.psdAssetPaths ?? [])]),
      assetOrder: normalizeDatasetAssetOrder(source?.assetOrder, assetIds, assetPaths),
      overwriteCaptions: source?.overwriteCaptions ?? false,
      captionOverrides: source?.captionOverrides ?? {},
    };
    await writeDatasetFile(directory, dataset);
    upsertProjectDataset(dataset);
    return dataset;
  };

  const duplicateDatasetEntry = async (entry: ExplorerItemEntry, parentPath?: string): Promise<Dataset | null> => {
    const dataset = await readDatasetEntry(entry);
    const copyParentPath =
      parentPath ?? dataset.parentPath ?? (entry.path.split('/').slice(0, -1).join('/') || 'Project');
    return createDatasetFileInDirectory(copyParentPath, `${dataset.name} Copy`, {
      triggerWord: dataset.triggerWord,
      assetIds: dataset.assetIds,
      assetPaths: dataset.assetPaths,
      psdAssetPaths: dataset.psdAssetPaths,
      assetOrder: dataset.assetOrder,
      overwriteCaptions: dataset.overwriteCaptions,
      captionOverrides: dataset.captionOverrides,
    });
  };

  const openDatasetTab = (datasetId: string) => {
    const dataset = useProjectStore.getState().datasets[datasetId];
    if (!dataset) {
      addNotification('error', 'Dataset is no longer available');
      return;
    }

    const tab: DatasetWorkspaceTab = {
      id: createDatasetTabId(datasetId),
      kind: 'dataset',
      datasetId,
    };
    setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
    setActiveTabId(tab.id);
  };

  const openDatasetToolTab = (datasetId: string, stage: DatasetToolStage) => {
    const dataset = useProjectStore.getState().datasets[datasetId];
    if (!dataset) {
      addNotification('error', 'Dataset is no longer available');
      return;
    }

    const tab: DatasetToolWorkspaceTab = {
      id: createDatasetToolTabId(datasetId, stage),
      kind: 'dataset-tool',
      datasetId,
      stage,
    };
    setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
    setActiveTabId(tab.id);
  };

  const refreshOpenDatasetTabs = (datasetId: string) => {
    setOpenTabs((tabs) =>
      tabs.map((tab) => {
        if (tab.kind === 'dataset' && tab.datasetId === datasetId) {
          return { ...tab, id: createDatasetTabId(datasetId) };
        }
        if (tab.kind === 'dataset-tool' && tab.datasetId === datasetId) {
          return { ...tab, id: createDatasetToolTabId(datasetId, tab.stage) };
        }
        return tab;
      })
    );
  };

  const openDatasetToolFromExplorer = async (node: ExplorerTreeNode, stage: DatasetToolStage) => {
    try {
      const dataset = await readDatasetEntry(node);
      openDatasetToolTab(dataset.id, stage);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to open Dataset tool');
    }
  };

  const updateDatasetFileBackedState = async (
    dataset: Dataset,
    updates: Partial<Pick<Dataset, 'triggerWord' | 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'assetOrder' | 'overwriteCaptions' | 'captionOverrides'>>
  ) => {
    const assetIds = updates.assetIds ? [...new Set(updates.assetIds)] : dataset.assetIds;
    const assetPaths = 'assetPaths' in updates
      ? filterLegacyProjectAssetPaths([...new Set(updates.assetPaths ?? [])])
      : filterLegacyProjectAssetPaths(dataset.assetPaths);
    const psdAssetPaths = updates.psdAssetPaths
      ? filterLegacyProjectAssetPaths([...new Set(updates.psdAssetPaths)])
      : 'assetPaths' in updates
        ? collectDatasetPsdPathsFromAssetPaths(filterLegacyProjectAssetPaths(updates.assetPaths ?? []))
        : filterLegacyProjectAssetPaths(dataset.psdAssetPaths);
    const normalizedPsdAssetPaths = filterLegacyProjectAssetPaths([
      ...new Set([...psdAssetPaths, ...collectDatasetPsdPathsFromAssetPaths(assetPaths)]),
    ]);
    const nextDataset = {
      ...dataset,
      ...updates,
      assetIds,
      assetPaths,
      psdAssetPaths: normalizedPsdAssetPaths,
      assetOrder: normalizeDatasetAssetOrder(updates.assetOrder ?? dataset.assetOrder, assetIds, assetPaths),
      overwriteCaptions: updates.overwriteCaptions ?? dataset.overwriteCaptions ?? false,
      captionOverrides: updates.captionOverrides ?? dataset.captionOverrides ?? {},
      updatedAt: new Date(),
    };
    updateProjectDataset(dataset.id, nextDataset);
    const directory = requireProjectDirectory();
    if (directory && nextDataset.filePath) {
      await writeDatasetFile(directory, nextDataset);
    }
  };

  const getDatasetBoardCaptionCount = (dataset: Dataset, item: WorkspaceImage): number => {
    const tags =
      item.kind === 'image'
        ? dataset.overwriteCaptions
          ? dataset.captionOverrides[item.id]
          : item.tags
        : item.assetPath
          ? dataset.captionOverrides[createWorkspaceFileAssetId(item.assetPath)]
          : item.tags;
    return tags?.length ?? 0;
  };

  const sortDatasetBoardItems = (
    items: WorkspaceImage[],
    dataset: Dataset,
    sortMode: DatasetBoardSortMode
  ): WorkspaceImage[] => {
    if (sortMode === 'manual') {
      return items;
    }

    return [...items].sort((left, right) => {
      if (sortMode === 'name') {
        return left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (sortMode === 'type') {
        return (
          left.kind.localeCompare(right.kind) ||
          left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' })
        );
      }
      if (sortMode === 'captioned') {
        return (
          getDatasetBoardCaptionCount(dataset, right) -
            getDatasetBoardCaptionCount(dataset, left) ||
          left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' })
        );
      }
      return (
        left.aspectRatio.localeCompare(right.aspectRatio) ||
        left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' })
      );
    });
  };

  const removeDatasetBoardAsset = async (dataset: Dataset, item: WorkspaceImage) => {
    const assetOrder = (dataset.assetOrder ?? []).filter((key) => key !== getDatasetBoardAssetKey(item));
    if (item.kind === 'image') {
      await updateDatasetFileBackedState(dataset, {
        assetIds: dataset.assetIds.filter((assetId) => assetId !== item.sourceImageId),
        assetOrder,
      });
    } else if (item.assetPath) {
      await updateDatasetFileBackedState(dataset, {
        assetPaths: filterLegacyProjectAssetPaths(dataset.assetPaths ?? []).filter((assetPath) => assetPath !== item.assetPath),
        psdAssetPaths: filterLegacyProjectAssetPaths(dataset.psdAssetPaths ?? []).filter((assetPath) => assetPath !== item.assetPath),
        assetOrder,
      });
    } else {
      return;
    }
    addNotification('info', 'Asset removed from Dataset');
  };

  const openDatasetBoardAssetContextMenu = (
    dataset: Dataset,
    item: WorkspaceImage,
    event: MouseEvent<HTMLElement>
  ) => {
    const assetPath = item.assetPath;
    if (!assetPath) {
      addNotification('warning', 'This Dataset item is not linked to an Explorer file.');
      return;
    }

    const path = assetPath.startsWith('Project/') ? assetPath : `Project/${assetPath}`;
    const node = findExplorerNodeByPath(path) ?? {
      name: item.fileName,
      path,
      kind: 'file' as const,
    };
    const fileKind = getExplorerFileKind(node.name);
    const workspaceImageId = findWorkspaceImageIdForPath(node.path);
    const canOpenFileInTab = canOpenExplorerFile(fileKind);
    const canOpenInPhotopea = isExplorerImageFileName(node.name) && Boolean(workspaceImageId);
    const canOpenInCaption = (fileKind === 'image' || fileKind === 'psd') && Boolean(workspaceImageId);
    const canOpenInAnalysis = fileKind === 'image' || fileKind === 'psd' || fileKind === 'video';

    setActiveExplorerNode(node);
    setSelectedExplorerPaths(new Set([node.path]));
    setSelectionAnchorPath(node.path);
    setExplorerContextMenu({
      node,
      x: event.clientX,
      y: event.clientY,
      actionGroups: [
        [
          canOpenFileInTab
            ? createExplorerAction({ id: 'open', label: 'Open', icon: File, onSelect: () => openExplorerFile(node) })
            : null,
        ].filter((action): action is ContextAction => Boolean(action)),
        [
          canOpenInPhotopea
            ? createExplorerAction({ id: 'photopea', label: 'Photopea', icon: Edit3, onSelect: () => openFileModeTab(node, 'edit') })
            : null,
          canOpenInCaption
            ? createExplorerAction({ id: 'caption', label: 'Caption', icon: Tags, onSelect: () => openFileModeTab(node, 'caption') })
            : null,
          canOpenInAnalysis
            ? createExplorerAction({ id: 'analysis', label: 'Analysis', icon: BarChart3, onSelect: () => openFileModeTab(node, 'analysis') })
            : null,
        ].filter((action): action is ContextAction => Boolean(action)),
        [
          createExplorerAction({
            id: 'remove-from-dataset',
            label: 'Remove from Dataset',
            icon: Trash2,
            variant: 'destructive',
            onSelect: () => removeDatasetBoardAsset(dataset, item),
          }),
        ],
      ].filter((group) => group.length > 0),
    });
  };

  const saveDatasetBoardOrder = async (
    dataset: Dataset,
    items: WorkspaceImage[],
    options: { notify?: boolean } = {}
  ) => {
    const orderedImageIds = items
      .filter((item) => item.kind === 'image' && item.sourceImageId)
      .map((item) => item.sourceImageId);
    const orderedAssetPaths = items
      .filter((item) => item.kind !== 'image' && item.assetPath)
      .map((item) => item.assetPath as string);
    const orderedKeys = items.map(getDatasetBoardAssetKey);
    const nextAssetIds = [
      ...orderedImageIds,
      ...dataset.assetIds.filter((assetId) => !orderedImageIds.includes(assetId)),
    ];
    const nextAssetPaths = filterLegacyProjectAssetPaths([
      ...orderedAssetPaths,
      ...filterLegacyProjectAssetPaths(dataset.assetPaths ?? []).filter((assetPath) => !orderedAssetPaths.includes(assetPath)),
    ]);

    await updateDatasetFileBackedState(dataset, {
      assetIds: nextAssetIds,
      assetPaths: nextAssetPaths,
      psdAssetPaths: collectDatasetPsdPathsFromAssetPaths(nextAssetPaths),
      assetOrder: normalizeDatasetAssetOrder(orderedKeys, nextAssetIds, nextAssetPaths),
    });

    if (options.notify) {
      addNotification('success', 'Dataset order updated');
    }
  };

  const reorderDatasetBoardAsset = async (
    dataset: Dataset,
    items: WorkspaceImage[],
    sourceKey: string,
    targetKey: string
  ) => {
    if (sourceKey === targetKey) {
      return;
    }

    const sourceIndex = items.findIndex((item) => getDatasetBoardAssetKey(item) === sourceKey);
    const targetIndex = items.findIndex((item) => getDatasetBoardAssetKey(item) === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }

    const nextItems = [...items];
    const [movedItem] = nextItems.splice(sourceIndex, 1);
    nextItems.splice(targetIndex, 0, movedItem);

    await saveDatasetBoardOrder(dataset, nextItems);
  };

  const renderDatasetTool = (tab: DatasetToolWorkspaceTab) => {
    const dataset = datasetsById[tab.datasetId];
    if (!dataset) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Dataset is no longer available
        </div>
      );
    }

    const updateDataset = (updates: Partial<Pick<Dataset, 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'assetOrder' | 'overwriteCaptions' | 'captionOverrides'>>) => {
      const latestDataset = useProjectStore.getState().datasets[tab.datasetId];
      if (!latestDataset) {
        addNotification('warning', 'Dataset is no longer available');
        return;
      }
      return updateDatasetFileBackedState(latestDataset, updates);
    };
    switch (tab.stage) {
      case 'select':
        return (
          <FinalReviewStage
            datasetId={dataset.id}
            mode="select"
            active={activeTabId === tab.id}
            onUpdateDataset={updateDataset}
            onOpenAssetContextMenu={openAssetExplorerContextMenu}
          />
        );
      case 'review':
        return (
          <FinalReviewStage
            datasetId={dataset.id}
            mode="review"
            active={activeTabId === tab.id}
            onUpdateDataset={updateDataset}
            onOpenAssetContextMenu={(item, event) => openDatasetBoardAssetContextMenu(dataset, item, event)}
          />
        );
      case 'analysis':
        return (
          <AnalysisStage
            datasetId={dataset.id}
            active={activeTabId === tab.id}
            projectDirectoryHandle={projectDirectoryHandle}
            onUpdateDataset={updateDataset}
            onOpenAssetContextMenu={(item, event) => openDatasetBoardAssetContextMenu(dataset, item, event)}
          />
        );
      case 'tagging':
        return (
          <TaggingStageComponent
            datasetId={dataset.id}
            active={activeTabId === tab.id}
            onUpdateDataset={updateDataset}
            onOpenAssetContextMenu={(item, event) => openDatasetBoardAssetContextMenu(dataset, item, event)}
          />
        );
      default:
        return null;
    }
  };

  const openExplorerFile = async (node: ExplorerTreeNode) => {
    if (node.kind === 'dataset') {
      try {
        const dataset = await readDatasetEntry(node);
        openDatasetTab(dataset.id);
      } catch (error) {
        addNotification('error', error instanceof Error ? error.message : 'Failed to open Dataset');
      }
      return;
    }

    if (node.kind !== 'file') {
      return;
    }

    try {
      if (!projectDirectoryHandle) {
        addNotification('warning', 'Open a project directory before opening Explorer files.');
        return;
      }

      const file = await readExplorerFile(projectDirectoryHandle, node.path);
      if (!file) {
        addNotification('error', 'File is no longer available');
        return;
      }

      const fileKind = getExplorerFileKind(node.name, 'type' in file ? file.type : undefined);
      if (!canOpenExplorerFile(fileKind)) {
        addNotification('warning', 'No viewer is available for this file type');
        return;
      }

      const tab: FileWorkspaceTab = {
        id: createFileTabId(node.path),
        kind: 'file-view',
        path: node.path,
        name: node.name,
        fileKind,
        file,
        workspaceImageId: findWorkspaceImageIdForPath(node.path) ?? undefined,
      };

      setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
      setActiveTabId(tab.id);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to open file');
    }
  };

  const openFileModeTab = async (node: ExplorerTreeNode, mode: 'edit' | 'caption' | 'analysis') => {
    try {
      const imageId = findWorkspaceImageIdForPath(node.path);
      if (mode !== 'analysis' && !imageId) {
        addNotification('warning', `${mode === 'edit' ? 'Photopea' : 'Caption'} is available for project workspace images.`);
        return;
      }

      if (!projectDirectoryHandle) {
        addNotification('warning', 'Open a project directory before opening Explorer files.');
        return;
      }

      const file = await readExplorerFile(projectDirectoryHandle, node.path);
      if (!file) {
        addNotification('error', 'File is no longer available');
        return;
      }

      const tab: FileWorkspaceTab = {
        id: createFileModeTabId(mode, node.path),
        kind: mode === 'edit' ? 'file-edit' : mode === 'analysis' ? 'file-analysis' : 'file-caption',
        path: node.path,
        name: node.name,
        fileKind: getExplorerFileKind(node.name, 'type' in file ? file.type : undefined),
        file,
        workspaceImageId: imageId ?? undefined,
      };

      setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
      setActiveTabId(tab.id);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : `Failed to open ${mode === 'edit' ? 'Photopea' : mode === 'analysis' ? 'Analysis' : 'Caption'}`);
    }
  };

  const savePsdFileFromViewer = async (
    tab: FileWorkspaceTab,
    payload: { psd: ArrayBuffer; preview?: ArrayBuffer },
    saveCopy: boolean
  ) => {
    try {
      if (!projectDirectoryHandle) {
        addNotification('warning', 'Open a project directory before saving PSD files.');
        return;
      }

      const { directory, name } = await getExplorerParentDirectory(projectDirectoryHandle, tab.path);
      const targetName = saveCopy ? await getUniqueExplorerName(directory, `${name.replace(/\.psd$/i, '')} Copy.psd`) : name;
      const nextBlob = new Blob([payload.psd], { type: 'image/vnd.adobe.photoshop' });
      const handle = await directory.getFileHandle(targetName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(nextBlob);
      await writable.close();

      const nextPath = `${tab.path.split('/').slice(0, -1).join('/') || 'Project'}/${targetName}`;
      if (payload.preview) {
        await writeProjectPreview(projectDirectoryHandle, 'psd', nextPath, new Blob([payload.preview], { type: 'image/png' }));
        useUIStore.getState().refreshAssetPreviews();
      }
      const nextTab: FileWorkspaceTab = {
        ...tab,
        id: createFileTabId(nextPath),
        path: nextPath,
        name: targetName,
        file: new globalThis.File([nextBlob], targetName, { type: 'image/vnd.adobe.photoshop' }),
      };

      setOpenTabs((tabs) => {
        if (saveCopy) {
          return tabs.some((entry) => entry.id === nextTab.id) ? tabs : [...tabs, nextTab];
        }
        return tabs.map((entry) => (entry.id === tab.id ? { ...entry, file: nextTab.file } : entry));
      });
      if (saveCopy) {
        setActiveTabId(nextTab.id);
      }
      refreshExplorer();
      addNotification('success', saveCopy ? `Saved PSD copy "${targetName}"` : `Saved "${name}"`);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to save PSD file');
    }
  };

  const renderDatasetWorkspace = (tab: DatasetWorkspaceTab) => {
    const dataset = datasetsById[tab.datasetId];
    if (!dataset) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Dataset is no longer available
        </div>
      );
    }
    const datasetNode = dataset.filePath ? findExplorerNodeByPath(dataset.filePath) : null;
    const datasetToolbarActionIds = new Set(['select', 'review', 'caption', 'analysis', 'export']);
    const datasetToolbarActions = datasetNode
      ? getDatasetContextActionGroups(datasetNode)
          .map((group) =>
            group
              .filter((action) => datasetToolbarActionIds.has(action.id))
              .map((action) => (action.id === 'export' ? { ...action, variant: 'primary' as const } : action))
          )
          .filter((group) => group.length > 0)
      : [];
    const datasetBoardItems = sortDatasetBoardItems(activeDatasetPreviewItems, dataset, datasetBoardSortMode);
    const canReorderDatasetBoard = datasetBoardSortMode === 'manual';

    return (
      <div
        className="h-full min-h-0 overflow-auto p-6"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(DATASET_BOARD_DRAG_TYPE) || event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE)) {
            return;
          }
          if (
            draggedExplorerEntriesRef.current?.length ||
            draggedExplorerEntries?.length ||
            event.dataTransfer.types.includes('text/plain') ||
            event.dataTransfer.types.includes('Files')
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes(DATASET_BOARD_DRAG_TYPE) || event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE)) {
            return;
          }
          if (
            draggedExplorerEntriesRef.current?.length ||
            draggedExplorerEntries?.length ||
            event.dataTransfer.types.includes('text/plain') ||
            event.dataTransfer.types.includes('Files')
          ) {
            setDatasetDropActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDatasetDropActive(false);
          }
        }}
        onDrop={(event) => {
          setDatasetDropActive(false);
          if (event.dataTransfer.types.includes(DATASET_BOARD_DRAG_TYPE) || event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE)) {
            return;
          }
          const transferPath = event.dataTransfer.getData('text/plain');
          const droppedEntries =
            draggedExplorerEntriesRef.current ??
            draggedExplorerEntries ??
            (transferPath ? getExplorerEntriesFromTransferPath(transferPath) : null);
          const hasFiles = event.dataTransfer.types.includes('Files');
          if (!droppedEntries?.length && !hasFiles) {
            return;
          }
          event.preventDefault();
          const dataTransfer = event.dataTransfer;
          setCurrentDraggedExplorerEntries(null);
          void (async () => {
            let assetIds = droppedEntries?.length
              ? collectDatasetAssetIdsFromExplorerEntries(droppedEntries)
              : [];
            let assetPaths = droppedEntries?.length
              ? collectDatasetAssetPathsFromExplorerEntries(droppedEntries)
              : [];
            if (droppedEntries?.length && assetIds.length === 0 && assetPaths.length === 0) {
              await indexProjectAssetsForDatasetDrop();
              assetIds = collectDatasetAssetIdsFromExplorerEntries(droppedEntries);
              assetPaths = collectDatasetAssetPathsFromExplorerEntries(droppedEntries);
            }
            if (hasFiles) {
              const imported = await importDroppedFilesIntoDataset(dataTransfer, dataset);
              assetIds = [...assetIds, ...imported.assetIds];
              assetPaths = [...assetPaths, ...imported.assetPaths];
            }
            if (assetIds.length > 0 || assetPaths.length > 0) {
              const currentDataset = useProjectStore.getState().datasets[dataset.id] ?? dataset;
              const nextAssetIds = [...new Set([...currentDataset.assetIds, ...assetIds])];
              const nextAssetPaths = filterLegacyProjectAssetPaths([...new Set([...(currentDataset.assetPaths ?? []), ...assetPaths])]);
              const nextPsdAssetPaths = collectDatasetPsdPathsFromAssetPaths(nextAssetPaths);
              const addedCount =
                nextAssetIds.length -
                currentDataset.assetIds.length +
                nextAssetPaths.length -
                (currentDataset.assetPaths ?? []).length;
              if (addedCount > 0) {
                const nextAssetOrder = normalizeDatasetAssetOrder(
                  [
                    ...(currentDataset.assetOrder ?? []),
                    ...assetIds.map(createDatasetImageAssetKey),
                    ...assetPaths.map(createDatasetFileAssetKey),
                  ],
                  nextAssetIds,
                  nextAssetPaths
                );
                await updateDatasetFileBackedState(currentDataset, {
                  assetIds: nextAssetIds,
                  assetPaths: nextAssetPaths,
                  psdAssetPaths: nextPsdAssetPaths,
                  assetOrder: nextAssetOrder,
                });
                addNotification('success', `Added ${addedCount} asset${addedCount !== 1 ? 's' : ''} to ${dataset.name}`);
              } else {
                addNotification('info', 'Selected assets are already in this Dataset');
              }
            } else {
              addNotification('warning', 'No supported project assets found to add');
            }
          })();
        }}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Dataset object</p>
              <h2 className="mt-1 truncate text-xl font-semibold">{dataset.name}</h2>
              <p className="mt-1 truncate text-sm text-muted-foreground">{dataset.filePath ?? 'Unsaved Dataset'}</p>
            </div>
            {datasetToolbarActions.length > 0 ? (
              <ContextActionGroups groups={datasetToolbarActions} mode="toolbar" />
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">Assets</p>
              <p className="mt-1 text-2xl font-semibold">{activeDatasetSummary?.assets ?? 0}</p>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">Supported</p>
              <p className="mt-1 text-2xl font-semibold">{activeDatasetSummary?.supported ?? 0}</p>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">Captioned</p>
              <p className="mt-1 text-2xl font-semibold">
                {activeDatasetSummary?.captioned ?? 0}/{activeDatasetSummary?.captionable ?? 0}
              </p>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <label className="text-xs text-muted-foreground" htmlFor={`dataset-trigger-${dataset.id}`}>
                Trigger
              </label>
              <input
                id={`dataset-trigger-${dataset.id}`}
                value={dataset.triggerWord}
                onChange={(event) => void updateDatasetFileBackedState(dataset, { triggerWord: event.target.value })}
                placeholder="Missing"
                className="mt-1 h-8 w-full min-w-0 rounded border border-border bg-background px-2 font-mono text-sm font-semibold text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div
            className={`flex min-h-24 items-center justify-between gap-4 rounded border border-dashed px-4 py-4 transition-colors ${
              datasetDropActive ? 'border-primary bg-primary/10' : 'border-border bg-card'
            }`}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">Dataset intake</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {datasetDropActive ? 'Release to link assets' : `${activeDatasetPreviewItems.length} assets linked`}
              </p>
            </div>
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded ${datasetDropActive ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
              <Plus className="h-4 w-4" />
            </div>
          </div>

          {activeDatasetPreviewItems.length > 0 ? (
            <div className="min-h-40 rounded border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Dataset contents</p>
                  <p className="text-xs text-muted-foreground">
                    {canReorderDatasetBoard ? `${activeDatasetPreviewItems.length} assets · manual order` : `${activeDatasetPreviewItems.length} assets · sorted preview`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-secondary px-2 py-1 text-xs text-muted-foreground">
                    {datasetBoardSortMode === 'manual' ? 'Manual' : 'Preview'}
                  </span>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Sort
                    <select
                      value={datasetBoardSortMode}
                      onChange={(event) => setDatasetBoardSortMode(event.target.value as DatasetBoardSortMode)}
                      className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                    >
                      {DATASET_BOARD_SORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              <BrickMasonry
                items={datasetBoardItems}
                getKey={(item) => item.id}
                getEstimate={(item) => item.height / Math.max(1, item.width)}
                className="p-3"
                renderItem={(item) => (
                  <div
                    draggable={canReorderDatasetBoard}
                    onDragStart={(event) => {
                      if (!canReorderDatasetBoard) {
                        return;
                      }
                      const key = getDatasetBoardAssetKey(item);
                      setDraggedDatasetAssetId(key);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData(DATASET_BOARD_DRAG_TYPE, key);
                      event.dataTransfer.setData('text/plain', key);
                    }}
                    onDragOver={(event) => {
                      if (!canReorderDatasetBoard || !draggedDatasetAssetId) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDatasetDropTargetAssetId(getDatasetBoardAssetKey(item));
                    }}
                    onDrop={(event) => {
                      if (!canReorderDatasetBoard) {
                        return;
                      }
                      event.preventDefault();
                      const sourceKey =
                        draggedDatasetAssetId ||
                        event.dataTransfer.getData(DATASET_BOARD_DRAG_TYPE) ||
                        event.dataTransfer.getData('text/plain');
                      setDraggedDatasetAssetId(null);
                      setDatasetDropTargetAssetId(null);
                      void reorderDatasetBoardAsset(dataset, datasetBoardItems, sourceKey, getDatasetBoardAssetKey(item));
                    }}
                    onDragEnd={() => {
                      setDraggedDatasetAssetId(null);
                      setDatasetDropTargetAssetId(null);
                    }}
                  >
                    <WorkspacePreviewCard
                      item={item}
                      previewUrl={activeDatasetPreviewUrls[item.id]}
                      className={`gallery-masonry-item ${
                        draggedDatasetAssetId === getDatasetBoardAssetKey(item)
                          ? 'opacity-50'
                          : datasetDropTargetAssetId === getDatasetBoardAssetKey(item)
                            ? 'ring-2 ring-primary'
                            : ''
                      }`}
                      onOpenContextMenu={(_item, event) => openDatasetBoardAssetContextMenu(dataset, item, event)}
                      footer={
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
                          <div className="flex items-end justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-white">{item.fileName}</p>
                              <p className="text-xs text-gray-300">
                                {item.label} · {item.width} x {item.height}
                              </p>
                            </div>
                          </div>
                        </div>
                      }
                    />
                  </div>
                )}
              />
            </div>
          ) : (
            <div className="rounded border border-border bg-card px-4 py-8 text-center">
              <p className="text-sm font-medium">Empty Dataset</p>
              <p className="mt-1 text-sm text-muted-foreground">0 assets linked</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  const getInspectorActionGroups = (): ContextActionGroup[] => {
    if (activeTab && isFileBackedTab(activeTab)) {
      const node = findExplorerNodeByPath(activeTab.path);
      if (!node) {
        return [];
      }
      const primaryActionIds =
        activeTab.kind === 'file-view'
          ? new Set(['photopea', 'caption'])
          : new Set(['open', 'photopea', 'caption']);
      return getFileContextActionGroups(node)
        .map((group) => group.filter((action) => primaryActionIds.has(action.id)))
        .filter((group) => group.length > 0);
    }

    if ((activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool') && activeDataset?.filePath) {
      const node = findExplorerNodeByPath(activeDataset.filePath);
      if (!node) {
        return [];
      }
      const primaryActionIds =
        activeTab.kind === 'dataset'
          ? new Set(['select', 'review', 'caption', 'analysis', 'export'])
          : new Set(['open', 'select', 'review', 'caption', 'analysis', 'export']);
      return getDatasetContextActionGroups(node)
        .map((group) => group.filter((action) => primaryActionIds.has(action.id)))
        .filter((group) => group.length > 0);
    }

    return [];
  };

  const renderInspectorContent = () => {
    const activeDatasetBoardItems =
      activeDataset && activeDatasetPreviewItems.length > 0
        ? sortDatasetBoardItems(activeDatasetPreviewItems, activeDataset, datasetBoardSortMode)
        : [];
    const Icon =
      activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
        ? Layers3
        : activeTab && isFileBackedTab(activeTab)
          ? activeTab.fileKind === 'video'
            ? Video
            : activeTab.fileKind === 'json'
              ? FileJson
              : File
          : activeStage
            ? activeStage === 'hub'
              ? Archive
              : toolIcons[activeStage]
            : PanelRight;
    const title =
      activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
        ? activeDataset?.name ?? 'Dataset'
        : activeTab && isFileBackedTab(activeTab)
          ? activeTab.name
          : activeStage
            ? TOOL_LABELS[activeStage]
            : 'Workspace';
    const canRename = activeTab?.kind === 'dataset' || (activeTab && isFileBackedTab(activeTab));
    const inspectorActionGroups = getInspectorActionGroups();
    const objectDetails = (() => {
      if (!activeTab) {
        return [
          { label: 'Object', value: 'Workspace' },
          { label: 'Target', value: 'Workspace' },
          { label: 'State', value: 'No active editor' },
        ];
      }

      if (isFileBackedTab(activeTab)) {
        const fileType =
          activeTab.fileKind === 'psd'
            ? 'PSD file'
            : activeTab.fileKind === 'video'
              ? 'Video file'
              : activeTab.fileKind === 'json'
                ? 'JSON file'
                : activeTab.fileKind === 'image'
                  ? 'Image file'
                  : 'File';
        const mode =
          activeTab.kind === 'file-edit'
            ? 'Photopea'
            : activeTab.kind === 'file-caption'
              ? 'Caption'
              : 'Open file';

        return [
          { label: 'Object', value: fileType },
          { label: 'Mode', value: mode },
          { label: 'Target', value: 'File' },
          { label: 'Path', value: activeTab.path },
        ];
      }

      if (activeTab.kind === 'dataset' || activeTab.kind === 'dataset-tool') {
        return [
          { label: 'Object', value: 'Dataset' },
          {
            label: 'Mode',
            value: activeTab.kind === 'dataset-tool' ? DATASET_TOOL_LABELS[activeTab.stage] : 'Dataset view',
          },
          { label: 'Target', value: 'Dataset contents' },
          { label: 'Path', value: activeDataset?.filePath ?? 'Dataset' },
        ];
      }

      return [
        { label: 'Object', value: TOOL_LABELS[activeTab.stage] },
        { label: 'Mode', value: activeTab.nested ? 'Nested item' : 'Project tool' },
        { label: 'Target', value: 'Project' },
      ];
    })();

    return (
      <div className="text-xs">
        <div className="mb-3 flex items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            {inspectorRenaming && canRename ? (
              <input
                value={inspectorRenameValue}
                autoFocus
                onFocus={(event) => selectFileNameStem(event.currentTarget)}
                onChange={(event) => setInspectorRenameValue(event.target.value)}
                onBlur={() => void commitInspectorRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitInspectorRename();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setInspectorRenaming(false);
                  }
                }}
                className="w-full rounded border border-primary bg-background px-2 py-1 text-sm font-semibold"
              />
            ) : (
              <button
                type="button"
                disabled={!canRename}
                onDoubleClick={() => canRename && setInspectorRenaming(true)}
                className="block w-full truncate text-left text-sm font-semibold disabled:cursor-default"
                title={canRename ? 'Double-click to rename' : undefined}
              >
                {title}
              </button>
            )}
            <p className="mt-1 truncate text-muted-foreground">
              {activeTab && isFileBackedTab(activeTab)
                ? activeTab.path
                : activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
                  ? activeDataset?.filePath ?? 'Dataset'
                  : activeStage
                    ? TOOL_DESCRIPTIONS[activeStage]
                    : 'Open a file, Dataset, or tool'}
            </p>
          </div>
        </div>

        <InspectorSection
          title="Object"
          open={inspectorSectionsOpen.object}
          onOpenChange={(open) => setInspectorSectionOpen('object', open)}
        >
          <div className="space-y-2">
            {objectDetails.map((detail) => (
              <div key={detail.label} className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">{detail.label}</span>
                <span className="min-w-0 truncate text-right font-medium" title={detail.value}>
                  {detail.value}
                </span>
              </div>
            ))}
          </div>
        </InspectorSection>

        {!activeTab ? (
          <InspectorSection
            title="Actions"
            open={inspectorSectionsOpen.actions}
            onOpenChange={(open) => setInspectorSectionOpen('actions', open)}
          >
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setTabMenuOpen(true)}
                className="flex items-center gap-2 rounded border border-border px-2 py-2 text-left hover:bg-secondary"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Open tool</span>
              </button>
              <button
                type="button"
                onClick={() => void handleOpenProject()}
                disabled={isProjectDirectoryBusy}
                className="flex items-center gap-2 rounded border border-border px-2 py-2 text-left hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <span>Open project</span>
              </button>
            </div>
          </InspectorSection>
        ) : null}

        {inspectorActionGroups.length > 0 ? (
          <InspectorSection
            title="Actions"
            open={inspectorSectionsOpen.actions}
            onOpenChange={(open) => setInspectorSectionOpen('actions', open)}
          >
            <ContextActionGroups groups={inspectorActionGroups} mode="inspector" />
          </InspectorSection>
        ) : null}

        {showFileInspector && fileInspectorMetadata && activeTab && isFileBackedTab(activeTab) ? (
          <InspectorSection
            title="File"
            open={inspectorSectionsOpen.file}
            onOpenChange={(open) => setInspectorSectionOpen('file', open)}
          >
            <div className="space-y-2">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Filename</span>
                <span className="min-w-0 truncate font-medium">{activeTab.name}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Format</span>
                <span className="font-medium">{fileInspectorMetadata.format}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Workspace asset</span>
                <span className="font-medium">{activeTab.workspaceImageId ? 'Linked' : 'External'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Size</span>
                <span className="font-medium">{fileInspectorMetadata.size}</span>
              </div>
              {fileInspectorMetadata.dimensions ? (
                <>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Dimensions</span>
                    <span className="font-medium">
                      {fileInspectorMetadata.dimensions.width} x {fileInspectorMetadata.dimensions.height}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Aspect ratio</span>
                    <span className="font-medium">
                      {getAspectRatioLabel(fileInspectorMetadata.dimensions.width, fileInspectorMetadata.dimensions.height)}
                    </span>
                  </div>
                </>
              ) : null}
              {fileInspectorMetadata.captionEntries.length > 0 ? (
                <div className="border-t border-border pt-2.5">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Caption</span>
                    <span className="text-[10px] text-muted-foreground">
                      {fileInspectorMetadata.captionEntries.reduce((count, entry) => count + entry.tags.length, 0)} tags
                    </span>
                  </div>
                  <div className="space-y-2">
                    {fileInspectorMetadata.captionEntries.map((entry) => (
                      <div key={entry.label} className="space-y-1">
                        {fileInspectorMetadata.captionEntries.length > 1 ? (
                          <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                            {entry.label}
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-1.5">
                          {entry.tags.map((tag, index) => (
                            <span
                              key={`${entry.label}-${tag}-${index}`}
                              className="max-w-full truncate rounded-sm border border-border bg-secondary/70 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-foreground"
                              title={tag}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </InspectorSection>
        ) : null}

        {showDatasetInspector && activeDataset ? (
          <InspectorSection
            title="Dataset"
            open={inspectorSectionsOpen.dataset}
            onOpenChange={(open) => setInspectorSectionOpen('dataset', open)}
          >
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-background p-2">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Context</span>
                  <span className="font-medium">
                    {activeTab?.kind === 'dataset-tool' ? `${DATASET_TOOL_LABELS[activeTab.stage]} applied` : 'Dataset object'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded bg-secondary/60 px-2 py-1.5">
                    <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Assets</p>
                    <p className="mt-1 text-sm font-semibold">{activeDatasetSummary?.assets ?? 0}</p>
                  </div>
                  <div className="rounded bg-secondary/60 px-2 py-1.5">
                    <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Supported</p>
                    <p className="mt-1 text-sm font-semibold">{activeDatasetSummary?.supported ?? 0}</p>
                  </div>
                </div>
                {activeDatasetSummary && activeDatasetSummary.sourceRefs > activeDatasetSummary.availableSourceRefs ? (
                  <p className="mt-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-yellow-700">
                    {activeDatasetSummary.sourceRefs - activeDatasetSummary.availableSourceRefs} source reference
                    {activeDatasetSummary.sourceRefs - activeDatasetSummary.availableSourceRefs !== 1 ? 's' : ''} not loaded in workspace.
                  </p>
                ) : null}
              </div>
              <div>
                <label className="mb-1 block text-muted-foreground">Trigger Word</label>
                <input
                  value={activeDataset.triggerWord}
                  onChange={(event) => void updateDatasetFileBackedState(activeDataset, { triggerWord: event.target.value })}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-sm"
                />
              </div>
              <label className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={Boolean(activeDataset.overwriteCaptions)}
                  onChange={(event) =>
                    void updateDatasetFileBackedState(activeDataset, { overwriteCaptions: event.target.checked })
                  }
                  className="h-4 w-4"
                />
                <span>Overwrite captions</span>
              </label>
              {activeTab?.kind === 'dataset' ? (
                <div className="rounded-md border border-border bg-background p-2">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Board</span>
                    <span className="font-medium">
                      {datasetBoardSortMode === 'manual' ? 'Manual order' : 'Sorted preview'}
                    </span>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-muted-foreground">Sort</span>
                    <select
                      value={datasetBoardSortMode}
                      onChange={(event) => setDatasetBoardSortMode(event.target.value as DatasetBoardSortMode)}
                      className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                    >
                      {DATASET_BOARD_SORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={datasetBoardSortMode === 'manual' || activeDatasetBoardItems.length === 0}
                    onClick={() => {
                      void saveDatasetBoardOrder(activeDataset, activeDatasetBoardItems, { notify: true });
                      setDatasetBoardSortMode('manual');
                    }}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded border border-border px-2 py-2 font-medium hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Grip className="h-3.5 w-3.5" />
                    Apply as manual order
                  </button>
                </div>
              ) : null}
            </div>
          </InspectorSection>
        ) : null}

        {showPhotopeaInspector ? (
          <InspectorSection
            title="Photopea"
            open={inspectorSectionsOpen.photopea}
            onOpenChange={(open) => setInspectorSectionOpen('photopea', open)}
          >
            <div className="grid gap-2">
              <a href="https://www.photopea.com" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded border border-border px-2 py-2 text-left hover:bg-secondary">
                <ExternalLink className="h-3.5 w-3.5" />
                Photopea
              </a>
              {activeTab?.kind === 'file-edit' ? (
                <>
                  <button type="button" onClick={() => runEditCommand('save')} disabled={!editToolbar.canSave || editToolbar.isProcessing} className="rounded bg-primary px-2 py-2 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    Save
                  </button>
                  <button type="button" onClick={() => runEditCommand('saveCopy')} disabled={!editToolbar.canSave || editToolbar.isProcessing} className="rounded border border-border px-2 py-2 text-left hover:bg-secondary disabled:opacity-50">
                    Save Copy
                  </button>
                  <button type="button" onClick={() => runEditCommand('cancel')} disabled={editToolbar.isProcessing} className="rounded border border-border px-2 py-2 text-left hover:bg-secondary disabled:opacity-50">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => runPsdCommand('save')}
                    className="rounded bg-primary px-2 py-2 font-medium text-primary-foreground hover:opacity-90"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => runPsdCommand('saveCopy')}
                    className="rounded border border-border px-2 py-2 text-left hover:bg-secondary"
                  >
                    Save Copy
                  </button>
                </>
              )}
            </div>
          </InspectorSection>
        ) : null}

        {showReviewInspector ? (
          <InspectorSection
            title="Review"
            open={inspectorSectionsOpen.review}
            onOpenChange={(open) => setInspectorSectionOpen('review', open)}
          >
            <div id="review-inspector-root" />
          </InspectorSection>
        ) : null}

        {showAnalysisInspector ? (
          <InspectorSection
            title="Analysis"
            open={inspectorSectionsOpen.analysis}
            onOpenChange={(open) => setInspectorSectionOpen('analysis', open)}
          >
            <div id="analysis-inspector-root" />
          </InspectorSection>
        ) : null}

        {showCaptionInspector ? (
          <InspectorSection
            title="Caption"
            open={inspectorSectionsOpen.caption}
            onOpenChange={(open) => setInspectorSectionOpen('caption', open)}
          >
            {activeTab?.kind !== 'file-caption' && fileInspectorMetadata?.tags?.length ? (
              <div>
                <p className="mb-1 text-muted-foreground">Tags</p>
                <div className="flex flex-wrap gap-1">
                  {fileInspectorMetadata.tags.map((tag) => (
                    <span key={tag} className="rounded bg-secondary px-2 py-1">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <div id="caption-inspector-root" />
          </InspectorSection>
        ) : null}

      </div>
    );
  };

  const requireProjectDirectory = (): ProjectDirectoryHandle | null => {
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Save or open a project directory before changing Explorer files.');
      return null;
    }
    return projectDirectoryHandle;
  };

  const refreshExplorer = () => setExplorerRefreshKey((key) => key + 1);

  const getFileTabIdForPath = (tab: FileWorkspaceTab, path: string): string => {
    const mode = tab.kind === 'file-edit' ? 'edit' : tab.kind === 'file-caption' ? 'caption' : null;
    return mode ? createFileModeTabId(mode, path) : createFileTabId(path);
  };

  const updateFileTabsForPathMoves = (moves: Array<{ from: string; to: string }>) => {
    const activeFileTab = activeTab && isFileBackedTab(activeTab) ? activeTab : null;
    setOpenTabs((tabs) =>
      tabs.map((tab) => {
        if (!isFileBackedTab(tab)) {
          return tab;
        }

        for (const move of moves) {
          if (tab.path === move.from || tab.path.startsWith(`${move.from}/`)) {
            const nextPath = tab.path === move.from ? move.to : `${move.to}/${tab.path.slice(move.from.length + 1)}`;
            return {
              ...tab,
              id: getFileTabIdForPath(tab, nextPath),
              path: nextPath,
              name: tab.path === move.from ? move.to.split('/').pop() ?? tab.name : tab.name,
            };
          }
        }

        return tab;
      })
    );
    if (activeFileTab) {
      const nextPath = applyExplorerPathMoves(activeFileTab.path, moves);
      if (nextPath !== activeFileTab.path) {
        setActiveTabId(getFileTabIdForPath(activeFileTab, nextPath));
      }
    }
  };

  const updateExplorerClipboardForPathMoves = (moves: Array<{ from: string; to: string }>) => {
    setExplorerClipboard((clipboard) => {
      if (!clipboard) {
        return clipboard;
      }
      return {
        ...clipboard,
        entries: clipboard.entries.map((entry) => {
          const nextPath = applyExplorerPathMoves(entry.path, moves);
          return {
            ...entry,
            path: nextPath,
            name: nextPath.split('/').pop() ?? entry.name,
          };
        }),
      };
    });
  };

  const clearExplorerClipboardForDeletedPaths = (entries: ExplorerItemEntry[]) => {
    setExplorerClipboard((clipboard) => {
      if (
        !clipboard ||
        !clipboard.entries.some((clipboardEntry) =>
          entries.some((entry) => clipboardEntry.path === entry.path || clipboardEntry.path.startsWith(`${entry.path}/`))
        )
      ) {
        return clipboard;
      }
      return null;
    });
  };

  const applyProjectRelativePathMoves = (
    path: string | undefined,
    moves: ExplorerPathMove[]
  ): string | undefined => {
    if (!path) {
      return path;
    }
    const explorerPath = `Project/${path}`;
    for (const move of moves) {
      if (explorerPath === move.from || explorerPath.startsWith(`${move.from}/`)) {
        const nextPath = explorerPath === move.from ? move.to : `${move.to}/${explorerPath.slice(move.from.length + 1)}`;
        return toProjectRelativePath(nextPath);
      }
    }
    return path;
  };

  const updateWorkspacePathsForPathMoves = async (moves: ExplorerPathMove[]) => {
    for (const source of Object.values(sourceImagesById)) {
      const originalFilePath = applyProjectRelativePathMoves(source.originalFilePath, moves);
      const manifestPath = applyProjectRelativePathMoves(source.manifestPath, moves);
      if (originalFilePath !== source.originalFilePath || manifestPath !== source.manifestPath) {
        const fileNameChanged = originalFilePath && originalFilePath !== source.originalFilePath;
        const fileName = fileNameChanged ? originalFilePath.split('/').pop() ?? source.fileName : source.fileName;
        updateSourceImage(source.id, {
          originalFilePath,
          manifestPath,
          fileName,
          originalFileName: fileNameChanged ? fileName : source.originalFileName,
        });
      }
    }

    for (const item of Object.values(datasetItemsById)) {
      const imageDataPath = applyProjectRelativePathMoves(item.imageDataPath, moves);
      const psdDataPath = applyProjectRelativePathMoves(item.psdDataPath, moves);
      const manifestPath = applyProjectRelativePathMoves(item.manifestPath, moves);
      if (
        imageDataPath !== item.imageDataPath ||
        psdDataPath !== item.psdDataPath ||
        manifestPath !== item.manifestPath
      ) {
        updateDatasetItem(item.id, { imageDataPath, psdDataPath, manifestPath });
      }
    }

    for (const dataset of Object.values(datasetsById)) {
      const parentPath = applyExplorerPathMoves(dataset.parentPath || 'Project', moves);
      const filePath = dataset.filePath ? applyExplorerPathMoves(dataset.filePath, moves) : dataset.filePath;
      const assetPaths = filterLegacyProjectAssetPaths(dataset.assetPaths ?? []).map((path) =>
        applyExplorerPathMoves(path, moves)
      );
      const psdAssetPaths = filterLegacyProjectAssetPaths(dataset.psdAssetPaths ?? []).map((path) =>
        applyExplorerPathMoves(path, moves)
      );
      const assetOrder = applyFileAssetOrderPathMoves(dataset.assetOrder, moves);
      const captionOverrides = applyCaptionOverridePathMoves(dataset.captionOverrides, moves);
      const nextDataset = {
        ...dataset,
        parentPath,
        filePath,
        assetPaths,
        psdAssetPaths,
        assetOrder: normalizeDatasetAssetOrder(assetOrder, dataset.assetIds, assetPaths),
        captionOverrides,
        updatedAt: new Date(),
      };
      if (
        parentPath !== (dataset.parentPath || 'Project') ||
        filePath !== dataset.filePath ||
        assetPaths.some((path, index) => path !== (dataset.assetPaths ?? [])[index]) ||
        psdAssetPaths.some((path, index) => path !== (dataset.psdAssetPaths ?? [])[index]) ||
        nextDataset.assetOrder.some((key, index) => key !== (dataset.assetOrder ?? [])[index]) ||
        Object.keys(captionOverrides).some((key) => captionOverrides[key] !== dataset.captionOverrides[key])
      ) {
        updateProjectDataset(dataset.id, nextDataset);
        if (projectDirectoryHandle && nextDataset.filePath) {
          await writeDatasetFile(projectDirectoryHandle, nextDataset);
        }
      }
    }
  };

  const renameExplorerItem = async (
    path: string,
    kind: ExplorerTreeNode['kind'],
    requestedName: string
  ): Promise<string | null> => {
    const directory = requireProjectDirectory();
    const trimmedName = requestedName.trim();
    if (!directory || !trimmedName || path === 'Project') {
      return null;
    }

    const previousProject = useProjectStore.getState();
    const nextFileName = kind === 'dataset' ? getDatasetFileName(trimmedName) : trimmedName;
    const entryKind = kind === 'folder' ? 'folder' : 'file';
    const nextPath = await renameExplorerEntry(directory, path, entryKind, nextFileName);
    const moves = [{ from: path, to: nextPath }];

    updateFileTabsForPathMoves(moves);
    await updateWorkspacePathsForPathMoves(moves);
    updateExplorerClipboardForPathMoves(moves);

    if (kind === 'dataset') {
      const dataset = await readDatasetFile(directory, nextPath);
      const updatedDataset = {
        ...dataset,
        name: getDatasetDisplayName(nextPath.split('/').pop() ?? trimmedName),
        parentPath: nextPath.split('/').slice(0, -1).join('/') || 'Project',
        filePath: nextPath,
        updatedAt: new Date(),
      };
      await writeDatasetFile(directory, updatedDataset);
      upsertProjectDataset(updatedDataset);
      refreshOpenDatasetTabs(updatedDataset.id);
    }

    await writeProjectDirectoryChanges(useProjectStore.getState(), previousProject, directory);
    refreshExplorer();
    return nextPath;
  };

  const removeWorkspaceReferencesForDeletedEntries = async (entries: ExplorerClipboardEntry[]) => {
    const deletedPaths = entries.map((entry) => toProjectRelativePath(entry.path));
    const datasetsBeforeSourceRemoval = useProjectStore.getState().datasets;
    const sourceAffectedDatasetIds = new Set<string>();
    const removedSourceIds: string[] = [];
    for (const source of Object.values(useProjectStore.getState().sourceImages)) {
      const sourcePath = source.originalFilePath;
      if (
        sourcePath &&
        deletedPaths.some((deletedPath) => sourcePath === deletedPath || sourcePath.startsWith(`${deletedPath}/`))
      ) {
        Object.values(datasetsBeforeSourceRemoval).forEach((dataset) => {
          if (dataset.assetIds.includes(source.id)) {
            sourceAffectedDatasetIds.add(dataset.id);
          }
        });
        removeSourceImage(source.id);
        removedSourceIds.push(source.id);
      }
    }
    for (const dataset of Object.values(useProjectStore.getState().datasets)) {
      const parentPath = dataset.parentPath || 'Project';
      if (deletedPaths.some((deletedPath) => parentPath === `Project/${deletedPath}` || parentPath.startsWith(`Project/${deletedPath}/`))) {
        removeProjectDataset(dataset.id);
        continue;
      }

      const deletedExplorerPaths = entries.map((entry) => entry.path);
      const isDeletedPath = (path: string) =>
        deletedExplorerPaths.some((deletedPath) => path === deletedPath || path.startsWith(`${deletedPath}/`));
      const assetIds = dataset.assetIds.filter((assetId) => !removedSourceIds.includes(assetId));
      const assetPaths = filterLegacyProjectAssetPaths(dataset.assetPaths ?? []).filter((path) => !isDeletedPath(path));
      const psdAssetPaths = filterLegacyProjectAssetPaths(dataset.psdAssetPaths ?? []).filter((path) => !isDeletedPath(path));
      const captionOverrides = Object.fromEntries(
        Object.entries(dataset.captionOverrides ?? {}).filter(([key]) => {
          if (!key.startsWith('asset:')) {
            return true;
          }
          return !isDeletedPath(key.slice('asset:'.length));
        })
      );
      const assetOrder = normalizeDatasetAssetOrder(
        (dataset.assetOrder ?? []).filter((key) => !key.startsWith('file:') || !isDeletedPath(key.slice('file:'.length))),
        assetIds,
        assetPaths
      );

      if (
        sourceAffectedDatasetIds.has(dataset.id) ||
        assetIds.length !== dataset.assetIds.length ||
        assetPaths.length !== (dataset.assetPaths ?? []).length ||
        psdAssetPaths.length !== (dataset.psdAssetPaths ?? []).length ||
        assetOrder.length !== (dataset.assetOrder ?? []).length ||
        Object.keys(captionOverrides).length !== Object.keys(dataset.captionOverrides ?? {}).length
      ) {
        const nextDataset = {
          ...dataset,
          assetIds,
          assetPaths,
          psdAssetPaths,
          assetOrder,
          captionOverrides,
          updatedAt: new Date(),
        };
        updateProjectDataset(dataset.id, nextDataset);
        if (projectDirectoryHandle && nextDataset.filePath) {
          await writeDatasetFile(projectDirectoryHandle, nextDataset);
        }
      }
    }
  };

  const handleExplorerDelete = async (node: ExplorerTreeNode) => {
    if (node.path === 'Project') {
      return;
    }
    const entries = getContextEntries(node);
    if (entries.length === 0) {
      return;
    }
    const activeFileTabDeleted =
      activeTab &&
      isFileBackedTab(activeTab) &&
      entries.filter(isFilesystemExplorerEntry).some((entry) => activeTab.path === entry.path || activeTab.path.startsWith(`${entry.path}/`));

    if (!window.confirm(`Delete ${entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`}? This cannot be undone.`)) {
      return;
    }

    try {
      const filesystemEntries = entries.filter(isFilesystemExplorerEntry);
      const datasetEntries = entries.filter((entry) => entry.kind === 'dataset');
      const directory = filesystemEntries.length > 0 || datasetEntries.length > 0 ? requireProjectDirectory() : null;
      if ((filesystemEntries.length > 0 || datasetEntries.length > 0) && !directory) {
        return;
      }
      for (const entry of filesystemEntries) {
        await deleteExplorerEntry(directory!, entry.path, true);
      }
      const deletedDatasetIds: string[] = [];
      for (const entry of datasetEntries) {
        const dataset = await readDatasetFile(directory!, entry.path).catch(() => null);
        await deleteExplorerEntry(directory!, entry.path, false);
        if (dataset) {
          removeProjectDataset(dataset.id);
          deletedDatasetIds.push(dataset.id);
        }
      }
      await removeWorkspaceReferencesForDeletedEntries(filesystemEntries);
      setOpenTabs((tabs) =>
        tabs.filter(
          (tab) =>
            (isFileBackedTab(tab) &&
              !filesystemEntries.some((entry) => tab.path === entry.path || tab.path.startsWith(`${entry.path}/`))) ||
            (tab.kind === 'dataset' &&
              !deletedDatasetIds.includes(tab.datasetId)) ||
            (tab.kind === 'dataset-tool' &&
              !deletedDatasetIds.includes(tab.datasetId)) ||
            tab.kind === 'tool'
        )
      );
      if (activeFileTabDeleted) {
        setActiveTabId(null);
      }
      clearExplorerClipboardForDeletedPaths(entries);
      setSelectedExplorerPaths(new Set());
      setFocusedExplorerPath(null);
      refreshExplorer();
      addNotification('success', 'Explorer entry deleted');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to delete entry');
    }
  };

  const handleExplorerRename = async (node: ExplorerTreeNode) => {
    if (node.path === 'Project') {
      return;
    }
    setInlineExplorerEdit({
      mode: 'rename',
      parentPath: node.path.split('/').slice(0, -1).join('/') || 'Project',
      path: node.path,
      kind: node.kind,
      value: node.name,
    });
  };

  const handleExplorerNewFolder = async (node: ExplorerTreeNode) => {
    if (node.kind !== 'folder') {
      return;
    }
    setInlineExplorerEdit({ mode: 'create', parentPath: node.path, kind: 'folder', value: 'New Folder' });
    setExpandedExplorerPaths((paths) => new Set([...paths, node.path]));
  };

  const handleExplorerNewDataset = (parentPath = 'Project') => {
    setInlineExplorerEdit({
      mode: 'create',
      parentPath,
      kind: 'dataset',
      value: getUniqueDatasetName('New Dataset', parentPath),
    });
  };

  const createDatasetFromHub = async () => {
    try {
      const dataset = await createDatasetFileInDirectory('Project', getUniqueDatasetName('New Dataset', 'Project'));
      setExpandedExplorerPaths((paths) => new Set([...paths, 'Project']));
      refreshExplorer();
      openDatasetTab(dataset.id);
      addNotification('success', 'Dataset created');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to create Dataset');
    }
  };

  const handleExplorerPaste = async (node: ExplorerTreeNode) => {
    if (node.kind !== 'folder' || !explorerClipboard) {
      return;
    }

    try {
      const filesystemEntries = explorerClipboard.entries.filter(isFilesystemExplorerEntry);
      const datasetEntries = explorerClipboard.entries.filter((entry) => entry.kind === 'dataset');
      if (filesystemEntries.length > 0) {
        const directory = requireProjectDirectory();
        if (!directory) {
          return;
        }
        const moves =
          explorerClipboard.mode === 'cut'
            ? await moveExplorerEntries(directory, filesystemEntries, node.path)
            : await copyExplorerEntries(directory, filesystemEntries, node.path);
        if (explorerClipboard.mode === 'cut') {
          updateFileTabsForPathMoves(moves);
          await updateWorkspacePathsForPathMoves(moves);
          updateExplorerClipboardForPathMoves(moves);
        }
      }
      if (explorerClipboard.mode === 'copy') {
        for (const entry of datasetEntries) {
          await duplicateDatasetEntry(entry, node.path);
        }
      }
      if (explorerClipboard.mode === 'cut') {
        const directory = requireProjectDirectory();
        if (!directory) {
          return;
        }
        const datasetMoves = await moveExplorerEntries(
          directory,
          datasetEntries.map(toPhysicalExplorerEntry),
          node.path
        );
        const movedPaths: string[] = [];
        for (const entry of datasetEntries) {
          const move = datasetMoves.find((candidate) => candidate.from === entry.path);
          if (!move) {
            continue;
          }
          const dataset = await readDatasetFile(directory, move.to);
          const updatedDataset = {
            ...dataset,
            parentPath: node.path,
            filePath: move.to,
            updatedAt: new Date(),
          };
        await writeDatasetFile(directory, updatedDataset);
        upsertProjectDataset(updatedDataset);
        refreshOpenDatasetTabs(updatedDataset.id);
        movedPaths.push(move.to);
        }
        updateExplorerClipboardForPathMoves(datasetMoves);
        setSelectedExplorerPaths(new Set(movedPaths));
      }
      if (explorerClipboard.mode === 'cut') {
        setExplorerClipboard(null);
      }
      setExpandedExplorerPaths((paths) => new Set([...paths, node.path]));
      refreshExplorer();
      addNotification('success', 'Explorer entry pasted');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to paste entry');
    }
  };

  const handleExplorerDuplicate = async (node: ExplorerTreeNode) => {
    try {
      const entries = getContextEntries(node);
      const filesystemEntries = entries.filter(isFilesystemExplorerEntry);
      const datasetEntries = entries.filter((entry) => entry.kind === 'dataset');
      if (filesystemEntries.length > 0) {
        const directory = requireProjectDirectory();
        if (!directory) {
          return;
        }
        await duplicateExplorerEntries(directory, filesystemEntries);
      }
      for (const entry of datasetEntries) {
        await duplicateDatasetEntry(entry);
      }
      refreshExplorer();
      addNotification('success', 'Explorer entry duplicated');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to duplicate entry');
    }
  };

  const commitInlineExplorerEdit = async () => {
    const edit = inlineExplorerEdit;
    if (!edit) {
      return;
    }

    try {
      if (edit.kind === 'dataset' && edit.mode === 'create') {
        const dataset = await createDatasetFileInDirectory(
          edit.parentPath,
          edit.value.trim() || getUniqueDatasetName('New Dataset', edit.parentPath)
        );
        setSelectedExplorerPaths(new Set([dataset.filePath!]));
        setSelectionAnchorPath(dataset.filePath!);
        setFocusedExplorerPath(dataset.filePath!);
        setInlineExplorerEdit(null);
        refreshExplorer();
        return;
      }

      if (edit.kind === 'dataset' && edit.mode === 'rename' && edit.path) {
        const nextName = edit.value.trim() || 'Dataset';
        const nextPath = await renameExplorerItem(edit.path, 'dataset', nextName);
        if (nextPath) {
          setSelectedExplorerPaths(new Set([nextPath]));
          setSelectionAnchorPath(nextPath);
          setFocusedExplorerPath(nextPath);
        }
        setInlineExplorerEdit(null);
        return;
      }

      const directory = requireProjectDirectory();
      if (!directory) {
        return;
      }

      if (edit.mode === 'create') {
        const nextPath = await createExplorerDirectory(directory, edit.parentPath, edit.value);
        setSelectedExplorerPaths(new Set([nextPath]));
        setSelectionAnchorPath(nextPath);
        setFocusedExplorerPath(nextPath);
      } else if (edit.path) {
        const nextName = edit.value.trim();
        if (!nextName || nextName === edit.path.split('/').pop()) {
          setInlineExplorerEdit(null);
          return;
        }
        const nextPath = await renameExplorerItem(edit.path, edit.kind, nextName);
        if (nextPath) {
          setSelectedExplorerPaths(new Set([nextPath]));
          setSelectionAnchorPath(nextPath);
          setFocusedExplorerPath(nextPath);
        }
      }
      setInlineExplorerEdit(null);
      refreshExplorer();
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to update Explorer entry');
    }
  };

  const cancelInlineExplorerEdit = () => setInlineExplorerEdit(null);

  const moveSelectedExplorerEntries = async (
    destinationPath: string,
    entriesOverride?: ExplorerItemEntry[] | null
  ) => {
    const allEntries = entriesOverride ?? getSelectedExplorerEntries();
    const filesystemEntries = allEntries.filter(isFilesystemExplorerEntry);
    const datasetEntries = allEntries.filter((entry) => entry.kind === 'dataset');
    try {
      const directory = filesystemEntries.length > 0 || datasetEntries.length > 0 ? requireProjectDirectory() : null;
      if ((filesystemEntries.length > 0 || datasetEntries.length > 0) && !directory) {
        return;
      }
      const moves = directory
        ? await moveExplorerEntries(directory, filesystemEntries, destinationPath)
        : [];
      if (moves.length > 0) {
        updateFileTabsForPathMoves(moves);
        await updateWorkspacePathsForPathMoves(moves);
        updateExplorerClipboardForPathMoves(moves);
      }
      const datasetMoves = datasetEntries.length > 0
        ? await moveExplorerEntries(directory!, datasetEntries.map(toPhysicalExplorerEntry), destinationPath)
        : [];
      const movedDatasetPaths: string[] = [];
      for (const entry of datasetEntries) {
        const move = datasetMoves.find((candidate) => candidate.from === entry.path);
        if (!move) {
          continue;
        }
        const dataset = await readDatasetFile(directory!, move.to);
        const updatedDataset = {
          ...dataset,
          parentPath: destinationPath,
          filePath: move.to,
          updatedAt: new Date(),
        };
        await writeDatasetFile(directory!, updatedDataset);
        upsertProjectDataset(updatedDataset);
        refreshOpenDatasetTabs(updatedDataset.id);
        movedDatasetPaths.push(move.to);
      }
      if (datasetMoves.length > 0) {
        updateExplorerClipboardForPathMoves(datasetMoves);
      }
      const selectedPaths = [...moves.map((move) => move.to), ...movedDatasetPaths];
      setSelectedExplorerPaths(new Set(selectedPaths));
      setFocusedExplorerPath(selectedPaths[0] ?? null);
      setCurrentDraggedExplorerEntries(null);
      refreshExplorer();
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to move Explorer entries');
    }
  };

  const importExternalFilesIntoExplorer = async (files: ImportInputFile[], destinationPath: string) => {
    const directory = requireProjectDirectory();
    if (!directory || files.length === 0) {
      return;
    }

    try {
      let importedImageCount = 0;
      let importedAssetCount = 0;
      const result = await importImageFiles(files, {
        logger: createOperationLogger('Import'),
        destination: {
          projectDirectory: directory,
          explorerPath: destinationPath,
        },
        onImageImported: async (image) => {
          const previousProject = useProjectStore.getState();
          addSourceImage(image);
          importedImageCount += 1;
          await writeProjectDirectoryChanges(useProjectStore.getState(), previousProject, directory);
          setExpandedExplorerPaths((paths) => new Set([...paths, destinationPath]));
          refreshExplorer();
        },
        onAssetImported: () => {
          importedAssetCount += 1;
          setExpandedExplorerPaths((paths) => new Set([...paths, destinationPath]));
          refreshExplorer();
        },
        onDirectoryImported: () => {
          setExpandedExplorerPaths((paths) => new Set([...paths, destinationPath]));
          refreshExplorer();
        },
        onError: (fileName) => addNotification('error', `Failed to process ${fileName}`),
      });

      if (result.importedImages.length > 0 || result.importedAssets.length > 0) {
        addNotification(
          'success',
          `Imported ${importedAssetCount || importedImageCount} asset${(importedAssetCount || importedImageCount) !== 1 ? 's' : ''}`
        );
        setExpandedExplorerPaths((paths) => new Set([...paths, destinationPath]));
        refreshExplorer();
      }
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to import files');
    }
  };

  const joinImportPath = (...parts: string[]): string => parts.filter(Boolean).join('/');

  const readImportDirectoryFiles = async (
    directory: ImportDirectoryHandle,
    parentPath = ''
  ): Promise<ImportInputFile[]> => {
    const directoryPath = joinImportPath(parentPath, directory.name);
    const inputs: ImportInputFile[] = [{ directoryPath }];

    for await (const [entryName, entry] of directory.entries()) {
      if ('entries' in entry) {
        inputs.push(...await readImportDirectoryFiles(entry as ImportDirectoryHandle, directoryPath));
      } else {
        const file = await (entry as FileSystemFileHandle).getFile();
        inputs.push({ file, relativePath: joinImportPath(directoryPath, entryName) });
      }
    }

    return inputs;
  };

  const pickImportFiles = async (): Promise<ImportInputFile[]> => {
    const pickerWindow = window as FilePickerWindow;
    if (!pickerWindow.showOpenFilePicker) {
      throw new Error('File picker is not available in this browser.');
    }

    const handles = await pickerWindow.showOpenFilePicker({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [
        {
          description: 'Project assets',
          accept: {
            'image/*': ['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp'],
            'text/plain': ['.txt'],
            'application/json': ['.json'],
            'image/vnd.adobe.photoshop': ['.psd'],
            'video/*': ['.mp4', '.webm'],
          },
        },
      ],
    });
    return Promise.all(handles.map((handle) => handle.getFile()));
  };

  const pickImportDirectory = async (): Promise<ImportInputFile[]> => {
    const pickerWindow = window as FilePickerWindow;
    if (!pickerWindow.showDirectoryPicker) {
      throw new Error('Folder picker is not available in this browser.');
    }

    const directory = await pickerWindow.showDirectoryPicker({ mode: 'read' });
    return readImportDirectoryFiles(directory as ImportDirectoryHandle);
  };

  const handleExplorerImport = async (destinationPath: string, importDirectory = false) => {
    try {
      const files = importDirectory ? await pickImportDirectory() : await pickImportFiles();
      await importExternalFilesIntoExplorer(files, destinationPath);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      addNotification('error', error instanceof Error ? error.message : 'Failed to select files for import');
    }
  };

  const handleDatasetExport = async (node: ExplorerTreeNode) => {
    try {
      const dataset = await readDatasetEntry(node);
      const assetIds = new Set(dataset.assetIds);
      const fileAssetPaths = filterLegacyProjectAssetPaths([...new Set([...(dataset.assetPaths ?? []), ...(dataset.psdAssetPaths ?? [])])]);
      const exportOrderIndex = new Map(
        normalizeDatasetAssetOrder(dataset.assetOrder, dataset.assetIds, fileAssetPaths).map((key, index) => [key, index])
      );
      const getExportOrder = (key: string): number => exportOrderIndex.get(key) ?? Number.MAX_SAFE_INTEGER;
      const exportItems = workspaceImages.filter(
        (item) => assetIds.has(item.sourceImageId) && !item.excludedFromDataset
      ).sort(
        (left, right) =>
          getExportOrder(createDatasetImageAssetKey(left.sourceImageId)) -
            getExportOrder(createDatasetImageAssetKey(right.sourceImageId)) ||
          left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' })
      );
      const directory = requireProjectDirectory();
      if (!directory) {
        return;
      }
      const fileAssets = (await Promise.all(
        fileAssetPaths.map(async (path): Promise<{ file: File; fileName: string; kind: ExplorerFileKind; path: string } | null> => {
          try {
            const file = await readExplorerFile(directory, path);
            return {
              file,
              fileName: path.split('/').pop() ?? file.name,
              kind: getExplorerFileKind(path.split('/').pop() ?? file.name, file.type),
              path,
            };
          } catch (error) {
            addNotification('warning', error instanceof Error ? error.message : `Unable to read "${path}"`);
            return null;
          }
        })
      )).filter((asset): asset is { file: File; fileName: string; kind: ExplorerFileKind; path: string } => Boolean(asset));
      const psdAssets = fileAssets
        .filter((asset) => asset.kind === 'psd')
        .sort(
          (left, right) =>
            getExportOrder(createDatasetFileAssetKey(left.path)) -
              getExportOrder(createDatasetFileAssetKey(right.path)) ||
            left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' })
        )
        .map(({ file, fileName }) => ({ file, fileName }));
      const skippedFileAssetCount = fileAssets.length - psdAssets.length;
      const workspaceExportsByKey = new Map(
        exportItems.map((item): [string, ExportAsset] => [
          createDatasetImageAssetKey(item.sourceImageId),
          { kind: 'workspace', item },
        ])
      );
      const psdExportsByKey = new Map(
        fileAssets
          .filter((asset) => asset.kind === 'psd')
          .map((asset): [string, ExportAsset] => [
            createDatasetFileAssetKey(asset.path),
            { kind: 'psd', asset: { file: asset.file, fileName: asset.fileName } },
          ])
      );
      const orderedAssets = normalizeDatasetAssetOrder(dataset.assetOrder, dataset.assetIds, fileAssetPaths)
        .map((key) => workspaceExportsByKey.get(key) ?? psdExportsByKey.get(key))
        .filter((asset): asset is ExportAsset => Boolean(asset));

      if (exportItems.length === 0 && psdAssets.length === 0) {
        createOperationLogger('Export').warning(`no assets to export for Dataset "${dataset.name}"`);
        addNotification('warning', 'No assets to export');
        return;
      }

      const logger = createOperationLogger('Export');
      const exportCount = exportItems.length + psdAssets.length;
      logger.info(`exporting Dataset "${dataset.name}" with ${exportCount} asset${exportCount !== 1 ? 's' : ''}`);
      if (skippedFileAssetCount > 0) {
        logger.warning(`skipped ${skippedFileAssetCount} non-PSD file asset${skippedFileAssetCount !== 1 ? 's' : ''}`);
        addNotification('warning', `Skipped ${skippedFileAssetCount} non-PSD file asset${skippedFileAssetCount !== 1 ? 's' : ''}`);
      }
      const zipBlob = await exportAsZip(
        {
          datasetKeyword: dataset.triggerWord,
          items: exportItems,
          psdAssets,
          orderedAssets,
        },
        useProjectStore.getState().taggingConfig.blacklist,
        logger
      );
      downloadZipFile(zipBlob, `${dataset.name || 'dataset'}-${new Date().toISOString().split('T')[0]}.zip`);
      logger.success(`exported Dataset "${dataset.name}"`);
      addNotification('success', `Exported ${exportCount} asset${exportCount !== 1 ? 's' : ''} as ZIP`);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to export Dataset');
    }
  };

  const exportDatasetById = (datasetId: string) => {
    const dataset = useProjectStore.getState().datasets[datasetId];
    if (!dataset?.filePath) {
      addNotification('error', 'Dataset file is no longer available');
      return;
    }
    void handleDatasetExport({
      name: dataset.name,
      path: dataset.filePath,
      kind: 'dataset',
      datasetId: dataset.id,
    });
  };

  const handleExplorerDrop = (event: DragEvent, destinationPath: string) => {
    if (Array.from(event.dataTransfer.types).includes('Files')) {
      event.dataTransfer.dropEffect = 'copy';
      void getImportFilesFromDataTransfer(event.dataTransfer)
        .then((files) => importExternalFilesIntoExplorer(files, destinationPath))
        .catch((error) => {
          addNotification('error', error instanceof Error ? error.message : 'Failed to read dropped files');
        });
      return;
    }

    void moveSelectedExplorerEntries(destinationPath, draggedExplorerEntries);
  };

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      Boolean(target.closest('input, textarea, select, [contenteditable="true"], iframe'));

    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key.toLowerCase() === 'w') {
        if (!activeTab) {
          return;
        }
        event.preventDefault();
        closeTab(activeTab.id);
        return;
      }

      if (event.shiftKey && event.key.toLowerCase() === 't') {
        if (closedTabs.length === 0) {
          return;
        }
        event.preventDefault();
        reopenClosedTab();
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        const targetIndex = Number(event.key) - 1;
        const targetTab = openTabs[targetIndex];
        if (!targetTab) {
          return;
        }
        event.preventDefault();
        activateTab(targetTab);
        return;
      }

      if (event.key === 'Tab' || event.key === 'PageDown' || event.key === 'PageUp') {
        if (openTabs.length < 2) {
          return;
        }
        event.preventDefault();
        const currentIndex = Math.max(0, activeTab ? openTabs.findIndex((tab) => tab.id === activeTab.id) : 0);
        const direction = event.key === 'PageUp' ? -1 : 1;
        const nextIndex = (currentIndex + direction + openTabs.length) % openTabs.length;
        activateTab(openTabs[nextIndex]);
      }
    };

    window.addEventListener('keydown', handleWorkspaceShortcut);
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut);
  }, [activeTab, closedTabs.length, openTabs]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      Boolean(target.closest('input, textarea, select, [contenteditable="true"], iframe'));

    const handleExplorerShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      const explorerHasFocus =
        document.activeElement instanceof HTMLElement &&
        Boolean(explorerPanelRef.current?.contains(document.activeElement));
      if (!explorerHasFocus && !explorerContextMenu) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveExplorerKeyboardFocus(1, event.shiftKey);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveExplorerKeyboardFocus(-1, event.shiftKey);
        return;
      }

      if (event.key === 'ArrowRight') {
        const focusedNode = getFocusedExplorerNode();
        if (focusedNode?.kind === 'folder') {
          event.preventDefault();
          if (!expandedExplorerPaths.has(focusedNode.path)) {
            setExpandedExplorerPaths((paths) => new Set([...paths, focusedNode.path]));
          } else if (focusedNode.children?.[0]) {
            focusExplorerNode(focusedNode.children[0], false);
          }
        }
        return;
      }

      if (event.key === 'ArrowLeft') {
        const focusedNode = getFocusedExplorerNode();
        if (focusedNode) {
          event.preventDefault();
          if (focusedNode.kind === 'folder' && expandedExplorerPaths.has(focusedNode.path)) {
            setExpandedExplorerPaths((paths) => {
              const next = new Set(paths);
              next.delete(focusedNode.path);
              return next;
            });
          } else {
            const parent = getParentExplorerNode(focusedNode.path);
            if (parent && parent.path !== 'Project') {
              focusExplorerNode(parent, false);
            }
          }
        }
        return;
      }

      if (event.key === 'Enter') {
        const focusedNode = getFocusedExplorerNode();
        if (focusedNode) {
          event.preventDefault();
          if (focusedNode.kind === 'folder') {
            toggleExplorerPath(focusedNode.path);
          } else {
            void openExplorerFile(focusedNode);
          }
        }
        return;
      }

      const selectedEntries = getSelectedExplorerEntries();
      const selectedNode = selectedEntries.length === 1
        ? getVisibleExplorerNodes().find((node) => node.path === selectedEntries[0].path)
        : null;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selectedEntries.length > 0) {
        event.preventDefault();
        setExplorerClipboard({ mode: 'copy', entries: selectedEntries });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x' && selectedEntries.length > 0) {
        event.preventDefault();
        setExplorerClipboard({ mode: 'cut', entries: selectedEntries });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && explorerClipboard) {
        event.preventDefault();
        void handleExplorerPaste({ name: activeExplorerDirectoryPath.split('/').pop() ?? 'Project', path: activeExplorerDirectoryPath, kind: 'folder' });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && selectedEntries.length > 0) {
        event.preventDefault();
        const node = selectedNode ?? getVisibleExplorerNodes().find((entry) => entry.path === selectedEntries[0].path);
        if (node) {
          void handleExplorerDuplicate(node);
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const nodes = getActiveDirectoryChildren();
        setSelectedExplorerPaths(new Set(nodes.map((node) => node.path)));
        setSelectionAnchorPath(nodes[0]?.path ?? null);
        return;
      }

      if (event.key === 'F2' && selectedNode) {
        event.preventDefault();
        handleExplorerRename(selectedNode);
        return;
      }

      if (event.key === 'Delete' && selectedEntries.length > 0) {
        event.preventDefault();
        const node = selectedNode ?? getVisibleExplorerNodes().find((entry) => entry.path === selectedEntries[0].path);
        if (node) {
          void handleExplorerDelete(node);
        }
      }
    };

    window.addEventListener('keydown', handleExplorerShortcut);
    return () => window.removeEventListener('keydown', handleExplorerShortcut);
  }, [activeExplorerDirectoryPath, explorerClipboard, explorerContextMenu, focusedExplorerPath, selectedExplorerPaths, explorerTree, expandedExplorerPaths]);

  const handleThemeChange = (nextDarkMode: boolean) => {
    setDarkMode(nextDarkMode);
    setViewMenuOpen(false);
  };

  const updateLocalTaggerFileSetting = async (
    key: LocalTaggerFileKey,
    handle: FileSystemFileHandle
  ) => {
    const fileName = handle.name.toLowerCase();
    const isValidFile = key === 'model' ? fileName.endsWith('.onnx') : fileName.endsWith('.csv');
    if (!isValidFile) {
      addNotification('error', `Select ${key === 'model' ? 'an ONNX model file' : 'a CSV tags file'}.`);
      return;
    }

    updateWorkspaceSettings(
      key === 'model'
        ? { localTaggerModelPath: handle.name }
        : { localTaggerTagsPath: handle.name }
    );

    try {
      await saveLocalTaggerFileHandle(key, handle);
    } catch (error) {
      console.warn('Failed to persist local tagger file handle', error);
      addNotification(
        'warning',
        `${handle.name} is saved by name, but browser file access could not be persisted.`
      );
      return;
    }

    addNotification(
      'success',
      `${key === 'model' ? 'Model file' : 'Tags CSV'} saved in Settings`
    );
  };

  const handlePickLocalTaggerFile = async (key: LocalTaggerFileKey) => {
    const pickerWindow = window as FilePickerWindow;
    const isModel = key === 'model';

    if (!pickerWindow.showOpenFilePicker) {
      (isModel ? taggerModelInputRef : taggerTagsInputRef).current?.click();
      return;
    }

    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          isModel
            ? {
                description: 'ONNX model',
                accept: { 'application/octet-stream': ['.onnx'] },
              }
            : {
                description: 'Selected tags CSV',
                accept: { 'text/csv': ['.csv'] },
              },
        ],
      });

      if (!handle) {
        return;
      }

      await updateLocalTaggerFileSetting(key, handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      addNotification(
        'error',
        error instanceof Error ? error.message : 'Could not save local tagger file setting.'
      );
    }
  };

  const handleFallbackLocalTaggerFileSelected = async (
    key: LocalTaggerFileKey,
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    const fileName = file.name.toLowerCase();
    const isValidFile = key === 'model' ? fileName.endsWith('.onnx') : fileName.endsWith('.csv');
    if (!isValidFile) {
      addNotification('error', `Select ${key === 'model' ? 'an ONNX model file' : 'a CSV tags file'}.`);
      return;
    }

    updateWorkspaceSettings(
      key === 'model'
        ? { localTaggerModelPath: file.name }
        : { localTaggerTagsPath: file.name }
    );

    try {
      await deleteLocalTaggerFileHandle(key);
    } catch (error) {
      console.warn('Failed to clear local tagger file handle', error);
    }

    addNotification(
      'info',
      `${file.name} selected. Persistent auto-load requires a browser with file handle support.`
    );
  };

  const handleProjectFileError = (error: unknown, message: string) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    addNotification('error', error instanceof Error ? error.message : message);
  };

  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === 'AbortError';

  const handleNewProject = async () => {
    if (projectOperationBusyRef.current) {
      return;
    }
    const logger = createOperationLogger('Project');
    setFileMenuOpen(false);
    if (workspaceImages.length > 0 && !window.confirm('Create a new project and clear the current workspace?')) {
      return;
    }

    projectOperationBusyRef.current = true;
    setIsProjectDirectoryBusy(true);
    try {
      logger.info('selecting parent directory');
      const parentDirectory = await pickProjectDirectory();
      const nextName = window.prompt('Project name', 'Untitled Project')?.trim();
      if (!nextName) {
        logger.warning('new project canceled');
        return;
      }

      logger.info(`creating project directory ${nextName}`);
      const directory = await parentDirectory.getDirectoryHandle(nextName, { create: true });
      if (
        (await projectDirectoryHasManifest(directory)) &&
        !window.confirm(`Overwrite the Dataset Creator project in "${nextName}"?`)
      ) {
        logger.warning(`new project canceled before overwriting ${nextName}`);
        return;
      }
      projectSessionRef.current += 1;
      autoSaveQueueRef.current = Promise.resolve();
      setProjectDirectory(undefined);
      initializeProject(nextName);
      const project = useProjectStore.getState();
      logger.info('writing project manifest and folders');
      await clearProjectDirectory(directory);
      await createProjectDirectory(directory, project);
      applyWorkspaceTabsForProject(project.id);
      setProjectDirectory({ handle: directory, name: directory.name });
      logger.success(`created project directory ${directory.name}`);
      addNotification('success', 'New project directory created');
    } catch (error) {
      if (!isAbortError(error)) {
        logger.error(error instanceof Error ? error.message : 'failed to create project directory');
      }
      handleProjectFileError(error, 'Failed to create project directory');
    } finally {
      projectOperationBusyRef.current = false;
      setIsProjectDirectoryBusy(false);
    }
  };

  const openProjectDirectory = async (directory: ProjectDirectoryHandle) => {
    const logger = createOperationLogger('Project');
    logger.info(`opening project directory ${directory.name}`);
    const project = await readProjectDirectory(directory);
    projectSessionRef.current += 1;
    autoSaveQueueRef.current = Promise.resolve();
    setProjectDirectory(undefined);
    loadProject(project);
    const datasets = await readProjectDatasetsFromDirectory(directory);
    for (const dataset of datasets) {
      upsertProjectDataset(dataset);
    }
    applyWorkspaceTabsForProject(project.id);
    setProjectDirectory({ handle: directory, name: directory.name });
    logger.success(`opened project directory ${directory.name}`);
    addNotification('success', 'Project directory opened');
    void indexProjectAssets(directory, {
      logger: createOperationLogger('Index'),
      existingSourceImages: useProjectStore.getState().sourceImages,
      onAssetIndexed: async ({ sourceImage }) => {
        const previousProject = useProjectStore.getState();
        if (sourceImage && !previousProject.sourceImages[sourceImage.id]) {
          addSourceImage(sourceImage);
        }
        await writeProjectDirectoryChanges(useProjectStore.getState(), previousProject, directory);
        refreshExplorer();
      },
    })
      .then(async () => {
        await writeProjectDirectoryChanges(useProjectStore.getState(), undefined, directory);
        refreshExplorer();
      })
      .catch((error) => {
        addNotification('error', error instanceof Error ? error.message : 'Failed to index project assets');
      });
  };

  const handleOpenProject = async () => {
    if (projectOperationBusyRef.current) {
      return;
    }
    projectOperationBusyRef.current = true;
    setFileMenuOpen(false);
    setIsProjectDirectoryBusy(true);
    try {
      const directory = await pickProjectDirectory();
      await openProjectDirectory(directory);
    } catch (error) {
      if (!isAbortError(error)) {
        createOperationLogger('Project').error(
          error instanceof Error ? error.message : 'failed to open project directory'
        );
      }
      handleProjectFileError(error, 'Failed to open project directory');
    } finally {
      projectOperationBusyRef.current = false;
      setIsProjectDirectoryBusy(false);
    }
  };

  const handleRenameProject = () => {
    setFileMenuOpen(false);
    const nextName = window.prompt('Project name', projectName)?.trim();
    if (!nextName || nextName === projectName) {
      return;
    }

    renameProject(nextName);
    addNotification('success', 'Project renamed');
  };

  const closeTopMenus = () => {
    setFileMenuOpen(false);
    setViewMenuOpen(false);
    setToolsMenuOpen(false);
    setWindowsMenuOpen(false);
    setTabContextMenu(null);
  };

  const closeExplorerContextMenu = () => setExplorerContextMenu(null);

  const createExplorerAction = (
    action: Omit<ContextAction, 'onSelect'> & { onSelect: (event: MouseEvent<HTMLButtonElement>) => void | Promise<void> }
  ): ContextAction => ({
    ...action,
    onSelect: (event) => {
      void action.onSelect(event);
      closeExplorerContextMenu();
    },
  });

  const getFileContextActionGroups = (node: ExplorerTreeNode): ContextActionGroup[] => {
    const contextEntries = getContextEntries(node);
    const isSingleFileSelection = contextEntries.length === 1;
    const fileKind = getExplorerFileKind(node.name);
    const workspaceImageId = findWorkspaceImageIdForPath(node.path);
    const canOpenFileInTab = isSingleFileSelection && canOpenExplorerFile(fileKind);
    const canOpenInAnalysis = isSingleFileSelection && (fileKind === 'image' || fileKind === 'psd' || fileKind === 'video');
    const canOpenInPhotopea = isSingleFileSelection && isExplorerImageFileName(node.name) && Boolean(workspaceImageId);
    const canOpenInCaption = isSingleFileSelection && (fileKind === 'image' || fileKind === 'psd') && Boolean(workspaceImageId);

    return [
      [
        canOpenFileInTab
          ? createExplorerAction({ id: 'open', label: 'Open', icon: File, onSelect: () => openExplorerFile(node) })
          : null,
      ].filter((action): action is ContextAction => Boolean(action)),
      [
        canOpenInPhotopea
          ? createExplorerAction({ id: 'photopea', label: 'Photopea', icon: Edit3, onSelect: () => openFileModeTab(node, 'edit') })
          : null,
        canOpenInCaption
          ? createExplorerAction({ id: 'caption', label: 'Caption', icon: Tags, onSelect: () => openFileModeTab(node, 'caption') })
          : null,
        canOpenInAnalysis
          ? createExplorerAction({ id: 'analysis', label: 'Analysis', icon: BarChart3, onSelect: () => openFileModeTab(node, 'analysis') })
          : null,
      ].filter((action): action is ContextAction => Boolean(action)),
      [
        createExplorerAction({ id: 'cut', label: 'Cut', icon: Scissors, onSelect: () => setExplorerClipboard({ mode: 'cut', entries: contextEntries }) }),
        createExplorerAction({ id: 'copy', label: 'Copy', icon: Copy, onSelect: () => setExplorerClipboard({ mode: 'copy', entries: contextEntries }) }),
        createExplorerAction({ id: 'duplicate', label: 'Duplicate', icon: Copy, onSelect: () => handleExplorerDuplicate(node) }),
      ],
      [
        isSingleFileSelection
          ? createExplorerAction({ id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => handleExplorerRename(node) })
          : null,
        createExplorerAction({ id: 'delete', label: 'Delete', icon: Trash2, variant: 'destructive', onSelect: () => handleExplorerDelete(node) }),
      ].filter((action): action is ContextAction => Boolean(action)),
    ].filter((group) => group.length > 0);
  };

  const getDatasetContextActionGroups = (node: ExplorerTreeNode): ContextActionGroup[] => {
    const contextEntries = getContextEntries(node);
    return [
      [
        createExplorerAction({ id: 'open', label: 'Open', icon: Layers3, onSelect: () => openExplorerFile(node) }),
      ],
      [
        createExplorerAction({ id: 'select', label: 'Select', icon: ScanSearch, onSelect: () => openDatasetToolFromExplorer(node, 'select') }),
        createExplorerAction({ id: 'review', label: 'Review', icon: Layers3, onSelect: () => openDatasetToolFromExplorer(node, 'review') }),
        createExplorerAction({ id: 'caption', label: 'Caption', icon: Tags, onSelect: () => openDatasetToolFromExplorer(node, 'tagging') }),
        createExplorerAction({ id: 'analysis', label: 'Analysis', icon: BarChart3, onSelect: () => openDatasetToolFromExplorer(node, 'analysis') }),
        createExplorerAction({ id: 'export', label: 'Export', icon: Download, onSelect: () => handleDatasetExport(node) }),
      ],
      [
        createExplorerAction({ id: 'cut', label: 'Cut', icon: Scissors, onSelect: () => setExplorerClipboard({ mode: 'cut', entries: contextEntries }) }),
        createExplorerAction({ id: 'copy', label: 'Copy', icon: Copy, onSelect: () => setExplorerClipboard({ mode: 'copy', entries: contextEntries }) }),
        createExplorerAction({ id: 'duplicate', label: 'Duplicate', icon: Copy, onSelect: () => handleExplorerDuplicate(node) }),
      ],
      [
        createExplorerAction({ id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => handleExplorerRename(node) }),
        createExplorerAction({ id: 'delete', label: 'Delete', icon: Trash2, variant: 'destructive', onSelect: () => handleExplorerDelete(node) }),
      ],
    ];
  };

  const getDirectoryContextActionGroups = (node: ExplorerTreeNode): ContextActionGroup[] => {
    const contextEntries = getContextEntries(node);
    const creationActions: ContextActionGroup =
      node.kind === 'folder'
        ? [
            createExplorerAction({ id: 'new-folder', label: 'New Folder', icon: FilePlus, onSelect: () => handleExplorerNewFolder(node) }),
            createExplorerAction({ id: 'new-dataset', label: 'New Dataset', icon: Layers3, onSelect: () => handleExplorerNewDataset(node.path) }),
            createExplorerAction({
              id: 'import',
              label: 'Import',
              icon: Upload,
              title: 'Shift-click to import a folder',
              onSelect: (event) => handleExplorerImport(node.path, event.shiftKey),
            }),
          ]
        : [];

    if (node.path === 'Project') {
      return [
        creationActions,
        explorerClipboard
          ? [createExplorerAction({ id: 'paste', label: 'Paste', icon: Copy, onSelect: () => handleExplorerPaste(node) })]
          : [],
      ].filter((group) => group.length > 0);
    }

    return [
      creationActions,
      [
        createExplorerAction({ id: 'cut', label: 'Cut', icon: Scissors, onSelect: () => setExplorerClipboard({ mode: 'cut', entries: contextEntries }) }),
        createExplorerAction({ id: 'copy', label: 'Copy', icon: Copy, onSelect: () => setExplorerClipboard({ mode: 'copy', entries: contextEntries }) }),
        explorerClipboard
          ? createExplorerAction({ id: 'paste', label: 'Paste', icon: Copy, onSelect: () => handleExplorerPaste(node) })
          : null,
        createExplorerAction({ id: 'duplicate', label: 'Duplicate', icon: Copy, onSelect: () => handleExplorerDuplicate(node) }),
      ].filter((action): action is ContextAction => Boolean(action)),
      [
        contextEntries.length === 1
          ? createExplorerAction({ id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => handleExplorerRename(node) })
          : null,
        createExplorerAction({ id: 'delete', label: 'Delete', icon: Trash2, variant: 'destructive', onSelect: () => handleExplorerDelete(node) }),
      ].filter((action): action is ContextAction => Boolean(action)),
    ].filter((group) => group.length > 0);
  };

  const renderFileContextMenuItems = (node: ExplorerTreeNode): ReactNode =>
    <ContextActionGroups groups={getFileContextActionGroups(node)} />;

  const renderDatasetContextMenuItems = (node: ExplorerTreeNode): ReactNode =>
    <ContextActionGroups groups={getDatasetContextActionGroups(node)} />;

  const renderDirectoryContextMenuItems = (node: ExplorerTreeNode): ReactNode =>
    <ContextActionGroups groups={getDirectoryContextActionGroups(node)} />;

  return (
    <div className="flex h-screen bg-background text-foreground">
      <PhotopeaPsdPreviewWorker active={Boolean(projectDirectoryHandle)} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="relative z-30 flex h-9 shrink-0 items-center border-b border-border bg-card px-3 text-sm">
          {(fileMenuOpen || viewMenuOpen || toolsMenuOpen || windowsMenuOpen) && (
            <button
              type="button"
              aria-label="Close menu"
              className="fixed inset-0 z-30 cursor-default"
              onClick={closeTopMenus}
            />
          )}
          <div className="relative z-40">
            <button
              type="button"
              className={`rounded px-3 py-1.5 font-medium transition-colors ${
                fileMenuOpen ? 'bg-secondary' : 'hover:bg-secondary'
              }`}
              onClick={() => {
                setViewMenuOpen(false);
                setToolsMenuOpen(false);
                setWindowsMenuOpen(false);
                setFileMenuOpen((open) => !open);
              }}
            >
              File
            </button>
            {fileMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-xl">
                <button
                  type="button"
                  disabled={isProjectDirectoryBusy}
                  onClick={() => void handleNewProject()}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50"
                >
                  <FilePlus className="h-4 w-4" />
                  <span className="flex-1">New Project Directory</span>
                </button>
                <button
                  type="button"
                  disabled={isProjectDirectoryBusy}
                  onClick={() => void handleOpenProject()}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="flex-1">Open Project Directory</span>
                </button>
                <button
                  type="button"
                  disabled={isProjectDirectoryBusy}
                  onClick={handleRenameProject}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50"
                >
                  <Pencil className="h-4 w-4" />
                  <span className="flex-1">Rename</span>
                </button>
              </div>
            )}
          </div>
          <div className="relative z-40">
            <button
              type="button"
              className={`rounded px-3 py-1.5 font-medium transition-colors ${
                viewMenuOpen ? 'bg-secondary' : 'hover:bg-secondary'
              }`}
              onClick={() => {
                setFileMenuOpen(false);
                setToolsMenuOpen(false);
                setWindowsMenuOpen(false);
                setViewMenuOpen((open) => !open);
              }}
            >
              View
            </button>
            {viewMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-48 rounded-md border border-border bg-popover p-1 shadow-xl">
                <button
                  type="button"
                  onClick={() => handleThemeChange(false)}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <Sun className="h-4 w-4" />
                  <span className="flex-1">Light</span>
                  {!darkMode && <Check className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleThemeChange(true)}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <Moon className="h-4 w-4" />
                  <span className="flex-1">Dark</span>
                  {darkMode && <Check className="h-4 w-4" />}
                </button>
              </div>
            )}
          </div>
          <div className="relative z-40">
            <button
              type="button"
              className={`rounded px-3 py-1.5 font-medium transition-colors ${
                toolsMenuOpen ? 'bg-secondary' : 'hover:bg-secondary'
              }`}
              onClick={() => {
                setFileMenuOpen(false);
                setViewMenuOpen(false);
                setWindowsMenuOpen(false);
                setToolsMenuOpen((open) => !open);
              }}
            >
              Tools
            </button>
            {toolsMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-xl">
                {TOOLS_MENU_ITEMS.map((stage) => {
                  const Icon = stage === 'hub' ? Archive : toolIcons[stage];
                  const active = activeTab?.kind === 'tool' && activeStage === stage;
                  return (
                    <button
                      type="button"
                      key={stage}
                      onClick={() => navigateToTool(stage)}
                      className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary ${
                        active ? 'bg-secondary/70' : ''
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="flex-1">{TOOL_LABELS[stage]}</span>
                      {active && <Check className="h-4 w-4" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="relative z-40">
            <button
              type="button"
              className={`rounded px-3 py-1.5 font-medium transition-colors ${
                windowsMenuOpen ? 'bg-secondary' : 'hover:bg-secondary'
              }`}
              onClick={() => {
                setFileMenuOpen(false);
                setViewMenuOpen(false);
                setToolsMenuOpen(false);
                setWindowsMenuOpen((open) => !open);
              }}
            >
              Windows
            </button>
            {windowsMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-xl">
                <button
                  type="button"
                  onClick={() => {
                    setLeftPanelOpen((open) => !open);
                    setWindowsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <PanelLeft className="h-4 w-4" />
                  <span className="flex-1">Explorer</span>
                  {leftPanelOpen && <Check className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRightPanelOpen((open) => !open);
                    setWindowsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <PanelRight className="h-4 w-4" />
                  <span className="flex-1">Inspector</span>
                  {rightPanelOpen && <Check className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBottomPanelOpen((open) => !open);
                    setWindowsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <PanelBottom className="h-4 w-4" />
                  <span className="flex-1">Output</span>
                  {bottomPanelOpen && <Check className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProjectWindowOpen(true);
                    setWindowsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="flex-1">Project window</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    openFloatingInspector();
                    setWindowsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <PanelRight className="h-4 w-4" />
                  <span className="flex-1">Floating inspector</span>
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="rounded px-3 py-1.5 font-medium transition-colors hover:bg-secondary"
            onClick={() => {
              closeTopMenus();
              setIsWorkspaceSettingsOpen(true);
            }}
          >
            Settings
          </button>
        </div>

        <div className="workspace-tab-strip relative flex h-9 shrink-0 items-stretch border-b border-border bg-background">
          <div className="workspace-tab-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto px-1">
            {openTabs.map((tab) => {
              const { Icon, label, title } = getWorkspaceTabChrome(tab);
              const active = activeTabId === tab.id;
              return (
                <div
                  key={tab.id}
                  role="tab"
                  tabIndex={0}
                  aria-selected={active}
                  draggable
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest('[data-tab-close]')) {
                      return;
                    }
                    activateTab(tab);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activateTab(tab);
                    }
                  }}
                  onDragStart={(event) => {
                    draggedTabRef.current = tab.id;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(WORKSPACE_TAB_DRAG_TYPE, tab.id);
                    event.dataTransfer.setData('text/plain', tab.id);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    if (draggedTabRef.current !== tab.id) {
                      setDragOverTab(tab.id);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source =
                      draggedTabRef.current ||
                      event.dataTransfer.getData(WORKSPACE_TAB_DRAG_TYPE) ||
                      event.dataTransfer.getData('text/plain');
                    if (source) {
                      reorderTabs(source, tab.id);
                    }
                    draggedTabRef.current = null;
                    setDragOverTab(null);
                  }}
                  onDragEnd={() => {
                    draggedTabRef.current = null;
                    setDragOverTab(null);
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 1 && !(event.target as HTMLElement).closest('[data-tab-close]')) {
                      event.preventDefault();
                      closeTab(tab.id);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setTabContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
                  }}
                  className={`group flex ${tab.pinned ? 'min-w-10 max-w-40' : 'min-w-[7rem] max-w-52'} shrink-0 cursor-pointer items-center gap-2 border-r border-border px-3 text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                    active ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-secondary/60'
                  } ${dragOverTab === tab.id ? 'border-l-2 border-l-primary' : ''}`}
                  title={title}
                >
                  {tab.pinned ? <Pin className="h-3 w-3 shrink-0" /> : null}
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className={`min-w-0 flex-1 truncate ${tab.pinned ? 'hidden sm:block' : ''}`}>{label}</span>
                  {isTabDirty(tab) ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="Unsaved changes" />
                  ) : null}
                  <button
                    type="button"
                    data-tab-close
                    draggable={false}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onDragStart={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    className={`rounded p-1 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 ${
                      tab.pinned ? 'opacity-0 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    title="Close tab"
                    aria-label={`Close ${label} tab`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <DropdownMenu.Root open={tabMenuOpen} onOpenChange={setTabMenuOpen}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="mx-1 shrink-0 self-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  title="Open tool"
                  aria-label="Open tool"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-[100] w-52 rounded-md border border-border bg-popover p-1 shadow-xl"
                >
                  <p className="px-3 py-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    Open tool
                  </p>
                  {TOOLS_MENU_ITEMS.map((stage) => {
                    const Icon = stage === 'hub' ? Archive : toolIcons[stage];
                    const isOpen = openTabs.some((tab) => tab.kind === 'tool' && tab.stage === stage);
                    return (
                      <DropdownMenu.Item
                        key={stage}
                        onSelect={() => navigateToTool(stage)}
                        className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-xs outline-none hover:bg-secondary"
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span className="min-w-0 flex-1 truncate">{TOOL_LABELS[stage]}</span>
                        {isOpen && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button
              type="button"
              disabled={closedTabs.length === 0}
              onClick={reopenClosedTab}
              className="mx-1 shrink-0 self-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
              title="Reopen closed tab"
              aria-label="Reopen closed tab"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={openFloatingInspector}
            className="mx-1 shrink-0 self-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden"
            title="Open floating inspector"
            aria-label="Open floating inspector"
          >
            <PanelRight className="h-4 w-4" />
          </button>
          {tabContextMenu && tabContextMenuTab ? (
            <>
              <button
                type="button"
                aria-label="Close tab menu"
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setTabContextMenu(null)}
              />
              <div
                className="fixed z-50 w-52 rounded-md border border-border bg-popover p-1 text-xs shadow-xl"
                style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
              >
                <button
                  type="button"
                  onClick={() => toggleTabPinned(tabContextMenuTab.id)}
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <Pin className="h-3.5 w-3.5" />
                  <span className="flex-1">{tabContextMenuTab.pinned ? 'Unpin tab' : 'Pin tab'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => closeOtherTabs(tabContextMenuTab.id)}
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <X className="h-3.5 w-3.5" />
                  <span className="flex-1">Close others</span>
                </button>
                <button
                  type="button"
                  disabled={closedTabs.length === 0}
                  onClick={reopenClosedTab}
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="flex-1">Reopen closed tab</span>
                </button>
                {isFileBackedTab(tabContextMenuTab) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTabContextMenu(null);
                      setExplorerContextMenu({
                        node: { name: tabContextMenuTab.name, path: tabContextMenuTab.path, kind: 'file' },
                        x: tabContextMenu.x,
                        y: tabContextMenu.y,
                      });
                    }}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-secondary"
                  >
                    <File className="h-3.5 w-3.5" />
                    <span className="flex-1">File actions</span>
                  </button>
                ) : null}
                {tabContextMenuDataset && tabContextMenuDatasetFilePath ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTabContextMenu(null);
                      setExplorerContextMenu({
                        node: {
                          name: tabContextMenuDataset.name,
                          path: tabContextMenuDatasetFilePath,
                          kind: 'dataset',
                          datasetId: tabContextMenuDataset.id,
                        },
                        x: tabContextMenu.x,
                        y: tabContextMenu.y,
                      });
                    }}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-secondary"
                  >
                    <Layers3 className="h-3.5 w-3.5" />
                    <span className="flex-1">Dataset actions</span>
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
          {showHeaderEditToolbar && (
            <div className="flex shrink-0 items-center gap-1 border-l border-border px-1">
              <a
                href="https://www.photopea.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors hover:bg-secondary"
                title="Open Photopea"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Photopea
              </a>
              <button
                type="button"
                onClick={() => runEditCommand('save')}
                disabled={!editToolbar.canSave || editToolbar.isProcessing}
                className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => runEditCommand('saveCopy')}
                disabled={!editToolbar.canSave || editToolbar.isProcessing}
                className="rounded px-2 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
              >
                Save Copy
              </button>
              <button
                type="button"
                onClick={() => runEditCommand('cancel')}
                disabled={editToolbar.isProcessing}
                className="rounded px-2 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
          <div className="flex min-w-0 shrink-0 items-center justify-end px-2 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {projectDirectoryName ?? 'Unsaved workspace'}
          </div>
        </div>

        <Dialog.Root open={isWorkspaceSettingsOpen} onOpenChange={setIsWorkspaceSettingsOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-card p-4 shadow-2xl">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-base font-semibold">Settings</Dialog.Title>
                  <Dialog.Description className="text-xs text-muted-foreground">
                    Configure shared workspace display options.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md p-2 transition-colors hover:bg-secondary"
                    aria-label="Close Settings"
                  >
                    <X size={16} />
                  </button>
                </Dialog.Close>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-2 block text-xs text-muted-foreground">Brick columns</label>
                  <select
                    value={workspaceSettings?.brickColumnCount ?? 'auto'}
                    onChange={(event) =>
                      updateWorkspaceSettings({
                        brickColumnCount: parseBrickColumnCount(event.target.value),
                      })
                    }
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    {BRICK_COLUMN_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option === 'auto' ? 'Auto' : `${option} columns`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-md border border-border bg-secondary/20 p-3">
                  <h3 className="mb-3 text-sm font-semibold">Local Tagger Files</h3>
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">model.onnx</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {workspaceSettings.localTaggerModelPath ?? 'No model selected'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handlePickLocalTaggerFile('model')}
                        className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                      >
                        <Upload size={16} />
                        Choose model
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">selected_tags.csv</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {workspaceSettings.localTaggerTagsPath ?? 'No tags CSV selected'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handlePickLocalTaggerFile('tags')}
                        className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                      >
                        <Upload size={16} />
                        Choose tags
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <input
          ref={taggerModelInputRef}
          type="file"
          accept=".onnx"
          className="hidden"
          onChange={(event) => void handleFallbackLocalTaggerFileSelected('model', event)}
          aria-hidden="true"
        />
        <input
          ref={taggerTagsInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => void handleFallbackLocalTaggerFileSelected('tags', event)}
          aria-hidden="true"
        />

        <div className="flex min-h-0 flex-1">
          {leftPanelOpen && (
            <aside
              className="workspace-dock-left relative flex min-h-0 shrink-0 flex-col border-r border-border bg-card"
              style={{ width: leftPanelWidth }}
            >
              <button
                type="button"
                aria-label="Resize explorer panel"
                className="workspace-dock-resize-vertical absolute inset-y-0 -right-1 z-10 w-2 cursor-ew-resize bg-transparent hover:bg-primary/60"
                onPointerDown={(event) => {
                  event.preventDefault();
                  dockResizeRef.current = {
                    kind: 'left',
                    startX: event.clientX,
                    startY: event.clientY,
                    origin: leftPanelWidth,
                  };
                  document.body.style.cursor = 'ew-resize';
                  document.body.style.userSelect = 'none';
                }}
              />
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
                <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                  <PanelLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">Explorer</span>
                </div>
                <button
                  type="button"
                  onClick={() => setLeftPanelOpen(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Close explorer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div
                ref={explorerPanelRef}
                className="min-h-0 flex-1 overflow-auto p-2"
                tabIndex={0}
                onContextMenu={(event) => {
                  if ((event.target as HTMLElement).closest('[data-explorer-row]')) {
                    return;
                  }
                  event.preventDefault();
                  setActiveExplorerDirectoryPath('Project');
                  setExplorerContextMenu({ node: { name: projectName || 'Project', path: 'Project', kind: 'folder' }, x: event.clientX, y: event.clientY });
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  handleExplorerDrop(event, 'Project');
                }}
              >
                {explorerError && (
                  <p className="mb-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-xs text-yellow-600">
                    Showing workspace state. {explorerError}
                  </p>
                )}
                {visibleExplorerTree ? (
                  <ExplorerTree
                    node={visibleExplorerTree}
                    expandedPaths={expandedExplorerPaths}
                    selectedPaths={selectedExplorerPaths}
                    inlineEdit={inlineExplorerEdit}
                    focusedPath={focusedExplorerPath}
                    onToggle={toggleExplorerPath}
                    onSelect={selectExplorerNode}
                    onContextMenu={(node, x, y) => {
                      setActiveExplorerNode(node);
                      if (!selectedExplorerPaths.has(node.path)) {
                        setSelectedExplorerPaths(new Set([node.path]));
                        setSelectionAnchorPath(node.path);
                      }
                      setExplorerContextMenu({ node, x, y });
                    }}
                    onInlineChange={(value) => setInlineExplorerEdit((edit) => edit ? { ...edit, value } : edit)}
                    onInlineCommit={() => void commitInlineExplorerEdit()}
                    onInlineCancel={cancelInlineExplorerEdit}
                    onDragStartItem={startExplorerDrag}
                    onDragEndItems={() => setCurrentDraggedExplorerEntries(null)}
                    onDropItems={(node, event) => handleExplorerDrop(event, node.path)}
                  />
                ) : (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No project files</p>
                )}
              </div>
              {explorerContextMenu && (
                <>
                  <button
                    type="button"
                    aria-label="Close Explorer context menu"
                    className="fixed inset-0 z-[950] cursor-default"
                    onClick={() => setExplorerContextMenu(null)}
                  />
                  <div
                    className="fixed z-[1000] w-44 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-xl"
                    style={{ left: explorerContextMenu.x, top: explorerContextMenu.y }}
                  >
                    {explorerContextMenu.actionGroups
                      ? <ContextActionGroups groups={explorerContextMenu.actionGroups} />
                      : explorerContextMenu.node.kind === 'file'
                      ? renderFileContextMenuItems(explorerContextMenu.node)
                      : explorerContextMenu.node.kind === 'dataset'
                        ? renderDatasetContextMenuItems(explorerContextMenu.node)
                        : renderDirectoryContextMenuItems(explorerContextMenu.node)}
                  </div>
                </>
              )}
            </aside>
          )}
          <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={showEditToolbar || showFullscreenTagging || (activeTab && isFileBackedTab(activeTab)) ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 overflow-auto'}
          >
            <div
              className={
                showEditToolbar || showFullscreenTagging || (activeTab && isFileBackedTab(activeTab))
                  ? 'relative h-full min-h-0'
                  : 'relative p-4 md:p-6'
              }
            >
              {activeToolNestedView ? (
                <button
                  type="button"
                  onClick={closeActiveToolNestedView}
                  className="absolute left-3 top-3 z-30 inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card/95 text-muted-foreground shadow hover:bg-secondary hover:text-foreground"
                  title="Back"
                  aria-label="Back to tool"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              ) : null}
              <Suspense
                fallback={
                  <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
                    Loading tool...
                  </div>
                }
              >
                {openTabs.filter(isFileBackedTab).map((tab) => {
                  const isActiveFileTab = activeTabId === tab.id;
                  return (
                    <div key={tab.id} className={isActiveFileTab ? 'h-full min-h-0' : 'hidden'}>
                      {tab.kind === 'file-view' ? (
                        <InternalFileViewer
                          file={tab.file}
                          fileName={tab.name}
                          fileKind={tab.fileKind}
                          active={isActiveFileTab}
                          onSavePsd={
                            tab.fileKind === 'psd'
                              ? (buffer, saveCopy) => savePsdFileFromViewer(tab, buffer, saveCopy)
                              : undefined
                          }
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setExplorerContextMenu({
                              node: { name: tab.name, path: tab.path, kind: 'file' },
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        />
                      ) : tab.kind === 'file-analysis' ? (
                        <AnalysisStage
                          active={isActiveFileTab}
                          projectDirectoryHandle={projectDirectoryHandle}
                          onOpenAssetContextMenu={openAssetExplorerContextMenu}
                          fileTarget={{
                            path: tab.path,
                            name: tab.name,
                            fileKind: tab.fileKind,
                            file: tab.file,
                            workspaceImageId: tab.workspaceImageId,
                          }}
                        />
                      ) : tab.kind === 'file-edit' ? (
                        <CleanupStageComponent
                          selectedImageId={tab.workspaceImageId}
                          singleFileMode
                          active={isActiveFileTab}
                          projectDirectoryHandle={projectDirectoryHandle}
                        />
                      ) : (
                        <TaggingStageComponent
                          selectedItemId={tab.workspaceImageId}
                          singleFileMode
                          active={isActiveFileTab}
                        />
                      )}
                    </div>
                  );
                })}
                {activeTab?.kind === 'dataset' ? (
                  renderDatasetWorkspace(activeTab)
                ) : activeTab && isDatasetToolTab(activeTab) ? (
                  renderDatasetTool(activeTab)
                ) : activeTab && isFileBackedTab(activeTab) ? null : activeStage ? (
                  renderTool({
                    currentStage: activeStage,
                    projectDirectoryHandle,
                    onOpenAssetContextMenu: openAssetExplorerContextMenu,
                    nested: activeToolNestedView,
                    onOpenNestedFile: openActiveToolNestedFile,
                    onOpenTool: navigateToTool,
                    onOpenDataset: openDatasetTab,
                    onOpenDatasetTool: openDatasetToolTab,
                    onCreateDataset: createDatasetFromHub,
                    onExportDataset: exportDatasetById,
                  })
                ) : (
                  <EmptyWorkspacePlaceholder
                    onOpenTool={() => setTabMenuOpen(true)}
                    onOpenProject={() => void handleOpenProject()}
                  />
                )}
              </Suspense>
            </div>
          </div>
          {bottomPanelOpen && (
            <section
              className="workspace-dock-bottom relative shrink-0 border-t border-border bg-card"
              style={{ height: bottomPanelHeight }}
            >
              <button
                type="button"
                aria-label="Resize output panel"
                className="workspace-dock-resize-horizontal absolute -top-1 left-0 z-20 h-2 w-full cursor-ns-resize bg-transparent hover:bg-primary/60"
                onPointerDown={(event) => {
                  event.preventDefault();
                  dockResizeRef.current = {
                    kind: 'bottom',
                    startX: event.clientX,
                    startY: event.clientY,
                    origin: bottomPanelHeight,
                  };
                  document.body.style.cursor = 'ns-resize';
                  document.body.style.userSelect = 'none';
                }}
              />
              <div className="flex h-full flex-col px-4 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <PanelBottom className="h-3.5 w-3.5 text-muted-foreground" />
                    Output
                  </div>
                  <button
                    type="button"
                    onClick={() => setBottomPanelOpen(false)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Close output"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div
                  ref={outputLogRef}
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                    outputAutoFollowRef.current = distanceFromBottom < 24;
                  }}
                  className="mt-2 min-h-0 flex-1 overflow-auto font-mono text-[11px]"
                >
                  {operationLogs.map((entry) => {
                    const time = entry.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    });
                    const levelClass =
                      entry.level === 'error'
                        ? 'text-destructive'
                        : entry.level === 'warning'
                          ? 'text-yellow-500'
                          : entry.level === 'success'
                            ? 'text-emerald-500'
                            : 'text-muted-foreground';
                    return (
                      <p key={entry.id} className={levelClass}>
                        [{time}] {entry.level.toUpperCase().padEnd(7, ' ')} {entry.message}
                      </p>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </div>
          </section>
          {rightPanelOpen && (
            <aside className="workspace-dock-right relative flex min-h-0 shrink-0 flex-col border-l border-border bg-card" style={{ width: rightPanelWidth }}>
              <button
                type="button"
                aria-label="Resize inspector panel"
                className="workspace-dock-resize-vertical absolute inset-y-0 -left-1 z-10 w-2 cursor-ew-resize bg-transparent hover:bg-primary/60"
                onPointerDown={(event) => {
                  event.preventDefault();
                  dockResizeRef.current = {
                    kind: 'right',
                    startX: event.clientX,
                    startY: event.clientY,
                    origin: rightPanelWidth,
                  };
                  document.body.style.cursor = 'ew-resize';
                  document.body.style.userSelect = 'none';
                }}
              />
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
                  Inspector
                </div>
                <button
                  type="button"
                  onClick={() => setRightPanelOpen(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Close inspector"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                {floatingInspectorOwnsContent ? (
                  <div className="space-y-3 text-xs">
                    <div className="rounded border border-border bg-background p-3">
                      <p className="font-medium">Floating inspector is open</p>
                      <p className="mt-1 text-muted-foreground">
                        Tool controls are shown in the floating panel.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={openFloatingInspector}
                      className="flex w-full items-center justify-center gap-2 rounded border border-border px-2 py-2 font-medium hover:bg-secondary"
                    >
                      <PanelRight className="h-3.5 w-3.5" />
                      Focus floating inspector
                    </button>
                    <button
                      type="button"
                      onClick={() => setInspectorWindow((panel) => ({ ...panel, minimized: true }))}
                      className="flex w-full items-center justify-center gap-2 rounded border border-border px-2 py-2 font-medium hover:bg-secondary"
                    >
                      <Minimize2 className="h-3.5 w-3.5" />
                      Return controls here
                    </button>
                  </div>
                ) : (
                  renderInspectorContent()
                )}
              </div>
            </aside>
          )}
        </div>

        {!leftPanelOpen && explorerContextMenu?.node.kind === 'file' && (
          <>
            <button
              type="button"
              aria-label="Close file context menu"
              className="fixed inset-0 z-[950] cursor-default"
              onClick={() => setExplorerContextMenu(null)}
            />
            <div
              className="fixed z-[1000] w-44 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-xl"
              style={{ left: explorerContextMenu.x, top: explorerContextMenu.y }}
            >
              {explorerContextMenu.actionGroups
                ? <ContextActionGroups groups={explorerContextMenu.actionGroups} />
                : renderFileContextMenuItems(explorerContextMenu.node)}
            </div>
          </>
        )}

        {notifications.length > 0 && (
          <div className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
            {notifications.map((notification) => {
              const isError = notification.type === 'error';
              const isSuccess = notification.type === 'success';
              return (
                <div
                  key={notification.id}
                  role="alert"
                  className={`pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-3 text-sm shadow-xl ${
                    isError
                      ? 'border-destructive/60 bg-destructive text-destructive-foreground'
                      : isSuccess
                        ? 'border-emerald-500/60 bg-emerald-950 text-emerald-100'
                        : 'border-border bg-card text-foreground'
                  }`}
                >
                  {isError ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
                  <p className="min-w-0 flex-1 break-words">{notification.message}</p>
                  <button
                    type="button"
                    onClick={() => removeNotification(notification.id)}
                    className="shrink-0 rounded p-0.5 opacity-80 transition-opacity hover:opacity-100"
                    aria-label="Dismiss notification"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {projectWindowOpen && (
          <FloatingWorkspacePanel
            title="Project"
            icon={FolderOpen}
            panel={projectWindow}
            zIndex={1200 + floatingPanelOrder.indexOf('project') + 1}
            onChange={setProjectWindow}
            onFocus={() => focusFloatingPanel('project')}
            onClose={() => setProjectWindowOpen(false)}
          >
            <div className="space-y-3 text-xs">
              <div className="rounded border border-border bg-background p-3">
                <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Current project</p>
                <p className="mt-1 truncate font-semibold">{projectName}</p>
                <p className="mt-1 truncate text-muted-foreground">{projectDirectoryName ?? 'Unsaved workspace'}</p>
              </div>
              <div>
                <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Open editors</p>
                <div className="space-y-1">
                  {openTabs.length === 0 && (
                    <p className="rounded border border-border px-2 py-2 text-muted-foreground">No open editors</p>
                  )}
                  {openTabs.map((tab) => {
                    const { Icon, label, target, title } = getWorkspaceTabChrome(tab);
                    return (
                      <button
                        type="button"
                        key={tab.id}
                        onClick={() => activateTab(tab)}
                        title={title}
                        className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors ${
                          activeTabId === tab.id ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                        }`}
                      >
                        {tab.pinned ? <Pin className="h-3 w-3 shrink-0" /> : null}
                        <Icon className="h-3.5 w-3.5" />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {isTabDirty(tab) ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
                        <span className="shrink-0 text-[10px] opacity-70">{target}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </FloatingWorkspacePanel>
        )}

        {inspectorWindowOpen && (
          <FloatingWorkspacePanel
            title="Inspector"
            icon={PanelRight}
            panel={inspectorWindow}
            zIndex={1200 + floatingPanelOrder.indexOf('inspector') + 1}
            onChange={setInspectorWindow}
            onFocus={() => focusFloatingPanel('inspector')}
            onClose={() => setInspectorWindowOpen(false)}
          >
            <div className="space-y-4 text-xs">
              {renderInspectorContent()}
              <div className="border-t border-border pt-3">
                <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Dock layout</p>
                <button
                  type="button"
                  onClick={() => setRightPanelOpen((open) => !open)}
                  className="mb-2 flex w-full items-center justify-between rounded border border-border px-2 py-2 text-left hover:bg-secondary"
                >
                  <span>Docked inspector</span>
                  <span className="text-muted-foreground">{rightPanelOpen ? 'On' : 'Off'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBottomPanelOpen((open) => !open)}
                  className="flex w-full items-center justify-between rounded border border-border px-2 py-2 text-left hover:bg-secondary"
                >
                  <span>Output panel</span>
                  <span className="text-muted-foreground">{bottomPanelOpen ? 'On' : 'Off'}</span>
                </button>
              </div>
            </div>
          </FloatingWorkspacePanel>
        )}
      </main>
    </div>
  );
}

export default App;
