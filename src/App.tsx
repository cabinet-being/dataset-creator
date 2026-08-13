import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ComponentType, DragEvent, ReactNode } from 'react';
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
  Plus,
  ScanSearch,
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
  STAGES,
  STAGE_LABELS,
  STAGE_URL_SLUGS,
  TOOL_DESCRIPTIONS,
  URL_STAGE_ALIASES,
} from './lib/constants';
import { toWorkspaceImages } from './lib/workspaceImages';
import {
  createProjectDirectory,
  clearProjectDirectory,
  pickProjectDirectory,
  projectDirectoryHasManifest,
  readProjectDirectory,
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
import { downloadZipFile, exportAsZip } from './services/export/exportService';
import {
  createDatasetForFile,
  getDatasetDisplayName,
  getDatasetFileName,
  isDatasetFileName,
  readDatasetFile,
  writeDatasetFile,
} from './services/project/datasetFileService';
import { InternalFileViewer } from './components/InternalFileViewer';
import { CleanupStage as CleanupStageComponent } from './components/stages/CleanupStage';
import { TaggingStage as TaggingStageComponent } from './components/stages/TaggingStage';
import { PSD_TOOL_COMMAND_EVENT } from './components/photopea/PhotopeaFrame';
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
import { type BrickColumnCount, type Dataset, type StageName } from './types';
import './App.css';

const EDIT_TOOL_COMMAND_EVENT = 'dataset-creator-edit-command';
const TAGGING_TOOL_COMMAND_EVENT = 'dataset-creator-tagging-command';
const BRICK_COLUMN_OPTIONS: BrickColumnCount[] = ['auto', 1, 2, 3, 4, 5];

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
  tags?: string[];
};

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

type ToolWorkspaceTab = {
  id: string;
  kind: 'tool';
  stage: StageName;
};

type DatasetToolStage = Extract<StageName, 'select' | 'analysis' | 'review' | 'tagging'>;

const DATASET_TOOL_LABELS: Record<DatasetToolStage, string> = {
  select: 'Select',
  analysis: 'Analysis',
  review: 'Review',
  tagging: 'Caption',
};

type DatasetToolWorkspaceTab = {
  id: string;
  kind: 'dataset-tool';
  datasetId: string;
  stage: DatasetToolStage;
};

type FileWorkspaceTab = {
  id: string;
  kind: 'file-view' | 'file-edit' | 'file-caption';
  path: string;
  name: string;
  fileKind: ExplorerFileKind;
  file: File | Blob;
  workspaceImageId?: string;
};

type DatasetWorkspaceTab = {
  id: string;
  kind: 'dataset';
  datasetId: string;
};

type WorkspaceTab = ToolWorkspaceTab | DatasetToolWorkspaceTab | FileWorkspaceTab | DatasetWorkspaceTab;

const createToolTab = (stage: StageName): ToolWorkspaceTab => ({
  id: `tool:${stage}`,
  kind: 'tool',
  stage,
});

const createFileTabId = (path: string): string => `file:${path}`;
const createFileModeTabId = (mode: 'edit' | 'caption', path: string): string => `file:${mode}:${path}`;
const createDatasetTabId = (datasetId: string): string => `dataset:${datasetId}`;
const createDatasetToolTabId = (datasetId: string, stage: DatasetToolStage): string => `dataset:${datasetId}:${stage}`;

const isToolTab = (tab: WorkspaceTab): tab is ToolWorkspaceTab => tab.kind === 'tool';
const isDatasetToolTab = (tab: WorkspaceTab): tab is DatasetToolWorkspaceTab => tab.kind === 'dataset-tool';
const isFileBackedTab = (tab: WorkspaceTab): tab is FileWorkspaceTab =>
  tab.kind === 'file-view' || tab.kind === 'file-edit' || tab.kind === 'file-caption';

type WorkspaceLayout = {
  openTabs: StageName[];
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
          .map((tab): StageName | null => {
            if (typeof tab === 'string' && isStageName(tab)) {
              return tab;
            }
            if (
              tab &&
              typeof tab === 'object' &&
              (tab as { kind?: unknown }).kind === 'tool' &&
              isStageName((tab as { stage?: string }).stage ?? null)
            ) {
              return (tab as { stage: StageName }).stage;
            }
            return null;
          })
          .filter((tab): tab is StageName => Boolean(tab))
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
      openTabs: openTabs ? Array.from(new Set(openTabs)) : undefined,
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
const FinalReviewStage = lazy(() =>
  import('./components/stages/FinalReviewStage').then((module) => ({ default: module.FinalReviewStage }))
);
const ExportStage = lazy(() =>
  import('./components/stages/ExportStage').then((module) => ({ default: module.ExportStage }))
);

const isStageName = (value: string | null): value is StageName =>
  Boolean(value && (STAGES as readonly string[]).includes(value));

const getStageFromUrlSlug = (value: string | null): StageName | null => {
  if (!value) {
    return null;
  }

  return (URL_STAGE_ALIASES[value] ?? null) as StageName | null;
};

const getUrlSlugForStage = (stage: StageName): string => STAGE_URL_SLUGS[stage] ?? stage;

const readStageFromUrl = (): StageName | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const stage = new URL(window.location.href).searchParams.get('tool');
  return getStageFromUrlSlug(stage) ?? (isStageName(stage) ? stage : null);
};

