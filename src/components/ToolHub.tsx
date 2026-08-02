import {
  Archive,
  Brush,
  Download,
  Image,
  Layers3,
  ScanSearch,
  Save,
  Tags,
  Upload,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useRef, useState } from 'react';
import { HUB_TOOL_CARDS, STAGE_LABELS, TOOL_DESCRIPTIONS, TOOL_REQUIREMENTS } from '../lib/constants';
import { toWorkspaceImages } from '../lib/workspaceImages';
import {
  downloadProjectFile,
  PROJECT_FILE_EXTENSION,
  readProjectFile,
} from '../services/project/projectFileService';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';
import { type StageName } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

const toolIcons: Record<string, ComponentType<{ className?: string }>> = {
  import: Image,
  select: ScanSearch,
  clean: Brush,
  review: Layers3,
  tagging: Tags,
  export: Download,
};

const getRequirementLabel = (
  requirement: (typeof TOOL_REQUIREMENTS)[string],
  sourceCount: number,
  workspaceCount: number
) => {
  if (requirement === 'none') {
    return 'Ready';
  }

  if (requirement === 'sourceImages') {
    return sourceCount > 0 ? 'Ready' : 'Needs Source';
  }

  return workspaceCount > 0 ? 'Ready' : 'Needs images';
};

export const ToolHub = () => {
  const setCurrentStage = useProjectStore((state) => state.setCurrentStage);
  const loadProject = useProjectStore((state) => state.loadProject);
  const sourceImages = useProjectStore((state) => Object.values(state.sourceImages));
  const syntheticImages = useProjectStore((state) => state.getDatasetItems(false));
  const taggingConfig = useProjectStore((state) => state.taggingConfig);
  const addNotification = useUIStore((state) => state.addNotification);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const [isProjectFileBusy, setIsProjectFileBusy] = useState(false);

  const sourceCount = sourceImages.length;
  const syntheticCount = syntheticImages.length;
  const workspaceImages = toWorkspaceImages(sourceImages, syntheticImages);
  const workspaceCount = workspaceImages.length;
  const taggedCount = workspaceImages.filter((item) => item.tags && item.tags.length > 0).length;
  const totalSourceSize = sourceImages.reduce((sum, image) => {
    return sum + (image.originalFile instanceof Blob ? image.originalFile.size : 0);
  }, 0);
  const handleSaveProject = async () => {
    setIsProjectFileBusy(true);
    try {
      await downloadProjectFile(useProjectStore.getState());
      addNotification('success', 'Project file saved');
    } catch (error) {
      console.error('Failed to save project file:', error);
      addNotification('error', 'Failed to save project file');
    } finally {
      setIsProjectFileBusy(false);
    }
  };

  const handleOpenProject = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) {
      return;
    }

    setIsProjectFileBusy(true);
    try {
      const project = await readProjectFile(file);
      loadProject(project);
      addNotification('success', 'Project file opened');
    } catch (error) {
      console.error('Failed to open project file:', error);
      addNotification('error', 'Failed to open project file');
    } finally {
      setIsProjectFileBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <section className="grid gap-4 md:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <Badge variant="secondary" className="mb-3">
                Shared workspace
              </Badge>
              <h1 className="text-3xl font-semibold tracking-normal">Image tools</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Import images once, keep them in the browser workspace, and move between tools
                without restarting the preparation flow.
              </p>
            </div>

            <div className="flex w-full flex-wrap justify-start gap-3 lg:w-auto lg:shrink-0 lg:justify-end">
              <Button
                size="lg"
                variant="outline"
                className="whitespace-nowrap"
                disabled={isProjectFileBusy}
                onClick={() => projectInputRef.current?.click()}
              >
                <Upload size={18} />
                Open Project
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="whitespace-nowrap"
                disabled={isProjectFileBusy}
                onClick={() => void handleSaveProject()}
              >
                <Save size={18} />
                Save Project
              </Button>
              <Button size="lg" className="whitespace-nowrap" onClick={() => setCurrentStage('import')}>
                <Image size={18} />
                Import
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="whitespace-nowrap"
                onClick={() => setCurrentStage('export')}
              >
                <Download size={18} />
                Export
              </Button>
              <input
                ref={projectInputRef}
                type="file"
                accept={`.${PROJECT_FILE_EXTENSION}`}
                onChange={(event) => void handleOpenProject(event)}
                className="hidden"
              />
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">Source</p>
              <p className="mt-2 text-2xl font-semibold">{sourceCount}</p>
            </div>
            <div className="rounded-md border border-border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">Synthetic</p>
              <p className="mt-2 text-2xl font-semibold">{syntheticCount}</p>
            </div>
            <div className="rounded-md border border-border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">Captioned</p>
              <p className="mt-2 text-2xl font-semibold">
                {taggedCount}/{workspaceCount}
              </p>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Workspace</CardTitle>
              <Archive className="h-5 w-5 text-muted-foreground" />
            </div>
            <CardDescription>Shared browser workspace data.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Source size</span>
              <span className="font-medium">{(totalSourceSize / 1024 / 1024).toFixed(1)} MB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Export keyword</span>
              <span className="font-mono text-xs font-medium">{taggingConfig.datasetKeyword}</span>
            </div>
            <div className="rounded-md bg-secondary p-3 text-xs text-muted-foreground">
              Source and Synthetic images are backed by IndexedDB and stay
              available while switching tools.
            </div>
            <button
              type="button"
              onClick={() => setCurrentStage('review')}
              className="text-left text-sm font-medium text-primary underline underline-offset-4 transition-opacity hover:opacity-80"
            >
              Open Review
            </button>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {HUB_TOOL_CARDS.map((tool, index) => {
          const Icon = toolIcons[tool];
          const requirement = TOOL_REQUIREMENTS[tool];
          const ready =
            requirement === 'none' ||
            (requirement === 'sourceImages' && sourceCount > 0) ||
            (requirement === 'workspaceImages' && workspaceCount > 0);

          return (
            <Card key={tool} className="flex min-h-[220px] flex-col">
              <CardHeader>
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <Badge
                    variant={ready ? 'secondary' : 'outline'}
                    className={!ready ? 'bg-background text-muted-foreground' : undefined}
                  >
                    {getRequirementLabel(requirement, sourceCount, workspaceCount)}
                  </Badge>
                </div>
                <CardTitle className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{index + 1}.</span>
                  {STAGE_LABELS[tool]}
                </CardTitle>
                <CardDescription>{TOOL_DESCRIPTIONS[tool]}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto">
                <Button
                  variant={ready ? 'default' : 'outline'}
                  className="w-full"
                  onClick={() => setCurrentStage(tool as StageName)}
                >
                  Open tool
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
};
