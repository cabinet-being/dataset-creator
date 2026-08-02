import { useEffect } from 'react';
import type { ComponentType } from 'react';
import {
  Archive,
  ArrowLeft,
  Brush,
  Download,
  ExternalLink,
  Image,
  Layers3,
  ScanSearch,
  Tags,
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
import { type StageName } from './types';
import { ToolHub } from './components/ToolHub';
import { ImportStage } from './components/stages/ImportStage';
import { SimilarityReviewStage } from './components/stages/SimilarityReviewStage';
import { CleanupStage } from './components/stages/CleanupStage';
import { FinalReviewStage } from './components/stages/FinalReviewStage';
import { TaggingStage } from './components/stages/TaggingStage';
import { ExportStage } from './components/stages/ExportStage';
import { Badge } from './components/ui/badge';
import { Separator } from './components/ui/separator';
import './App.css';

const EDIT_TOOL_COMMAND_EVENT = 'dataset-creator-edit-command';

const toolIcons: Record<string, ComponentType<{ className?: string }>> = {
  import: Image,
  select: ScanSearch,
  clean: Brush,
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
  const currentStage = useProjectStore((state) => state.currentStage);
  const setCurrentStage = useProjectStore((state) => state.setCurrentStage);
  const hydrateSourceImages = useProjectStore((state) => state.hydrateSourceImages);
  const hydrateDatasetItems = useProjectStore((state) => state.hydrateDatasetItems);
  const sourceImages = useProjectStore((state) => Object.values(state.sourceImages));
  const datasetItems = useProjectStore((state) => state.getDatasetItems(false));
  const workspaceImages = toWorkspaceImages(sourceImages, datasetItems);
  const { darkMode, setDarkMode, editToolbar } = useUIStore();

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

  const activeLabel = STAGE_LABELS[currentStage] ?? 'Image Workspace';
  const activeDescription =
    currentStage === 'hub'
      ? 'Choose a tool and keep working from the shared image workspace.'
      : TOOL_DESCRIPTIONS[currentStage] ?? '';
  const showEditToolbar = currentStage === 'clean' && editToolbar.visible;
  const runEditCommand = (command: 'back' | 'save' | 'saveCopy' | 'cancel') => {
    window.dispatchEvent(new CustomEvent(EDIT_TOOL_COMMAND_EVENT, { detail: command }));
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="p-5">
          <button
            onClick={() => setCurrentStage('hub')}
            className="block w-full rounded-lg text-left transition-colors hover:bg-secondary/70"
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
            {SIDEBAR_PRIMARY_TOOLS.map((tool) => {
              const Icon = toolIcons[tool];
              const active = tool === currentStage;

              return (
                <button
                  key={tool}
                  onClick={() => setCurrentStage(tool as StageName)}
                  className={`flex h-10 w-full items-center gap-3 rounded-md px-4 text-left text-sm font-medium transition-colors ${
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-secondary hover:text-secondary-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="block min-w-0 truncate">{STAGE_LABELS[tool]}</span>
                </button>
              );
            })}
          </div>

          <Separator className="my-3 bg-border/70" />

          <div className="space-y-1">
            {SIDEBAR_SECONDARY_TOOLS.map((tool) => {
              const Icon = toolIcons[tool];
              const active = tool === currentStage;

              return (
                <button
                  key={tool}
                  onClick={() => setCurrentStage(tool as StageName)}
                  className={`flex h-10 w-full items-center gap-3 rounded-md px-4 text-left text-sm font-medium transition-colors ${
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-secondary hover:text-secondary-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="block min-w-0 truncate">{STAGE_LABELS[tool]}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="border-b border-border bg-card px-4 py-4 md:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <h2 className="truncate text-xl font-semibold">{activeLabel}</h2>
                {currentStage !== 'hub' && <Badge variant="outline">Tool</Badge>}
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {activeDescription} {currentStage === 'review' ? `${workspaceImages.length} images in scope.` : ''}
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
