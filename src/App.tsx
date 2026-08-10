import * as Dialog from '@radix-ui/react-dialog';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ComponentType, ReactNode } from 'react';
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BarChart3,
  Brush,
  Download,
  ExternalLink,
  FilePlus,
  FolderOpen,
  Grip,
  Check,
  Layers3,
  Maximize2,
  Menu,
  Minimize2,
  Moon,
  PanelBottom,
  PanelRight,
  Pencil,
  ScanSearch,
  Settings2,
  Sun,
  Tags,
  Upload,
  X,
} from 'lucide-react';
import { useProjectStore } from './stores/useProjectStore';
import { useUIStore } from './stores/useUIStore';
import {
  SIDEBAR_PRIMARY_TOOLS,
  SIDEBAR_SECONDARY_TOOLS,
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
import {
  deleteLocalTaggerFileHandle,
  saveLocalTaggerFileHandle,
  type LocalTaggerFileKey,
} from './services/tagging/localTaggerFileSettings';
import { type BrickColumnCount, type StageName } from './types';
import { Badge } from './components/ui/badge';
import { Separator } from './components/ui/separator';
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
  };

const parseBrickColumnCount = (value: string): BrickColumnCount =>
  value === 'auto' ? 'auto' : (Math.min(5, Math.max(1, Number(value))) as BrickColumnCount);

