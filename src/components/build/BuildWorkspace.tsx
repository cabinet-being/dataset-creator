import { BuildClusterView } from './BuildClusterView';
import { BuildGridView } from './BuildGridView';
import { CaptionEditor } from '../caption/CaptionEditor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, HelpCircle, ImageIcon, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import type { BuildReviewDecision, BuildReviewView, BuildSession, BuildStage } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useSizedPreviewUrls } from '../../lib/previewUrlCache';
import { useProjectStore } from '../../stores/useProjectStore';
import { usePublishInspectorSelection, type InspectorSelectionPayload } from '../../stores/useInspectorSelectionStore';
import { useUIStore } from '../../stores/useUIStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { runHistoryTransaction } from '../../stores/useHistoryStore';
import { useCommands } from '../workspace/Commands';
import { ImportTool } from '../tools/ImportTool';
import { ExportTool } from '../tools/ExportTool';
import { VideoFramesTool } from '../tools/VideoFramesTool';
import type { ImportInputFile, ImportImagesOptions, ImportImagesResult } from '../../services/import/importService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { useOperation } from '../../hooks/useOperation';
import { persistCaptionTagsForItems } from '../../services/caption/captionMutationService';
import { changeDatasetTriggerWord } from '../../lib/triggerWordActions';
import { TriggerWordInput } from '../ui/TriggerWordInput';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { applyCharacterTraits } from '../../services/tagging/characterTraits';
import { selectActiveCharacterTraits } from '../../stores/useProjectStore';
import { LocalTaggerConnectPrompt } from '../tagging/LocalTaggerConnectPrompt';
import {
  clearBuildShortlist,
  getActiveShortlist,
  getBuildAssetId,
  getBuildRecordForItem,
  getBuildCounts,
  selectBuildQueue,
  nextBuildCursor,
  updateBuildDecision,
} from '../../services/build/buildSessionService';
import { getMinShortSide } from '../../services/quality/imageQuality';
import { getBuildTransformGeometry } from '../../services/build/buildTransformService';
import { getBuildTriageCounts, selectAssemblyCandidates } from '../../services/build/buildTriageService';
import { useDatasetQualityReport } from '../quality/useDatasetQualityReport';
import { BuildQualityPanel } from './BuildQualityPanel';
import { BuildProfileControls } from './BuildProfileControls';
import { BuildStepper, BuildNextStageFooter } from './BuildStepper';
import { BuildCaptionStage } from './BuildCaptionStage';
import { parseTags } from './buildCaptionTags';
import { getBuildStageSummary, selectBuildDatasetItems } from '../../lib/buildStageSummary';
import { useQualityActions } from './useQualityActions';
import type { createSemanticFeatureEncoder } from '../../services/analysis/semanticFeatureService';
import { useBuildModel } from './useBuildModel';
import { useBuildAutoPipeline } from './useBuildAutoPipeline';
import { useApplyMembership } from './useApplyMembership';
import { resolveDatasetMembership } from '../../services/dataset/datasetMembershipResolver';
import { BuildAutoSelectPanel } from './BuildAutoSelectPanel';
import { BuildSelectStatus } from './BuildSelectStatus';
import { BuildReviewBar } from './BuildReviewBar';
import { ProposalSuggestions } from './ProposalSuggestions';
import { getAutoSelectSteps } from '../../lib/autoSelectSteps';
import { buildFolderRows, inboxFolderOf, isInboxItem, isInboxItemSelected, toggleFolderSelection } from '../../lib/inboxFolders';
import { isProjectPathIncluded } from '../../lib/projectCategories';

type Props = {
  active: boolean;
  viewId: string;
  items: WorkspaceImage[];
  directory?: ProjectDirectoryHandle | null;
  onImportFiles?: (files: ImportInputFile[], execution?: Pick<ImportImagesOptions, 'signal' | 'onProgress'>) => Promise<ImportImagesResult>;
  onRefresh?: () => void | Promise<void>;
  semanticEncoderFactory?: typeof createSemanticFeatureEncoder;
};

const itemName = (item: WorkspaceImage) => item.originalFileName || item.fileName;

