import {
  Archive,
  Brush,
  Crop,
  Download,
  Image,
  Layers3,
  ScanSearch,
  Sparkles,
  Tags,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { HUB_TOOL_CARDS, STAGE_LABELS, TOOL_DESCRIPTIONS, TOOL_REQUIREMENTS } from '../lib/constants';
import { useProjectStore } from '../stores/useProjectStore';
import { type StageName } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

const toolIcons: Record<string, ComponentType<{ className?: string }>> = {
  import: Image,
  select: ScanSearch,
  clean: Brush,
  crop: Crop,
  augment: Sparkles,
  review: Layers3,
  tagging: Tags,
  export: Download,
};

const getRequirementLabel = (
  requirement: (typeof TOOL_REQUIREMENTS)[string],
  sourceCount: number,
  datasetCount: number
) => {
  if (requirement === 'none') {
    return 'Ready';
  }

  if (requirement === 'sourceImages') {
    return sourceCount > 0 ? 'Ready' : 'Needs sources';
  }

  return datasetCount > 0 ? 'Ready' : 'Needs dataset';
};

export const ToolHub = () => {
  const setCurrentStage = useProjectStore((state) => state.setCurrentStage);
  const sourceImages = useProjectStore((state) => Object.values(state.sourceImages));
  const datasetItems = useProjectStore((state) => state.getDatasetItems(false));
  const taggingConfig = useProjectStore((state) => state.taggingConfig);

  const sourceCount = sourceImages.length;
  const datasetCount = datasetItems.length;
  const taggedCount = datasetItems.filter((item) => item.tags && item.tags.length > 0).length;
  const totalSourceSize = sourceImages.reduce((sum, image) => {
    return sum + (image.originalFile instanceof Blob ? image.originalFile.size : 0);
  }, 0);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <section className="grid gap-4 md:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <Badge variant="secondary" className="mb-3">
                Shared workspace
              </Badge>
              <h1 className="text-3xl font-semibold tracking-normal">Dataset tools</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Import images once, keep them in the browser workspace, and move between tools
                without restarting the preparation flow.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
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
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">Source images</p>
              <p className="mt-2 text-2xl font-semibold">{sourceCount}</p>
            </div>
            <div className="rounded-md border border-border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">Dataset items</p>
              <p className="mt-2 text-2xl font-semibold">{datasetCount}</p>
            </div>
            <div className="rounded-md border border-border bg-background p-4">
              <p className="text-xs font-medium text-muted-foreground">Tagged items</p>
              <p className="mt-2 text-2xl font-semibold">
                {taggedCount}/{datasetCount}
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
              Source images and generated dataset items are backed by IndexedDB and stay
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
            (requirement === 'datasetItems' && datasetCount > 0);

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
                    {getRequirementLabel(requirement, sourceCount, datasetCount)}
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
