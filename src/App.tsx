import { WorkspaceWelcome } from './components/workspace/WorkspaceWelcome';
import { WorkspaceTool, type AnalysisScopeTarget, type AssetContextMenuHandler, type DatasetToolName } from './components/workspace/WorkspaceTool';
import { getToolViewContext, setToolViewScope, moveToolViewScope, pruneToolViewScope, type ToolSelectionScope } from './lib/workspaceToolScope';
import { readWorkspacePersistence, writeWorkspacePersistence, getRestorableWorkspaceTabs, readWorkspaceLayout, type WorkspaceLayout } from './lib/workspacePersistence';
import {
  createDatasetToolTabId,
  createFileTabId,
  createToolTab,
  dedupeWorkspaceTabs,
  getInspectorContext,
  isDatasetToolTab,
  orderWorkspaceTabs,
  persistWorkspaceTab,
  type DatasetToolWorkspaceTab,
  type PersistedWorkspaceTab,
  type ToolNestedView,
  type ToolWorkspaceTab,
  type WindowWorkspaceTab,
  type WorkspaceTab,
} from './lib/workspaceTabs';
import { orderDatasetBoardItems } from './lib/datasetBoard';
import { ExplorerPanel } from './components/workspace/ExplorerPanel';
import { ExplorerTree, getExplorerIcon, type ExplorerTreeNode } from './components/workspace/ExplorerTree';
import { checkDirtyDocuments, useDocumentStateStore } from './stores/useDocumentStateStore';
import { type EmptyDatasetSuggestion } from './components/workspace/DatasetBoard';
import { DatasetToolView, DatasetWorkspaceView } from './components/workspace/DatasetWorkspaceView';
import { WorkspaceInspector, type FileInspectorMetadata, type InspectorSectionId } from './components/workspace/WorkspaceInspector';
import { WorkspaceTabMenus, type ExplorerContextMenuState } from './components/workspace/WorkspaceTabMenus';
import { buildDatasetBoardContextActionGroups, buildDirectoryContextActionGroups, buildFileContextActionGroups, type CreateExplorerAction } from './lib/explorerContextActions';
import { findFileTab, isFileBackedTab, moveFileTab, type FileWorkspaceTab } from './lib/workspaceFileTabs';
import { TOOL_ICONS as toolIcons } from './lib/toolDefinitions';
import { WorkspaceSettingsDialog } from './components/workspace/WorkspaceSettingsDialog';
import { addDatasetReferences, addWorkspacePathsToDataset, removeAssetsFromDataset } from './lib/assetActions';
import { AppShell } from './components/workspace/AppShell';
import { WorkspaceMenus, type WorkspaceMenu } from './components/workspace/WorkspaceMenus';
import { WorkspaceStatusBar } from './components/workspace/WorkspaceStatusBar';
import { WorkspaceNotifications } from './components/workspace/WorkspaceNotifications';
import { isOperationRunning, useOperationStore } from './stores/useOperationStore';
import { useWorkspaceAppearance } from './hooks/useWorkspaceAppearance';
import { useEscapeToClose } from './hooks/useEscapeToClose';
import { useLocalTaggerFilePicker } from './hooks/useLocalTaggerFilePicker';
import { useWorkspaceCommands, type ExplorerItemEntry, type ExplorerClipboard } from './hooks/useWorkspaceCommands';
import { useHistoryStore } from './stores/useHistoryStore';
import { useCommandPalette } from './components/workspace/Commands';
import { flushProjectSave, runProjectFileOperation, useProjectSave } from './hooks/useProjectSave';
import { ProjectSetupDialog } from './components/ProjectSetupDialog';
import { PROJECT_TYPE_PROFILES } from './lib/projectProfiles';
import type { ProjectType } from './types';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent, SetStateAction } from 'react';
import {
  ArrowLeft,
  FolderOpen,
  GitBranch,
  Layers3,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pin,
} from 'lucide-react';
import { useProjectStore } from './stores/useProjectStore';
import { useInspectorSelectionStore } from './stores/useInspectorSelectionStore';
import { useUIStore } from './stores/useUIStore';
import {
  TOOLS,
  TOOL_LABELS,
  getUrlSlugForTool,
  readToolFromUrl,
} from './lib/constants';
import {
  createWorkspaceFileAssetId,
  getProjectDataFileExtension,
  toProjectRelativePath,
  toWorkspaceImages,
  toWorkspaceReviewAssets,
  type WorkspaceFileAsset,
  type WorkspaceImage,
} from './lib/workspaceImages';
import { collectWorkspaceFileAssets, generateMissingWorkspacePsdPreviews, invalidateWorkspaceFileAssetCache, updateWorkspaceFileAssetCache } from './lib/workspaceFileAssets';
import { buildEmptyExplorerTree, sanitizeExplorerTree, emptyExplorerChanges, findExplorerTreeNode, moveExplorerTreeNodes, replaceExplorerTreeNode, type ExplorerChanges } from './lib/explorerTreeUpdates';
import { clearLegacyExclusionAtPath } from './services/project/legacyDatasetExclusionService';
import {
  createProjectDirectory,
  clearProjectDirectory,
  pickProjectDirectory,
  projectDirectoryHasManifest,
  readProjectDirectory,
  writeProjectPreview,
  type ProjectDirectoryHandle,
} from './services/project/projectDirectoryService';
import { getImportFilesFromDataTransfer, importImageFiles, type ImportInputFile, type ImportImagesOptions, type ImportImagesResult } from './services/import/importService';
import { restoreSavedLocalTagger } from './services/tagging/localTaggerConnectionService';
import { createOperationLogger } from './services/logging/applicationLog';
import { applyBuildSessionPathMoves } from './services/build/buildSessionService';
import { indexProjectAssets } from './services/project/assetIndexService';
import {
  isLegacyProjectRootPath,
} from './services/project/projectPathFilters';
import { InternalFileViewer } from './components/InternalFileViewer';
import { type ContextActionGroup } from './components/ui/ContextActions';
import {
  applyExplorerPathMoves,
  applyProjectRelativePathMoves,
  applyFileAssetOrderPathMoves,
  type ExplorerPathMove,
} from './lib/datasetAssets';
import { PhotopeaPsdPreviewWorker } from './components/photopea/PhotopeaFrame';
import {
  canOpenExplorerFile,
  copyExplorerEntries,
  createExplorerDirectory,
  deleteExplorerEntry,
  duplicateExplorerEntries,
  getExplorerParentDirectory,
  getDirectoryAtExplorerPath,
  getExplorerFileKind,
  getUniqueExplorerName,
  isExplorerImageFileName,
  moveExplorerEntries,
  readExplorerDirectory,
  readExplorerFile,
  renameExplorerEntry,
  ExplorerBatchError,
  ExplorerRecoveryError,
  type ExplorerClipboardEntry,
} from './services/project/explorerFileService';
import { createProject, type ProjectState, type Dataset, type ToolName } from './types';
import { createProjectVersion, listProjectVersions, restoreProjectVersion, ProjectVersionRestoreError, type ProjectVersion } from './services/project/projectVersionService';
import {
  PROJECT_DATASET_DIRECTORY,
  PROJECT_SHARED_DIRECTORY,
} from './services/project/projectLayoutService';
import { DockWorkspace, type DockView } from './components/workspace/DockWorkspace';
import { useDockWorkspace } from './hooks/useDockWorkspace';
import { useWorkspaceNavigation } from './hooks/useWorkspaceNavigation';
import { DATASET_VIEW, EXPLORER_VIEW, findDockGroup } from './lib/workspaceLayout';
import { hasBusyVideoTabs } from './services/video/videoClient';
import { DATASET_EXPLORER_PATH, isProjectDatasetPath } from './services/dataset/datasetFolderService';


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

const DATASET_TOOL_LABELS = { ...TOOL_LABELS, select: 'Add files', analysis: TOOL_LABELS.analysis, review: TOOL_LABELS.review, tagging: TOOL_LABELS.tagging };

const formatFileSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

type FilesystemExplorerItemEntry = ExplorerItemEntry & { kind: 'folder' | 'file' };

const isFilesystemExplorerEntry = (entry: ExplorerItemEntry): entry is FilesystemExplorerItemEntry =>
  entry.kind === 'folder' || entry.kind === 'file';

