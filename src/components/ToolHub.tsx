import {
  Archive,
  BarChart3,
  Brush,
  Download,
  Layers3,
  ScanSearch,
  Tags,
  Upload,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useMemo } from 'react';
import { HUB_TOOL_CARDS, STAGE_LABELS, TOOL_REQUIREMENTS } from '../lib/constants';
import { toWorkspaceImages } from '../lib/workspaceImages';
import { useProjectStore } from '../stores/useProjectStore';
import { type StageName } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

const toolIcons: Record<string, ComponentType<{ className?: string }>> = {
  import: Upload,
  select: ScanSearch,
  clean: Brush,
  analysis: BarChart3,
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

type ToolHubProps = {
  onOpenTool?: (stage: StageName) => void;
};

export const ToolHub = ({ onOpenTool }: ToolHubProps = {}) => {
  const setCurrentStage = useProjectStore((state) => state.setCurrentStage);
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const syntheticImagesById = useProjectStore((state) => state.datasetItems);
  const datasetsById = useProjectStore((state) => state.datasets);
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const syntheticImages = useMemo(
    () => Object.values(syntheticImagesById).filter((item) => !item.deleted),
    [syntheticImagesById]
  );

  const sourceCount = sourceImages.length;
  const syntheticCount = syntheticImages.length;
  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, syntheticImages),
    [sourceImages, syntheticImages]
  );
  const workspaceCount = workspaceImages.length;
  const datasetCount = Object.keys(datasetsById).length;
  const totalSourceSize = sourceImages.reduce((sum, image) => {
    return sum + (image.originalFile instanceof Blob ? image.originalFile.size : 0);
  }, 0);
  const openTool = (stage: StageName) => {
    if (onOpenTool) {
      onOpenTool(stage);
      return;
    }
    setCurrentStage(stage);
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      <section className="rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Archive className="h-4 w-4 text-muted-foreground" />
              <h1 className="text-base font-semibold">Image Workspace</h1>
              <Badge variant="secondary">Project scope</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">Shared browser workspace</p>
          </div>
          <button
            type="button"
            onClick={() => openTool('review')}
            className="rounded border border-border px-3 py-2 text-sm font-medium hover:bg-secondary"
          >
            Open Project Review
          </button>
        </div>

        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-5">
          <div className="bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Source</p>
            <p className="mt-1 text-2xl font-semibold">{sourceCount}</p>
          </div>
          <div className="bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Generated</p>
            <p className="mt-1 text-2xl font-semibold">{syntheticCount}</p>
          </div>
          <div className="bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Datasets</p>
            <p className="mt-1 text-2xl font-semibold">{datasetCount}</p>
          </div>
          <div className="bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Workspace assets</p>
            <p className="mt-1 text-2xl font-semibold">{workspaceCount}</p>
          </div>
          <div className="bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Source size</p>
            <p className="mt-1 text-2xl font-semibold">{(totalSourceSize / 1024 / 1024).toFixed(1)} MB</p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {HUB_TOOL_CARDS.map((tool, index) => {
          const Icon = toolIcons[tool];
          const requirement = TOOL_REQUIREMENTS[tool];
          const ready =
            requirement === 'none' ||
            (requirement === 'sourceImages' && sourceCount > 0) ||
            (requirement === 'workspaceImages' && workspaceCount > 0);

          return (
            <Card key={tool}>
              <CardContent className="flex items-center gap-3 p-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{index + 1}.</span>
                    <h2 className="truncate text-sm font-semibold">{STAGE_LABELS[tool]}</h2>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge
                      variant={ready ? 'secondary' : 'outline'}
                      className={!ready ? 'bg-background text-muted-foreground' : undefined}
                    >
                      {getRequirementLabel(requirement, sourceCount, workspaceCount)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">Project scope</span>
                  </div>
                </div>
                <Button
                  variant={ready ? 'default' : 'outline'}
                  size="sm"
                  className="shrink-0"
                  onClick={() => openTool(tool as StageName)}
                >
                  Open
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
};