const ToolHub = lazy(() => import('./components/ToolHub').then((module) => ({ default: module.ToolHub })));
const ImportStage = lazy(() =>
  import('./components/stages/ImportStage').then((module) => ({ default: module.ImportStage }))
);
const SimilarityReviewStage = lazy(() =>
  import('./components/stages/SimilarityReviewStage').then((module) => ({
    default: module.SimilarityReviewStage,
  }))
);
const CleanupStage = lazy(() =>
  import('./components/stages/CleanupStage').then((module) => ({ default: module.CleanupStage }))
);
const AnalysisStage = lazy(() =>
  import('./components/stages/AnalysisStage').then((module) => ({ default: module.AnalysisStage }))
);
const FinalReviewStage = lazy(() =>
  import('./components/stages/FinalReviewStage').then((module) => ({ default: module.FinalReviewStage }))
);
const TaggingStage = lazy(() =>
  import('./components/stages/TaggingStage').then((module) => ({ default: module.TaggingStage }))
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

const renderTool = (currentStage: StageName) => {
  switch (currentStage) {
    case 'hub':
      return <ToolHub />;
    case 'import':
      return <ImportStage />;
    case 'select':
      return <SimilarityReviewStage />;
    case 'clean':
      return <CleanupStage />;
    case 'analysis':
      return <AnalysisStage />;
    case 'review':
      return <FinalReviewStage />;
    case 'tagging':
      return <TaggingStage />;
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
  onChange: (next: FloatingPanelState) => void;
  onClose: () => void;
  children: ReactNode;
};

const FloatingWorkspacePanel = ({
  title,
  icon: Icon,
  panel,
  onChange,
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
          x: Math.max(8, Math.min(window.innerWidth - 160, drag.originX + event.clientX - drag.startX)),
          y: Math.max(8, Math.min(window.innerHeight - 90, drag.originY + event.clientY - drag.startY)),
        });
      }

      if (resizeRef.current) {
        const resize = resizeRef.current;
        onChange({
          ...panel,
          width: Math.max(240, Math.min(window.innerWidth - panel.x - 12, resize.originWidth + event.clientX - resize.startX)),
          height: Math.max(150, Math.min(window.innerHeight - panel.y - 12, resize.originHeight + event.clientY - resize.startY)),
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
      style={{ left: panel.x, top: panel.y, width: panel.width, height: panel.minimized ? 38 : panel.height }}
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

function App() {
  const projectName = useProjectStore((state) => state.name);
  const currentStage = useProjectStore((state) => state.currentStage);
  const initializeProject = useProjectStore((state) => state.initializeProject);
  const loadProject = useProjectStore((state) => state.loadProject);
  const renameProject = useProjectStore((state) => state.renameProject);
  const setCurrentStage = useProjectStore((state) => state.setCurrentStage);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const updateWorkspaceSettings = useProjectStore((state) => state.updateWorkspaceSettings);
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const datasetItemsById = useProjectStore((state) => state.datasetItems);
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
    setTaggingModal,
    addNotification,
    notifications,
    removeNotification,
    projectDirectoryHandle,
    projectDirectoryName,
    setProjectDirectory,
  } = useUIStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [isWorkspaceSettingsOpen, setIsWorkspaceSettingsOpen] = useState(false);
  const [isProjectDirectoryBusy, setIsProjectDirectoryBusy] = useState(false);
  const [isUrlStageReady, setIsUrlStageReady] = useState(false);
  const [openTabs, setOpenTabs] = useState<StageName[]>(['hub']);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(280);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(190);
  const [projectWindow, setProjectWindow] = useState<FloatingPanelState>({
    x: 92,
    y: 112,
    width: 300,
    height: 360,
    minimized: false,
  });
  const [inspectorWindow, setInspectorWindow] = useState<FloatingPanelState>({
    x: 420,
    y: 144,
    width: 300,
    height: 330,
    minimized: false,
  });
  const [projectWindowOpen, setProjectWindowOpen] = useState(false);
  const [inspectorWindowOpen, setInspectorWindowOpen] = useState(false);
  const taggerModelInputRef = useRef<HTMLInputElement | null>(null);
  const taggerTagsInputRef = useRef<HTMLInputElement | null>(null);
  const autoSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectSessionRef = useRef(0);
  const projectOperationBusyRef = useRef(false);
  const dockResizeRef = useRef<{
    kind: 'right' | 'bottom';
    startX: number;
    startY: number;
    origin: number;
  } | null>(null);

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDarkMode(prefersDark);
  }, [setDarkMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    const stageFromUrl = readStageFromUrl();
    if (stageFromUrl) {
      setCurrentStage(stageFromUrl);
    }
    setIsUrlStageReady(true);

    const handlePopState = () => {
      const nextStage = readStageFromUrl();
      if (nextStage) {
        setCurrentStage(nextStage);
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

      if (resize.kind === 'right') {
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
    setOpenTabs((tabs) => (tabs.includes(currentStage) ? tabs : [...tabs, currentStage]));
  }, [currentStage]);

  useEffect(() => {
    if (!sidebarOpen && !fileMenuOpen && !viewMenuOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        setFileMenuOpen(false);
        setViewMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fileMenuOpen, sidebarOpen, viewMenuOpen]);

  const activeLabel = STAGE_LABELS[currentStage] ?? 'Image Workspace';
  const activeDescription =
    currentStage === 'hub'
      ? 'Choose a tool and keep working from the shared image workspace.'
      : TOOL_DESCRIPTIONS[currentStage] ?? '';
  const showEditToolbar = currentStage === 'clean' && editToolbar.visible;
  const showTaggingToolbar = currentStage === 'tagging';
  const showTaggingBackButton = showTaggingToolbar && taggingToolbar.visible;
  const showFullscreenTagging = showTaggingToolbar && taggingToolbar.visible;
  const runEditCommand = (command: 'back' | 'save' | 'saveCopy' | 'cancel') => {
    window.dispatchEvent(new CustomEvent(EDIT_TOOL_COMMAND_EVENT, { detail: command }));
  };
  const navigateToStage = (stage: StageName) => {
    setOpenTabs((tabs) => (tabs.includes(stage) ? tabs : [...tabs, stage]));
    writeStageToUrl(stage, 'push');
    setCurrentStage(stage);
    setSidebarOpen(false);
    setFileMenuOpen(false);
    setViewMenuOpen(false);
  };

  const closeTab = (stage: StageName) => {
    if (stage === 'hub' && openTabs.length === 1) {
      return;
    }

    const tabIndex = openTabs.indexOf(stage);
    const nextTabs = openTabs.filter((tab) => tab !== stage);
    const nextStage = nextTabs[Math.max(0, Math.min(tabIndex, nextTabs.length - 1))] ?? 'hub';
    setOpenTabs(nextTabs.length > 0 ? nextTabs : ['hub']);

    if (currentStage === stage) {
      navigateToStage(nextStage);
    }
  };

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

  const handleNewProject = async () => {
    if (projectOperationBusyRef.current) {
      return;
    }
    setFileMenuOpen(false);
    if (workspaceImages.length > 0 && !window.confirm('Create a new project and clear the current workspace?')) {
      return;
    }

    projectOperationBusyRef.current = true;
    setIsProjectDirectoryBusy(true);
    try {
      const parentDirectory = await pickProjectDirectory();
      const nextName = window.prompt('Project name', 'Untitled Project')?.trim();
      if (!nextName) {
        return;
      }

      const directory = await parentDirectory.getDirectoryHandle(nextName, { create: true });
      if (
        (await projectDirectoryHasManifest(directory)) &&
        !window.confirm(`Overwrite the Dataset Creator project in "${nextName}"?`)
      ) {
        return;
      }
      projectSessionRef.current += 1;
      autoSaveQueueRef.current = Promise.resolve();
      setProjectDirectory(undefined);
      initializeProject(nextName);
      const project = useProjectStore.getState();
      await clearProjectDirectory(directory);
      await createProjectDirectory(directory, project);
      setProjectDirectory({ handle: directory, name: directory.name });
      addNotification('success', 'New project directory created');
    } catch (error) {
      handleProjectFileError(error, 'Failed to create project directory');
    } finally {
      projectOperationBusyRef.current = false;
      setIsProjectDirectoryBusy(false);
    }
  };

  const openProjectDirectory = async (directory: ProjectDirectoryHandle) => {
    const project = await readProjectDirectory(directory);
    projectSessionRef.current += 1;
    autoSaveQueueRef.current = Promise.resolve();
    setProjectDirectory(undefined);
    loadProject(project);
    setProjectDirectory({ handle: directory, name: directory.name });
    addNotification('success', 'Project directory opened');
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

  const renderNavigationButton = (tool: string, compact = false) => {
    const Icon = toolIcons[tool];
    const active = tool === currentStage;

    return (
      <button
        key={tool}
        onClick={() => navigateToStage(tool as StageName)}
        className={
          compact
            ? `flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-foreground hover:bg-secondary hover:text-secondary-foreground'
              }`
            : `flex h-10 w-full items-center gap-3 rounded-md px-4 text-left text-sm font-medium transition-colors ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-foreground hover:bg-secondary hover:text-secondary-foreground'
              }`
        }
        title={STAGE_LABELS[tool]}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {!compact && <span className="block min-w-0 truncate">{STAGE_LABELS[tool]}</span>}
      </button>
    );
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-16 shrink-0 flex-col items-center border-r border-border bg-card py-4">
        <button
          onClick={() => setSidebarOpen(true)}
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90"
          title="Open menu"
        >
          <Menu size={18} />
        </button>

        <nav className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
          {SIDEBAR_PRIMARY_TOOLS.map((tool) => renderNavigationButton(tool, true))}
          {SIDEBAR_PRIMARY_TOOLS.length > 0 && SIDEBAR_SECONDARY_TOOLS.length > 0 && (
            <Separator className="my-2 w-8 bg-border/70" />
          )}
          {SIDEBAR_SECONDARY_TOOLS.map((tool) => renderNavigationButton(tool, true))}
        </nav>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/65" onClick={() => setSidebarOpen(false)} />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-card shadow-2xl transition-transform duration-200 ${
          sidebarOpen ? 'translate-x-0' : 'pointer-events-none -translate-x-full'
        }`}
        aria-hidden={!sidebarOpen}
      >
        <div className="p-5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigateToStage('hub')}
              className="block min-w-0 flex-1 rounded-lg text-left transition-colors hover:bg-secondary/70"
            >
              <div className="p-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Archive size={18} />
                  </div>
                  <div>
                    <h1 className="font-semibold leading-tight">Image Workspace</h1>
                  </div>
                </div>
              </div>
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary hover:bg-muted transition-colors"
              title="Close menu"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-5">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">Source</p>
              <p className="text-xl font-semibold">{sourceImages.length}</p>
            </div>
            <div className="rounded-md border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">Synthetic</p>
              <p className="text-xl font-semibold">{datasetItems.length}</p>
            </div>
          </div>
        </div>

        <Separator className="mt-4 mb-3" />

        <nav className="flex-1 overflow-y-auto px-3 pb-5">
          <div className="space-y-1">
            {SIDEBAR_PRIMARY_TOOLS.map((tool) => renderNavigationButton(tool))}
          </div>

          {SIDEBAR_PRIMARY_TOOLS.length > 0 && SIDEBAR_SECONDARY_TOOLS.length > 0 && (
            <Separator className="my-3 bg-border/70" />
          )}

          <div className="space-y-1">
            {SIDEBAR_SECONDARY_TOOLS.map((tool) => renderNavigationButton(tool))}
          </div>
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="relative z-30 flex h-9 shrink-0 items-center border-b border-border bg-card px-3 text-sm">
          {(fileMenuOpen || viewMenuOpen) && (
            <button
              type="button"
              aria-label="Close menu"
              className="fixed inset-0 z-30 cursor-default"
              onClick={() => {
                setFileMenuOpen(false);
                setViewMenuOpen(false);
              }}
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
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={() => navigateToStage('import')}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <Upload className="h-4 w-4" />
                  <span className="flex-1">Import Images</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigateToStage('export')}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <Download className="h-4 w-4" />
                  <span className="flex-1">Export Dataset</span>
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
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={() => setRightPanelOpen((open) => !open)}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <PanelRight className="h-4 w-4" />
                  <span className="flex-1">Inspector</span>
                  {rightPanelOpen && <Check className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setBottomPanelOpen((open) => !open)}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <PanelBottom className="h-4 w-4" />
                  <span className="flex-1">Output</span>
                  {bottomPanelOpen && <Check className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setProjectWindowOpen(true)}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="flex-1">Project window</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInspectorWindowOpen(true)}
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
              setFileMenuOpen(false);
              setViewMenuOpen(false);
              setIsWorkspaceSettingsOpen(true);
            }}
          >
            Settings
          </button>
        </div>

        <div className="workspace-tab-strip flex h-9 shrink-0 items-stretch border-b border-border bg-background px-1">
          {openTabs.map((tab) => {
            const Icon = tab === 'hub' ? Archive : toolIcons[tab];
            const active = currentStage === tab;
            return (
              <div
                key={tab}
                className={`group flex min-w-0 max-w-52 items-center border-r border-border ${
                  active ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-secondary/60'
                }`}
              >
                <button
                  type="button"
                  onClick={() => navigateToStage(tab)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs"
                  title={`Open ${STAGE_LABELS[tab]}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{STAGE_LABELS[tab]}</span>
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab)}
                  className="mr-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                  title="Close tab"
                  aria-label={`Close ${STAGE_LABELS[tab]} tab`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <div className="flex min-w-0 flex-1 items-center justify-end px-2 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
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
          <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border bg-card px-4 py-4 md:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <h2 className="truncate text-xl font-semibold">{activeLabel}</h2>
                {currentStage !== 'hub' && <Badge variant="outline">Tool</Badge>}
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {activeDescription}{' '}
                {currentStage === 'analysis' || currentStage === 'review' || currentStage === 'clean'
                  ? `${workspaceImages.length} images in scope.`
                  : ''}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                Project: <span className="font-medium text-foreground">{projectName}</span>
                {projectDirectoryName ? ` - ${projectDirectoryName}` : ''}
              </p>
            </div>

            {showEditToolbar && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => runEditCommand('back')}
                  disabled={editToolbar.isProcessing}
                  className="p-2 rounded-md bg-secondary hover:bg-muted disabled:opacity-50 transition-colors"
                  title="Back"
                >
                  <ArrowLeft size={18} />
                </button>
                <a
                  href="https://www.photopea.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 bg-secondary hover:bg-muted rounded-md transition-colors text-sm font-medium"
                >
                  <ExternalLink size={15} />
                  Photopea
                </a>
                <button
                  onClick={() => runEditCommand('save')}
                  disabled={!editToolbar.canSave || editToolbar.isProcessing}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity text-sm font-medium"
                >
                  Save
                </button>
                <button
                  onClick={() => runEditCommand('saveCopy')}
                  disabled={!editToolbar.canSave || editToolbar.isProcessing}
                  className="px-4 py-2 bg-secondary hover:bg-muted disabled:opacity-50 rounded-md transition-colors text-sm font-medium"
                >
                  Save Copy
                </button>
                <button
                  onClick={() => runEditCommand('cancel')}
                  disabled={editToolbar.isProcessing}
                  className="px-4 py-2 bg-secondary hover:bg-muted disabled:opacity-50 rounded-md transition-colors text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            )}

            {showTaggingToolbar && (
              <div className="flex shrink-0 items-center gap-2">
                {showTaggingBackButton && (
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent(TAGGING_TOOL_COMMAND_EVENT, { detail: 'back' }))}
                    className="rounded-md bg-secondary p-2 transition-colors hover:bg-muted"
                    title="Back"
                  >
                    <ArrowLeft size={18} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setTaggingModal({ datasetTags: true })}
                  className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <Tags size={16} />
                  Dataset Tags
                </button>
                <button
                  type="button"
                  onClick={() => setTaggingModal({ settings: true })}
                  className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <Settings2 size={16} />
                  Settings
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={showEditToolbar || showFullscreenTagging ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 overflow-auto'}
          >
            <div
              className={
                showEditToolbar || showFullscreenTagging
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
                {renderTool(currentStage)}
              </Suspense>
            </div>
          </div>
          {bottomPanelOpen && (
            <section className="workspace-dock-bottom shrink-0 border-t border-border bg-card" style={{ height: bottomPanelHeight }}>
              <button
                type="button"
                aria-label="Resize output panel"
                className="workspace-dock-resize-horizontal h-1 w-full cursor-ns-resize bg-transparent hover:bg-primary/60"
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
              <div className="flex h-[calc(100%-0.25rem)] flex-col px-4 py-2">
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
                <div className="mt-2 min-h-0 flex-1 overflow-auto font-mono text-[11px] text-muted-foreground">
                  <p className="text-emerald-400">workspace ready</p>
                  <p>active tool: {STAGE_LABELS[currentStage]}</p>
                  <p>scope: {workspaceImages.length} images</p>
                  <p>source: {sourceImages.length} / synthetic: {datasetItems.length}</p>
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
                <div className="space-y-4 text-xs">
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Active tool</p>
                    <p className="font-medium">{STAGE_LABELS[currentStage]}</p>
                    <p className="mt-1 text-muted-foreground">{TOOL_DESCRIPTIONS[currentStage]}</p>
                  </div>
                  <div className="border-t border-border pt-3">
                    <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Workspace</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded border border-border bg-background p-2">
                        <p className="text-muted-foreground">Source</p>
                        <p className="mt-1 text-lg font-semibold">{sourceImages.length}</p>
                      </div>
                      <div className="rounded border border-border bg-background p-2">
                        <p className="text-muted-foreground">Synthetic</p>
                        <p className="mt-1 text-lg font-semibold">{datasetItems.length}</p>
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-border pt-3">
                    <p className="mb-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Project</p>
                    <p className="truncate font-medium">{projectName}</p>
                    <p className="mt-1 truncate text-muted-foreground">{projectDirectoryName ?? 'Unsaved workspace'}</p>
                  </div>
                </div>
              </div>
            </aside>
          )}
        </div>

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
            onChange={setProjectWindow}
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
                  {openTabs.map((tab) => {
                    const Icon = tab === 'hub' ? Archive : toolIcons[tab];
                    return (
                      <button
                        type="button"
                        key={tab}
                        onClick={() => navigateToStage(tab)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors ${
                          currentStage === tab ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span className="truncate">{STAGE_LABELS[tab]}</span>
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
            onChange={setInspectorWindow}
            onClose={() => setInspectorWindowOpen(false)}
          >
            <div className="space-y-4 text-xs">
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Selection</p>
                <p className="font-medium">{STAGE_LABELS[currentStage]}</p>
                <p className="mt-1 text-muted-foreground">{workspaceImages.length} images in scope</p>
              </div>
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
