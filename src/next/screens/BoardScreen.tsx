import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Settings } from 'lucide-react';
import { useBuildModel } from '../../components/build/useBuildModel';
import { useBuildClusters } from '../../components/build/useBuildClusters';
import { useQualityActions } from '../../components/build/useQualityActions';
import { useDatasetQualityReport } from '../../components/quality/useDatasetQualityReport';
import { getBuildAssetId } from '../../services/build/buildSessionService';
import type { SimilarityStrictnessId } from '../../services/similarity/similarityLevels';
import { selectBuildDatasetItems } from '../../lib/buildStageSummary';
import type { createSemanticFeatureEncoder } from '../../services/analysis/semanticFeatureService';
import type { BuildSession } from '../../types';
import { Button } from '../../components/ui/button';
import { NextSettingsDialog } from '../board/NextSettingsDialog';
import { PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../../lib/projectProfiles';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { cn } from '../../lib/utils';
import { getMinShortSide } from '../../services/quality/imageQuality';
import { useProjectStore } from '../../stores/useProjectStore';
import { AssembleControls, AssembleSummary } from '../board/AssembleControls';
import { CaptionMode } from '../board/CaptionMode';
import { ExportDialog } from '../board/ExportDialog';
import { FrameGrid } from '../board/FrameGrid';
import { HealthPanel } from '../board/HealthPanel';
import { useBoardPipeline } from '../board/useBoardPipeline';
import { SourcesPanel } from '../board/SourcesPanel';
import { BoardToolsContext, PhotopeaOverlay, VideoOverlay, type BoardTools } from '../board/toolOverlays';
import type { useProjectRuntime } from '../useProjectRuntime';

type Runtime = ReturnType<typeof useProjectRuntime>;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export type BoardMode = 'select' | 'caption';

function BoardHeader({ runtime, assemble, mode, onModeChange }: { runtime: Runtime; assemble: React.ReactNode; mode: BoardMode; onModeChange: (mode: BoardMode) => void }) {
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
      {(['select', 'caption'] as const).map(option => <button key={option} type="button" aria-pressed={mode === option} data-mode={option} onClick={() => onModeChange(option)}
        className={cn('min-h-[44px] px-4 text-sm', mode === option ? 'bg-primary font-medium text-primary-foreground' : 'text-muted-foreground hover:bg-secondary', focusRing)}>
        {option === 'select' ? 'Select' : 'Caption'}</button>)}
    </div>
    {assemble}
    <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Settings" title="Settings" onClick={() => runtime.setSettingsOpen(true)}><Settings className="h-4 w-4" /></Button>
  </header>;
}

/** Board of the next UI: Sources on the left, the frame grid in the middle, room for Health on the right. Mount with `key={projectId}`. */
export function BoardScreen({ runtime, encoderFactory }: { runtime: Runtime; encoderFactory?: typeof createSemanticFeatureEncoder }) {
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<BoardMode>('select');
  const [exportOpen, setExportOpen] = useState(false);
  const [video, setVideo] = useState<WorkspaceImage | null>(null);
  const [photopea, setPhotopea] = useState<WorkspaceImage | null>(null);
  const model = useBuildModel(runtime.workspaceReviewItems, { writeBack: true, busy: busy || runtime.isProjectDirectoryBusy });
  const { effectiveItems, candidates, reconciled, patchSession } = model;
  const sources = reconciled.profile.sources;
  const setSources = useCallback((next: string[]) => patchSession(session => ({ ...session, profile: { ...session.profile, sources: next } })), [patchSession]);
  const { actions, pipeline, sourceItems } = useBoardPipeline({ runtime, model, busy, setBusy, root, encoderFactory });
  const exportCount = useMemo(() => selectBuildDatasetItems(effectiveItems).length, [effectiveItems]);

  const changeSizeMode = useCallback((mode: 'auto' | 'target', target?: number) => patchSession((session: BuildSession) => {
    const { sizeMode: _previous, ...profile } = session.profile;
    void _previous;
    return { ...session, profile: { ...profile, ...(mode === 'auto' ? { sizeMode: 'auto' as const } : {}), ...(target !== undefined ? { target } : {}) } };
  }), [patchSession]);

  const changeStrictness = useCallback((strictness: SimilarityStrictnessId) => patchSession((session: BuildSession) =>
    session.profile.similarityStrictness === strictness ? session : { ...session, profile: { ...session.profile, similarityStrictness: strictness } }), [patchSession]);

  // Health and the theme grouping need image features: they are computed only after the first Assemble.
  const assembled = Boolean(reconciled.auto?.assembledAt);
  const dataset = useProjectStore(state => state.dataset);
  const projectType = useProjectStore(state => state.projectType);
  const targetModel = useProjectStore(state => state.targetModel);
  const quality = useDatasetQualityReport({ featuresActive: assembled, items: effectiveItems, candidates, session: reconciled, triggerWord: dataset.triggerWord, projectType, targetModel });
  const candidateIds = useMemo(() => candidates.filter(item => item.kind !== 'video').map(item => item.id), [candidates]);
  const clusters = useBuildClusters({ active: assembled, ids: candidateIds, features: quality.features, strictness: reconciled.profile.similarityStrictness ?? 'balanced' });

  // Local grid filter from a Health item. Report ids are workspace image ids; a transformed output stands for its source frame.
  const [idFilter, setIdFilter] = useState<{ label: string; ids: ReadonlySet<string> } | null>(null);
  const showIds = useCallback((label: string, ids: string[]) => {
    const byId = new Map(effectiveItems.map(item => [item.id, item]));
    const records = Object.values(useProjectStore.getState().buildSession.records);
    const expanded = new Set(ids);
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) continue;
      const assetId = getBuildAssetId(item);
      expanded.add(assetId);
      const source = records.find(record => record.outputAssetId === assetId)?.assetId;
      if (source) expanded.add(source);
    }
    setIdFilter({ label, ids: expanded });
  }, [effectiveItems]);
  const clearIdFilter = useCallback(() => setIdFilter(null), []);
  const qualityActions = useQualityActions({ datasetItems: quality.datasetItems, directory: runtime.projectDirectoryHandle, onSelectIds: (ids, action) => showIds(action.label, ids) });

  const { explorer } = runtime;
  // Dragging frames from the grid onto an inbox folder moves their files through the Explorer mutations.
  const dragFrames = useCallback((items: WorkspaceImage[]) => explorer.setCurrentDraggedExplorerEntries(items.flatMap(item => item.assetPath
    ? [{ path: item.assetPath, name: item.assetPath.split('/').pop() ?? item.fileName, kind: 'file' as const, workspaceImageId: item.id }] : [])), [explorer]);
  const endFrameDrag = useCallback(() => explorer.setCurrentDraggedExplorerEntries(null), [explorer]);

  const boardTools = useMemo<BoardTools>(() => ({ openVideo: setVideo, editInPhotopea: setPhotopea }), []);
  const directory = runtime.projectDirectoryHandle;

  const assemble = <AssembleControls pipeline={pipeline} session={reconciled} sourceCount={sourceItems.length} exportCount={exportCount}
    busy={busy || runtime.isProjectDirectoryBusy} onSizeModeChange={changeSizeMode} onStrictnessChange={changeStrictness}
    onExport={() => setExportOpen(true)} />;

  return <BoardToolsContext.Provider value={boardTools}><div ref={root} data-board className="flex min-h-0 flex-1 flex-col">
    <BoardHeader runtime={runtime} assemble={assemble} mode={mode} onModeChange={setMode} />
    {mode === 'caption'
      ? <CaptionMode runtime={runtime} candidates={candidates} effectiveItems={effectiveItems} session={reconciled} pipeline={pipeline} patchSession={patchSession} report={quality.report} />
      : <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
      <SourcesPanel runtime={runtime} items={effectiveItems} sources={sources} onSourcesChange={setSources} />
      <main data-board-grid className="flex min-h-[320px] min-w-0 flex-1 flex-col">
        <AssembleSummary session={reconciled} />
        <FrameGrid candidates={candidates} effectiveItems={effectiveItems} session={reconciled} actions={actions} clusters={clusters.result} idFilter={idFilter} onClearIdFilter={clearIdFilter} onDragFrames={dragFrames} onDragFramesEnd={endFrameDrag} />
      </main>
      <HealthPanel assembled={assembled} report={quality.report} datasetCount={quality.datasetItems.length} features={quality.features}
        onShowIds={showIds} onApplyAction={(hint, action) => void qualityActions.apply(hint, action)} canApplyAction={qualityActions.canApply} />
    </div>}
    <ExportDialog open={exportOpen} onOpenChange={setExportOpen} pairCount={exportCount} report={quality.report} targetModel={targetModel}
      onExportComplete={plan => patchSession(session => ({ ...session, lastExport: { fingerprint: plan.fingerprint, completedAt: new Date().toISOString(), entries: plan.entries.length } }))} />
    <NextSettingsDialog runtime={runtime} strictness={{ value: reconciled.profile.similarityStrictness ?? 'balanced', onChange: changeStrictness }} />
    {photopea && directory && <PhotopeaOverlay item={photopea} directory={directory} onClose={() => setPhotopea(null)} />}
    {video && directory && <VideoOverlay item={video} directory={directory} onClose={() => setVideo(null)}
      onSaved={() => runtime.explorerMutations.indexProjectWorkspaceAssets()} />}
  </div></BoardToolsContext.Provider>;
}
