import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useBuildModel } from '../../components/build/useBuildModel';
import { useUIStore } from '../../stores/useUIStore';
import { selectBuildDatasetItems } from '../../lib/buildStageSummary';
import type { createSemanticFeatureEncoder } from '../../services/analysis/semanticFeatureService';
import type { BuildSession } from '../../types';
import { Button } from '../../components/ui/button';
import { PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../../lib/projectProfiles';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { cn } from '../../lib/utils';
import { getMinShortSide } from '../../services/quality/imageQuality';
import { useProjectStore } from '../../stores/useProjectStore';
import { AssembleControls, AssembleSummary } from '../board/AssembleControls';
import { FrameGrid } from '../board/FrameGrid';
import { useBoardPipeline } from '../board/useBoardPipeline';
import { SourcesPanel } from '../board/SourcesPanel';
import type { useProjectRuntime } from '../useProjectRuntime';

type Runtime = ReturnType<typeof useProjectRuntime>;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function BoardHeader({ runtime, assemble }: { runtime: Runtime; assemble: React.ReactNode }) {
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
    {assemble}
  </header>;
}

/** Board of the next UI: Sources on the left, the frame grid in the middle, room for Health on the right. Mount with `key={projectId}`. */
export function BoardScreen({ runtime, encoderFactory }: { runtime: Runtime; encoderFactory?: typeof createSemanticFeatureEncoder }) {
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const notify = useUIStore(state => state.addNotification);
  const model = useBuildModel(runtime.workspaceReviewItems, { writeBack: true, busy: busy || runtime.isProjectDirectoryBusy });
  const { effectiveItems, candidates, reconciled, patchSession } = model;
  const sources = reconciled.profile.sources;
  const setSources = useCallback((next: string[]) => patchSession(session => ({ ...session, profile: { ...session.profile, sources: next } })), [patchSession]);
  const { pipeline, sourceItems } = useBoardPipeline({ runtime, model, busy, setBusy, root, encoderFactory });
  const exportCount = useMemo(() => selectBuildDatasetItems(effectiveItems).length, [effectiveItems]);

  const changeSizeMode = useCallback((mode: 'auto' | 'target', target?: number) => patchSession((session: BuildSession) => {
    const { sizeMode: _previous, ...profile } = session.profile;
    void _previous;
    return { ...session, profile: { ...profile, ...(mode === 'auto' ? { sizeMode: 'auto' as const } : {}), ...(target !== undefined ? { target } : {}) } };
  }), [patchSession]);

  const { explorer } = runtime;
  // Dragging frames from the grid onto an inbox folder moves their files through the Explorer mutations.
  const dragFrames = useCallback((items: WorkspaceImage[]) => explorer.setCurrentDraggedExplorerEntries(items.flatMap(item => item.assetPath
    ? [{ path: item.assetPath, name: item.assetPath.split('/').pop() ?? item.fileName, kind: 'file' as const, workspaceImageId: item.id }] : [])), [explorer]);
  const endFrameDrag = useCallback(() => explorer.setCurrentDraggedExplorerEntries(null), [explorer]);

  const assemble = <AssembleControls pipeline={pipeline} session={reconciled} sourceCount={sourceItems.length} exportCount={exportCount}
    busy={busy || runtime.isProjectDirectoryBusy} onSizeModeChange={changeSizeMode}
    onExport={() => notify('info', 'The export dialog arrives in the next step.')} />;

  return <div ref={root} data-board className="flex min-h-0 flex-1 flex-col">
    <BoardHeader runtime={runtime} assemble={assemble} />
    <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
      <SourcesPanel runtime={runtime} items={effectiveItems} sources={sources} onSourcesChange={setSources} />
      <main data-board-grid className="flex min-h-[320px] min-w-0 flex-1 flex-col">
        <AssembleSummary session={reconciled} />
        <FrameGrid candidates={candidates} effectiveItems={effectiveItems} session={reconciled} onDragFrames={dragFrames} onDragFramesEnd={endFrameDrag} />
      </main>
      {/* The Health column (step 3.3) goes here. */}
    </div>
  </div>;
}