const writeStageToUrl = (stage: StageName, mode: 'push' | 'replace' = 'replace') => {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  const stageSlug = getUrlSlugForStage(stage);
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

const TOOLS_MENU_STAGES = STAGES.filter((stage) => stage !== 'import' && stage !== 'export');

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

const renderTool = (currentStage: StageName, projectDirectoryHandle?: ProjectDirectoryHandle | null) => {
  switch (currentStage) {
    case 'hub':
      return <ToolHub />;
    case 'import':
      return <ImportStage />;
    case 'select':
      return <SimilarityReviewStage />;
    case 'clean':
      return <CleanupStageComponent projectDirectoryHandle={projectDirectoryHandle} />;
    case 'analysis':
      return <AnalysisStage />;
    case 'review':
      return <FinalReviewStage />;
    case 'tagging':
      return <TaggingStageComponent />;
    case 'export':
      return <ExportStage />;
    default:
      return <ToolHub />;
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
              Math.max(8, window.innerHeight - (panel.minimized ? 38 : panel.height) - 8),
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
        height: panel.minimized ? 38 : panel.height,
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
    if (entryName === '.dataset-creator-data') {
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
    if (entryName === '.dataset-creator-data') {
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

const EmptyWorkspacePlaceholder = () => (
  <div className="flex h-full min-h-[20rem] items-center justify-center text-center">
    <div className="text-muted-foreground">
      <Archive className="mx-auto mb-3 h-8 w-8 opacity-60" />
      <p className="text-sm font-medium text-foreground">No tool is open</p>
      <p className="mt-1 text-xs">Open one from the Tools menu</p>
    </div>
  </div>
);

function App() {
  const projectName = useProjectStore((state) => state.name);
  const currentStage = useProjectStore((state) => state.currentStage);
  const initializeProject = useProjectStore((state) => state.initializeProject);
  const loadProject = useProjectStore((state) => state.loadProject);
  const renameProject = useProjectStore((state) => state.renameProject);
  const setCurrentStage = useProjectStore((state) => state.setCurrentStage);
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
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [windowsMenuOpen, setWindowsMenuOpen] = useState(false);
  const [isWorkspaceSettingsOpen, setIsWorkspaceSettingsOpen] = useState(false);
  const [isProjectDirectoryBusy, setIsProjectDirectoryBusy] = useState(false);
  const [isUrlStageReady, setIsUrlStageReady] = useState(false);
  const [storedWorkspaceLayout] = useState(readWorkspaceLayout);
  const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(openTabs[0]?.id ?? null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(storedWorkspaceLayout.leftPanelOpen ?? true);
  const [rightPanelOpen, setRightPanelOpen] = useState(storedWorkspaceLayout.rightPanelOpen ?? true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(storedWorkspaceLayout.bottomPanelOpen ?? false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(storedWorkspaceLayout.leftPanelWidth ?? 260);
  const [rightPanelWidth, setRightPanelWidth] = useState(storedWorkspaceLayout.rightPanelWidth ?? 280);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(storedWorkspaceLayout.bottomPanelHeight ?? 190);
  const [explorerTree, setExplorerTree] = useState<ExplorerTreeNode | null>(null);
  const visibleExplorerTree = explorerTree;
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
  } | null>(null);
  const [inspectorRenameValue, setInspectorRenameValue] = useState('');
  const [inspectorRenaming, setInspectorRenaming] = useState(false);
  const [fileInspectorMetadata, setFileInspectorMetadata] = useState<FileInspectorMetadata | null>(null);
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
    const stageFromUrl = readStageFromUrl();
    if (stageFromUrl) {
      setCurrentStage(stageFromUrl);
      setOpenTabs((tabs) =>
        tabs.some((tab) => tab.kind === 'tool' && tab.stage === stageFromUrl)
          ? tabs
          : [...tabs, createToolTab(stageFromUrl)]
      );
      setActiveTabId(createToolTab(stageFromUrl).id);
    }
    setIsUrlStageReady(true);

    const handlePopState = () => {
      const nextStage = readStageFromUrl();
      if (nextStage) {
        setCurrentStage(nextStage);
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
  }, [setCurrentStage]);

  useEffect(() => {
    if (isUrlStageReady) {
      writeStageToUrl(currentStage);
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
    if (!(STAGES as readonly string[]).includes(currentStage)) {
      setCurrentStage('hub');
    }
  }, [currentStage, setCurrentStage]);

  useEffect(() => {
    if (!fileMenuOpen && !viewMenuOpen && !toolsMenuOpen && !windowsMenuOpen && !tabMenuOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFileMenuOpen(false);
        setViewMenuOpen(false);
        setToolsMenuOpen(false);
        setWindowsMenuOpen(false);
        setTabMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fileMenuOpen, tabMenuOpen, toolsMenuOpen, viewMenuOpen, windowsMenuOpen]);

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
  const activeStage = activeTab?.kind === 'tool' || activeTab?.kind === 'dataset-tool' ? activeTab.stage : null;
  const activeDataset =
    activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
      ? datasetsById[activeTab.datasetId]
      : null;
  const activeFileSource = activeTab && isFileBackedTab(activeTab) && activeTab.workspaceImageId
    ? sourceImagesById[activeTab.workspaceImageId]
    : null;

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
    setInspectorRenameValue(activeStage ? STAGE_LABELS[activeStage] : '');
  }, [activeDataset?.name, activeStage, activeTab]);

  useEffect(() => {
    if (!activeTab || !isFileBackedTab(activeTab)) {
      setFileInspectorMetadata(null);
      return;
    }

    const format = activeTab.name.split('.').pop()?.toUpperCase() || activeTab.fileKind.toUpperCase();
    const tags = activeFileSource?.tags;
    const metadata: FileInspectorMetadata = {
      format,
      size: 'size' in activeTab.file ? formatFileSize(activeTab.file.size) : 'Unknown',
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
  }, [activeFileSource?.tags, activeTab]);

  useEffect(() => {
    if (activeTabId && openTabs.some((tab) => tab.id === activeTabId)) {
      return;
    }
    setActiveTabId(openTabs[0]?.id ?? null);
  }, [activeTabId, openTabs]);
  const showEditToolbar = (activeStage === 'clean' || activeTab?.kind === 'file-edit') && editToolbar.visible;
  const showHeaderEditToolbar = activeStage === 'clean' && editToolbar.visible;
  const showTaggingToolbar = activeStage === 'tagging' || activeTab?.kind === 'file-caption';
  const showTaggingBackButton = showTaggingToolbar && taggingToolbar.visible;
  const showFullscreenTagging = showTaggingToolbar && taggingToolbar.visible;
  const runEditCommand = (command: 'back' | 'save' | 'saveCopy' | 'cancel') => {
    window.dispatchEvent(new CustomEvent(EDIT_TOOL_COMMAND_EVENT, { detail: command }));
  };
  const runPsdCommand = (command: 'save' | 'saveCopy') => {
    window.dispatchEvent(new CustomEvent(PSD_TOOL_COMMAND_EVENT, { detail: command }));
  };
  const navigateToStage = (stage: StageName) => {
    const nextTab = createToolTab(stage);
    setOpenTabs((tabs) => (tabs.some((tab) => tab.id === nextTab.id) ? tabs : [...tabs, nextTab]));
    setActiveTabId(nextTab.id);
    writeStageToUrl(stage, 'push');
    setCurrentStage(stage);
    setFileMenuOpen(false);
    setViewMenuOpen(false);
    setToolsMenuOpen(false);
    setWindowsMenuOpen(false);
    setTabMenuOpen(false);
  };

  const activateTab = (tab: WorkspaceTab) => {
    setActiveTabId(tab.id);
    if (tab.kind === 'tool') {
      writeStageToUrl(tab.stage, 'push');
      setCurrentStage(tab.stage);
    }
    setFileMenuOpen(false);
    setViewMenuOpen(false);
    setToolsMenuOpen(false);
    setWindowsMenuOpen(false);
    setTabMenuOpen(false);
  };

  const closeTab = (tabId: string) => {
    const tabIndex = openTabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = openTabs.filter((tab) => tab.id !== tabId);
    const nextTab = nextTabs[Math.max(0, Math.min(tabIndex, nextTabs.length - 1))] ?? null;
    setOpenTabs(nextTabs);

    if (activeTabId === tabId) {
      if (nextTab) {
        activateTab(nextTab);
      } else {
        setActiveTabId(null);
      }
    }
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
      window.localStorage.setItem(
        WORKSPACE_LAYOUT_STORAGE_KEY,
        JSON.stringify({
          openTabs: openTabs.filter(isToolTab).map((tab) => tab.stage),
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
    leftPanelOpen,
    leftPanelWidth,
    openTabs,
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

  const collectDatasetPsdPathsFromExplorerEntries = (entries: ExplorerItemEntry[]): string[] => {
    const psdPaths = new Set<string>();
    const nodes = getAllExplorerNodes();

    for (const entry of entries.filter(isFilesystemExplorerEntry)) {
      const candidateNodes =
        entry.kind === 'folder'
          ? nodes.filter((node) => node.kind === 'file' && node.path.startsWith(`${entry.path}/`))
          : nodes.filter((node) => node.path === entry.path && node.kind === 'file');

      for (const node of candidateNodes) {
        if (getExplorerFileKind(node.name) === 'psd') {
          psdPaths.add(node.path);
        }
      }
    }

    return [...psdPaths];
  };

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
  ): Promise<{ assetIds: string[]; psdAssetPaths: string[] }> => {
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Open a project directory before importing files into a Dataset');
      return { assetIds: [], psdAssetPaths: [] };
    }

    const files = await getImportFilesFromDataTransfer(dataTransfer);
    if (files.length === 0) {
      return { assetIds: [], psdAssetPaths: [] };
    }

    const importedAssetIds: string[] = [];
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
        if (asset.kind === 'psd') {
          importedPsdPaths.push(asset.assetPath.startsWith('Project/') ? asset.assetPath : `Project/${asset.assetPath}`);
        }
      },
      onError: (fileName) => addNotification('error', `Failed to process ${fileName}`),
    });

    if (result.importedImages.length > 0 || result.importedAssets.length > 0) {
      await writeProjectDirectoryChanges(useProjectStore.getState(), previousProject, projectDirectoryHandle);
      refreshExplorer();
    }

    return { assetIds: importedAssetIds, psdAssetPaths: importedPsdPaths };
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
    source?: Pick<Dataset, 'triggerWord' | 'assetIds' | 'psdAssetPaths' | 'overwriteCaptions' | 'captionOverrides'>
  ): Promise<Dataset> => {
    const directory = requireProjectDirectory();
    if (!directory) {
      throw new Error('Open a project directory before creating a Dataset.');
    }
    const parentDirectory = await getDirectoryAtExplorerPath(directory, parentPath);
    const fileName = await getUniqueExplorerName(parentDirectory, getDatasetFileName(name));
    const filePath = `${parentPath}/${fileName}`;
    const dataset = {
      ...createDatasetForFile(getDatasetDisplayName(fileName), filePath),
      triggerWord: source?.triggerWord ?? '',
      assetIds: [...new Set(source?.assetIds ?? [])],
      psdAssetPaths: [...new Set(source?.psdAssetPaths ?? [])],
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
      psdAssetPaths: dataset.psdAssetPaths,
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
    updates: Partial<Pick<Dataset, 'triggerWord' | 'assetIds' | 'psdAssetPaths' | 'overwriteCaptions' | 'captionOverrides'>>
  ) => {
    const nextDataset = {
      ...dataset,
      ...updates,
      assetIds: updates.assetIds ? [...new Set(updates.assetIds)] : dataset.assetIds,
      psdAssetPaths: updates.psdAssetPaths ? [...new Set(updates.psdAssetPaths)] : dataset.psdAssetPaths,
      overwriteCaptions: updates.overwriteCaptions ?? dataset.overwriteCaptions ?? false,
      captionOverrides: updates.captionOverrides ?? dataset.captionOverrides ?? {},
      updatedAt: new Date(),
    };
    updateProjectDataset(dataset.id, updates);
    const directory = requireProjectDirectory();
    if (directory && nextDataset.filePath) {
      await writeDatasetFile(directory, nextDataset);
    }
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

    const updateDataset = (updates: Partial<Pick<Dataset, 'assetIds' | 'psdAssetPaths' | 'overwriteCaptions' | 'captionOverrides'>>) =>
      updateDatasetFileBackedState(dataset, updates);
    const openScopedTool = (stage: StageName) => {
      if (stage === 'select' || stage === 'analysis' || stage === 'review' || stage === 'tagging') {
        openDatasetToolTab(dataset.id, stage);
        return;
      }
      navigateToStage(stage);
    };

    switch (tab.stage) {
      case 'select':
        return (
          <FinalReviewStage
            datasetId={dataset.id}
            mode="select"
            onUpdateDataset={updateDataset}
            onOpenTool={openScopedTool}
          />
        );
      case 'review':
        return (
          <FinalReviewStage
            datasetId={dataset.id}
            mode="review"
            onUpdateDataset={updateDataset}
            onOpenTool={openScopedTool}
          />
        );
      case 'analysis':
        return <AnalysisStage datasetId={dataset.id} onUpdateDataset={updateDataset} />;
      case 'tagging':
        return <TaggingStageComponent datasetId={dataset.id} onUpdateDataset={updateDataset} />;
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
      };

      setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
      setActiveTabId(tab.id);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to open file');
    }
  };

  const openFileModeTab = async (node: ExplorerTreeNode, mode: 'edit' | 'caption') => {
    try {
      const imageId = findWorkspaceImageIdForPath(node.path);
      if (!imageId) {
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
        kind: mode === 'edit' ? 'file-edit' : 'file-caption',
        path: node.path,
        name: node.name,
        fileKind: getExplorerFileKind(node.name, 'type' in file ? file.type : undefined),
        file,
        workspaceImageId: imageId,
      };

      setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
      setActiveTabId(tab.id);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : `Failed to open ${mode === 'edit' ? 'Photopea' : 'Caption'}`);
    }
  };

  const savePsdFileFromViewer = async (
    tab: FileWorkspaceTab,
    buffer: ArrayBuffer,
    saveCopy: boolean
  ) => {
    try {
      if (!projectDirectoryHandle) {
        addNotification('warning', 'Open a project directory before saving PSD files.');
        return;
      }

      const { directory, name } = await getExplorerParentDirectory(projectDirectoryHandle, tab.path);
      const targetName = saveCopy ? await getUniqueExplorerName(directory, `${name.replace(/\.psd$/i, '')} Copy.psd`) : name;
      const nextBlob = new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
      const handle = await directory.getFileHandle(targetName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(nextBlob);
      await writable.close();

      const nextPath = `${tab.path.split('/').slice(0, -1).join('/') || 'Project'}/${targetName}`;
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

    const assets = dataset.assetIds
      .map((assetId) => sourceImagesById[assetId])
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
    const psdAssets = dataset.psdAssetPaths ?? [];

    return (
      <div
        className="h-full min-h-0 overflow-auto p-6"
        onDragOver={(event) => {
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
        onDrop={(event) => {
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
            let psdAssetPaths = droppedEntries?.length
              ? collectDatasetPsdPathsFromExplorerEntries(droppedEntries)
              : [];
            if (droppedEntries?.length && assetIds.length === 0 && psdAssetPaths.length === 0) {
              await indexProjectAssetsForDatasetDrop();
              assetIds = collectDatasetAssetIdsFromExplorerEntries(droppedEntries);
              psdAssetPaths = collectDatasetPsdPathsFromExplorerEntries(droppedEntries);
            }
            if (hasFiles) {
              const imported = await importDroppedFilesIntoDataset(dataTransfer, dataset);
              assetIds = [...assetIds, ...imported.assetIds];
              psdAssetPaths = [...psdAssetPaths, ...imported.psdAssetPaths];
            }
            if (assetIds.length > 0 || psdAssetPaths.length > 0) {
              const currentDataset = useProjectStore.getState().datasets[dataset.id] ?? dataset;
              const nextAssetIds = [...new Set([...currentDataset.assetIds, ...assetIds])];
              const nextPsdAssetPaths = [...new Set([...(currentDataset.psdAssetPaths ?? []), ...psdAssetPaths])];
              const addedCount =
                nextAssetIds.length -
                currentDataset.assetIds.length +
                nextPsdAssetPaths.length -
                (currentDataset.psdAssetPaths ?? []).length;
              if (addedCount > 0) {
                await updateDatasetFileBackedState(currentDataset, {
                  assetIds: nextAssetIds,
                  psdAssetPaths: nextPsdAssetPaths,
                });
                addNotification('success', `Added ${addedCount} asset${addedCount !== 1 ? 's' : ''} to ${dataset.name}`);
              } else {
                addNotification('info', 'Selected assets are already in this Dataset');
              }
            } else {
              addNotification('warning', 'No supported project images found to add');
            }
          })();
        }}
      >
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="flex min-h-28 items-center justify-center rounded border border-dashed border-border bg-card text-sm text-muted-foreground">
            Drop project assets here
          </div>
          {assets.length > 0 || psdAssets.length > 0 ? (
            <div className="min-h-40 rounded border border-border bg-card">
              <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 md:grid-cols-4">
                {assets.map((asset) => (
                  <div key={asset.id} className="min-w-0 overflow-hidden rounded border border-border bg-background">
                    <div className="aspect-square bg-secondary">
                      {asset.previewUrl ? (
                        <img
                          src={asset.previewUrl}
                          alt={asset.originalFileName ?? asset.fileName}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center">
                          <File className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="truncate px-2 py-1.5 text-xs">{asset.originalFilePath ?? asset.fileName}</div>
                  </div>
                ))}
                {psdAssets.map((path) => (
                  <div key={path} className="min-w-0 overflow-hidden rounded border border-border bg-background">
                    <div className="flex aspect-square items-center justify-center bg-secondary">
                      <File className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <div className="truncate px-2 py-1.5 text-xs">{path}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
	        </div>
	      </div>
	    );
  };

  const renderInspectorContent = () => {
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
            ? STAGE_LABELS[activeStage]
            : 'No tab active';
    const canRename = activeTab?.kind === 'dataset' || (activeTab && isFileBackedTab(activeTab));

    return (
      <div className="space-y-4 text-xs">
        <div className="flex items-start gap-2">
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

        {activeTab && isFileBackedTab(activeTab) && fileInspectorMetadata ? (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">File</p>
            <div className="space-y-2">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Format</span>
                <span className="font-medium">{fileInspectorMetadata.format}</span>
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
              {fileInspectorMetadata.tags?.length ? (
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
            </div>
          </div>
        ) : null}

        {activeDataset ? (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Dataset</p>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-muted-foreground">Trigger Word</label>
                <input
                  value={activeDataset.triggerWord}
                  onChange={(event) => void updateDatasetFileBackedState(activeDataset, { triggerWord: event.target.value })}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-sm"
                />
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Assets</span>
                <span className="font-medium">
                  {activeDataset.assetIds.length + (activeDataset.psdAssetPaths ?? []).length}
                </span>
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
                <span>Overwrite Caption</span>
              </label>
            </div>
          </div>
        ) : null}

        {activeTab?.kind === 'file-edit' ? (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Photopea</p>
            <div className="grid gap-2">
              <button type="button" onClick={() => runEditCommand('back')} disabled={editToolbar.isProcessing} className="flex items-center gap-2 rounded border border-border px-2 py-2 text-left hover:bg-secondary disabled:opacity-50">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <a href="https://www.photopea.com" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded border border-border px-2 py-2 text-left hover:bg-secondary">
                <ExternalLink className="h-3.5 w-3.5" />
                Photopea
              </a>
              <button type="button" onClick={() => runEditCommand('save')} disabled={!editToolbar.canSave || editToolbar.isProcessing} className="rounded bg-primary px-2 py-2 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                Save
              </button>
              <button type="button" onClick={() => runEditCommand('saveCopy')} disabled={!editToolbar.canSave || editToolbar.isProcessing} className="rounded border border-border px-2 py-2 text-left hover:bg-secondary disabled:opacity-50">
                Save Copy
              </button>
              <button type="button" onClick={() => runEditCommand('cancel')} disabled={editToolbar.isProcessing} className="rounded border border-border px-2 py-2 text-left hover:bg-secondary disabled:opacity-50">
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {activeTab && isFileBackedTab(activeTab) && activeTab.fileKind === 'psd' ? (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">PSD</p>
            <div className="grid gap-2">
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
            </div>
          </div>
        ) : null}

        {activeTab?.kind === 'file-caption' || activeStage === 'tagging' ? (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Caption</p>
            {showTaggingBackButton ? (
              <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(TAGGING_TOOL_COMMAND_EVENT, { detail: 'back' }))} className="mb-3 flex w-full items-center gap-2 rounded border border-border px-2 py-2 text-left hover:bg-secondary">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
            ) : null}
            <div id="dataset-tags-inspector-root" />
          </div>
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

  const applyExplorerPathMoves = (path: string, moves: Array<{ from: string; to: string }>): string => {
    for (const move of moves) {
      if (path === move.from || path.startsWith(`${move.from}/`)) {
        return path === move.from ? move.to : `${move.to}/${path.slice(move.from.length + 1)}`;
      }
    }
    return path;
  };

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
    moves: Array<{ from: string; to: string }>
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

  const updateWorkspacePathsForPathMoves = (moves: Array<{ from: string; to: string }>) => {
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
      if (parentPath !== (dataset.parentPath || 'Project') || filePath !== dataset.filePath) {
        updateProjectDataset(dataset.id, { parentPath, filePath });
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
    updateWorkspacePathsForPathMoves(moves);
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
      setOpenTabs((tabs) =>
        tabs.map((tab) =>
          tab.kind === 'dataset' && tab.datasetId === updatedDataset.id
            ? { ...tab, id: createDatasetTabId(updatedDataset.id) }
            : tab
        )
      );
    }

    await writeProjectDirectoryChanges(useProjectStore.getState(), previousProject, directory);
    refreshExplorer();
    return nextPath;
  };

  const removeWorkspaceSourcesForDeletedEntries = (entries: ExplorerClipboardEntry[]) => {
    const deletedPaths = entries.map((entry) => toProjectRelativePath(entry.path));
    for (const source of Object.values(useProjectStore.getState().sourceImages)) {
      const sourcePath = source.originalFilePath;
      if (
        sourcePath &&
        deletedPaths.some((deletedPath) => sourcePath === deletedPath || sourcePath.startsWith(`${deletedPath}/`))
      ) {
        removeSourceImage(source.id);
      }
    }
    for (const dataset of Object.values(useProjectStore.getState().datasets)) {
      const parentPath = dataset.parentPath || 'Project';
      if (deletedPaths.some((deletedPath) => parentPath === `Project/${deletedPath}` || parentPath.startsWith(`Project/${deletedPath}/`))) {
        removeProjectDataset(dataset.id);
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
      removeWorkspaceSourcesForDeletedEntries(filesystemEntries);
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
          updateWorkspacePathsForPathMoves(moves);
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
        updateWorkspacePathsForPathMoves(moves);
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
      const exportItems = workspaceImages.filter(
        (item) => assetIds.has(item.sourceImageId) && !item.excludedFromDataset
      );
      const directory = requireProjectDirectory();
      if (!directory) {
        return;
      }
      const psdAssets = (await Promise.all(
        (dataset.psdAssetPaths ?? []).map(async (path): Promise<{ file: File; fileName: string } | null> => {
          try {
            const file = await readExplorerFile(directory, path);
            return {
              file,
              fileName: path.split('/').pop() ?? file.name,
            };
          } catch (error) {
            addNotification('warning', error instanceof Error ? error.message : `Unable to read "${path}"`);
            return null;
          }
        })
      )).filter((asset): asset is { file: File; fileName: string } => Boolean(asset));

      if (exportItems.length === 0 && psdAssets.length === 0) {
        createOperationLogger('Export').warning(`no images to export for Dataset "${dataset.name}"`);
        addNotification('warning', 'No images to export');
        return;
      }

      const logger = createOperationLogger('Export');
      const exportCount = exportItems.length + psdAssets.length;
      logger.info(`exporting Dataset "${dataset.name}" with ${exportCount} asset${exportCount !== 1 ? 's' : ''}`);
      const zipBlob = await exportAsZip(
        {
          datasetKeyword: dataset.triggerWord,
          items: exportItems,
          psdAssets,
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
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
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
  }, [activeTab, openTabs]);

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
  };

  const renderFileContextMenuItems = (node: ExplorerTreeNode): ReactNode => (
    <>
      {getContextEntries(node).length === 1 && canOpenExplorerFile(getExplorerFileKind(node.name)) && (
        <button
          type="button"
          onClick={() => {
            void openExplorerFile(node);
            setExplorerContextMenu(null);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
        >
          <File className="h-3.5 w-3.5" />
          <span>Open</span>
        </button>
      )}
      {getContextEntries(node).length === 1 && isExplorerImageFileName(node.name) && Boolean(findWorkspaceImageIdForPath(node.path)) && (
        <>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              void openFileModeTab(node, 'edit');
              setExplorerContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
          >
            <Edit3 className="h-3.5 w-3.5" />
            <span>Photopea</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void openFileModeTab(node, 'caption');
              setExplorerContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
          >
            <Tags className="h-3.5 w-3.5" />
            <span>Caption</span>
          </button>
        </>
      )}
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        onClick={() => {
          setExplorerClipboard({ mode: 'cut', entries: getContextEntries(node) });
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Copy className="h-3.5 w-3.5" />
        <span>Cut</span>
      </button>
      <button
        type="button"
        onClick={() => {
          setExplorerClipboard({ mode: 'copy', entries: getContextEntries(node) });
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Copy className="h-3.5 w-3.5" />
        <span>Copy</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void handleExplorerDuplicate(node);
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Copy className="h-3.5 w-3.5" />
        <span>Duplicate</span>
      </button>
      <div className="my-1 h-px bg-border" />
      {getContextEntries(node).length === 1 && (
        <button
          type="button"
          onClick={() => {
            void handleExplorerRename(node);
            setExplorerContextMenu(null);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
        >
          <Pencil className="h-3.5 w-3.5" />
          <span>Rename</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          void handleExplorerDelete(node);
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span>Delete</span>
      </button>
    </>
  );

  const renderDatasetContextMenuItems = (node: ExplorerTreeNode): ReactNode => (
    <>
      <button
        type="button"
        onClick={() => {
          void openExplorerFile(node);
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Layers3 className="h-3.5 w-3.5" />
        <span>Open</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void openDatasetToolFromExplorer(node, 'select');
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <ScanSearch className="h-3.5 w-3.5" />
        <span>Select</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void openDatasetToolFromExplorer(node, 'review');
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Layers3 className="h-3.5 w-3.5" />
        <span>Review</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void openDatasetToolFromExplorer(node, 'tagging');
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Tags className="h-3.5 w-3.5" />
        <span>Caption</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void openDatasetToolFromExplorer(node, 'analysis');
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <BarChart3 className="h-3.5 w-3.5" />
        <span>Analysis</span>
      </button>
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        onClick={() => {
          setExplorerClipboard({ mode: 'cut', entries: getContextEntries(node) });
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Copy className="h-3.5 w-3.5" />
        <span>Cut</span>
      </button>
      <button
        type="button"
        onClick={() => {
          setExplorerClipboard({ mode: 'copy', entries: getContextEntries(node) });
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Copy className="h-3.5 w-3.5" />
        <span>Copy</span>
      </button>
      {explorerClipboard && (
        <button
          type="button"
          onClick={() => {
            void handleExplorerPaste({ name: projectName || 'Project', path: 'Project', kind: 'folder' });
            setExplorerContextMenu(null);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
        >
          <Copy className="h-3.5 w-3.5" />
          <span>Paste</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          void handleExplorerDuplicate(node);
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Copy className="h-3.5 w-3.5" />
        <span>Duplicate</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void handleDatasetExport(node);
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Download className="h-3.5 w-3.5" />
        <span>Export</span>
      </button>
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        onClick={() => {
          void handleExplorerRename(node);
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
      >
        <Pencil className="h-3.5 w-3.5" />
        <span>Rename</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void handleExplorerDelete(node);
          setExplorerContextMenu(null);
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span>Delete</span>
      </button>
    </>
  );

  const renderDirectoryContextMenuItems = (node: ExplorerTreeNode): ReactNode => (
    <>
      {node.kind === 'folder' && (
        <button
          type="button"
          onClick={() => {
            void handleExplorerNewFolder(node);
            setExplorerContextMenu(null);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
        >
          <FilePlus className="h-3.5 w-3.5" />
          <span>New Folder</span>
        </button>
      )}
      {node.kind === 'folder' && (
        <button
          type="button"
          onClick={() => {
            handleExplorerNewDataset(node.path);
            setExplorerContextMenu(null);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
        >
          <Layers3 className="h-3.5 w-3.5" />
          <span>New Dataset</span>
        </button>
      )}
      {node.kind === 'folder' && (
        <button
          type="button"
          title="Shift-click to import a folder"
          onClick={(event) => {
            void handleExplorerImport(node.path, event.shiftKey);
            setExplorerContextMenu(null);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
        >
          <Upload className="h-3.5 w-3.5" />
          <span>Import</span>
        </button>
      )}
      {(node.path !== 'Project' || explorerClipboard) && <div className="my-1 h-px bg-border" />}
      {node.path === 'Project' ? (
        explorerClipboard && (
          <button
            type="button"
            onClick={() => {
              void handleExplorerPaste(node);
              setExplorerContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Paste</span>
          </button>
        )
      ) : (
        <>
          <button
            type="button"
            onClick={() => {
              setExplorerClipboard({ mode: 'cut', entries: getContextEntries(node) });
              setExplorerContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Cut</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setExplorerClipboard({ mode: 'copy', entries: getContextEntries(node) });
              setExplorerContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Copy</span>
          </button>
          {explorerClipboard && (
            <button
              type="button"
              onClick={() => {
                void handleExplorerPaste(node);
                setExplorerContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>Paste</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void handleExplorerDuplicate(node);
              setExplorerContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Duplicate</span>
          </button>
          <div className="my-1 h-px bg-border" />
          {getContextEntries(node).length === 1 && (
            <button
              type="button"
              onClick={() => {
                void handleExplorerRename(node);
                setExplorerContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary"
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>Rename</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void handleExplorerDelete(node);
              setExplorerContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete</span>
          </button>
        </>
      )}
    </>
  );

  return (
    <div className="flex h-screen bg-background text-foreground">
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
                {TOOLS_MENU_STAGES.map((stage) => {
                  const Icon = stage === 'hub' ? Archive : toolIcons[stage];
                  const active = activeStage === stage;
                  return (
                    <button
                      type="button"
                      key={stage}
                      onClick={() => navigateToStage(stage)}
                      className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary ${
                        active ? 'bg-secondary/70' : ''
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="flex-1">{STAGE_LABELS[stage]}</span>
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
                    setInspectorWindowOpen(true);
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
              const active = activeTabId === tab.id;
              const label =
                tab.kind === 'tool'
                  ? STAGE_LABELS[tab.stage]
                  : tab.kind === 'dataset-tool'
                    ? `${datasetsById[tab.datasetId]?.name ?? 'Dataset'} - ${DATASET_TOOL_LABELS[tab.stage]}`
                  : tab.kind === 'dataset'
                    ? `${datasetsById[tab.datasetId]?.name ?? 'Dataset'} - Dataset`
                  : tab.kind === 'file-edit'
                    ? `${tab.name} - Photopea`
                    : tab.kind === 'file-caption'
                      ? `${tab.name} - Caption`
                      : tab.name;
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
                    const source = draggedTabRef.current ?? event.dataTransfer.getData('text/plain');
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
                    if (!isFileBackedTab(tab)) {
                      return;
                    }
                    event.preventDefault();
                    setExplorerContextMenu({
                      node: { name: tab.name, path: tab.path, kind: 'file' },
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  className={`group flex min-w-[7rem] max-w-52 shrink-0 cursor-pointer items-center gap-2 border-r border-border px-3 text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                    active ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-secondary/60'
                  } ${dragOverTab === tab.id ? 'border-l-2 border-l-primary' : ''}`}
                  title={`Open ${label}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
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
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
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
                  title="Open Photopea"
                  aria-label="Open Photopea"
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
                    Open Photopea
                  </p>
                  {STAGES.map((stage) => {
                    const Icon = stage === 'hub' ? Archive : toolIcons[stage];
                    const isOpen = openTabs.some((tab) => tab.kind === 'tool' && tab.stage === stage);
                    const isDisabled = stage === 'import';
                    return (
                      <DropdownMenu.Item
                        key={stage}
                        disabled={isDisabled}
                        onSelect={() => {
                          if (!isDisabled) {
                            navigateToStage(stage);
                          }
                        }}
                        className={`flex items-center gap-2 rounded px-3 py-2 text-xs outline-none ${
                          isDisabled
                            ? 'cursor-not-allowed opacity-45'
                            : 'cursor-pointer hover:bg-secondary'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span className="min-w-0 flex-1 truncate">{STAGE_LABELS[stage]}</span>
                        {isOpen && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          {showHeaderEditToolbar && (
            <div className="flex shrink-0 items-center gap-1 border-l border-border px-1">
              <button
                type="button"
                onClick={() => runEditCommand('back')}
                disabled={editToolbar.isProcessing}
                className="rounded px-2 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                title="Back"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
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
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-2xl">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-lg font-semibold">Settings</Dialog.Title>
                  <Dialog.Description className="text-sm text-muted-foreground">
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

              <div className="space-y-4">
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

                <div className="rounded-lg border border-border bg-secondary/20 p-4">
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
                        Select file
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
                        Select file
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
                    {explorerContextMenu.node.kind === 'file'
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
                  ? 'h-full min-h-0'
                  : 'p-4 md:p-6'
              }
            >
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
                  renderTool(activeStage, projectDirectoryHandle)
                ) : (
                  <EmptyWorkspacePlaceholder />
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
                {renderInspectorContent()}
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
              {renderFileContextMenuItems(explorerContextMenu.node)}
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
                        ? STAGE_LABELS[tab.stage]
                        : tab.kind === 'dataset-tool'
                          ? `${datasetsById[tab.datasetId]?.name ?? 'Dataset'} - ${DATASET_TOOL_LABELS[tab.stage]}`
                        : tab.kind === 'dataset'
                          ? datasetsById[tab.datasetId]?.name ?? 'Dataset'
                          : tab.name;
                    return (
                      <button
                        type="button"
                        key={tab.id}
                        onClick={() => activateTab(tab)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors ${
                          activeTabId === tab.id ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground">Source</p>
                  <p className="mt-1 text-lg font-semibold">{sourceImages.length}</p>
                </div>
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground">Synthetic</p>
                  <p className="mt-1 text-lg font-semibold">{datasetItems.length}</p>
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