function App() {
  const projectId = useProjectStore((state) => state.id);
  const projectName = useProjectStore((state) => state.name);
  const projectType = useProjectStore((state) => state.projectType);
  const currentTool = useProjectStore((state) => state.currentTool);
  const profile = useProjectStore((state) => PROJECT_TYPE_PROFILES[state.projectType]);
  const [projectSetup, setProjectSetup] = useState<{ name: string; migration: boolean; complete: (value: { name: string; projectType: ProjectType } | null) => void } | null>(null);
  const requestProjectSetup = (name: string, migration: boolean) => new Promise<{ name: string; projectType: ProjectType } | null>((resolve) => {
    setProjectSetup({ name, migration, complete: (value) => { setProjectSetup(null); resolve(value); } });
  });
  const loadProject = useProjectStore((state) => state.loadProject);
  const renameProject = useProjectStore((state) => state.renameProject);
  const setCurrentTool = useProjectStore((state) => state.setCurrentTool);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  useEffect(() => { void restoreSavedLocalTagger(); }, []);
  const updateWorkspaceSettings = useProjectStore((state) => state.updateWorkspaceSettings);
  const updateBuildSession = useProjectStore((state) => state.updateBuildSession);
  const addSourceImage = useProjectStore((state) => state.addSourceImage);
  const removeSourceImage = useProjectStore((state) => state.removeSourceImage);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const updateProjectDataset = useProjectStore((state) => state.updateDataset);
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const datasetItemsById = useProjectStore((state) => state.datasetItems);
  const globalDataset = useProjectStore((state) => state.dataset);
  const datasetsById = useMemo<Record<string, Dataset>>(
    () => ({ [globalDataset.id]: globalDataset }),
    [globalDataset]
  );
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const datasetItems = useMemo(
    () => Object.values(datasetItemsById).filter((item) => !item.deleted),
    [datasetItemsById]
  );
  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, datasetItems),
    [datasetItems, sourceImages]
  );
  const documentStates = useDocumentStateStore(state => state.documents);
  const addNotification = useUIStore(state => state.addNotification);
  const operationLogs = useUIStore(state => state.operationLogs);
  const projectDirectoryHandle = useUIStore(state => state.projectDirectoryHandle);
  const projectDirectoryName = useUIStore(state => state.projectDirectoryName);
  const setProjectDirectory = useUIStore(state => state.setProjectDirectory);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const [openMenu, setOpenMenu] = useState<WorkspaceMenu | null>(null);
  const [isWorkspaceSettingsOpen, setIsWorkspaceSettingsOpen] = useState(false);
  const [isProjectDirectoryBusy, setIsProjectDirectoryBusy] = useState(false);
  const [datasetAssemblyRequestToken, setDatasetAssemblyRequestToken] = useState(0);
  const projectMenuButtonRef = useRef<HTMLButtonElement>(null);
  const projectOperationOriginRef = useRef<HTMLElement | null>(null);
  const projectWasBusyRef = useRef(false);
  useEffect(() => {
    if (projectWasBusyRef.current && !isProjectDirectoryBusy) {
      const frame = requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return;
        const origin = projectOperationOriginRef.current;
        (origin?.isConnected && origin !== document.body && origin !== document.documentElement
          ? origin : projectMenuButtonRef.current)?.focus();
      });
      projectWasBusyRef.current = false;
      return () => cancelAnimationFrame(frame);
    }
    projectWasBusyRef.current = isProjectDirectoryBusy;
  }, [isProjectDirectoryBusy]);
  const [projectVersions, setProjectVersions] = useState<ProjectVersion[]>([]);
  const [currentProjectVersionId, setCurrentProjectVersionId] = useState<string | undefined>();
  const [newVersionName, setNewVersionName] = useState('');
  const [storedWorkspaceLayout] = useState(readWorkspaceLayout);
  const persistWorkspaceRef = useRef<(() => void) | null>(null);
  const [initialWorkspaceTabs] = useState<WorkspaceTab[]>(() =>
    getRestorableWorkspaceTabs(storedWorkspaceLayout).filter((tab) => tab.kind !== 'window' || tab.window === 'dataset')
  );
  const [openTabs, setOpenTabsState] = useState<WorkspaceTab[]>(initialWorkspaceTabs);
  const openTabsRef = useRef(openTabs);
  const setOpenTabs = useCallback((update: SetStateAction<WorkspaceTab[]>) => {
    const next = typeof update === 'function' ? update(openTabsRef.current) : update;
    openTabsRef.current = next;
    setOpenTabsState(next);
  }, []);
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    storedWorkspaceLayout.activeTabId === null ? null : initialWorkspaceTabs.some((tab) => tab.id === storedWorkspaceLayout.activeTabId)
      ? storedWorkspaceLayout.activeTabId ?? null
      : initialWorkspaceTabs[0]?.id ?? null
  );
  const dock = useDockWorkspace(storedWorkspaceLayout, openTabs.filter((tab) => tab.kind !== 'window').map((tab) => tab.id), activeTabId, openTabs.filter((tab) => tab.pinned).map((tab) => tab.id));
  const leftPanelOpen = dock.explorerOpen;
  const [activeActivityView, setActiveActivityView] = useState<'explorer' | 'versions'>(
    storedWorkspaceLayout.activeActivityView ?? 'explorer'
  );
  const [explorerTree, setExplorerTree] = useState<ExplorerTreeNode | null>(null);
  const explorerTreeRef = useRef(explorerTree);
  explorerTreeRef.current = explorerTree;
  const explorerReadRevision = useRef(0);
  const explorerMutationChanges = useRef<ExplorerChanges | null>(null);
  const [explorerDropTargetPath, setExplorerDropTargetPath] = useState<string | null>(null);
  const visibleExplorerTree = useMemo(() => sanitizeExplorerTree(explorerTree), [explorerTree]);
  const [, setExplorerStatus] = useState<'ready' | 'loading' | 'error'>('ready');
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [expandedExplorerPaths, setExpandedExplorerPaths] = useState<Set<string>>(
    () => new Set(['Project'])
  );
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [closedTabs, setClosedTabs] = useState<WorkspaceTab[]>([]);
  const [toolMenuPosition, setToolMenuPosition] = useState({ x: 0, y: 0 });
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const { pickLocalTaggerFile, inputs: localTaggerFileInputs } = useLocalTaggerFilePicker();
  const explorerPanelRef = useRef<HTMLDivElement | null>(null);
  const outputLogRef = useRef<HTMLDivElement | null>(null);
  const outputAutoFollowRef = useRef(true);
  const projectSessionRef = useRef(0);
  const projectOperationBusyRef = useRef(false);
  const [explorerContextMenu, setExplorerContextMenu] = useState<ExplorerContextMenuState | null>(null);
  const [inspectorSectionsOpen, setInspectorSectionsOpen] = useState<Record<InspectorSectionId, boolean>>({
    object: false,
    actions: true,
    file: true,
    dataset: true,
    photopea: true,
    review: true,
    analysis: true,
    caption: true,
  });
  const [fileInspectorMetadata, setFileInspectorMetadata] = useState<FileInspectorMetadata | null>(null);
  const [workspaceFileAssets, setWorkspaceFileAssets] = useState<WorkspaceFileAsset[]>([]);
  const [dismissedEmptyDatasetSuggestionSignatures, setDismissedEmptyDatasetSuggestionSignatures] = useState<Set<string>>(
    () => new Set()
  );
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
    kind: 'folder' | 'file';
    value: string;
  } | null>(null);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);

  const setInspectorSectionOpen = (section: InspectorSectionId, open: boolean) => {
    setInspectorSectionsOpen((sections) =>
      sections[section] === open ? sections : { ...sections, [section]: open }
    );
  };

  const { theme, setTheme, density, setDensity } = useWorkspaceAppearance();

  useEffect(() => {
    const outputLog = outputLogRef.current;
    if (!outputLog || !outputAutoFollowRef.current) {
      return;
    }

    outputLog.scrollTop = outputLog.scrollHeight;
  }, [operationLogs.length]);

  const [navigationRecovery, setNavigationRecovery] = useState(false);
  useWorkspaceNavigation({
    projectId, activeId: activeTabId, views: openTabs, closedViews: closedTabs,
    toolFromUrl: () => { const tool = readToolFromUrl(); return tool ? createToolTab(tool) : null; },
    toolSlug: tab => tab.kind === 'tool' ? getUrlSlugForTool(tab.tool) : null,
    activate: tab => {
      if (tab) {
        setNavigationRecovery(false);
        setOpenTabs(tabs => tabs.some(item => item.id === tab.id) ? tabs : [...tabs, tab]);
        dock.show(tab.id);
        if (tab.kind === 'tool') setCurrentTool(tab.tool);
      }
      setActiveTabId(tab?.id ?? null);
      requestAnimationFrame(() => {
        const target = tab ? document.getElementById(`panel-${tab.id}`) : document.querySelector<HTMLElement>('[data-workspace-welcome]');
        target?.focus();
      });
    },
    unavailable: () => setNavigationRecovery(true),
  });

  const projectSave = useProjectSave();
  const openCommands = useCommandPalette();

  useEffect(() => {
    if (!(TOOLS as readonly string[]).includes(currentTool)) {
      setCurrentTool('import');
    }
  }, [currentTool, setCurrentTool]);

  useEscapeToClose(Boolean(openMenu || tabMenuOpen || workspaceContextMenu), () => {
    setOpenMenu(null);
    setTabMenuOpen(false);
    setWorkspaceContextMenu(null);
  });

  useEscapeToClose(Boolean(explorerContextMenu), () => setExplorerContextMenu(null));

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeInspectorSelection = useInspectorSelectionStore((state) =>
    state.projectId === projectId && state.activeOwnerId === activeTabId && activeTabId
      ? state.selections[activeTabId] ?? null
      : null
  );
  const activeTool = activeTab?.kind === 'tool' || activeTab?.kind === 'dataset-tool' ? activeTab.tool : null;
  const activeDataset =
    activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
      ? datasetsById[activeTab.datasetId]
      : activeTab?.kind === 'window' && activeTab.window === 'dataset'
        ? globalDataset
      : null;
  const activeDatasetSourceImages = useMemo(
    () => Object.values(sourceImagesById).filter((asset) => isProjectDatasetPath(asset.originalFilePath)),
    [sourceImagesById]
  );
  const workspaceReviewItems = useMemo(
    () => toWorkspaceReviewAssets(sourceImages, workspaceFileAssets, {}, datasetItems),
    [datasetItems, sourceImages, workspaceFileAssets]
  );
  const activeDatasetPreviewItems = useMemo(
    () => orderDatasetBoardItems(
      toWorkspaceReviewAssets(activeDatasetSourceImages, workspaceFileAssets.filter(asset => isProjectDatasetPath(asset.path)), {}, datasetItems)
        .filter(item => isProjectDatasetPath(item.assetPath)),
      globalDataset.assetOrder,
      activeDatasetSourceImages.map(item => item.id)
    ),
    [globalDataset.assetOrder, activeDatasetSourceImages, datasetItems, workspaceFileAssets]
  );
  const globalDatasetTags = useMemo(
    () => [...new Set(activeDatasetPreviewItems.flatMap((item) => item.tags ?? []))]
      .sort((left, right) => left.localeCompare(right)),
    [activeDatasetPreviewItems]
  );
  const projectTags = useMemo(
    () => [...new Set([...sourceImages.flatMap((image) => image.tags ?? []), ...globalDatasetTags])]
      .sort((left, right) => left.localeCompare(right)),
    [globalDatasetTags, sourceImages]
  );
  const activeEmptyDatasetSuggestion = useMemo<EmptyDatasetSuggestion | null>(() => {
    const isEmpty = activeDatasetPreviewItems.length === 0;
    if (!isEmpty) {
      return null;
    }

    const candidates = workspaceImages
      .filter((item) => {
        const tagCount = item.tags?.length ?? 0;
        return (
          item.kind === 'image' &&
          Boolean(item.sourceImageId) &&
          !item.hidden &&
          tagCount > 0
        );
      })
      .sort(
        (left, right) =>
          (right.tags?.length ?? 0) - (left.tags?.length ?? 0) ||
          left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: 'base' })
      );
    if (candidates.length === 0) {
      return null;
    }

    const assetIds = [...new Set(candidates.map((item) => item.sourceImageId).filter(Boolean))];
    const signature = `${globalDataset.id}:${assetIds
      .map((assetId) => {
        const item = candidates.find((candidate) => candidate.sourceImageId === assetId);
        return `${assetId}:${item?.tags?.length ?? 0}`;
      })
      .join('|')}`;
    if (dismissedEmptyDatasetSuggestionSignatures.has(signature)) {
      return null;
    }

    return {
      signature,
      items: candidates.slice(0, 24),
      assetIds,
      totalCount: assetIds.length,
    };
  }, [activeDatasetPreviewItems.length, globalDataset, dismissedEmptyDatasetSuggestionSignatures, workspaceImages]);
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
  }, [activeFileWorkspaceItem, activeTab]);
  const getWorkspaceTabChrome = (tab: WorkspaceTab) => {
    const Icon =
      tab.kind === 'tool'
        ? toolIcons[tab.tool]
        : tab.kind === 'window'
          ? tab.window === 'output' ? PanelBottom : tab.window === 'project' ? FolderOpen : tab.window === 'dataset' ? Layers3 : PanelRight
        : tab.kind === 'dataset-tool'
          ? toolIcons[tab.tool]
        : tab.kind === 'dataset'
          ? Layers3
          : getExplorerIcon({ name: tab.name, path: tab.path, kind: 'file' });
    const label =
      tab.kind === 'tool'
        ? tab.tool === 'review' && tab.scope?.review
          ? `${TOOL_LABELS[tab.tool]}: ${tab.scope.review.label}`
          : TOOL_LABELS[tab.tool]
        : tab.kind === 'window'
          ? tab.window === 'output' ? 'Output' : tab.window === 'project' ? 'Project' : tab.window === 'dataset' ? 'Dataset' : 'Inspector'
        : tab.kind === 'dataset-tool'
          ? `${DATASET_TOOL_LABELS[tab.tool]}: ${datasetsById[tab.datasetId]?.name ?? 'Dataset'}`
        : tab.kind === 'dataset'
          ? `Dataset: ${datasetsById[tab.datasetId]?.name ?? 'Dataset'}`
        : tab.kind === 'file-edit'
          ? `Photopea: ${tab.name}`
          : tab.kind === 'file-analysis'
            ? `Analysis: ${tab.name}`
          : tab.kind === 'file-video'
            ? `Video Frames: ${tab.name}`
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
          : tab.kind === 'window'
            ? 'Workspace window'
            : 'File';
    const title = `${label} - ${target}`;

    return { Icon, label, target, title };
  };
  const activeInspectorContext = getInspectorContext(activeTab, activeTool);
  const showFileInspector = Boolean(activeTab && isFileBackedTab(activeTab));
  const showAnalysisInspector = activeInspectorContext === 'analysis';

  const setToolTabNestedView = async (tabId: string, nested: ToolNestedView | undefined) => {
    const current = openTabs.find(tab => tab.id === tabId);
    if (current?.kind === 'tool' && current.nested?.itemId !== nested?.itemId) {
      if (useOperationStore.getState().entries.some(entry => entry.viewId === tabId && isOperationRunning(entry))) {
        addNotification('warning', 'Finish saving before leaving this editor.'); return;
      }
      if (!await confirmClosingTabs([current])) return;
    }
    setOpenTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId && (tab.kind === 'tool' || tab.kind === 'dataset-tool')
          ? { ...tab, nested }
          : tab
      )
    );
  };

  useEffect(() => {
    let canceled = false;

    if (!projectDirectoryHandle) {
      setWorkspaceFileAssets([]);
      return;
    }

    const loadDatasetWorkspaceFileAssets = async () => {
      try {
        const assets = await collectWorkspaceFileAssets(projectDirectoryHandle);
        const pendingAssets = assets.map((asset) =>
          asset.kind === 'psd' && !asset.previewUrl ? { ...asset, previewStatus: 'queued' as const } : asset
        );

        if (canceled) {
          return;
        }

        setWorkspaceFileAssets(pendingAssets);
        void generateMissingWorkspacePsdPreviews(
          projectDirectoryHandle,
          pendingAssets,
          (path, update) => {
            setWorkspaceFileAssets((currentAssets) =>
              currentAssets.map((asset) => (asset.path === path ? { ...asset, ...update } : asset))
            );
          },
          () => canceled
        );
      } catch (error) {
        if (!canceled) {
          setWorkspaceFileAssets([]);
          addNotification('warning', error instanceof Error ? error.message : 'Unable to read Dataset file assets');
        }
      }
    };

    void loadDatasetWorkspaceFileAssets();

    return () => {
      canceled = true;
    };
  }, [addNotification, assetPreviewRefreshKey, projectDirectoryHandle]);

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
    if (activeTabId === null || openTabs.some((tab) => tab.id === activeTabId)) {
      return;
    }
    setActiveTabId(openTabs[0]?.id ?? null);
  }, [activeTabId, openTabs]);


  const navigateToTool = (
    tool: ToolName,
    scopes?: ToolSelectionScope
  ) => {
    if (!profile.enabledTools.includes(tool)) return;
    setNavigationRecovery(false);
    const nextTab = createToolTab(tool, scopes);
    dock.show(nextTab.id);
    setOpenTabs(tabs => setToolViewScope(tabs.some(tab => tab.id === nextTab.id) ? tabs : [...tabs, nextTab], nextTab.id, scopes));
    setActiveTabId(nextTab.id);
    setCurrentTool(tool);
    focusView(nextTab.id);
    setOpenMenu(null);
    setTabMenuOpen(false);
  };

  const activateTab = (tab: WorkspaceTab) => {
    setNavigationRecovery(false);
    dock.show(tab.id);
    setActiveTabId(tab.id);
    if (tab.kind === 'tool') {
      setCurrentTool(tab.tool);
    }
    setOpenMenu(null);
    setTabMenuOpen(false);
    setWorkspaceContextMenu(null);
  };

  const pushClosedTabs = (tabs: WorkspaceTab[]) => {
    if (tabs.length === 0) {
      return;
    }
    setClosedTabs((current) => [...tabs, ...current.filter((tab) => !tabs.some((closedTab) => closedTab.id === tab.id))].slice(0, 12));
  };

  const toggleTabPinned = (tabId: string) => {
    setOpenTabs((tabs) => orderWorkspaceTabs(tabs.map((tab) => (tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab))));
    setWorkspaceContextMenu(null);
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
    setWorkspaceContextMenu(null);
  };

  const isTabDirty = (tab: WorkspaceTab): boolean =>
    Boolean(documentStates[tab.id]?.dirty ?? tab.dirty);

  const applyWorkspaceTabsForProject = (nextProject: ProjectState) => {
    const nextProjectId = nextProject.id;
    const layout = readWorkspaceLayout(nextProjectId);
    if (layout.projectId === nextProjectId) {
      const savedDock = readWorkspacePersistence(window.localStorage, nextProjectId).dock;
      if (savedDock) dock.setLayout(savedDock);
      setActiveActivityView(layout.activeActivityView ?? 'explorer');
    }
    const datasets = { [nextProject.dataset.id]: nextProject.dataset };
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
      return tab.kind === 'window' && tab.window === 'dataset';
    });

    const currentToolTabs = openTabs.filter((tab): tab is ToolWorkspaceTab => tab.kind === 'tool').map(tab => ({
      ...tab,
      scope: tab.scope?.review ? { review: tab.scope.review } : undefined,
      nested: undefined,
      dirty: false,
    }));
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

  const confirmClosingTabs = async (tabs: WorkspaceTab[]): Promise<boolean> => {
    if (hasBusyVideoTabs(tabs.map((tab) => tab.id)) && !window.confirm('Cancel the running video operation and close its tab? Already saved frames will remain in the project.')) return false;
    let checked: string[];
    try { checked = await checkDirtyDocuments(tabs.map(tab => tab.id)); }
    catch (error) { addNotification('error', error instanceof Error ? error.message : 'Could not verify unsaved changes'); return false; }
    const registered = useDocumentStateStore.getState().documents;
    const dirtyCount = tabs.filter(tab => checked.includes(tab.id) || (!registered[tab.id] && tab.dirty)).length;
    if (dirtyCount === 0) {
      return true;
    }
    return window.confirm(
      `Close ${dirtyCount === 1 ? '1 tab' : `${dirtyCount} tabs`} with unsaved changes?`
    );
  };

  useEffect(() => {
    const persist = () => {
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
        writeWorkspacePersistence(
          window.localStorage,
          {
            openTabs: nextOpenTabs,
            activeTabId: persistedActiveTab
              ? persistableActiveTab?.id ?? null
              : projectDirectoryHandle
                ? null
                : storedWorkspaceLayout.activeTabId ?? null,
            projectId: projectDirectoryHandle ? projectId : storedWorkspaceLayout.projectId ?? null,
            activeActivityView,
          } satisfies Partial<WorkspaceLayout>,
          dock.layout,
          projectDirectoryHandle ? projectId : undefined
        );
      } catch {
        // Workspace layout is a convenience; private browsing can disable localStorage.
      }
    };
    persistWorkspaceRef.current = persist;
    const timer = window.setTimeout(persist, 120);
    window.addEventListener('pagehide', persist);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', persist);
    };
  }, [
    activeActivityView,
    activeTabId,
    openTabs,
    projectDirectoryHandle,
    projectId,
    dock.layout,
  ]);

  useEffect(() => {
    let canceled = false;

    const loadExplorerTree = async () => {
      const revision = ++explorerReadRevision.current;
      if (projectDirectoryHandle) {
        setExplorerStatus('loading');
        setExplorerError(null);
        try {
          const tree = await readExplorerDirectory(
            projectDirectoryHandle,
            projectDirectoryName ?? projectDirectoryHandle.name,
            'Project'
          );
          if (!canceled && revision === explorerReadRevision.current) {
            setExplorerTree(tree);
            setExplorerStatus('ready');
          }
        } catch (error) {
          if (!canceled && revision === explorerReadRevision.current) {
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
    if (!node || (node.kind === 'folder' && !expandedExplorerPaths.has(node.path))) {
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
    const row = Array.from(explorerPanelRef.current?.querySelectorAll<HTMLElement>('[data-explorer-row]') ?? [])
      .find(element => element.dataset.explorerPath === node.path);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
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
    const currentIndex = visibleNodes.findIndex((node) => node.path === focusedPath);
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
                workspaceImageId: node.kind === 'file' ? findWorkspaceImageIdForPath(node.path) ?? undefined : undefined,
              }]
            : []
        )
    );

  const createExplorerEntryForNode = (node: ExplorerTreeNode): ExplorerItemEntry => ({
    path: node.path,
    name: node.name,
    kind: node.kind,
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
    return [{ path: node.path, name: node.name, kind: node.kind }];
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

  const handleExplorerMarqueeSelection = useCallback((paths: string[]) => {
    setSelectedExplorerPaths(new Set(paths));
    setSelectionAnchorPath(paths[0] ?? null);
    setFocusedExplorerPath(paths[0] ?? null);
  }, []);

  const selectExplorerNode = (node: ExplorerTreeNode, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
    setActiveExplorerNode(node);
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (node.kind === 'file') {
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

    const edited = Object.values(projectState.datasetItems).find(
      (item) =>
        (item.imageDataPath ?? `.dataset-creator-data/generated-images/${item.id}/image.png`) === projectRelativePath
    );
    if (edited) {
      return `edited:${edited.id}`;
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
      if (entry.workspaceImageId?.startsWith('edited:')) {
        const edited = datasetItemsById[entry.workspaceImageId.replace(/^edited:/, '')];
        if (edited) {
          assetIds.add(edited.sourceImageId);
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
          : workspaceImageId?.startsWith('edited:')
            ? datasetItemsById[workspaceImageId.replace(/^edited:/, '')]?.sourceImageId
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

  const indexProjectWorkspaceAssets = async (save = true, paths?: string[], updateUi = true) => {
    if (!projectDirectoryHandle) {
      return;
    }
    for (const path of paths ?? []) {
      if (isProjectDatasetPath(path)) await clearLegacyExclusionAtPath(projectDirectoryHandle,path);
    }

    await indexProjectAssets(projectDirectoryHandle, {
      logger: createOperationLogger('Index'),
      paths,
      existingSourceImages: useProjectStore.getState().sourceImages,
      onAssetIndexed: async ({ sourceImage }) => {
        const previousProject = useProjectStore.getState();
        if (sourceImage && !previousProject.sourceImages[sourceImage.id]) {
          addSourceImage(sourceImage);
        }
      },
    });
    if (save) await flushProjectSave();
    if (updateUi) {
      refreshExplorer();
      useUIStore.getState().refreshAssetPreviews();
    }
  };

  const importDroppedFilesIntoDataset = async (
    dataTransfer: DataTransfer,
    _dataset: Dataset
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
    const result = await importImageFiles(files, {
      logger: createOperationLogger('Dataset'),
      destination: {
        projectDirectory: projectDirectoryHandle,
        explorerPath: DATASET_EXPLORER_PATH,
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
      await flushProjectSave();
      refreshExplorer();
    }

    return { assetIds: importedAssetIds, assetPaths: importedAssetPaths, psdAssetPaths: importedPsdPaths };
  };

  const toPhysicalExplorerEntry = (entry: ExplorerItemEntry): ExplorerClipboardEntry => ({
    path: entry.path,
    name: entry.name,
    kind: entry.kind === 'folder' ? 'folder' : 'file',
  });

  const openProjectDataset = () => {
    const dataset = useProjectStore.getState().dataset;
    if (!dataset) {
      addNotification('error', 'Dataset is no longer available');
      return;
    }

    const tab: WindowWorkspaceTab = { id: DATASET_VIEW, kind: 'window', window: 'dataset' };
    setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
    setActiveTabId(tab.id);
    dock.show(DATASET_VIEW);
    requestAnimationFrame(() => document.getElementById(`panel-${DATASET_VIEW}`)?.focus());
  };

  const openDatasetToolTab = (datasetId: string, tool: DatasetToolName) => {
    if (!profile.enabledTools.includes(tool)) return;
    const dataset = useProjectStore.getState().dataset;
    if (!dataset) {
      addNotification('error', 'Dataset is no longer available');
      return;
    }

    const tab: DatasetToolWorkspaceTab = {
      id: createDatasetToolTabId(datasetId, tool),
      kind: 'dataset-tool',
      datasetId,
      tool,
    };
    setOpenTabs((tabs) => (tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab]));
    setActiveTabId(tab.id);
  };

  const updateDatasetFileBackedState = async (
    dataset: Dataset,
    updates: Partial<Pick<Dataset, 'name' | 'triggerWord' | 'assetOrder'>>
  ) => {
    // Merge only the changed fields into the latest store snapshot. Passing a
    // captured Dataset back here can overwrite membership added by another panel.
    updateProjectDataset(dataset.id, updates);
    await flushProjectSave();
  };

  const dismissEmptyDatasetSuggestion = (signature: string) => {
    setDismissedEmptyDatasetSuggestionSignatures((current) => {
      const next = new Set(current);
      next.add(signature);
      return next;
    });
  };

  const applyEmptyDatasetSuggestion = async (dataset: Dataset, suggestion: EmptyDatasetSuggestion) => {
    const currentDataset = useProjectStore.getState().dataset;
    if (!currentDataset) {
      addNotification('warning', 'Dataset is no longer available');
      return;
    }

    const addedCount = await addDatasetReferences({ assetIds: suggestion.assetIds });
    if (addedCount <= 0) {
      dismissEmptyDatasetSuggestion(suggestion.signature);
      addNotification('info', 'Suggested assets are already in this Dataset');
      return;
    }
    await flushProjectSave();
    addNotification('success', `Added ${addedCount} asset${addedCount !== 1 ? 's' : ''} to ${dataset.name}`);
  };

  const removeDatasetBoardAsset = async (_dataset: Dataset, item: WorkspaceImage) => {
    await removeAssetsFromDataset([item]);
    await flushProjectSave();
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
    setActiveExplorerNode(node);
    setSelectedExplorerPaths(new Set([node.path]));
    setSelectionAnchorPath(node.path);
    setExplorerContextMenu({
      node,
      x: event.clientX,
      y: event.clientY,
      actionGroups: buildDatasetBoardContextActionGroups(node, {
        createExplorerAction, findWorkspaceImageIdForPath, openExplorerFile, openFileModeTab,
        removeFromDataset: () => removeDatasetBoardAsset(dataset, item),
      }),
    });
  };

  const renderDatasetTool = (tab: DatasetToolWorkspaceTab) => (
    <DatasetToolView tab={tab} dataset={datasetsById[tab.datasetId]} activeTabId={activeTabId} projectDirectoryHandle={projectDirectoryHandle}
      indexProjectWorkspaceAssets={() => indexProjectWorkspaceAssets()} updateDatasetFileBackedState={updateDatasetFileBackedState}
      addNotification={addNotification} openDatasetToolTab={openDatasetToolTab} setAssemblyRequestToken={setDatasetAssemblyRequestToken}
      openProjectDataset={openProjectDataset} navigateToTool={navigateToTool} openAssetExplorerContextMenu={openAssetExplorerContextMenu}
      openDatasetBoardAssetContextMenu={openDatasetBoardAssetContextMenu} />
  );

  const openExplorerFile = async (node: ExplorerTreeNode) => {
    if (node.kind !== 'file') {
      return;
    }
    const existing = findFileTab(openTabsRef.current, node.path, 'file-view');
    if (existing) { setActiveTabId(existing.id); return; }
    const session = projectSessionRef.current;

    try {
      if (!projectDirectoryHandle) {
        addNotification('warning', 'Open a project directory before opening Explorer files.');
        return;
      }

      const file = await readExplorerFile(projectDirectoryHandle, node.path);
      if (session !== projectSessionRef.current) return;
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
        id: createFileTabId(),
        kind: 'file-view',
        path: node.path,
        name: node.name,
        fileKind,
        file,
        workspaceImageId: findWorkspaceImageIdForPath(node.path) ?? undefined,
      };

      const current = findFileTab(openTabsRef.current, tab.path, tab.kind);
      if (!current) setOpenTabs(tabs => [...tabs, tab]);
      setActiveTabId(current?.id ?? tab.id);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to open file');
    }
  };

  const openFileModeTab = async (node: ExplorerTreeNode, mode: 'edit' | 'caption' | 'analysis' | 'video') => {
    const kind: FileWorkspaceTab['kind'] = mode === 'video' ? 'file-video' : mode === 'edit' ? 'file-edit' : mode === 'analysis' ? 'file-analysis' : 'file-caption';
    const existing = findFileTab(openTabsRef.current, node.path, kind);
    if (existing) { setActiveTabId(existing.id); return; }
    const session = projectSessionRef.current;
    try {
      const imageId = findWorkspaceImageIdForPath(node.path);
      if (mode === 'caption' && !imageId) {
        addNotification('warning', 'Caption is available for project workspace images.');
        return;
      }

      if (!projectDirectoryHandle) {
        addNotification('warning', 'Open a project directory before opening Explorer files.');
        return;
      }

      const file = await readExplorerFile(projectDirectoryHandle, node.path, { snapshot: mode !== 'video' });
      if (session !== projectSessionRef.current) return;
      if (!file) {
        addNotification('error', 'File is no longer available');
        return;
      }

      const tab: FileWorkspaceTab = {
        id: createFileTabId(),
        kind,
        path: node.path,
        name: node.name,
        fileKind: getExplorerFileKind(node.name, 'type' in file ? file.type : undefined),
        file,
        workspaceImageId: imageId ?? undefined,
      };

      const current = findFileTab(openTabsRef.current, tab.path, tab.kind);
      if (!current) setOpenTabs(tabs => [...tabs, tab]);
      setActiveTabId(current?.id ?? tab.id);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : `Failed to open ${mode === 'video' ? 'Video Frames' : mode === 'edit' ? 'Photopea' : mode === 'analysis' ? 'Analysis' : 'Caption'}`);
    }
  };

  const openExplorerFilesInAnalysis = async (nodes: ExplorerTreeNode[]) => {
    if (nodes.length === 1) {
      return openFileModeTab(nodes[0], 'analysis');
    }
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Open a project directory before opening Explorer files.');
      return;
    }

    const targets: AnalysisScopeTarget[] = [];
    for (const node of nodes) {
      const file = await readExplorerFile(projectDirectoryHandle, node.path);
      if (!file) {
        addNotification('warning', `${node.name} is no longer available`);
        continue;
      }
      targets.push({
        path: node.path,
        name: node.name,
        fileKind: getExplorerFileKind(node.name, 'type' in file ? file.type : undefined),
        file,
        workspaceImageId: findWorkspaceImageIdForPath(node.path) ?? undefined,
      });
    }

    if (targets.length > 0) {
      navigateToTool('analysis', { analysisFiles: targets });
    }
  };

  const openExplorerFilesInCaption = async (nodes: ExplorerTreeNode[]) => {
    if (nodes.length === 1) {
      return openFileModeTab(nodes[0], 'caption');
    }

    const itemIds = nodes
      .map((node) => findWorkspaceImageIdForPath(node.path))
      .filter((id): id is string => Boolean(id));
    if (itemIds.length === nodes.length) {
      navigateToTool('tagging', { taggingItemIds: itemIds });
    }
  };

  const openExplorerFilesInReview = (sourceNode: ExplorerTreeNode, nodes: ExplorerTreeNode[]) => {
    const contextEntries = getContextEntries(sourceNode);
    const singleDirectory = contextEntries.length === 1 && contextEntries[0].kind === 'folder'
      ? contextEntries[0]
      : null;
    const review = singleDirectory
      ? { kind: 'directory' as const, path: singleDirectory.path, label: `${singleDirectory.name} / Review` }
      : {
          kind: 'selection' as const,
          paths: [...new Set(nodes.map((entry) => entry.path))],
          label: `Selected files · ${nodes.length}`,
        };
    navigateToTool('review', { review });
  };

  const openExplorerFilesInPhotopea = async (nodes: ExplorerTreeNode[]) => {
    for (const node of nodes) {
      await openFileModeTab(node, 'edit');
    }
  };

  const savePsdFileFromViewer = async (
    tab: FileWorkspaceTab,
    payload: { psd: ArrayBuffer; preview?: ArrayBuffer },
    saveCopy: boolean
  ) => {
    try {
      if (!projectDirectoryHandle) {
        throw new Error('Open a project directory before saving PSD files.');
      }
      const { targetName, nextPath, nextTab } = await runProjectFileOperation(async () => {
        const { directory, name } = await getExplorerParentDirectory(projectDirectoryHandle, tab.path);
        const sourceStem = name.replace(/\.[^.]+$/, '');
        const shouldCreatePsd = tab.fileKind !== 'psd';
        const requestedName = saveCopy
          ? `${sourceStem} Copy.psd`
          : shouldCreatePsd
            ? `${sourceStem}.psd`
            : name;
        const targetName = saveCopy || shouldCreatePsd
          ? await getUniqueExplorerName(directory, requestedName)
          : requestedName;
        const nextBlob = new Blob([payload.psd], { type: 'image/vnd.adobe.photoshop' });
        const handle = await directory.getFileHandle(targetName, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(nextBlob);
          await writable.close();
        } catch (error) {
          await (writable as typeof writable & { abort?: () => Promise<void> }).abort?.();
          throw error;
        }

        const nextPath = `${tab.path.split('/').slice(0, -1).join('/') || 'Project'}/${targetName}`;
        if (payload.preview) {
          await writeProjectPreview(projectDirectoryHandle, 'psd', nextPath, new Blob([payload.preview], { type: 'image/png' }));
        }
        const nextTab: FileWorkspaceTab = {
          ...tab,
          id: saveCopy ? createFileTabId() : tab.id,
          path: nextPath,
          name: targetName,
          fileKind: 'psd',
          file: new globalThis.File([nextBlob], targetName, { type: 'image/vnd.adobe.photoshop' }),
        };
        return { targetName, nextPath, nextTab };
      });

      useUIStore.getState().refreshAssetPreviews();
      setOpenTabs((tabs) => saveCopy
        ? tabs.some((entry) => entry.id === nextTab.id) ? tabs : [...tabs, nextTab]
        : tabs.map((entry) => (entry.id === tab.id ? nextTab : entry)));
      if (saveCopy || nextPath !== tab.path) setActiveTabId(nextTab.id);
      refreshExplorer();
      addNotification('success', saveCopy ? `Saved PSD copy "${targetName}"` : `Saved "${targetName}"`);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to save PSD file');
      throw error;
    }
  };

  const renderDatasetWorkspace = (dataset: Dataset) => (
    <DatasetWorkspaceView dataset={dataset} items={activeDatasetPreviewItems} active={activeTab?.id === DATASET_VIEW} suggestion={activeEmptyDatasetSuggestion}
      projectDirectoryHandle={projectDirectoryHandle} projectId={projectId} projectType={projectType}
      assemblyRequestToken={datasetAssemblyRequestToken} setAssemblyRequestToken={setDatasetAssemblyRequestToken}
      workspaceSettings={workspaceSettings} openDatasetToolTab={openDatasetToolTab} navigateToTool={navigateToTool}
      updateDatasetFileBackedState={updateDatasetFileBackedState} addNotification={addNotification}
      openDatasetBoardAssetContextMenu={openDatasetBoardAssetContextMenu}
      applyEmptyDatasetSuggestion={applyEmptyDatasetSuggestion} dismissEmptyDatasetSuggestion={dismissEmptyDatasetSuggestion}
      draggedExplorerEntriesRef={draggedExplorerEntriesRef} draggedExplorerEntries={draggedExplorerEntries}
      getExplorerEntriesFromTransferPath={getExplorerEntriesFromTransferPath} setCurrentDraggedExplorerEntries={setCurrentDraggedExplorerEntries}
      collectDatasetAssetIdsFromExplorerEntries={collectDatasetAssetIdsFromExplorerEntries}
      collectDatasetAssetPathsFromExplorerEntries={collectDatasetAssetPathsFromExplorerEntries}
      indexProjectWorkspaceAssets={indexProjectWorkspaceAssets} importDroppedFilesIntoDataset={importDroppedFilesIntoDataset} />
  );

  const requireProjectDirectory = (): ProjectDirectoryHandle | null => {
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Save or open a project directory before changing Explorer files.');
      return null;
    }
    return projectDirectoryHandle;
  };

  const refreshExplorer = () => {
    if (projectDirectoryHandle) invalidateWorkspaceFileAssetCache(projectDirectoryHandle);
    setExplorerRefreshKey((key) => key + 1);
  };

  const refreshChangedExplorer = async (directory: ProjectDirectoryHandle, changes: ExplorerChanges) => {
    if (!changes.moves.length && !changes.paths.length) return;
    const operationProjectId = useProjectStore.getState().id;
    const isCurrent = () => useUIStore.getState().projectDirectoryHandle === directory && useProjectStore.getState().id === operationProjectId;
    if (!isCurrent()) return;
    ++explorerReadRevision.current;
    const paths = new Set(changes.paths);
    for (const move of changes.moves) {
      if (!findExplorerTreeNode(explorerTreeRef.current, move.from)) paths.add(move.to);
      for (const path of [move.from, move.to]) {
        const kind = getExplorerFileKind(path);
        if (kind === 'image' || kind === 'psd') paths.add(path.replace(/\.[^.]+$/, '.txt'));
      }
    }
    const replacements: Array<{ path: string; node?: ExplorerTreeNode }> = [];
    for (const path of paths) {
      const name = path.split('/').pop()!;
      try {
        let node: ExplorerTreeNode;
        try {
          const folder = await getDirectoryAtExplorerPath(directory, path);
          node = await readExplorerDirectory(folder, name, path);
        } catch (error) {
          if (!(error instanceof Error) || !['NotFoundError', 'TypeMismatchError'].includes(error.name)) throw error;
          const parent = await getExplorerParentDirectory(directory, path);
          await parent.directory.getFileHandle(name);
          node = { name, path, kind: 'file' };
        }
        replacements.push({ path, node });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'NotFoundError')) throw error;
        replacements.push({ path });
      }
    }
    await updateWorkspaceFileAssetCache(directory, changes);
    if (!isCurrent()) return;
    setExplorerTree(previous => {
      let next = moveExplorerTreeNodes(previous ?? buildEmptyExplorerTree(projectName), changes.moves);
      for (const { path, node } of replacements) next = replaceExplorerTreeNode(next, path, node);
      return next;
    });
    setExpandedExplorerPaths(paths => new Set([...paths].map(path => applyExplorerPathMoves(path, changes.moves))));
    useUIStore.getState().refreshAssetPreviews();
  };

  const runExplorerMutation = async <T,>(label: string, action: () => Promise<T>): Promise<T> => {
    const operations = useOperationStore.getState();
    const running = operations.entries.find(isOperationRunning);
    if (projectOperationBusyRef.current || running) {
      throw new Error(running ? `Finish or cancel ${running.label} before changing project files.` : 'Wait for the project to finish opening.');
    }
    const id = `explorer:${crypto.randomUUID()}`;
    const directory = projectDirectoryHandle;
    const changes = emptyExplorerChanges();
    explorerMutationChanges.current = changes;
    operations.start({ id, viewId: EXPLORER_VIEW, label });
    try {
      const result = await runProjectFileOperation(action);
      operations.finish(id, 'completed');
      return result;
    } catch (error) {
      if (error instanceof ExplorerBatchError || error instanceof ExplorerRecoveryError) changes.paths.push(...error.recoveryPaths);
      operations.finish(id, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      explorerMutationChanges.current = null;
      if (directory) {
        try { await refreshChangedExplorer(directory, changes); }
        catch (error) { addNotification('warning', error instanceof Error ? error.message : 'Could not refresh changed files'); }
      }
    }
  };

  const updateFileTabsForPathMoves = (moves: Array<{ from: string; to: string }>) => {
    const movedTabs = openTabsRef.current.flatMap(tab => {
      if (!isFileBackedTab(tab)) return [];
      const moved = moveFileTab(tab, moves);
      return moved === tab ? [] : [{id: tab.id, path: moved.path}];
    });
    setOpenTabs(tabs => tabs.map(tab => moveToolViewScope(moveFileTab(tab, moves), moves)));
    setClosedTabs(tabs => tabs.map(tab => moveToolViewScope(moveFileTab(tab, moves), moves)));
    if (projectDirectoryHandle && movedTabs.length > 0) {
      void Promise.all(
        movedTabs.map(async ({ id, path }) => ({ id, path, file: await readExplorerFile(projectDirectoryHandle, path) }))
      ).then((refreshedTabs) => {
        setOpenTabs((tabs) =>
          tabs.map((tab) => {
            if (!isFileBackedTab(tab)) {
              return tab;
            }
            const refreshed = refreshedTabs.find((candidate) => candidate.id === tab.id && candidate.path === tab.path);
            if (!refreshed?.file) {
              return tab;
            }
            return {
              ...tab,
              file: refreshed.file,
              fileKind: getExplorerFileKind(tab.name, 'type' in refreshed.file ? refreshed.file.type : undefined),
            };
          })
        );
      }).catch(error => addNotification('warning', error instanceof Error ? error.message : 'Could not refresh the moved file'));
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

  const updateWorkspacePathsForPathMoves = async (moves: ExplorerPathMove[]) => {
    for (const source of Object.values(useProjectStore.getState().sourceImages)) {
      const originalFilePath = applyProjectRelativePathMoves(source.originalFilePath, moves);
      const manifestPath = applyProjectRelativePathMoves(source.manifestPath, moves, true);
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

    for (const item of Object.values(useProjectStore.getState().datasetItems)) {
      const imageDataPath = applyProjectRelativePathMoves(item.imageDataPath, moves);
      const psdDataPath = applyProjectRelativePathMoves(item.psdDataPath, moves);
      const manifestPath = applyProjectRelativePathMoves(item.manifestPath, moves, true);
      if (
        imageDataPath !== item.imageDataPath ||
        psdDataPath !== item.psdDataPath ||
        manifestPath !== item.manifestPath
      ) {
        updateDatasetItem(item.id, { imageDataPath, psdDataPath, manifestPath });
      }
    }

    const dataset = useProjectStore.getState().dataset;
    const assetOrder = applyFileAssetOrderPathMoves(dataset.assetOrder, moves);
    if (assetOrder.some((key, index) => key !== dataset.assetOrder[index])) {
      updateProjectDataset(dataset.id, { assetOrder });
    }
    updateBuildSession((session) => applyBuildSessionPathMoves(session, moves));
  };

  useEffect(() => {
    const handleDatasetFolderMoves = (event: Event) => {
      const moves = (event as CustomEvent<ExplorerPathMove[]>).detail;
      if (!Array.isArray(moves) || moves.length === 0) return;
      updateFileTabsForPathMoves(moves);
      updateExplorerClipboardForPathMoves(moves);
      if (explorerMutationChanges.current) explorerMutationChanges.current.moves.push(...moves);
      else if (projectDirectoryHandle) void refreshChangedExplorer(projectDirectoryHandle, { moves, paths: [] })
        .catch(error => addNotification('warning', error instanceof Error ? error.message : 'Could not refresh Dataset files'));
    };
    window.addEventListener('dataset-folder-paths-changed', handleDatasetFolderMoves);
    return () => window.removeEventListener('dataset-folder-paths-changed', handleDatasetFolderMoves);
  });

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

    return runExplorerMutation('Rename file', async () => {
      const nextFileName = trimmedName;
      const entryKind = kind === 'folder' ? 'folder' : 'file';
      const nextPath = await renameExplorerEntry(directory, path, entryKind, nextFileName, async change => {
        const moves = [change];
        explorerMutationChanges.current?.moves.push(change);
        const nextPath = change.to;
        setSelectedExplorerPaths(new Set([nextPath]));
        setSelectionAnchorPath(nextPath);
        setFocusedExplorerPath(nextPath);
        setInlineExplorerEdit(null);
        updateFileTabsForPathMoves(moves);
        await updateWorkspacePathsForPathMoves(moves);
        updateExplorerClipboardForPathMoves(moves);

      });
      await indexProjectWorkspaceAssets(false, [nextPath], false);
      return nextPath;
    });
  };

  const removeWorkspaceReferencesForDeletedEntries = async (entries: ExplorerClipboardEntry[]) => {
    const deletedPaths = entries.map((entry) => toProjectRelativePath(entry.path));
    const previousEdited = Object.values(useProjectStore.getState().datasetItems);
    const removedSourceIds: string[] = [];
    for (const source of Object.values(useProjectStore.getState().sourceImages)) {
      const sourcePath = source.originalFilePath;
      if (
        sourcePath &&
        deletedPaths.some((deletedPath) => sourcePath === deletedPath || sourcePath.startsWith(`${deletedPath}/`))
      ) {
        removeSourceImage(source.id);
        removedSourceIds.push(source.id);
      }
    }
    const removedIds = new Set([
      ...removedSourceIds.map(id => `source:${id}`),
      ...previousEdited.filter(item => removedSourceIds.includes(item.sourceImageId)).map(item => `edited:${item.id}`),
    ]);
    const explorerPaths = entries.map(entry => entry.path);
    const isDeletedExplorerPath = (path: string) => explorerPaths.some(root => path === root || path.startsWith(`${root}/`));
    const keepViews = (tabs: WorkspaceTab[]) => tabs
      .filter(tab => !isFileBackedTab(tab) || !explorerPaths.some(path => tab.path === path || tab.path.startsWith(`${path}/`)))
      .map(tab => pruneToolViewScope(tab, explorerPaths, removedIds));
    setOpenTabs(keepViews);
    setClosedTabs(keepViews);
    clearExplorerClipboardForDeletedPaths(entries);
    setSelectedExplorerPaths(paths => new Set([...paths].filter(path => !isDeletedExplorerPath(path))));
    setFocusedExplorerPath(path => path && isDeletedExplorerPath(path) ? null : path);
    setSelectionAnchorPath(path => path && isDeletedExplorerPath(path) ? null : path);
    {
      const dataset = useProjectStore.getState().dataset;

      const deletedExplorerPaths = entries.map((entry) => entry.path);
      const isDeletedPath = (path: string) =>
        deletedExplorerPaths.some((deletedPath) => path === deletedPath || path.startsWith(`${deletedPath}/`));
      const assetOrder = dataset.assetOrder.filter((key) => !key.startsWith('file:') || !isDeletedPath(key.slice('file:'.length)));

      if (assetOrder.length !== dataset.assetOrder.length) {
        updateProjectDataset(dataset.id, { assetOrder });
      }
    }
  };

  // Caller owns the save queue lane; updates are applied after each completed move.
  const moveWorkspaceEntries = async (directory: ProjectDirectoryHandle, entries: ExplorerClipboardEntry[], destinationPath: string) => {
    const completed: ExplorerPathMove[] = [];
    try {
      return await moveExplorerEntries(directory, entries, destinationPath, async move => {
        if (move.from === move.to) return;
        completed.push(move);
        explorerMutationChanges.current?.moves.push(move);
        updateFileTabsForPathMoves([move]);
        await updateWorkspacePathsForPathMoves([move]);
        updateExplorerClipboardForPathMoves([move]);
      });
    } finally {
      if (completed.length > 0) await indexProjectWorkspaceAssets(false, completed.map(move => move.to), false);
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
    const datasetFiles = entries.filter(
      (entry) =>
        entry.kind === 'file' &&
        entry.path.startsWith(`Project/${PROJECT_DATASET_DIRECTORY}/`) &&
        isExplorerImageFileName(entry.name)
    );
    const confirmation = datasetFiles.length > 0 && datasetFiles.length === entries.length
      ? `Remove ${datasetFiles.length === 1 ? `"${datasetFiles[0].name}"` : `${datasetFiles.length} images`} from the Dataset and move them to shared?`
      : `Delete ${entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`}? This cannot be undone.`;
    if (!window.confirm(confirmation)) {
      return;
    }
    const affectedTabs = openTabs.filter(tab => isFileBackedTab(tab) && entries.some(entry => tab.path === entry.path || tab.path.startsWith(`${entry.path}/`)));
    if (!await confirmClosingTabs(affectedTabs)) return;

    try {
      await runExplorerMutation('Delete files', async () => {
        const filesystemEntries = entries.filter(isFilesystemExplorerEntry);
        const directory = filesystemEntries.length > 0 ? requireProjectDirectory() : null;
        if (filesystemEntries.length > 0 && !directory) {
          return;
        }
        const filesToReturnToShared = filesystemEntries.filter((entry) => datasetFiles.some((datasetFile) => datasetFile.path === entry.path));
        if (filesToReturnToShared.length > 0) {
          await moveWorkspaceEntries(directory!, filesToReturnToShared, `Project/${PROJECT_SHARED_DIRECTORY}`);
        }
        const deletedFilesystemEntries = filesystemEntries.filter((entry) => !filesToReturnToShared.some((moved) => moved.path === entry.path));
        const activeFileTabDeleted =
          activeTab &&
          isFileBackedTab(activeTab) &&
          deletedFilesystemEntries.some((entry) => activeTab.path === entry.path || activeTab.path.startsWith(`${entry.path}/`));
        for (const entry of deletedFilesystemEntries) {
          await deleteExplorerEntry(directory!, entry.path, true, async () => {
            explorerMutationChanges.current?.paths.push(entry.path);
            await removeWorkspaceReferencesForDeletedEntries([entry]);
          });
        }
        setOpenTabs((tabs) =>
          tabs.filter(
            (tab) =>
              (isFileBackedTab(tab) &&
                !deletedFilesystemEntries.some((entry) => tab.path === entry.path || tab.path.startsWith(`${entry.path}/`))) ||
              tab.kind === 'dataset' || tab.kind === 'dataset-tool' ||
              tab.kind === 'tool' || tab.kind === 'window'
          )
        );
        if (activeFileTabDeleted) {
          setActiveTabId(null);
        }
        clearExplorerClipboardForDeletedPaths(entries);
        setSelectedExplorerPaths(new Set());
        setFocusedExplorerPath(null);
      });
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

  const handleExplorerPaste = async (node: ExplorerTreeNode) => {
    if (node.kind !== 'folder' || !explorerClipboard) return;
    const directory = requireProjectDirectory();
    if (!directory) return;
    const clipboard = explorerClipboard;
    try {
      await runExplorerMutation('Paste files', async () => {
        if (clipboard.mode === 'cut') {
          const moves = await moveWorkspaceEntries(directory, clipboard.entries.map(toPhysicalExplorerEntry), node.path);
          setSelectedExplorerPaths(new Set(moves.map(move => move.to)));
          setExplorerClipboard(null);
        } else {
          let copied: ExplorerPathMove[] = [];
          try {
            copied = await copyExplorerEntries(directory, clipboard.entries.filter(isFilesystemExplorerEntry), node.path);
          } catch (error) {
            if (error instanceof ExplorerBatchError) copied = error.completed;
            throw error;
          } finally {
            explorerMutationChanges.current?.paths.push(...copied.map(change => change.to));
            if (copied.length > 0) await indexProjectWorkspaceAssets(false, copied.map(change => change.to), false);
          }
        }
        setExpandedExplorerPaths(paths => new Set([...paths,node.path]));
      });
      addNotification('success','Explorer entry pasted');
    } catch (error) {
      addNotification('error',error instanceof Error ? error.message : 'Failed to paste entry');
    }
  };

  const handleExplorerDuplicate = async (node: ExplorerTreeNode) => {
    try {
      await runExplorerMutation('Duplicate files', async () => {
        const entries = getContextEntries(node);
        const filesystemEntries = entries.filter(isFilesystemExplorerEntry);
        let duplicated: ExplorerPathMove[] = [];
        try {
          if (filesystemEntries.length > 0) {
            const directory = requireProjectDirectory();
            if (!directory) return;
            duplicated = await duplicateExplorerEntries(directory, filesystemEntries);
          }
        } catch (error) {
          if (error instanceof ExplorerBatchError) duplicated = error.completed;
          throw error;
        } finally {
          explorerMutationChanges.current?.paths.push(...duplicated.map(change => change.to));
          if (duplicated.length > 0) await indexProjectWorkspaceAssets(false, duplicated.map(change => change.to), false);
        }
      });
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
      const directory = requireProjectDirectory();
      if (!directory) {
        return;
      }

      if (edit.mode === 'create') {
        const nextPath = await runExplorerMutation('Create folder', async () => {
          const path = await createExplorerDirectory(directory, edit.parentPath, edit.value);
          explorerMutationChanges.current?.paths.push(path);
          return path;
        });
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
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to update Explorer entry');
    }
  };

  const cancelInlineExplorerEdit = () => setInlineExplorerEdit(null);

  const moveSelectedExplorerEntries = async (destinationPath: string, entriesOverride?: ExplorerItemEntry[] | null) => {
    const entries = entriesOverride ?? getSelectedExplorerEntries();
    const directory = requireProjectDirectory();
    if (!directory || !entries.length) return;
    try {
      const moves = await runExplorerMutation('Move files', () => moveWorkspaceEntries(directory,entries.map(toPhysicalExplorerEntry),destinationPath));
      const paths = moves.map(move => move.to);
      setSelectedExplorerPaths(new Set(paths));
      setFocusedExplorerPath(paths[0] ?? null);
      setCurrentDraggedExplorerEntries(null);
    } catch (error) {
      addNotification('error',error instanceof Error ? error.message : 'Failed to move Explorer entries');
    }
  };

  const importExternalFilesIntoExplorer = async (files: ImportInputFile[], destinationPath: string, execution?: Pick<ImportImagesOptions, 'signal' | 'onProgress'>): Promise<ImportImagesResult> => {
    const directory = requireProjectDirectory();
    if (!directory || files.length === 0) {
      return { importedImages: [], importedAssets: [], skippedCount: 0, summary: { pairedImages: 0, imagesWithoutCaption: 0, standaloneTextFiles: 0, captionConflicts: 0, errors: 0 } };
    }

    try {
      let importedImageCount = 0;
      let importedAssetCount = 0;
      const result = await importImageFiles(files, {
        ...execution,
        logger: createOperationLogger('Import'),
        destination: {
          projectDirectory: directory,
          explorerPath: destinationPath,
        },
        onImageImported: async (image) => {
          addSourceImage(image);
          importedImageCount += 1;
          await flushProjectSave();
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
        const details = [
          result.summary.pairedImages ? `${result.summary.pairedImages} paired` : '',
          result.summary.imagesWithoutCaption ? `${result.summary.imagesWithoutCaption} without caption` : '',
          result.summary.standaloneTextFiles ? `${result.summary.standaloneTextFiles} standalone TXT` : '',
          result.summary.captionConflicts ? `${result.summary.captionConflicts} caption conflicts` : '',
        ].filter(Boolean).join(' · ');
        addNotification(
          'success',
          `Imported ${importedAssetCount || importedImageCount} asset${(importedAssetCount || importedImageCount) !== 1 ? 's' : ''}${details ? ` · ${details}` : ''}`
        );
        setExpandedExplorerPaths((paths) => new Set([...paths, destinationPath]));
        refreshExplorer();
        useUIStore.getState().refreshAssetPreviews();
      }
      return result;
    } catch (error) {
      if (execution) throw error;
      addNotification('error', error instanceof Error ? error.message : 'Failed to import files');
      return { importedImages: [], importedAssets: [], skippedCount: 0, summary: { pairedImages: 0, imagesWithoutCaption: 0, standaloneTextFiles: 0, captionConflicts: 0, errors: 1 } };
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

    const handleExplorerShortcut = (event: KeyboardEvent) => {
      if (projectOperationBusyRef.current) return;
      if (event.defaultPrevented || event.isComposing || event.repeat || event.getModifierState('AltGraph') || document.querySelector('[role=dialog][data-state=open], [role=menu][data-state=open]')) return;
      if (isEditableTarget(event.target)) {
        return;
      }
      const explorerHasFocus =
        document.activeElement instanceof HTMLElement &&
        Boolean(explorerPanelRef.current?.contains(document.activeElement));
      if (!explorerHasFocus && !explorerContextMenu) {
        return;
      }

      if (event.key === 'Escape' && selectedExplorerPaths.size > 0) {
        event.preventDefault();
        setSelectedExplorerPaths(new Set());
        setSelectionAnchorPath(null);
        setFocusedExplorerPath(null);
        setExplorerContextMenu(null);
        return;
      }

      if (event.key === 'Home' || event.key === 'End') {
        const nodes = getVisibleExplorerNodes();
        const node = event.key === 'Home' ? nodes[0] : nodes[nodes.length - 1];
        if (node) {
          event.preventDefault();
          focusExplorerNode(node, event.shiftKey);
        }
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

    };

    window.addEventListener('keydown', handleExplorerShortcut);
    return () => window.removeEventListener('keydown', handleExplorerShortcut);
  }, [activeExplorerDirectoryPath, explorerClipboard, explorerContextMenu, focusedExplorerPath, selectedExplorerPaths, explorerTree, expandedExplorerPaths]);

  const handleProjectFileError = (error: unknown, message: string) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    addNotification('error', error instanceof Error ? error.message : message);
  };

  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === 'AbortError';

  const activateProjectDirectory = (directory: ProjectDirectoryHandle, project: ProjectState) => {
    persistWorkspaceRef.current?.();
    setNavigationRecovery(false);
    projectSessionRef.current += 1;
    setProjectDirectory(undefined);
    loadProject(project);
    setClosedTabs([]);
    useHistoryStore.setState({past:[],future:[]});
    applyWorkspaceTabsForProject(project);
    setProjectDirectory({handle:directory,name:directory.name});
  };

  const indexActiveProject = async (directory: ProjectDirectoryHandle, expectedProjectId: string) => {
    const operations = useOperationStore.getState();
    const operationId = `project-index:${crypto.randomUUID()}`;
    operations.start({id:operationId,viewId:EXPLORER_VIEW,label:'Index project files'});
    try {
      await runProjectFileOperation(async () => {
        await indexProjectAssets(directory, {
          logger: createOperationLogger('Index'),
          existingSourceImages: useProjectStore.getState().sourceImages,
          onAssetIndexed: ({sourceImage}) => {
            const current = useProjectStore.getState();
            if (current.id !== expectedProjectId || useUIStore.getState().projectDirectoryHandle !== directory) {
              throw new DOMException('Project changed during indexing', 'AbortError');
            }
            if (sourceImage && !current.sourceImages[sourceImage.id]) addSourceImage(sourceImage);
            refreshExplorer();
          },
          onProgress: (completed,total) => operations.update(operationId,{completed,total}),
        });
      });
      operations.finish(operationId,'completed');
      refreshExplorer();
    } catch (error) {
      operations.finish(operationId,'failed',error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const canSwitchProject = async () => {
    if (useHistoryStore.getState().busy) { addNotification('warning', 'Wait for Undo or Redo to finish saving.'); return false; }
    const running = useOperationStore.getState().entries.find(isOperationRunning);
    if (!running) return confirmClosingTabs(openTabs);
    addNotification('warning', `Finish or cancel ${running.label} before switching projects.`); focusView(running.viewId); return false;
  };

  const handleNewProject = async () => {
    if (!await canSwitchProject()) return;
    if (projectOperationBusyRef.current) {
      return;
    }
    const logger = createOperationLogger('Project');
    setOpenMenu(null);
    if (workspaceImages.length > 0 && !window.confirm('Create a new project and clear the current workspace?')) {
      return;
    }

    projectOperationBusyRef.current = true;
    projectOperationOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsProjectDirectoryBusy(true);
    try {
      const setup = await requestProjectSetup('Untitled Project', false);
      if (!setup) {
        logger.warning('new project canceled');
        return;
      }

      const { name: nextName, projectType } = setup;
      const parentDirectory = await pickProjectDirectory();
      logger.info(`creating project directory ${nextName}`);
      const directory = await parentDirectory.getDirectoryHandle(nextName, { create: true });
      if (
        (await projectDirectoryHasManifest(directory)) &&
        !window.confirm(`Overwrite the Dataset Creator project in "${nextName}"?`)
      ) {
        logger.warning(`new project canceled before overwriting ${nextName}`);
        return;
      }
      await flushProjectSave();
      const project = createProject(nextName, projectType);
      logger.info('writing project manifest and folders');
      const create = async () => {
        await clearProjectDirectory(directory);
        await createProjectDirectory(directory, project);
        activateProjectDirectory(directory, project);
      };
      if (projectDirectoryHandle) await runProjectFileOperation(create);
      else await create();
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
    await flushProjectSave();
    const previousProject = useProjectStore.getState();
    const project = await readProjectDirectory(directory, async (name) => {
      const setup = await requestProjectSetup(name, true);
      if (!setup) throw new DOMException('Project opening canceled', 'AbortError');
      return setup.projectType;
    });
    if (useProjectStore.getState() !== previousProject) {
      throw new Error('The current project changed while opening the folder. Open it again after your changes are saved.');
    }
    activateProjectDirectory(directory, project);
    await indexActiveProject(directory, project.id);
    logger.success(`opened project directory ${directory.name}`);
    addNotification('success', 'Project directory opened');
  };

  const handleOpenProject = async () => {
    if (!await canSwitchProject()) return;
    if (projectOperationBusyRef.current) {
      return;
    }
    projectOperationBusyRef.current = true;
    projectOperationOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenMenu(null);
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
    setOpenMenu(null);
    const nextName = window.prompt('Project name', projectName)?.trim();
    if (!nextName || nextName === projectName) {
      return;
    }

    renameProject(nextName);
    addNotification('success', 'Project renamed');
  };

  const openProjectVersions = async () => {
    setActiveActivityView('versions');
    dock.show(EXPLORER_VIEW);
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Open a project directory before managing versions');
      return;
    }
    try {
      const { currentId, versions } = await listProjectVersions(projectDirectoryHandle);
      setCurrentProjectVersionId(currentId);
      setProjectVersions(versions);
      setOpenMenu(null);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to read project versions');
    }
  };

  const handleCreateProjectVersion = async () => {
    if (!projectDirectoryHandle || !newVersionName.trim()) {
      return;
    }
    try {
      const version = await runExplorerMutation('Create project version', () => createProjectVersion(projectDirectoryHandle, newVersionName));
      setProjectVersions((versions) => [...versions, version]);
      setCurrentProjectVersionId(version.id);
      setNewVersionName('');
      addNotification('success', `Created version ${version.name}`);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to create project version');
    }
  };

  const handleRestoreProjectVersion = async (version: ProjectVersion) => {
    if (!projectDirectoryHandle || projectOperationBusyRef.current || !await canSwitchProject()) return;
    if (!window.confirm(`Restore project version "${version.name}"? Current changes will be replaced.`)) return;
    const directory = projectDirectoryHandle;
    const operations = useOperationStore.getState();
    const operationId = `project-restore:${crypto.randomUUID()}`;
    projectOperationBusyRef.current = true;
    projectOperationOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsProjectDirectoryBusy(true);
    operations.start({id:operationId,viewId:EXPLORER_VIEW,label:'Restore project version'});
    try {
      await runProjectFileOperation(async () => {
        let restoredOnDisk = false;
        try {
          let project!: ProjectState;
          await restoreProjectVersion(directory, version.id, async () => { project = await readProjectDirectory(directory); });
          restoredOnDisk = true;
          activateProjectDirectory(directory, project);
        } catch (error) {
          // Stop the old queue before its finally block can write over a partial restore.
          if (restoredOnDisk || (error instanceof ProjectVersionRestoreError && !error.previousRestored)) {
            setProjectDirectory(undefined);
          }
          throw error;
        }
      });
      await indexActiveProject(directory, useProjectStore.getState().id);
      setCurrentProjectVersionId(version.id);
      operations.finish(operationId,'completed');
      addNotification('success', `Restored version ${version.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore project version';
      operations.finish(operationId,'failed',message);
      addNotification('error', message);
    } finally {
      projectOperationBusyRef.current = false;
      setIsProjectDirectoryBusy(false);
    }
  };

  const closeTopMenus = () => {
    setOpenMenu(null);
    setWorkspaceContextMenu(null);
  };

  const closeExplorerContextMenu = () => setExplorerContextMenu(null);

  const createExplorerAction: CreateExplorerAction = (action) => ({
    ...action,
    onSelect: (event) => {
      void action.onSelect(event);
      closeExplorerContextMenu();
    },
  });

  const getExplorerToolScopeFileNodes = (node: ExplorerTreeNode): ExplorerTreeNode[] => {
    const scopePaths = new Set<string>();
    const allNodes = getAllExplorerNodes();

    for (const entry of getContextEntries(node)) {
      if (entry.kind === 'file') {
        scopePaths.add(entry.path);
        continue;
      }
      if (entry.kind === 'folder') {
        allNodes
          .filter((candidate) => candidate.kind === 'file' && candidate.path.startsWith(`${entry.path}/`))
          .forEach((candidate) => scopePaths.add(candidate.path));
      }
    }

    return allNodes.filter((entry) => entry.kind === 'file' && scopePaths.has(entry.path));
  };

  const addToDatasetFromExplorer = async (paths: string[]) => {
    try {
      const added = await runExplorerMutation('Add to Dataset', async () => addWorkspacePathsToDataset(paths));
      addNotification(added ? 'success' : 'info', added ? `Added ${added} file${added !== 1 ? 's' : ''} to Dataset` : 'Files are already in Dataset');
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Could not add files to Dataset');
    }
  };

  const getFileContextActionGroups = (node: ExplorerTreeNode): ContextActionGroup[] => buildFileContextActionGroups(node, {
    createExplorerAction, findWorkspaceImageIdForPath, openExplorerFile, openFileModeTab, getContextEntries, getExplorerToolScopeFileNodes,
    createExplorerEntryForNode, addToDataset: addToDatasetFromExplorer, openExplorerFilesInPhotopea, openExplorerFilesInCaption,
    openExplorerFilesInAnalysis, openExplorerFilesInReview, setExplorerClipboard, handleExplorerRename, handleExplorerDelete,
  });

  const getDirectoryContextActionGroups = (node: ExplorerTreeNode): ContextActionGroup[] => buildDirectoryContextActionGroups(node, {
    createExplorerAction, findWorkspaceImageIdForPath, openExplorerFile, openFileModeTab, getContextEntries, getExplorerToolScopeFileNodes,
    createExplorerEntryForNode, addToDataset: addToDatasetFromExplorer, openExplorerFilesInPhotopea, openExplorerFilesInCaption,
    openExplorerFilesInAnalysis, openExplorerFilesInReview, setExplorerClipboard, handleExplorerRename, handleExplorerDelete,
    explorerClipboard, handleExplorerNewFolder, handleExplorerImport, handleExplorerPaste, handleExplorerDuplicate,
  });


  const closeWorkspaceViews = async (ids: string[]) => {
    const closable = ids.filter((id) => !openTabs.find((tab) => tab.id === id)?.pinned && !dock.layout.pinned?.includes(id));
    const running = useOperationStore.getState().entries.filter(entry => closable.includes(entry.viewId) && isOperationRunning(entry));
    if (running.length) { addNotification('warning', 'Finish or cancel running operations before closing their tabs.'); focusView(running[0].viewId); return; }
    const editors = openTabs.filter((tab) => closable.includes(tab.id));
    if (!await confirmClosingTabs(editors)) return;
    if (useOperationStore.getState().entries.some(entry => closable.includes(entry.viewId) && isOperationRunning(entry))) {
      addNotification('warning', 'Finish saving before closing this editor.'); return;
    }
    pushClosedTabs(editors);
    setOpenTabs((tabs) => tabs.filter((tab) => !closable.includes(tab.id)));
    dock.close(closable);
    if (activeTabId && closable.includes(activeTabId)) {
      const location = findDockGroup(dock.layout, activeTabId);
      const next = location?.group.tabs.find((id) => !closable.includes(id) && openTabs.some((tab) => tab.id === id));
      setActiveTabId(next ?? openTabs.find((tab) => !closable.includes(tab.id))?.id ?? null);
    }
    setWorkspaceContextMenu(null);
  };

  const renderEditor = (tab: WorkspaceTab) => {
    const focused = tab.id === activeTabId;
    if (tab.kind === 'file-video' || (tab.kind === 'tool' && tab.tool === 'video')) {
      return <WorkspaceTool tool="video" viewId={tab.id} active={focused} directory={projectDirectoryHandle}
        context={{...(tab.kind === 'file-video' ? {kind:'file', file:tab} : {kind:'project'}), viewId:tab.id,
          onSaved:async () => { refreshExplorer(); await indexProjectWorkspaceAssets(); }}} />;
    }
    if (isFileBackedTab(tab)) return <div className="h-full min-h-0">                      {tab.kind === 'file-view' ? (
                        <InternalFileViewer
                          file={tab.file}
                          fileName={tab.name}
                          fileKind={tab.fileKind}
                          active={focused}
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
                        <WorkspaceTool tool="analysis" viewId={tab.id} active={focused} directory={projectDirectoryHandle}
                          onAssetContextMenu={openAssetExplorerContextMenu}
                          context={{kind:'file', file:tab}} />
                      ) : tab.kind === 'file-edit' ? (
                        <WorkspaceTool tool="clean" viewId={tab.id} active={focused}
                          context={{kind:'file', file:tab, onSavePsd:(buffer, saveCopy) => savePsdFileFromViewer(tab, buffer, saveCopy)}} />
                      ) : (
                        <WorkspaceTool tool="tagging" viewId={tab.id} active={focused} context={{kind:'file', file:tab}} />
                      )}
</div>;
    if (tab.kind === 'dataset') return renderDatasetWorkspace(globalDataset);
    if (isDatasetToolTab(tab)) return renderDatasetTool(tab);
    if (tab.kind !== 'tool' || tab.tool === 'video') return null;
    return <div className="relative h-full min-h-0 overflow-auto p-4">
      {tab.nested && <button type="button" title="Back to tool" className="absolute left-2 top-2 z-30 rounded border border-border bg-card p-2"
        onClick={() => setToolTabNestedView(tab.id, undefined)}><ArrowLeft className="h-4 w-4" /></button>}
      <WorkspaceTool {...getToolViewContext(tab.tool, tab.scope, tab.nested?.itemId)} viewId={tab.id} active={focused} directory={projectDirectoryHandle}
        items={workspaceReviewItems}
        onRefresh={() => indexProjectWorkspaceAssets()}
        onAssetContextMenu={openAssetExplorerContextMenu}
        onOpenItem={itemId => setToolTabNestedView(tab.id, {kind:'file', itemId})}
        onOpenProjectFile={path => {
          const node = findExplorerNodeByPath(path) ?? { name:path.split('/').pop() ?? path, path, kind:'file' as const };
          void openFileModeTab(node, 'edit');
        }}
        onImportFiles={projectDirectoryHandle ? (files, execution) => importExternalFilesIntoExplorer(files, `Project/${PROJECT_SHARED_DIRECTORY}`, execution) : undefined}
        onOpenImport={() => navigateToTool('import')} />
    </div>;
  };
  const workspaceViews: DockView[] = [
    { id: EXPLORER_VIEW, title: activeActivityView === 'versions' ? 'Versions' : 'Explorer', icon: activeActivityView === 'versions' ? GitBranch : PanelLeft,
      content: <div className="flex h-full min-h-0 flex-col">              {activeActivityView === 'explorer' ? (
                <>
              <ExplorerPanel key={projectId} panelRef={explorerPanelRef} error={explorerError}
                selectedPaths={selectedExplorerPaths}
                onDismissContextMenu={() => setExplorerContextMenu(null)}
                onSelectionChange={handleExplorerMarqueeSelection}
                onRootContextMenu={(x, y) => { setActiveExplorerDirectoryPath('Project'); setExplorerContextMenu({ node: { name: projectName || 'Project', path: 'Project', kind: 'folder' }, x, y }); }}
                onDropTargetChange={setExplorerDropTargetPath}
                onDropFiles={event => handleExplorerDrop(event, 'Project')}>
                {visibleExplorerTree ? (
                  <ExplorerTree
                    node={visibleExplorerTree}
                    expandedPaths={expandedExplorerPaths}
                    selectedPaths={selectedExplorerPaths}
                    dropTargetPath={explorerDropTargetPath}
                    inlineEdit={inlineExplorerEdit}
                    focusedPath={focusedExplorerPath}
                    onToggle={toggleExplorerPath}
                    onFocus={setActiveExplorerNode}
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
                    onDragEndItems={() => {
                      setCurrentDraggedExplorerEntries(null);
                      setExplorerDropTargetPath(null);
                    }}
                    onDropTargetChange={setExplorerDropTargetPath}
                    onDropItems={(node, event) => handleExplorerDrop(event, node.path)}
                  />
                ) : (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No project files</p>
                )}
              </ExplorerPanel>

                </>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                  <p className="mb-1 font-medium">Project versions</p>
                  <p className="mb-3 text-muted-foreground">Versions are tagged snapshots. Restoring replaces current project files.</p>
                  <div className="flex gap-2">
                    <input value={newVersionName} onChange={(event) => setNewVersionName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateProjectVersion(); }} placeholder="Version name" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5" />
                    <button type="button" onClick={() => void handleCreateProjectVersion()} disabled={!newVersionName.trim()} className="rounded bg-primary px-2 py-1.5 font-medium text-primary-foreground disabled:opacity-40">Create</button>
                  </div>
                  <div className="mt-3 divide-y divide-border rounded border border-border">
                    {projectVersions.length > 0 ? projectVersions.map((version) => <div key={version.id} className="flex items-center gap-2 px-2 py-2"><GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate font-medium">{version.name}{version.id === currentProjectVersionId ? ' (current)' : ''}</p><p className="text-[10px] text-muted-foreground">{new Date(version.createdAt).toLocaleString()}</p></div><button type="button" onClick={() => void handleRestoreProjectVersion(version)} disabled={version.id === currentProjectVersionId} className="rounded border border-border px-2 py-1 text-[10px] hover:bg-secondary disabled:opacity-40">Restore</button></div>) : <p className="px-2 py-4 text-center text-muted-foreground">No versions yet.</p>}
                  </div>
                </div>
              )}
</div> },
    { id: 'window:inspector', title: 'Inspector', icon: PanelRight, content: <div className="h-full overflow-auto p-3"><WorkspaceInspector
      activeTab={activeTab} activeTabId={activeTabId} activeTool={activeTool} activeDatasetName={activeDataset?.name}
      activeInspectorSelection={activeInspectorSelection} inspectorSectionsOpen={inspectorSectionsOpen} setInspectorSectionOpen={setInspectorSectionOpen}
      fileInspectorMetadata={fileInspectorMetadata} showFileInspector={showFileInspector} showAnalysisInspector={showAnalysisInspector}
      inspectorWindowOpen={dock.isOpen('window:inspector')} onFocusView={(id) => focusView(id)} /></div> },
    { id: 'window:output', title: 'Output', icon: PanelBottom,
      content: <div ref={outputLogRef} className="h-full overflow-auto p-3 font-mono text-[11px]" onScroll={(event) => { const node = event.currentTarget; outputAutoFollowRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>
        {operationLogs.map((entry) => <p key={entry.id} className={entry.level === 'error' ? 'text-destructive' : entry.level === 'warning' ? 'text-yellow-500' : entry.level === 'success' ? 'text-emerald-500' : 'text-muted-foreground'}>[{entry.timestamp.toLocaleTimeString()}] {entry.level.toUpperCase().padEnd(7, ' ')} {entry.message}</p>)}
      </div> },
    { id: 'window:project', title: 'Project', icon: FolderOpen, content: <div className="h-full overflow-auto p-3">            <div className="space-y-3 text-xs">
              <div className="rounded border border-border bg-background p-3">
                <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Current project</p>
                <p className="mt-1 truncate font-semibold">{projectName}</p>
                <p className="mt-1 text-muted-foreground">{profile.label} project</p>
                <p className="mt-1 truncate text-muted-foreground">{projectDirectoryName ?? 'Unsaved workspace'}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-muted-foreground">
                  <span>Assets</span><span className="text-right text-foreground">{workspaceImages.length}</span>
                  <span>Dataset assets</span><span className="text-right text-foreground">{activeDatasetPreviewItems.length}</span>
                  <span>Tags</span><span className="text-right text-foreground">{projectTags.length}</span>
                </div>
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
</div> },
    { id: DATASET_VIEW, title: 'Dataset', icon: Layers3, content: renderDatasetWorkspace(globalDataset) },
    ...openTabs.filter((tab) => tab.kind !== 'window').map((tab) => {
      const chrome = getWorkspaceTabChrome(tab);
      return { id: tab.id, title: chrome.label, icon: chrome.Icon, pinned: tab.pinned, dirty: isTabDirty(tab),
        content: <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading…</div>}>{renderEditor(tab)}</Suspense> };
    }),
  ].map((view: DockView) => ({ ...view, pinned: view.pinned || dock.layout.pinned?.includes(view.id) }));

  const focusView = (id: string) => {
    dock.show(id);
    requestAnimationFrame(() => {
      const view = Array.from(document.querySelectorAll<HTMLElement>('[data-dock-view]')).find(node => node.dataset.dockView === id);
      (view?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), button:not([disabled]), [tabindex="0"]') ?? view)?.focus();
    });
  };
  const stepTab = (direction: number) => {
    const group = activeTabId ? findDockGroup(dock.layout, activeTabId)?.group : null;
    const tabs = group?.tabs.filter(id => openTabs.some(tab => tab.id === id)) ?? openTabs.map(tab => tab.id);
    const next = tabs[(Math.max(0, tabs.indexOf(activeTabId ?? '')) + direction + tabs.length) % tabs.length];
    const tab = openTabs.find(tab => tab.id === next); if (tab) { activateTab(tab); focusView(tab.id); }
  };
  useWorkspaceCommands({
    activeExplorerDirectoryPath, activeTab, activeTabId, activeTool, closedTabs, closeWorkspaceViews, dock, explorerClipboard,
    explorerPanelRef, findExplorerNodeByPath, focusView, getActiveDirectoryChildren, getSelectedExplorerEntries, globalDataset,
    handleExplorerDelete, handleExplorerDuplicate, handleExplorerPaste, handleExplorerRename, handleNewProject, handleOpenProject,
    handleRenameProject, isProjectDirectoryBusy, navigateToTool, openCommands, openDatasetToolTab, openProjectDataset,
    openProjectVersions, openTabs, profile, projectDirectoryHandle, projectSave, reopenClosedTab, setExplorerClipboard,
    setIsWorkspaceSettingsOpen, setSelectedExplorerPaths, setSelectionAnchorPath, setTheme, stepTab,
  });

  return <AppShell
    busy={isProjectDirectoryBusy}
    setupDialog={projectSetup ? <ProjectSetupDialog name={projectSetup.name} migration={projectSetup.migration} onComplete={projectSetup.complete} /> : null}
    backgroundTasks={<PhotopeaPsdPreviewWorker active={Boolean(projectDirectoryHandle)} />}
    header={<WorkspaceMenus openMenu={openMenu}
      onOpenMenuChange={menu => { setOpenMenu(menu); setTabMenuOpen(false); setWorkspaceContextMenu(null); }}
      fileButtonRef={projectMenuButtonRef} enabledTools={profile.enabledTools}
      activeTool={activeTab?.kind === 'tool' ? activeTool : null}
      theme={theme} isWindowOpen={dock.isOpen} onCommands={() => openCommands()} />}
    activityBar={
          <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2" aria-label="Activity bar">
            <button
              type="button"
              onClick={() => { setActiveActivityView('explorer'); dock.show(EXPLORER_VIEW); }}
              className={`rounded p-2 transition-colors ${activeActivityView === 'explorer' && leftPanelOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
              title="Explorer"
              aria-label="Explorer"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void openProjectVersions()}
              className={`rounded p-2 transition-colors ${activeActivityView === 'versions' && leftPanelOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
              title="Versions"
              aria-label="Versions"
            >
              <GitBranch className="h-4 w-4" />
            </button>
          </nav>
    }
    footer={<WorkspaceStatusBar projectName={projectName} save={projectSave}
      onFocusOperation={id => { const tab = openTabs.find(tab => tab.id === id); if (tab) { activateTab(tab); focusView(id); } else focusView('window:output'); }}
      onOutput={() => focusView('window:output')} onHelp={() => openCommands(true)} />}
    overlays={<>
        <WorkspaceSettingsDialog open={isWorkspaceSettingsOpen} onOpenChange={setIsWorkspaceSettingsOpen}
          theme={theme} onThemeChange={setTheme} density={density} onDensityChange={setDensity}
          settings={workspaceSettings} onSettingsChange={updateWorkspaceSettings}
          onPickTaggerFile={kind => void pickLocalTaggerFile(kind)}
          onRestoreTaggerAccess={() => void restoreSavedLocalTagger(true)}
          onShortcuts={() => openCommands(true)} onOpenTool={tool => navigateToTool(tool)} />
        {localTaggerFileInputs}

      <WorkspaceTabMenus
        workspaceViews={workspaceViews} dockLayout={dock.layout} setDockLayout={dock.setLayout} openTabs={openTabs} closedTabs={closedTabs}
        enabledTools={profile.enabledTools} tabMenuOpen={tabMenuOpen} setTabMenuOpen={setTabMenuOpen} toolMenuPosition={toolMenuPosition}
        workspaceContextMenu={workspaceContextMenu} setWorkspaceContextMenu={setWorkspaceContextMenu}
        explorerContextMenu={explorerContextMenu} setExplorerContextMenu={setExplorerContextMenu}
        closeTopMenus={closeTopMenus} navigateToTool={navigateToTool} reopenClosedTab={reopenClosedTab} toggleTabPinned={toggleTabPinned}
        closeWorkspaceViews={closeWorkspaceViews} getFileContextActionGroups={getFileContextActionGroups}
        getDirectoryContextActionGroups={getDirectoryContextActionGroups} />
      <WorkspaceNotifications />
    </>}
  >
          <DockWorkspace key={`${projectId}:${projectSessionRef.current}`}
            activeEditorId={activeTabId}
            emptyContent={<WorkspaceWelcome projectName={projectDirectoryName} hasDirectory={Boolean(projectDirectoryHandle)} recoveryNeeded={navigationRecovery}
              onOpen={() => void handleOpenProject()} onCreate={() => void handleNewProject()}
              onContinue={() => navigateToTool(projectDirectoryHandle ? 'review' : 'import')} />}
            layout={dock.layout}
            onLayout={dock.setLayout}
            views={workspaceViews}
            onFocus={(id) => { const tab = openTabs.find((entry) => entry.id === id); if (tab && activeTabId !== id) activateTab(tab); }}
            onClose={closeWorkspaceViews}
            onContextMenu={(id, x, y) => setWorkspaceContextMenu({ id, x, y })}
            onOpenTool={(group, x, y) => { dock.setLayout((layout) => ({ ...layout, focusedGroup: group })); setToolMenuPosition({ x, y }); setTabMenuOpen(true); }}
          />
  </AppShell>;

}

export default App;
