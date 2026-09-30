import { PROJECT_TYPE_PROFILES } from '../lib/projectProfiles';
import {
  Archive,
  BarChart3,
  Brush,
  CheckCircle2,
  Download,
  Layers3,
  ScanSearch,
  Tags,
  Upload,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useMemo } from 'react';
import { HUB_TOOL_CARDS, TOOL_LABELS, TOOL_REQUIREMENTS } from '../lib/constants';
import { toWorkspaceImages } from '../lib/workspaceImages';
import { useProjectStore } from '../stores/useProjectStore';
import { type ToolName } from '../types';

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
  onOpenTool?: (tool: ToolName) => void;
};

export const ToolHub = ({
  onOpenTool,
}: ToolHubProps = {}) => {
  const profile = useProjectStore((state) => PROJECT_TYPE_PROFILES[state.projectType]);
  const setCurrentTool = useProjectStore((state) => state.setCurrentTool);
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const editedAssetsById = useProjectStore((state) => state.datasetItems);
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const editedAssets = useMemo(
    () => Object.values(editedAssetsById).filter((item) => !item.deleted),
    [editedAssetsById]
  );

  const sourceCount = sourceImages.length;
  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, editedAssets),
    [sourceImages, editedAssets]
  );
  const workspaceCount = workspaceImages.length;
  const openTool = (tool: ToolName) => {
    if (onOpenTool) {
      onOpenTool(tool);
      return;
    }
    setCurrentTool(tool);
  };

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="min-w-0 rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Archive className="h-4 w-4 text-muted-foreground" />
              <h1 className="text-base font-semibold">{profile.labels.workspace}</h1>
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
          {HUB_TOOL_CARDS.filter((tool) => profile.enabledTools.includes(tool as ToolName)).map((tool) => {
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
                    <p className="truncate text-sm font-medium">{TOOL_LABELS[tool]}</p>
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
                    onClick={() => openTool(tool as ToolName)}
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
            Dataset output
          </div>
        </div>
        <div className="space-y-3 px-4 py-4 text-sm text-muted-foreground">
          <p>Each project contains one dataset. Put final images in <code>dataset/</code>.</p>
          <p>Use <code>src/shared/</code> for files visible to global tools and <code>src/assets/</code> for private working files.</p>
          <button type="button" onClick={() => openTool('export')} className="rounded border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary">
            Open export
          </button>
        </div>
      </section>
    </div>
  );
};