export function BuildWorkspace({ active, viewId, items, directory, onImportFiles, onRefresh, semanticEncoderFactory }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const projectId = useProjectStore((state) => state.id);
  const projectType = useProjectStore((state) => state.projectType);
  const targetModel = useProjectStore((state) => state.targetModel);
  const dataset = useProjectStore((state) => state.dataset);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const updateSession = useProjectStore((state) => state.updateBuildSession);
  const notify = useUIStore((state) => state.addNotification);
  const taggingConfig = useProjectStore((state) => state.taggingConfig);
  const characterTraits = useProjectStore(selectActiveCharacterTraits);
  const localTagger = useLocalTaggerStore((state) => state.bundle);
  // Folders unchecked in the Auto-select panel; empty means every inbox folder is a source. Not persisted.
  const [deselectedFolders, setDeselectedFolders] = useState<Set<string>>(new Set());
  const [allowShortfall, setAllowShortfall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchTag, setBatchTag] = useState('');
  const [batchReplacement, setBatchReplacement] = useState('');
  const [batchMode, setBatchMode] = useState<'add' | 'remove' | 'replace'>('add');
  const operation = useOperation('Build review', root, viewId);

  const { session, effectiveItems, candidates, reconciled, counts, patchSession } = useBuildModel(items, { busy, writeBack: true });
  const view: BuildReviewView = reconciled.view ?? 'list';
  const queue = useMemo(() => selectBuildQueue(reconciled, candidates),
    [candidates, reconciled.order, reconciled.records, reconciled.filter, reconciled.profile]);
  // The cursor lives in local state so moving between images does not rewrite the session (and re-run
  // reconcile, counts, the quality report and a full project save) on every step; the session gets it after a pause.
  const [localCursor, setLocalCursor] = useState(session.cursor);
  const cursor = Math.min(localCursor, Math.max(0, queue.length - 1));
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const pendingCursor = useRef<{ base: number; projectId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const lastWrittenCursor = useRef<number | null>(null);
  const flushCursor = useCallback(() => {
    const pending = pendingCursor.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCursor.current = null;
    const state = useProjectStore.getState();
    // Skip when the project changed or something else moved the stored cursor since this write was scheduled.
    if (state.id !== pending.projectId || state.buildSession.cursor !== pending.base) return;
    const value = cursorRef.current;
    if (value === state.buildSession.cursor) return;
    lastWrittenCursor.current = value;
    updateSession((current) => current.cursor === value ? current : { ...current, cursor: value });
  }, [updateSession]);
  const setCursor = useCallback((index: number) => {
    cursorRef.current = index;
    setLocalCursor(index);
    const pending = pendingCursor.current;
    if (pending) clearTimeout(pending.timer);
    const state = useProjectStore.getState();
    pendingCursor.current = {
      base: pending?.base ?? state.buildSession.cursor, projectId: pending?.projectId ?? state.id,
      timer: setTimeout(flushCursor, 1000),
    };
  }, [flushCursor]);
  // An outside change of the stored cursor (undo, project load, filter reset) wins over a pending local move.
  useEffect(() => {
    if (lastWrittenCursor.current === session.cursor) { lastWrittenCursor.current = null; return; }
    lastWrittenCursor.current = null;
    const pending = pendingCursor.current;
    if (pending) { clearTimeout(pending.timer); pendingCursor.current = null; }
    cursorRef.current = session.cursor;
    setLocalCursor(session.cursor);
  }, [session.cursor]);
  /** Patches that also decide the cursor (filter, view, queue changes): stored cursor first, then the local copy follows. */
  const patchSessionAndCursor = useCallback((patch: (value: BuildSession) => BuildSession) => {
    flushCursor();
    updateSession(patch);
    const next = useProjectStore.getState().buildSession.cursor;
    cursorRef.current = next;
    setLocalCursor(next);
  }, [flushCursor, updateSession]);
  const current = queue[cursor];
  const currentId = current ? getBuildAssetId(current) : undefined;
  const currentRecord = currentId ? reconciled.records[currentId] : undefined;
  const inspectorPayload = useMemo<InspectorSelectionPayload | null>(() => {
    if (!current || !currentId) return null;
    const output = currentRecord?.outputAssetId
      ? effectiveItems.find((item) => getBuildAssetId(item) === currentRecord.outputAssetId)
      : isProjectDatasetPath(current.assetPath) ? current : undefined;
    const ready = currentRecord ? getBuildCounts({
      version: 2, profile: reconciled.profile, cursor: 0, filter: 'all',
      order: [currentId],
      records: { [currentId]: currentRecord },
    }, effectiveItems).ready > 0 : false;
    let status = 'Needs review';
    let detail = 'Awaiting a review decision.';
    if (currentRecord?.application === 'failed' || currentRecord?.validation === 'error') {
      status = 'Error';
      detail = currentRecord.error || 'Build could not be applied.';
    } else if (currentRecord?.validation === 'stale') {
      status = 'Stale';
      detail = currentRecord.acceptedRevision !== currentRecord.revision
        ? 'The source or preparation settings changed after acceptance.'
        : currentRecord.outputAssetId && !output
          ? 'The saved output is missing.'
          : 'The saved output changed or is no longer in Dataset.';
    } else if (ready) {
      status = 'Ready';
      detail = 'Saved in Dataset and ready for export.';
    } else if (currentRecord?.application === 'pending') {
      status = 'Saving';
      detail = 'Applying the review decision.';
    } else if (currentRecord?.decision === 'deferred') {
      status = 'Deferred';
      detail = 'Review decision is deferred.';
    } else if (currentRecord?.decision === 'skipped') {
      status = 'Skipped';
      detail = 'Intentionally excluded from this build.';
    } else if (currentRecord?.decision === 'accepted') {
      status = 'Pending';
      detail = currentRecord.application === 'applied' && !output
        ? 'The accepted item has no saved output in Dataset.'
        : currentRecord.validation === 'pending'
          ? 'Complete the required caption or validation.'
          : 'The accepted item is not ready for export.';
    }
    return {
      title: itemName(current),
      items: [current],
      outputItem: output,
      status,
      detail,
      sourcePath: current.assetPath,
      outputPath: output?.assetPath,
    };
  }, [current, currentId, currentRecord, effectiveItems, reconciled.profile]);
  usePublishInspectorSelection(active, viewId, inspectorPayload);
  const stage: BuildStage = reconciled.stage ?? 'select';
  const setStage = useCallback((next: BuildStage) => updateSession((value) => value.stage === next ? value : { ...value, stage: next }), [updateSession]);
  const quality = useDatasetQualityReport({
    featuresActive: active && (stage === 'check' || stage === 'export' || (stage === 'select' && view === 'clusters')), items: effectiveItems, candidates, session: reconciled,
    triggerWord: dataset.triggerWord, projectType, targetModel,
  });
  const datasetItems = useMemo(() => selectBuildDatasetItems(effectiveItems), [effectiveItems]);
  const summary = useMemo(() => getBuildStageSummary({ session: reconciled, effectiveItems, candidates, readiness: quality.report.readiness, counts }),
    [candidates, effectiveItems, quality.report.readiness, counts, reconciled.lastExport]);
  useEffect(() => flushCursor, [stage, flushCursor]);
  // A fresh session leaves Add as soon as materials exist, unless the user went back to Add on purpose.
  const stayInAdd = useRef(false);
  const goToStage = useCallback((next: BuildStage) => { stayInAdd.current = next === 'add'; setStage(next); }, [setStage]);
  useEffect(() => {
    if (stage === 'add' && candidates.length > 0 && !stayInAdd.current) setStage('select');
  }, [candidates.length, setStage, stage]);
  const selectQualityItem = useCallback((id: string) => {
    const item = effectiveItems.find((candidate) => candidate.id === id);
    if (!item) return;
    const assetId = getBuildAssetId(item);
    const sourceId = Object.values(reconciled.records).find((record) => record.outputAssetId === assetId)?.assetId ?? assetId;
    const index = selectBuildQueue({ ...reconciled, filter: 'all' }, candidates).findIndex((candidate) => getBuildAssetId(candidate) === sourceId);
    if (index < 0) { notify('info', `${quality.labelFor(id)} is not in the Build queue.`); return; }
    patchSessionAndCursor((value) => ({ ...value, stage: 'select', filter: 'all', cursor: index }));
  }, [candidates, effectiveItems, notify, patchSessionAndCursor, quality, reconciled]);
  const qualityActions = useQualityActions({ datasetItems: quality.datasetItems, directory, onSelectId: selectQualityItem });
  const missingRecords = useMemo(() => {
    const available = new Set(effectiveItems.map(getBuildAssetId));
    return reconciled.order.map((id) => reconciled.records[id]).filter((record) => record && !available.has(record.assetId) && record.decision !== 'skipped');
  }, [effectiveItems, reconciled.order, reconciled.records]);
  const filmstrip = useMemo(() => queue.slice(Math.max(0, cursor - 18), Math.min(queue.length, cursor + 19)), [cursor, queue]);
  const filmstripImages = useMemo(() => filmstrip.filter((item) => item.kind !== 'video'), [filmstrip]);
  const mainImages = useMemo(() => (current && current.kind !== 'video' ? [current] : []), [current]);
  const neighborImages = useMemo(() => [1, -1, 2, -2].map((offset) => queue[cursor + offset]).filter((item) => item && item.kind !== 'video'), [cursor, queue]);
  const thumbs = useSizedPreviewUrls(filmstripImages, 'thumb', { focusId: current?.id });
  const mainPreviews = useSizedPreviewUrls(mainImages, 'large', { focusId: current?.id, prefetch: neighborImages });

  useEffect(() => { setDraft(currentRecord?.draft ?? current?.tags?.join(', ') ?? ''); }, [currentId, current?.tags, currentRecord?.draft]);
  useEffect(() => { setSelected((ids) => new Set([...ids].filter((id) => reconciled.order.includes(id)))); }, [reconciled.order]);

  const setView = useCallback((next: BuildReviewView) => patchSession((value) => (value.view ?? 'list') === next ? value : { ...value, view: next }), [patchSession]);
  const captionSuggestions = useMemo(() => [...new Set([
    ...effectiveItems.flatMap(item => item.tags ?? []), ...(localTagger?.tags ?? []),
  ])].filter(tag => !taggingConfig.blacklist.includes(tag)), [effectiveItems, localTagger, taggingConfig.blacklist]);
  // The draft shows immediately; it is written to the session (and saved) after a short pause or when the
  // item changes, so each keystroke does not re-run reconcile, counts, the quality report and saving.
  const pendingDraft = useRef<{ id: string; value: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const flushDraft = useCallback(() => {
    const pending = pendingDraft.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDraft.current = null;
    patchSession(session => {
      const record = session.records[pending.id];
      return record && record.draft !== pending.value ? { ...session, records: { ...session.records, [pending.id]: { ...record, draft: pending.value } } } : session;
    });
  }, [patchSession]);
  useEffect(() => flushDraft, [currentId, flushDraft]);
  const changeDraft = (value: string) => {
    setDraft(value);
    if (!currentId) return;
    if (pendingDraft.current && pendingDraft.current.id !== currentId) flushDraft();
    if (pendingDraft.current) clearTimeout(pendingDraft.current.timer);
    pendingDraft.current = { id: currentId, value, timer: setTimeout(flushDraft, 400) };
  };
  // A newly connected model or changed thresholds must not reuse old predictions.
  useEffect(() => {
    patchSession(value => Object.values(value.records).some(record => record.proposal)
      ? { ...value, records: Object.fromEntries(Object.entries(value.records).map(([id, record]) => [id, { ...record, proposal: undefined }])) }
      : value);
  }, [localTagger, taggingConfig.threshold, taggingConfig.maxTags, projectId, patchSession]);

  const moveCursor = useCallback((step: number) => setCursor(Math.max(0, Math.min(queue.length - 1, cursorRef.current + step))), [queue.length, setCursor]);

  const { applyDecisions } = useApplyMembership({ directory, operation, busy, setBusy });

  /** Applies one decision per item inside a single history transaction (one Undo). */
  const commitDecisions = useCallback(async (entries: Array<{ item: WorkspaceImage; decision: BuildReviewDecision }>, provenance: 'manual' | 'auto' = 'manual', propagateError = false) => {
    if (!entries.length || busy) return;
    await applyDecisions(entries.map((entry) => ({ ...entry, ...(entry.item === current ? { tags: parseTags(draft) } : {}) })), {
      provenance, propagateError,
      beforeStart: (targetIds) => {
        flushCursor();
        // A decision consumes the typed draft directly; a pending delayed write must not resurrect it afterwards.
        const pending = pendingDraft.current;
        if (pending && targetIds.includes(pending.id)) { clearTimeout(pending.timer); pendingDraft.current = null; }
      },
      onApplied: () => {
        if (entries.length !== 1) return;
        patchSessionAndCursor((value) => {
          const nextQueue = selectBuildQueue(value, candidates);
          return { ...value, cursor: nextBuildCursor(queue, nextQueue, cursor, getBuildAssetId(entries[0].item)) };
        });
      },
    });
  }, [applyDecisions, busy, candidates, current, cursor, draft, flushCursor, patchSessionAndCursor, queue]);
  const commitDecision = useCallback((decision: BuildReviewDecision, targets: WorkspaceImage[] = current ? [current] : [], provenance: 'manual' | 'auto' = 'manual', propagateError = false) =>
    commitDecisions(targets.map((item) => ({ item, decision })), provenance, propagateError), [commitDecisions, current]);

  // Auto-select sources: inbox images in the checked folders that the user has not rejected.
  const inboxItems = useMemo(() => candidates.filter((item) => item.kind !== 'video' && isInboxItem(item) && !isProjectDatasetPath(item.assetPath)
    && isProjectPathIncluded(item.assetPath, workspaceSettings.excludedProjectCategories ?? [], workspaceSettings.includedProjectCategories ?? [])
    && reconciled.records[getBuildAssetId(item)]?.decision !== 'skipped'),
  [candidates, reconciled.records, workspaceSettings.excludedProjectCategories, workspaceSettings.includedProjectCategories]);
  const folderRows = useMemo(() => buildFolderRows(inboxItems.map(inboxFolderOf)), [inboxItems]);
  const sourceItems = useMemo(() => inboxItems.filter((item) => isInboxItemSelected(item, deselectedFolders)), [inboxItems, deselectedFolders]);
  const pipeline = useBuildAutoPipeline({
    active, busy, candidates, sources: sourceItems, effectiveItems, session: reconciled, targetModel,
    patchSession, dataset, commitDecision, applyDecisions, localTagger, taggingConfig, root, viewId, notify, encoderFactory: semanticEncoderFactory, characterTraits,
  });
  const shortlist = useMemo(() => getActiveShortlist(reconciled, candidates), [reconciled.auto, reconciled.records, reconciled.profile, candidates]);
  const shortlistedIds = useMemo(() => new Set(shortlist?.entries.map(({ entry }) => entry.id)), [shortlist]);
  const datasetCount = useMemo(() => resolveDatasetMembership(dataset, effectiveItems).effective.length, [dataset, effectiveItems]);
  const undescribedCandidates = useMemo(() => (shortlist?.entries ?? []).filter(({ item }) => {
    const record = reconciled.records[getBuildAssetId(item)];
    return !item.tags?.length && !(record?.proposal && record.proposal.revision === record.revision);
  }).map(({ item }) => item), [shortlist, reconciled.records]);
  const autoSelect = getAutoSelectSteps({
    folderImages: sourceItems.length,
    analyzed: sourceItems.filter((item) => !!reconciled.records[getBuildAssetId(item)]?.triage).length,
    pendingAnalysis: sourceItems.filter((item) => { const record = reconciled.records[getBuildAssetId(item)]; return record?.decision === 'unreviewed' && !record.triage; }).length,
    analysisPaused: pipeline.paused,
    poolSize: selectAssemblyCandidates(reconciled, sourceItems).length,
    datasetCount, target: reconciled.profile.target, auto: reconciled.profile.sizeMode === 'auto',
    hasCandidates: !!reconciled.auto?.shortlist,
    candidates: shortlist?.entries.length ?? 0,
    described: (shortlist?.entries.length ?? 0) - undescribedCandidates.length,
    taggable: pipeline.countTaggingTargets(undescribedCandidates),
    picks: shortlist?.narrowed.length ?? 0,
    duplicatesSkipped: reconciled.auto?.shortlist?.duplicatesRejected ?? 0,
    unreadable: pipeline.skipped.length,
    taskRunning: busy || pipeline.phase === 'assembly' || pipeline.phase === 'tagging' || pipeline.phase === 'triage',
    task: pipeline.task,
  });
  const setFilter = useCallback((filter: BuildSession['filter']) => patchSessionAndCursor((value) => ({ ...value, filter, cursor: 0 })), [patchSessionAndCursor]);
  const filterCounts = useMemo(() => {
    const size = (filter: BuildSession['filter']) => selectBuildQueue({ ...reconciled, filter }, candidates).length;
    return {
      all: size('all'), unresolved: size('unresolved'), needsDecision: size('needs-decision'), accepted: size('accepted'), rejected: size('rejected'),
      candidates: shortlist?.entries.length ?? 0, picks: shortlist?.narrowed.length ?? 0, errors: counts.errors,
    };
  }, [candidates, reconciled.order, reconciled.records, reconciled.profile, reconciled.auto, shortlist, counts.errors]);
  const triageCounts = useMemo(() => getBuildTriageCounts(reconciled, candidates), [candidates, reconciled.order, reconciled.records]);

  const applyBatchCaption = useCallback(async () => {
    const tag = batchTag.trim();
    const replacement = batchReplacement.trim();
    if (!tag || (batchMode === 'replace' && !replacement) || !selected.size || busy) return;
    const snapshot = candidates.filter((item) => selected.has(getBuildAssetId(item)) && item.kind !== 'video');
    setBusy(true);
    operation.start(undefined, snapshot.length);
    try {
      await runHistoryTransaction(`${batchMode === 'add' ? 'Add' : 'Remove'} caption tag`, async (historyWriter) => {
        await persistCaptionTagsForItems({
          items: snapshot, directory, flush: flushProjectSave, historyWriter,
          resolveTags: (item) => batchMode === 'add'
            ? [...(item.tags ?? []).filter((value) => value.toLocaleLowerCase() !== tag.toLocaleLowerCase()), tag]
            : batchMode === 'remove'
              ? (item.tags ?? []).filter((value) => value.toLocaleLowerCase() !== tag.toLocaleLowerCase())
              : (item.tags ?? []).map((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase() ? replacement : value),
        });
      });
      operation.finish('completed', `${snapshot.length} captions updated`);
      setBatchTag(''); setBatchReplacement('');
    } catch (error) { const message = error instanceof Error ? error.message : 'Batch caption update failed.'; operation.finish('failed', message); notify('error', message); }
    finally { setBusy(false); }
  }, [batchMode, batchReplacement, batchTag, busy, candidates, directory, notify, operation, selected]);


  useCommands([
    { id: 'build.accept', label: 'Build: Accept', shortcut: 'A', active: active && stage === 'select' && view === 'list', disabled: busy || !current || current.kind === 'video', run: () => commitDecision('accepted') },
    { id: 'build.skip', label: 'Build: Reject', shortcut: 'X', active: active && stage === 'select' && view === 'list', disabled: busy || !current, run: () => commitDecision('skipped') },
    { id: 'build.defer', label: 'Build: Defer', shortcut: 'D', active: active && stage === 'select' && view === 'list', disabled: busy || !current, run: () => commitDecision('deferred') },
    { id: 'build.previous', label: 'Build: Previous', shortcut: 'ArrowLeft', active: active && stage === 'select' && view === 'list', disabled: cursor <= 0, run: () => moveCursor(-1) },
    { id: 'build.next', label: 'Build: Next', shortcut: 'ArrowRight', active: active && stage === 'select' && view === 'list', disabled: cursor >= queue.length - 1, run: () => moveCursor(1) },
    { id: 'build.finish', label: 'Build: Finish review', shortcut: 'Mod+Enter', active: active && stage !== 'caption', disabled: busy, run: () => counts.unresolved || counts.errors ? patchSessionAndCursor((value) => ({ ...value, filter: counts.errors ? 'errors' : 'unresolved', cursor: 0 })) : setStage('export') },
  ], () => root.current);

  // Proposals keep the raw model tags; character traits are applied here and when merging.
  const proposal = useMemo(() => currentRecord?.proposal && currentRecord.proposal.revision === currentRecord.revision
    ? applyCharacterTraits(currentRecord.proposal.tags, characterTraits) : [], [characterTraits, currentRecord?.proposal, currentRecord?.revision]);
  const currentTransform = currentRecord?.transform ?? reconciled.profile.transform;
  const crop = currentTransform?.crop ?? { x:0, y:0, width:1, height:1 };
  const cropZoom = Math.round(100 / Math.max(crop.width, crop.height));
  const cropCenterX = Math.round((crop.x + crop.width / 2) * 100);
  const cropCenterY = Math.round((crop.y + crop.height / 2) * 100);
  const cropGeometry = current && currentTransform?.mode === 'crop'
    ? getBuildTransformGeometry(current.width, current.height, currentTransform) : undefined;
  const updateCrop = (zoom: number, centerX: number, centerY: number) => {
    if (!currentId || !reconciled.profile.transform || reconciled.profile.transform.mode !== 'crop') return;
    const size = Math.min(1, 100 / Math.max(100, zoom));
    const x = Math.max(0, Math.min(1 - size, centerX / 100 - size / 2));
    const y = Math.max(0, Math.min(1 - size, centerY / 100 - size / 2));
    patchSession((value) => { const record = value.records[currentId]; return record ? { ...value, records:{ ...value.records, [currentId]:{ ...record, transform:{ ...value.profile.transform!, crop:{x,y,width:size,height:size} } } } } : value; });
  };
  const queueGroupActive = ['needs-decision', 'accepted', 'rejected', 'shortlisted', 'picked'].includes(reconciled.filter);
  const acceptTargets = queueGroupActive ? queue.filter((item) => {
    const record = reconciled.records[getBuildAssetId(item)];
    return item.kind !== 'video' && !(record?.decision === 'accepted' && record.application === 'applied');
  }) : [];
  const rejectTargets = queueGroupActive ? queue.filter((item) => reconciled.records[getBuildAssetId(item)]?.decision !== 'skipped') : [];
  const clearQualityTriage = () => { patchSession((value) => ({
    ...value,
    records: Object.fromEntries(Object.entries(value.records).map(([id, record]) => [id, record.decision === 'unreviewed' && record.triage?.stage === 'quality' ? { ...record, triage: undefined } : record])),
    auto: undefined,
  })); };
  const canExport = counts.unresolved === 0 && counts.errors === 0 && (counts.ready >= counts.target || allowShortfall);
  const setProfileTransform = (value: string) => patchSession((currentSession) => ({ ...currentSession, profile: {
    ...currentSession.profile,
    transform: value === 'original' ? undefined : { mode: value === 'fit-512' ? 'fit' : 'crop', width: value === 'crop-768' ? 768 : 512, height: value === 'crop-768' ? 768 : 512, allowUpscale: false },
  } }));

  // Keep keyboard shortcuts working when the focused control disappears (for example a rejected filmstrip item).
  useEffect(() => {
    if (!active) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body || !focused.isConnected) root.current?.focus({ preventScroll: true });
  }, [active, stage, view, reconciled.filter, busy, currentId]);
  const startOver = () => {
    pipeline.clearSkipped();
    patchSessionAndCursor((value) => ({ ...clearBuildShortlist(value), filter: value.filter === 'shortlisted' || value.filter === 'picked' ? 'all' : value.filter, cursor: 0 }));
  };
  // Caption stage: Dataset images with neither caption tags nor a model suggestion.
  const untaggedDatasetItems = useMemo(() => datasetItems.filter((item) => !item.tags?.length), [datasetItems]);
  const suggestTargets = pipeline.countTaggingTargets(untaggedDatasetItems);
  const proposalFor = useCallback((item: WorkspaceImage) => {
    const record = getBuildRecordForItem(reconciled, item);
    return record?.proposal && record.proposal.revision === record.revision ? applyCharacterTraits(record.proposal.tags, characterTraits) : [];
  }, [characterTraits, reconciled]);

  return <div ref={root} tabIndex={-1} className="flex h-full min-h-0 flex-col overflow-y-auto bg-background outline-none" data-build-workspace>
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
      <div className="mr-auto"><h1 className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4 text-primary" />Build Dataset</h1><p className="text-xs text-muted-foreground">One queue from import to export</p></div>
    </header>
    <BuildStepper stages={summary.stages} current={stage} onSelect={goToStage} />
    {stage === 'add' ? <div className="min-h-0 flex-1 overflow-auto p-4"><div role="group" aria-label="Project settings" className="mb-4 flex flex-wrap items-center gap-3 text-xs"><BuildProfileControls onModelChange={clearQualityTriage} suggestions={captionSuggestions} /></div><ImportTool active={active} onImportFiles={onImportFiles} /></div>
    : stage === 'caption' ? <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
        <button type="button" data-testid="build-suggest-tags" className="rounded border border-border px-2 py-1 disabled:opacity-40" disabled={busy || pipeline.phase !== 'idle' || !localTagger || suggestTargets === 0}
          title={!localTagger ? 'Connect a local caption model first' : suggestTargets === 0 ? 'Every Dataset image already has tags or a suggestion' : undefined}
          onClick={() => pipeline.startTagging(untaggedDatasetItems)}>Suggest tags for {suggestTargets} {suggestTargets === 1 ? 'image' : 'images'}</button>
        {pipeline.phase === 'tagging' && <span role="status" className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Suggesting tags{pipeline.progress.total > 0 && ` ${pipeline.progress.completed}/${pipeline.progress.total}`}<button className="ml-1 underline" onClick={pipeline.cancel}>Cancel</button></span>}
        {!localTagger && <LocalTaggerConnectPrompt message="No local caption model connected. Connect one to get tag suggestions." />}
      </div>
      <BuildCaptionStage active={active} items={datasetItems} suggestions={captionSuggestions} directory={directory} proposalFor={proposalFor} /></>
    : stage === 'check' ? <section aria-label="Dataset quality" className="min-h-0 flex-1 overflow-auto p-4"><BuildQualityPanel testId="build-quality-panel" report={quality.report} features={quality.features} datasetCount={quality.datasetItems.length} labelFor={quality.labelFor} onSelectId={selectQualityItem} onAction={qualityActions.apply} canApply={qualityActions.canApply} /></section>
    : stage === 'export' ? <div className="min-h-0 flex-1 overflow-auto"><ExportTool active={active} fixedSource="dataset" onExportComplete={(plan) => patchSession((value) => ({ ...value, lastExport: { fingerprint: plan.fingerprint, completedAt: new Date().toISOString(), entries: plan.entries.length } }))} /></div>
    : <>
      <BuildAutoSelectPanel derived={autoSelect} datasetCount={datasetCount} target={reconciled.profile.target} auto={reconciled.profile.sizeMode === 'auto'} comparedAtFind={reconciled.auto?.shortlist?.poolCount}
        onAutoChange={(auto) => patchSession((value) => {
          if ((value.profile.sizeMode === 'auto') === auto) return value;
          const { sizeMode: _removed, ...profile } = value.profile;
          void _removed;
          // A candidate list made in the other mode no longer fits: Find has to run again.
          return clearBuildShortlist({ ...value, profile: auto ? { ...profile, sizeMode: 'auto' } : profile });
        })}
        onTargetChange={(target) => patchSession((value) => ({ ...value, profile: { ...value.profile, target } }))}
        folderRows={folderRows} deselectedFolders={deselectedFolders} onToggleFolder={(folder) => setDeselectedFolders((value) => toggleFolderSelection(folderRows, value, folder))}
        analysisPaused={pipeline.paused} onResumeAnalysis={pipeline.resume} progress={pipeline.progress}
        modelDownloadFor={pipeline.modelDownloadFor} onConfirmDownload={pipeline.confirmModelDownload} onDismissDownload={pipeline.dismissModelDownload}
        skipped={pipeline.skipped} taggerConnected={!!localTagger} busy={busy}
        onFind={() => pipeline.startShortlist()} onDescribe={() => pipeline.startTagging(undescribedCandidates)} onPick={() => pipeline.startNarrow()}
        onApply={() => pipeline.startApplyNarrowed(shortlist?.narrowed ?? [])} onCancel={pipeline.cancel}
        onShowCandidates={() => setFilter('shortlisted')} onReviewPicks={() => setFilter('picked')} onStartOver={startOver} />
      <BuildSelectStatus datasetCount={datasetCount} target={reconciled.profile.target} auto={reconciled.profile.sizeMode === 'auto'}
        analysisLeft={triageCounts.pending} analysisRunning={pipeline.phase === 'triage'} analysisPaused={pipeline.paused && pipeline.phase === 'idle'} onPause={pipeline.cancel} onResume={pipeline.resume}
        errors={counts.errors} onShowErrors={() => setFilter('errors')}
        settings={<>
        <label>Review <select value={reconciled.profile.reviewMode} onChange={(event) => patchSession((value) => ({ ...value, profile: { ...value.profile, reviewMode: event.target.value as BuildSession['profile']['reviewMode'] } }))} className="ml-1 rounded border border-border bg-background px-2 py-1"><option value="every-item">Every photo</option><option value="uncertain-only">Uncertain only</option></select></label>
        <label>Output <select value={!reconciled.profile.transform ? 'original' : `${reconciled.profile.transform.mode}-${reconciled.profile.transform.width}`} onChange={(event) => setProfileTransform(event.target.value)} className="ml-1 rounded border border-border bg-background px-2 py-1"><option value="original">Original</option><option value="fit-512">Fit within 512</option><option value="crop-512">Center crop 512</option><option value="crop-768">Center crop 768</option></select></label>
        <BuildProfileControls onModelChange={clearQualityTriage} suggestions={captionSuggestions} />
        <label className="flex items-start gap-1">Trigger word <TriggerWordInput value={dataset.triggerWord} onApply={(word) => { void changeDatasetTriggerWord(word).then(() => patchSession((value) => ({ ...value, records:Object.fromEntries(Object.entries(value.records).map(([id,record]) => [id,record.decision === 'accepted' ? { ...record, validation:'stale' as const } : record])) }))).catch((error) => notify('error', error instanceof Error ? error.message : 'Could not change the trigger word')); }} className="w-32 rounded border border-border bg-background px-2 py-1" /></label>
        </>} />
      <BuildReviewBar filter={reconciled.filter} onFilter={setFilter} counts={filterCounts} hasCandidates={!!reconciled.auto?.shortlist} view={view} onView={setView}
        bulk={queueGroupActive ? { accept: acceptTargets.length, reject: rejectTargets.length } : null} busy={busy}
        onAcceptAll={() => void commitDecision('accepted', acceptTargets)} onRejectAll={() => void commitDecision('skipped', rejectTargets)} />

      {view === 'clusters' ? <BuildClusterView active={active} root={root} features={quality.features} candidates={candidates} session={reconciled} minShortSide={getMinShortSide(targetModel)} busy={busy}
        onCommit={(entries) => commitDecisions(entries)} onOpenItem={(id) => { setView('list'); selectQualityItem(id); }} /> : <>
      <main className="grid min-h-[18rem] flex-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="relative flex min-h-0 flex-col items-center justify-center overflow-auto bg-black/5 p-4 dark:bg-black/20">
          {view === 'grid' ? <BuildGridView active={active && stage === 'select'} root={root} queue={queue} session={reconciled} cursor={cursor} busy={busy}
            selected={selected} onSelectedChange={setSelected} onCursor={setCursor}
            onCommit={(entries) => commitDecisions(entries)} onOpenItem={(index) => patchSessionAndCursor((value) => ({ ...value, view: 'list', cursor: index }))} shortlisted={shortlistedIds} />
          : current?.kind === 'video' ? <div className="h-full w-full overflow-auto"><VideoFramesTool active={active} tabId={`${viewId}:video:${current.id}`} projectDirectoryHandle={directory} file={current.imageData} fileName={current.fileName} onSaved={onRefresh} /></div>
          : current && mainPreviews[current.id] ? <div className="relative flex h-full w-full items-center justify-center">{cropGeometry
            ? <svg role="img" aria-label={itemName(current)} viewBox={`${cropGeometry.sourceX} ${cropGeometry.sourceY} ${cropGeometry.sourceWidth} ${cropGeometry.sourceHeight}`} className="max-h-full max-w-full rounded-lg shadow-lg" style={{ aspectRatio: `${cropGeometry.outputWidth} / ${cropGeometry.outputHeight}`, height: '100%', width: 'auto' }}><image href={mainPreviews[current.id]} width={current.width} height={current.height} preserveAspectRatio="none" /></svg>
            : <img src={mainPreviews[current.id]} alt={itemName(current)} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />}</div>
          : <div className="text-center text-sm text-muted-foreground"><ImageIcon className="mx-auto mb-2 h-10 w-10" />{current ? 'Preview unavailable' : candidates.length ? 'No items match this queue' : <><p className="font-medium text-foreground">No materials yet</p><button type="button" onClick={() => goToStage('add')} className="mt-2 rounded bg-primary px-3 py-1.5 text-primary-foreground">Add materials →</button></>}</div>}
          {busy && <div className="absolute inset-0 flex items-center justify-center bg-background/60"><Loader2 className="h-6 w-6 animate-spin" /></div>}
        </section>
        <aside className="min-h-0 overflow-auto border-l border-border p-4">
          {current ? <div className="space-y-4">
            <div><p className="truncate font-medium" title={itemName(current)}>{itemName(current)}</p><p className="text-xs text-muted-foreground">{cursor + 1} / {queue.length} · {current.width}×{current.height} · {current.kind}</p></div>
            {currentRecord?.triage && <div data-triage-box className="space-y-1 rounded border border-border p-2 text-xs"><p className="font-medium capitalize">Proposal: {currentRecord.triage.group.replace('-', ' ')}</p>
              <ul className="list-disc pl-4 text-muted-foreground">{currentRecord.triage.reasons.map((reason) => <li key={`${reason.code}:${reason.message}`}>{reason.message}</li>)}</ul>
              {currentRecord.triage.quality && <p className="text-muted-foreground">Short side {currentRecord.triage.quality.shortSide}px · sharpness {currentRecord.triage.quality.sharpness.toFixed(4)} · brightness {Math.round(currentRecord.triage.quality.brightness * 100)}%</p>}
              {currentRecord.triage.duplicateOf && <p className="text-muted-foreground">Duplicate of {currentRecord.triage.duplicateOf}{currentRecord.triage.similarity !== undefined ? ` (${Math.round(currentRecord.triage.similarity * 100)}% similar)` : ''}</p>}
              {currentRecord.decision !== 'unreviewed' && <p className="text-amber-700 dark:text-amber-300">Your decision overrides the proposal</p>}</div>}
            {currentRecord?.error && <p role="alert" className="flex gap-2 rounded border border-destructive/40 p-2 text-xs text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />{currentRecord.error}</p>}
            {current.kind !== 'video' && <div className="space-y-1"><p className="text-xs font-medium">Caption</p><CaptionEditor key={currentId} value={draft} onChange={changeDraft} suggestions={captionSuggestions} rows={6} disabled={busy} ariaLabel="Caption" placeholder="tag one, tag two" />{dataset.triggerWord.trim() && <p className="text-xs text-muted-foreground">The Dataset caption file starts with the trigger: <span className="font-mono">{dataset.triggerWord}</span></p>}</div>}
            <ProposalSuggestions tags={proposal} onMerge={() => changeDraft([...new Set([...parseTags(draft), ...proposal])].join(', '))} />
            {!localTagger && current.kind !== 'video' && <LocalTaggerConnectPrompt message="No local caption model connected. Manual review remains available." />}
            {currentTransform?.mode === 'crop' && current.kind !== 'video' && current.kind !== 'psd' && <fieldset className="space-y-2 rounded border border-border p-2 text-xs"><legend className="px-1 font-medium">Crop frame</legend><label className="grid grid-cols-[4rem_1fr] items-center gap-2">Zoom<input type="range" min={100} max={250} value={cropZoom} onChange={(event)=>updateCrop(Number(event.target.value),cropCenterX,cropCenterY)} /></label><label className="grid grid-cols-[4rem_1fr] items-center gap-2">Horizontal<input type="range" min={0} max={100} value={cropCenterX} onChange={(event)=>updateCrop(cropZoom,Number(event.target.value),cropCenterY)} /></label><label className="grid grid-cols-[4rem_1fr] items-center gap-2">Vertical<input type="range" min={0} max={100} value={cropCenterY} onChange={(event)=>updateCrop(cropZoom,cropCenterX,Number(event.target.value))} /></label>{!currentTransform.allowUpscale && (current.width < currentTransform.width || current.height < currentTransform.height) && <p className="text-amber-700 dark:text-amber-300">Output stays below the profile size because upscale is disabled.</p>}</fieldset>}
            <div className="grid grid-cols-3 gap-2"><button disabled={busy || current.kind === 'video'} onClick={() => void commitDecision('accepted')} className="rounded bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40">Accept · A</button><button disabled={busy} onClick={() => void commitDecision('skipped')} className="rounded border border-border px-2 py-2 text-xs">Reject · X</button><button disabled={busy} onClick={() => void commitDecision('deferred')} className="rounded border border-border px-2 py-2 text-xs">Defer · D</button></div>
            <div className="flex justify-between"><button disabled={cursor <= 0} onClick={() => moveCursor(-1)} className="rounded p-2 disabled:opacity-30" aria-label="Previous"><ChevronLeft className="h-4 w-4" /></button><span className="self-center text-xs capitalize text-muted-foreground">{currentRecord?.decision} · {currentRecord?.validation}</span><button disabled={cursor >= queue.length - 1} onClick={() => moveCursor(1)} className="rounded p-2 disabled:opacity-30" aria-label="Next"><ChevronRight className="h-4 w-4" /></button></div>
          </div> : <div className="space-y-3 text-sm">{candidates.length ? <p>No visible items in this filter.</p> : <p>No materials yet.</p>}{missingRecords.map((record) => <div key={record.assetId} className="rounded border border-destructive/30 p-2 text-xs"><p className="break-all">Missing: {record.locator ?? record.assetId}</p><button className="mt-2 underline" onClick={() => patchSession((value) => updateBuildDecision(value, record.assetId, 'skipped', { application:'idle', validation:'pending', error:undefined }))}>Skip missing record</button></div>)}{candidates.length > 0 && <button onClick={() => patchSessionAndCursor((value) => ({ ...value, filter: 'all', cursor: 0 }))} className="rounded border border-border px-3 py-2">Show all</button>}</div>}
        </aside>
      </main>

      <section className="border-t border-border bg-card p-3">
        {!!selected.size && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs"><strong>{selected.size} selected</strong><select value={batchMode} onChange={(event) => setBatchMode(event.target.value as 'add' | 'remove' | 'replace')} className="rounded border border-border bg-background px-2 py-1"><option value="add">Add tag</option><option value="remove">Remove tag</option><option value="replace">Replace tag</option></select><input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} className="rounded border border-border bg-background px-2 py-1" placeholder={batchMode === 'replace' ? 'old tag' : 'tag'} />{batchMode === 'replace' && <input value={batchReplacement} onChange={(event)=>setBatchReplacement(event.target.value)} className="rounded border border-border bg-background px-2 py-1" placeholder="new tag" />}<button onClick={() => void applyBatchCaption()} className="rounded border border-border px-2 py-1">Apply</button><button disabled={busy} onClick={() => void commitDecision('accepted', candidates.filter((item) => selected.has(getBuildAssetId(item))))} className="rounded bg-primary px-2 py-1 text-primary-foreground">Accept selected</button><button onClick={() => setSelected(new Set())}>Clear</button></div>}
        {view !== 'grid' && <div className="flex gap-2 overflow-x-auto" aria-label="Candidate filmstrip">{filmstrip.map((item) => { const id = getBuildAssetId(item); const record = reconciled.records[id]; const itemCursor = queue.indexOf(item); return <button key={id} onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey) setSelected((ids) => { const next = new Set(ids); if (next.has(id)) next.delete(id); else next.add(id); return next; }); else setCursor(itemCursor); }} className={`relative h-16 w-20 shrink-0 overflow-hidden rounded border-2 ${itemCursor === cursor ? 'border-primary' : selected.has(id) ? 'border-sky-500' : 'border-transparent'}`} title={`${itemName(item)} · ${record?.decision}`}>
          {thumbs[item.id] ? <img src={thumbs[item.id]} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-secondary text-[10px]">{item.kind}</span>}
          {(record?.decision === 'skipped' || (record?.decision === 'unreviewed' && record.triage?.group === 'rejected')) && <span aria-label="Rejected" className="absolute right-1 top-1 rounded-full bg-red-600 p-0.5 text-white"><X className="h-3 w-3" /></span>}{(record?.decision === 'deferred' || (record?.decision === 'unreviewed' && record.triage?.group === 'needs-decision')) && <span aria-label="Flagged" className="absolute right-1 top-1 rounded-full bg-amber-500 p-0.5 text-white"><HelpCircle className="h-3 w-3" /></span>}{record?.decision === 'accepted' && <span className="absolute right-1 top-1 rounded-full bg-emerald-600 p-0.5 text-white"><Check className="h-3 w-3" /></span>}{shortlistedIds.has(id) && <span aria-label="Candidate" data-testid="build-shortlist-badge" className="absolute bottom-1 left-1 rounded bg-primary px-1 text-[9px] text-primary-foreground">Candidate</span>}{record?.validation === 'stale' && <span className="absolute left-1 top-1 rounded-full bg-amber-500 p-0.5 text-white"><RotateCcw className="h-3 w-3" /></span>}
        </button>; })}</div>}
      </section>
      </>}
    {!canExport && candidates.length > 0 && counts.ready < counts.target && counts.unresolved === 0 && <div className="flex items-center gap-3 border-t border-border bg-amber-500/10 px-4 py-2 text-xs"><span>Only {counts.ready} of {counts.target} target items are ready.</span><button onClick={() => setAllowShortfall(true)} className="underline">Finish with fewer</button></div>}
    </>}
    <BuildNextStageFooter current={stage} onNext={goToStage} />
  </div>;
}
