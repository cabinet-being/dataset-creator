import { useCallback } from 'react';
import { ArrowLeft, Wand2 } from 'lucide-react';
import { useBuildModel } from '../../components/build/useBuildModel';
import { Button } from '../../components/ui/button';
import { PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../../lib/projectProfiles';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { cn } from '../../lib/utils';
import { getMinShortSide } from '../../services/quality/imageQuality';
import { useProjectStore } from '../../stores/useProjectStore';
import { FrameGrid } from '../board/FrameGrid';
import { SourcesPanel } from '../board/SourcesPanel';
import type { useProjectRuntime } from '../useProjectRuntime';

type Runtime = ReturnType<typeof useProjectRuntime>;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function BoardHeader({ runtime }: { runtime: Runtime }) {
  const projectType = useProjectStore(state => state.projectType);
  const targetModel = useProjectStore(state => state.targetModel);
  const { isProjectDirectoryBusy } = runtime;
  return <header data-board-header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card px-4 py-2">
    <Button variant="outline" className="min-h-[44px]" disabled={isProjectDirectoryBusy} onClick={() => void runtime.closeProject()}>
      <ArrowLeft className="h-4 w-4" />Projects
    </Button>
    <h1 data-next-project-name className="min-w-0 truncate text-base font-semibold tracking-tight">{runtime.projectDirectoryName ?? runtime.projectName}</h1>
    <span data-project-chip className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
      {PROJECT_TYPE_PROFILES[projectType]?.label ?? projectType} · {TARGET_MODEL_PRESETS[targetModel]?.label ?? targetModel} · min {getMinShortSide(targetModel)} px
    </span>
    <div role="group" aria-label="Mode" className="ml-auto flex overflow-hidden rounded-md border border-border">
      <button type="button" aria-pressed="true" data-mode="select" className={cn('min-h-[44px] bg-primary px-4 text-sm font-medium text-primary-foreground', focusRing)}>Select</button>
      <button type="button" aria-pressed="false" data-mode="caption" disabled title="Available in a later step"
        className={cn('min-h-[44px] px-4 text-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60', focusRing)}>Caption</button>
    </div>
    {/* Placeholder for the primary Assemble action (stage 3). */}
    <Button data-assemble-placeholder className="min-h-[44px]" disabled title="Available in a later step"><Wand2 className="h-4 w-4" />Assemble</Button>
  </header>;
}

/** Board of the next UI: Sources on the left, the frame grid in the middle, room for Health on the right. Mount with `key={projectId}`. */
export function BoardScreen({ runtime }: { runtime: Runtime }) {
  const { effectiveItems, candidates, reconciled, patchSession } = useBuildModel(runtime.workspaceReviewItems, { writeBack: true, busy: runtime.isProjectDirectoryBusy });
  const sources = reconciled.profile.sources;
  const setSources = useCallback((next: string[]) => patchSession(session => ({ ...session, profile: { ...session.profile, sources: next } })), [patchSession]);

  const { explorer } = runtime;
  // Dragging frames from the grid onto an inbox folder moves their files through the Explorer mutations.
  const dragFrames = useCallback((items: WorkspaceImage[]) => explorer.setCurrentDraggedExplorerEntries(items.flatMap(item => item.assetPath
    ? [{ path: item.assetPath, name: item.assetPath.split('/').pop() ?? item.fileName, kind: 'file' as const, workspaceImageId: item.id }] : [])), [explorer]);
  const endFrameDrag = useCallback(() => explorer.setCurrentDraggedExplorerEntries(null), [explorer]);

  return <div data-board className="flex min-h-0 flex-1 flex-col">
    <BoardHeader runtime={runtime} />
    <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
      <SourcesPanel runtime={runtime} items={effectiveItems} sources={sources} onSourcesChange={setSources} />
      <main data-board-grid className="flex min-h-[320px] min-w-0 flex-1 flex-col">
        <FrameGrid candidates={candidates} effectiveItems={effectiveItems} session={reconciled} onDragFrames={dragFrames} onDragFramesEnd={endFrameDrag} />
      </main>
      {/* The Health column (stage 3) goes here. */}
    </div>
  </div>;
}
