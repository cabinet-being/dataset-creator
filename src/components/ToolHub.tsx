import {
  Archive,
  BarChart3,
  Brush,
  CheckCircle2,
  Download,
  Layers3,
  Plus,
  ScanSearch,
  Tags,
  Upload,
  Wand2,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useMemo } from 'react';
import { HUB_TOOL_CARDS, STAGE_LABELS, TOOL_REQUIREMENTS } from '../lib/constants';
import { toWorkspaceImages } from '../lib/workspaceImages';
import { useProjectStore } from '../stores/useProjectStore';
import { type StageName } from '../types';

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
    return sourceCount > 0 ? 'Ready' : 'Needs sources';
  }

  return workspaceCount > 0 ? 'Ready' : 'Needs images';
};

type ToolHubProps = {
  onOpenTool?: (stage: StageName) => void;
  onOpenDataset?: (datasetId: string) => void;
  onOpenDatasetTool?: (datasetId: string, stage: Extract<StageName, 'select' | 'analysis' | 'review' | 'tagging'>) => void;
  onCreateDataset?: () => void;
  onExportDataset?: (datasetId: string) => void;
};

export const ToolHub = ({
  onOpenTool,
  onOpenDataset,
  onOpenDatasetTool,
  onCreateDataset,
  onExportDataset,
}: ToolHubProps = {}) => {
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
  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, syntheticImages),
    [sourceImages, syntheticImages]
  );
  const workspaceCount = workspaceImages.length;
  const datasetCount = Object.keys(datasetsById).length;
  const datasets = useMemo(
    () =>
      Object.values(datasetsById)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })),
    [datasetsById]
  );
  const openTool = (stage: StageName) => {
    if (onOpenTool) {
      onOpenTool(stage);
      return;
    }
    setCurrentStage(stage);
  };

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="min-w-0 rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Archive className="h-4 w-4 text-muted-foreground" />
              <h1 className="text-base font-semibold">Project Workspace</h1>
              <span className="rounded bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Project tool</span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">Tools and project assets</p>
          </div>
          <button
            type="button"
            onClick={() => openTool('review')}
            className="rounded border border-border px-3 py-2 text-sm font-medium hover:bg-secondary"
          >
            Open Project Review
          </button>
        </div>

        <div>
          <div className="hidden grid-cols-[minmax(0,1fr)_7rem_5rem] items-center border-b border-border px-4 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:grid">
            <span>Tool</span>
            <span>Status</span>
            <span className="text-right">Action</span>
          </div>
          {HUB_TOOL_CARDS.map((tool) => {
            const Icon = toolIcons[tool];
            const requirement = TOOL_REQUIREMENTS[tool];
            const ready =
              requirement === 'none' ||
              (requirement === 'sourceImages' && sourceCount > 0) ||
              (requirement === 'workspaceImages' && workspaceCount > 0);

            return (
              <div key={tool} className="grid gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_7rem_5rem] sm:items-center sm:py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-secondary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{STAGE_LABELS[tool]}</p>
                    <p className="text-xs text-muted-foreground">Project-wide</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 sm:contents">
                  <span className={`inline-flex w-fit items-center gap-1 rounded px-2 py-1 text-xs ${ready ? 'bg-secondary text-foreground' : 'border border-border text-muted-foreground'}`}>
                    {ready ? <CheckCircle2 className="h-3 w-3" /> : null}
                    {getRequirementLabel(requirement, sourceCount, workspaceCount)}
                  </span>
                  <button
                    type="button"
                    onClick={() => openTool(tool as StageName)}
                    className={`rounded px-3 py-1.5 text-xs font-medium sm:justify-self-end ${ready ? 'bg-primary text-primary-foreground hover:opacity-90' : 'border border-border hover:bg-secondary'}`}
                  >
                    Open
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-md border border-border bg-card">
        <div className="flex h-11 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Layers3 className="h-4 w-4 text-muted-foreground" />
            Datasets
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{datasetCount}</span>
            <button
              type="button"
              onClick={onCreateDataset}
              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              disabled={!onCreateDataset}
              title="New Dataset"
              aria-label="New Dataset"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="max-h-[32rem] divide-y divide-border overflow-auto">
          {datasets.length > 0 ? (
            datasets.map((dataset) => {
              const fileAssetCount = new Set([...(dataset.assetPaths ?? []), ...(dataset.psdAssetPaths ?? [])]).size;
              return (
                <div key={dataset.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onOpenDataset?.(dataset.id)}
                      className="min-w-0 truncate text-left text-sm font-medium hover:underline"
                    >
                      {dataset.name}
                    </button>
                    <span className="shrink-0 rounded bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                      {dataset.assetIds.length + fileAssetCount}
                    </span>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{dataset.filePath ?? 'Unsaved Dataset'}</span>
                    <span className="shrink-0">
                      {dataset.assetIds.length} source{dataset.assetIds.length !== 1 ? 's' : ''}
                    </span>
                    <span className="shrink-0">
                      {fileAssetCount} file{fileAssetCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-5 gap-1">
                    <button
                      type="button"
                      onClick={() => onOpenDatasetTool?.(dataset.id, 'select')}
                      className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
                      title="Remove Duplicates"
                      aria-label={`Remove duplicates in ${dataset.name}`}
                    >
                      <ScanSearch className="mx-auto h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenDatasetTool?.(dataset.id, 'review')}
                      className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
                      title="Review"
                      aria-label={`Review ${dataset.name}`}
                    >
                      <Layers3 className="mx-auto h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenDatasetTool?.(dataset.id, 'tagging')}
                      className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
                      title="Caption"
                      aria-label={`Caption ${dataset.name}`}
                    >
                      <Tags className="mx-auto h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenDatasetTool?.(dataset.id, 'analysis')}
                      className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
                      title="Analysis"
                      aria-label={`Analyze ${dataset.name}`}
                    >
                      <BarChart3 className="mx-auto h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onExportDataset?.(dataset.id)}
                      className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={!onExportDataset}
                      title="Export"
                      aria-label={`Export ${dataset.name}`}
                    >
                      <Download className="mx-auto h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              <Wand2 className="mx-auto mb-2 h-5 w-5 opacity-70" />
              <p>No Datasets</p>
              {onCreateDataset ? (
                <button
                  type="button"
                  onClick={onCreateDataset}
                  className="mt-3 rounded border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
                >
                  New Dataset
                </button>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
