import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ComponentType } from 'react';
import {
  Archive,
  ArrowLeft,
  BarChart3,
  Brush,
  Download,
  ExternalLink,
  FilePlus,
  FolderOpen,
  Check,
  Layers3,
  Menu,
  Moon,
  Pencil,
  ScanSearch,
  Save,
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
  TOOL_DESCRIPTIONS,
} from './lib/constants';
import { toWorkspaceImages } from './lib/workspaceImages';
import {
  downloadProjectFile,
  pickProjectFileForOpen,
  pickProjectFileForSave,
  PROJECT_FILE_EXTENSION,
  type ProjectFileHandle,
  readProjectFile,
  writeProjectFileToHandle,
} from './services/project/projectFileService';
import { type StageName } from './types';
import { ToolHub } from './components/ToolHub';
import { ImportStage } from './components/stages/ImportStage';
import { SimilarityReviewStage } from './components/stages/SimilarityReviewStage';
import { CleanupStage } from './components/stages/CleanupStage';
import { AnalysisStage } from './components/stages/AnalysisStage';
import { FinalReviewStage } from './components/stages/FinalReviewStage';
import { TaggingStage } from './components/stages/TaggingStage';
import { ExportStage } from './components/stages/ExportStage';
import { Badge } from './components/ui/badge';
import { Separator } from './components/ui/separator';
import './App.css';

const EDIT_TOOL_COMMAND_EVENT = 'dataset-creator-edit-command';
const TAGGING_TOOL_COMMAND_EVENT = 'dataset-creator-tagging-command';

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

function App() {
  const projectName = useProjectStore((state) => state.name);
  const currentStage = useProjectStore((state) => state.currentStage);
  const initializeProject = useProjectStore((state) => state.initializeProject);
  const loadProject = useProjectStore((state) => state.loadProject);
  const renameProject = useProjectStore((state) => state.renameProject);
  const setCurrentStage = useProjectStore((state) => state.setCurrentStage);
  const hydrateSourceImages = useProjectStore((state) => state.hydrateSourceImages);
  const hydrateDatasetItems = useProjectStore((state) => state.hydrateDatasetItems);
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
    addNotification,
    projectFileHandle,
    projectFileName,
    setProjectFile,
  } = useUIStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [isProjectFileBusy, setIsProjectFileBusy] = useState(false);
  const projectInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDarkMode(prefersDark);

    Promise.all([hydrateSourceImages(), hydrateDatasetItems()]).catch((error) => {
      console.warn('Failed to hydrate image workspace', error);
    });
  }, [hydrateDatasetItems, hydrateSourceImages, setDarkMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    if (!(STAGES as readonly string[]).includes(currentStage)) {
      setCurrentStage('hub');
    }
  }, [currentStage, setCurrentStage]);

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
  const runEditCommand = (command: 'back' | 'save' | 'saveCopy' | 'cancel') => {
    window.dispatchEvent(new CustomEvent(EDIT_TOOL_COMMAND_EVENT, { detail: command }));
  };
  const runTaggingCommand = (command: 'datasetTags' | 'settings') => {
    window.dispatchEvent(new CustomEvent(TAGGING_TOOL_COMMAND_EVENT, { detail: command }));
  };
  const navigateToStage = (stage: StageName) => {
    setCurrentStage(stage);
    setSidebarOpen(false);
    setFileMenuOpen(false);
    setViewMenuOpen(false);
  };

  const handleThemeChange = (nextDarkMode: boolean) => {
    setDarkMode(nextDarkMode);
    setViewMenuOpen(false);
  };

  const handleProjectFileError = (error: unknown, message: string) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    console.error(message, error);
    addNotification('error', message);
  };

  const handleNewProject = () => {
    setFileMenuOpen(false);
    if (workspaceImages.length > 0 && !window.confirm('Create a new project and clear the current workspace?')) {
      return;
    }

    const nextName = window.prompt('Project name', 'Untitled Project')?.trim() || 'Untitled Project';
    initializeProject(nextName);
    setProjectFile(undefined);
    addNotification('success', 'New project created');
  };

  const openProjectFile = async (file: File, handle?: ProjectFileHandle) => {
    const project = await readProjectFile(file);
    loadProject(project);
    setProjectFile({ handle, name: file.name });
    addNotification('success', 'Project file opened');
  };

  const handleOpenProjectInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) {
      return;
    }

    setIsProjectFileBusy(true);
    try {
      await openProjectFile(file);
    } catch (error) {
      handleProjectFileError(error, 'Failed to open project file');
    } finally {
      setIsProjectFileBusy(false);
    }
  };

  const handleOpenProject = async () => {
    setFileMenuOpen(false);
    setIsProjectFileBusy(true);
    try {
      const picked = await pickProjectFileForOpen();
      if (picked) {
        await openProjectFile(picked.file, picked.handle);
      } else {
        projectInputRef.current?.click();
      }
    } catch (error) {
      handleProjectFileError(error, 'Failed to open project file');
    } finally {
      setIsProjectFileBusy(false);
    }
  };

  const handleSaveProjectAs = async () => {
    setFileMenuOpen(false);
    setIsProjectFileBusy(true);
    try {
      const project = useProjectStore.getState();
      const handle = await pickProjectFileForSave(project.name);
      if (handle) {
        await writeProjectFileToHandle(project, handle);
        setProjectFile({ handle, name: handle.name ?? `${project.name}.${PROJECT_FILE_EXTENSION}` });
      } else {
        await downloadProjectFile(project);
        setProjectFile({ name: `${project.name}.${PROJECT_FILE_EXTENSION}` });
      }
      addNotification('success', 'Project file saved');
    } catch (error) {
      handleProjectFileError(error, 'Failed to save project file');
    } finally {
      setIsProjectFileBusy(false);
    }
  };

  const handleSaveProject = async () => {
    setFileMenuOpen(false);
    if (!projectFileHandle) {
      await handleSaveProjectAs();
      return;
    }

    setIsProjectFileBusy(true);
    try {
      await writeProjectFileToHandle(useProjectStore.getState(), projectFileHandle);
      addNotification('success', 'Project file saved');
    } catch (error) {
      handleProjectFileError(error, 'Failed to save project file');
    } finally {
      setIsProjectFileBusy(false);
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
                  disabled={isProjectFileBusy}
                  onClick={handleNewProject}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50"
                >
                  <FilePlus className="h-4 w-4" />
                  <span className="flex-1">New</span>
                </button>
                <button
                  type="button"
                  disabled={isProjectFileBusy}
                  onClick={() => void handleOpenProject()}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="flex-1">Open</span>
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  disabled={isProjectFileBusy}
                  onClick={() => void handleSaveProject()}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  <span className="flex-1">Save</span>
                </button>
                <button
                  type="button"
                  disabled={isProjectFileBusy}
                  onClick={() => void handleSaveProjectAs()}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50"
                >
                  <Download className="h-4 w-4" />
                  <span className="flex-1">Save As</span>
                </button>
                <button
                  type="button"
                  disabled={isProjectFileBusy}
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
              </div>
            )}
          </div>
          <input
            ref={projectInputRef}
            type="file"
            accept={`.${PROJECT_FILE_EXTENSION}`}
            onChange={(event) => void handleOpenProjectInput(event)}
            className="hidden"
          />
        </div>

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
                {projectFileName ? ` - ${projectFileName}` : ''}
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
                <button
                  type="button"
                  onClick={() => runTaggingCommand('datasetTags')}
                  className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <Tags size={16} />
                  Dataset Tags
                </button>
                <button
                  type="button"
                  onClick={() => runTaggingCommand('settings')}
                  className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <Settings2 size={16} />
                  Settings
                </button>
              </div>
            )}
          </div>
        </header>

        <div className={showEditToolbar ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 overflow-auto'}>
          <div className={showEditToolbar ? 'h-full min-h-0' : 'p-4 md:p-6'}>
            {renderTool(currentStage)}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
