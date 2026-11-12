import { CaptionEditor } from '../caption/CaptionEditor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, HelpCircle, ImageIcon, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import type { BuildReviewDecision, BuildSession, EditedAsset } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { useProjectStore } from '../../stores/useProjectStore';
import { usePublishInspectorSelection, type InspectorSelectionPayload } from '../../stores/useInspectorSelectionStore';
import { useUIStore } from '../../stores/useUIStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { runHistoryTransaction, captureHistoryEpoch, isHistoryEpochCurrent, type HistoryTransactionWriter } from '../../stores/useHistoryStore';
import { toWorkspaceImages } from '../../lib/workspaceImages';
import { useCommands } from '../workspace/Commands';
import { ImportTool } from '../tools/ImportTool';
import { ExportTool } from '../tools/ExportTool';
import { VideoFramesTool } from '../tools/VideoFramesTool';
import { DatasetAssemblyDialog } from '../workspace/DatasetAssemblyDialog';
import type { ImportInputFile, ImportImagesOptions, ImportImagesResult } from '../../services/import/importService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { useOperation } from '../../hooks/useOperation';
import { persistCaptionTagsForItems } from '../../services/caption/captionMutationService';
import { setAssetsDatasetMembership } from '../../lib/assetActions';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { predictLocalTags } from '../../services/tagging/localTaggerService';
import { connectLocalTaggerSource, restoreSavedLocalTagger } from '../../services/tagging/localTaggerConnectionService';
import {
  getBuildAssetId,
  getBuildAssetRevision,
  assertBuildSourceCurrent,
  getBuildCounts,
  getBuildValidation,
  reconcileBuildSession,
  selectBuildQueue,
  nextBuildCursor,
  updateBuildDecision,
} from '../../services/build/buildSessionService';
import { createBuildOutputAssetId, getBuildImageDigest, getBuildTransformGeometry, renderBuildTransform } from '../../services/build/buildTransformService';
import { PROJECT_ASSETS_DIRECTORY } from '../../services/project/projectLayoutService';
import { getBuildTriageCounts, getBuildTriageGroup } from '../../services/build/buildTriageService';
import { DEFAULT_MIN_SHORT_SIDE, MIN_SHORT_SIDE_PRESETS } from '../../services/quality/imageQuality';
import type { createSemanticFeatureEncoder } from '../../services/analysis/semanticFeatureService';
import { useBuildAutoPipeline } from './useBuildAutoPipeline';

type Props = {
  active: boolean;
  viewId: string;
  items: WorkspaceImage[];
  directory?: ProjectDirectoryHandle | null;
  onImportFiles?: (files: ImportInputFile[], execution?: Pick<ImportImagesOptions, 'signal' | 'onProgress'>) => Promise<ImportImagesResult>;
  onRefresh?: () => void | Promise<void>;
  semanticEncoderFactory?: typeof createSemanticFeatureEncoder;
};

const parseTags = (value: string): string[] => {
  const seen = new Set<string>();
  return value.split(/[\n,]/).map((tag) => tag.trim()).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
};

const sameTags = (left: string[] | undefined, right: string[]) =>
  left !== undefined && left.length === right.length && left.every((tag, index) => tag === right[index]);

const itemName = (item: WorkspaceImage) => item.originalFileName || item.fileName;
const currentRegisteredItem = (assetId: string): WorkspaceImage | undefined => {
  const state = useProjectStore.getState();
  return toWorkspaceImages(Object.values(state.sourceImages), Object.values(state.datasetItems))
    .find((item) => getBuildAssetId(item) === assetId);
};

export function BuildWorkspace({ active, viewId, items, directory, onImportFiles, onRefresh, semanticEncoderFactory }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const projectId = useProjectStore((state) => state.id);
  const projectType = useProjectStore((state) => state.projectType);
  const session = useProjectStore((state) => state.buildSession);
  const dataset = useProjectStore((state) => state.dataset);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const updateSession = useProjectStore((state) => state.updateBuildSession);
  const updateDataset = useProjectStore((state) => state.updateDataset);
  const addDatasetItem = useProjectStore((state) => state.addDatasetItem);
  const removeDatasetItem = useProjectStore((state) => state.removeDatasetItem);
  const notify = useUIStore((state) => state.addNotification);
  const taggingConfig = useProjectStore((state) => state.taggingConfig);
  const localTagger = useLocalTaggerStore((state) => state.bundle);
  const savedTaggerFileNames = useLocalTaggerStore((state) => state.savedFileNames);
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showAssembly, setShowAssembly] = useState(false);
  const [allowShortfall, setAllowShortfall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchTag, setBatchTag] = useState('');
  const [batchReplacement, setBatchReplacement] = useState('');
  const [batchMode, setBatchMode] = useState<'add' | 'remove' | 'replace'>('add');
  const taggerInput = useRef<HTMLInputElement>(null);
  const operation = useOperation('Build review', root, viewId);

  const effectiveItems = useMemo(() => {
    const state = useProjectStore.getState();
    const registered = toWorkspaceImages(Object.values(state.sourceImages), Object.values(state.datasetItems));
    const byId = new Map(registered.map((item) => [getBuildAssetId(item), item]));
    return [...items.map((item) => item.sourceImageId ? byId.get(getBuildAssetId(item)) ?? item : item),
      ...registered.filter((item) => !items.some((candidate) => getBuildAssetId(candidate) === getBuildAssetId(item)))];
  }, [items, session]);
  const outputIds = useMemo(() => new Set(Object.values(session.records).flatMap((record) => record.outputAssetId ? [record.outputAssetId] : [])), [session.records]);
  const candidates = useMemo(() => effectiveItems.filter((item) => !outputIds.has(getBuildAssetId(item)) &&
    !(item.kind === 'edited' && item.editedAssetType === 'crop' && item.editedAssetId?.startsWith('build-'))), [effectiveItems, outputIds]);
  const reconciled = useMemo(() => busy ? session : reconcileBuildSession(session, candidates, undefined, effectiveItems), [busy, candidates, effectiveItems, session]);
  useEffect(() => { if (reconciled !== session) updateSession(reconciled); }, [reconciled, session, updateSession]);
  const queue = useMemo(() => selectBuildQueue(reconciled, candidates), [candidates, reconciled]);
  const cursor = Math.min(reconciled.cursor, Math.max(0, queue.length - 1));
  const current = queue[cursor];
  const currentId = current ? getBuildAssetId(current) : undefined;
  const currentRecord = currentId ? reconciled.records[currentId] : undefined;
  const inspectorPayload = useMemo<InspectorSelectionPayload | null>(() => {
    if (!current || !currentId) return null;
    const output = currentRecord?.outputAssetId
      ? effectiveItems.find((item) => getBuildAssetId(item) === currentRecord.outputAssetId)
      : isProjectDatasetPath(current.assetPath) ? current : undefined;
    const ready = currentRecord ? getBuildCounts({
      ...reconciled,
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
  }, [current, currentId, currentRecord, effectiveItems, reconciled]);
  usePublishInspectorSelection(active, viewId, inspectorPayload);
  const counts = useMemo(() => getBuildCounts(reconciled, effectiveItems), [effectiveItems, reconciled]);
  const missingRecords = useMemo(() => {
    const available = new Set(effectiveItems.map(getBuildAssetId));
    return reconciled.order.map((id) => reconciled.records[id]).filter((record) => record && !available.has(record.assetId) && record.decision !== 'skipped');
  }, [effectiveItems, reconciled.order, reconciled.records]);
  const previews = useWorkspacePreviewUrls(queue.filter((item) => item.kind !== 'video'));
  const filmstrip = useMemo(() => queue.slice(Math.max(0, cursor - 18), Math.min(queue.length, cursor + 19)), [cursor, queue]);

  useEffect(() => { setDraft(currentRecord?.draft ?? current?.tags?.join(', ') ?? ''); }, [currentId, current?.tags, currentRecord?.draft]);
  useEffect(() => { setSelected((ids) => new Set([...ids].filter((id) => reconciled.order.includes(id)))); }, [reconciled.order]);

  const patchSession = useCallback((patch: (value: BuildSession) => BuildSession) => updateSession(patch), [updateSession]);
  const captionSuggestions = useMemo(() => [...new Set([
    ...effectiveItems.flatMap(item => item.tags ?? []), ...(localTagger?.tags ?? []),
  ])].filter(tag => !taggingConfig.blacklist.includes(tag)), [effectiveItems, localTagger, taggingConfig.blacklist]);
  const changeDraft = (value: string) => {
    setDraft(value);
    if (currentId) patchSession(session => {
      const record = session.records[currentId];
      return record ? { ...session, records: { ...session.records, [currentId]: { ...record, draft: value } } } : session;
    });
  };
  // A newly connected model or changed thresholds must not reuse old predictions.
  useEffect(() => {
    patchSession(value => Object.values(value.records).some(record => record.proposal)
      ? { ...value, records: Object.fromEntries(Object.entries(value.records).map(([id, record]) => [id, { ...record, proposal: undefined }])) }
      : value);
  }, [localTagger, taggingConfig.threshold, taggingConfig.maxTags, projectId, patchSession]);

  const moveCursor = useCallback((step: number) => patchSession((value) => ({ ...value, cursor: Math.max(0, Math.min(queue.length - 1, cursor + step)) })), [cursor, patchSession, queue.length]);

  const saveCaption = useCallback(async (item: WorkspaceImage, tags: string[], historyWriter: HistoryTransactionWriter) => {
    if (item.kind === 'video' || sameTags(item.tags, tags)) return;
    await persistCaptionTagsForItems({ items: [item], resolveTags: () => tags, directory, flush: flushProjectSave, historyWriter });
  }, [directory]);

  const createTransformedOutput = useCallback(async (item: WorkspaceImage, assetId: string, assertCurrent: () => void, historyWriter: HistoryTransactionWriter): Promise<string | undefined> => {
    const recipe = reconciled.records[assetId]?.transform ?? reconciled.profile.transform;
    if (!recipe || !item.sourceImageId || item.kind === 'video' || item.kind === 'psd') return undefined;
    const digest = await getBuildImageDigest(item.imageData);
    assertCurrent();
    const outputId = createBuildOutputAssetId(assetId, digest, recipe);
    const outputAssetId = `edited:${outputId}`;
    const existing = currentRegisteredItem(outputAssetId);
    if (existing) {
      if (!sameTags(existing.tags, item.tags ?? [])) await saveCaption(existing, item.tags ?? [], historyWriter);
      assertCurrent();
      return outputAssetId;
    }
    const transformed = await renderBuildTransform(item.imageData, recipe);
    assertCurrent();
    const next: EditedAsset = {
      id: outputId,
      sourceImageId: item.sourceImageId,
      ...transformed,
      type: 'crop',
      tags: item.tags,
      imageDataPath: `${PROJECT_ASSETS_DIRECTORY}/${outputId}.png`,
      manifestPath: `${PROJECT_ASSETS_DIRECTORY}/${outputId}.png.manifest.json`,
      deleted: false,
      createdAt: new Date(),
    };
    addDatasetItem(next);
    historyWriter.push({
      label: 'Create transformed output',
      undo: () => removeDatasetItem(outputId),
      redo: () => addDatasetItem(next),
    });
    await flushProjectSave();
    assertCurrent();
    return outputAssetId;
  }, [addDatasetItem, reconciled.profile.transform, reconciled.records, removeDatasetItem, saveCaption]);

  const commitDecision = useCallback(async (decision: BuildReviewDecision, targets = current ? [current] : [], provenance: 'manual' | 'auto' = 'manual', propagateError = false) => {
    if (!targets.length || busy) return;
    const epoch = captureHistoryEpoch();
    const before = useProjectStore.getState().buildSession;
    const targetIds = targets.map(getBuildAssetId);
    patchSession((value) => targetIds.reduce((next, id) => updateBuildDecision(next, id, decision, {
      application: decision === 'accepted' ? 'pending' : 'idle', validation: 'pending', provenance,
    }), value));
    setBusy(true);
    operation.start(undefined, targets.length);
    try {
      await runHistoryTransaction(`${decision === 'accepted' ? 'Accept' : decision === 'skipped' ? 'Skip' : 'Defer'} ${targets.length} item${targets.length === 1 ? '' : 's'}`, async (historyWriter) => {
        let next = useProjectStore.getState().buildSession;
        let activeAssetId: string | undefined;
        try {
          for (const [index, item] of targets.entries()) {
            if (!isHistoryEpochCurrent(epoch)) throw new Error('The project changed while applying the review decision.');
            const assetId = getBuildAssetId(item); activeAssetId = assetId;
            const recipe = next.records[assetId]?.transform ?? next.profile.transform;
            const assertCurrentAsset = () => {
              assertBuildSourceCurrent(item, item.sourceImageId ? currentRegisteredItem(assetId) : item, recipe, isHistoryEpochCurrent(epoch));
            };
            const tags = item === current ? parseTags(draft) : item.tags ?? [];
            assertCurrentAsset();
            if (item === current && item.kind !== 'video') await saveCaption(item, tags, historyWriter);
            assertCurrentAsset();
            const revision = getBuildAssetRevision(item, tags, recipe);
            const previousOutputId = next.records[assetId]?.outputAssetId;
            const outputItem = previousOutputId ? currentRegisteredItem(previousOutputId) : undefined;
            if (decision === 'accepted') {
              if (item.kind === 'video') throw new Error('Save one or more frames before accepting a video.');
              const outputAssetId = await createTransformedOutput({ ...item, tags }, assetId, assertCurrentAsset, historyWriter);
              assertCurrentAsset();
              if (previousOutputId && previousOutputId !== outputAssetId) {
                const oldOutput = currentRegisteredItem(previousOutputId);
                if (oldOutput && isProjectDatasetPath(oldOutput.assetPath)) await setAssetsDatasetMembership([oldOutput], false, historyWriter);
                assertCurrentAsset();
              }
              if (!outputAssetId) await setAssetsDatasetMembership([{ ...item, tags }], true, historyWriter);
              assertCurrentAsset();
              const existingOutput = outputAssetId ? currentRegisteredItem(outputAssetId) : undefined;
              if (outputAssetId && !existingOutput) throw new Error('The transformed output disappeared before it could be saved.');
              if (existingOutput && !isProjectDatasetPath(existingOutput.assetPath)) await setAssetsDatasetMembership([existingOutput], true, historyWriter);
              assertCurrentAsset();
              if (outputAssetId && isProjectDatasetPath(item.assetPath)) await setAssetsDatasetMembership([item], false, historyWriter);
              assertCurrentAsset();
              const finalOutput = outputAssetId ? currentRegisteredItem(outputAssetId) : undefined;
              const outputRevision = finalOutput ? getBuildAssetRevision(finalOutput, finalOutput.tags, recipe) : undefined;
              next = updateBuildDecision(next, assetId, decision, {
                application: 'applied', validation: getBuildValidation({ ...item, tags }, next.profile.captionRequired),
                acceptedRevision: revision, revision, provenance, outputAssetId, outputRevision,
                draft: undefined,
              });
            } else {
              if (outputItem && isProjectDatasetPath(outputItem.assetPath)) await setAssetsDatasetMembership([outputItem], false, historyWriter);
              assertCurrentAsset();
              if (isProjectDatasetPath(item.assetPath)) await setAssetsDatasetMembership([item], false, historyWriter);
              assertCurrentAsset();
              next = updateBuildDecision(next, assetId, decision, { application: 'idle', validation: 'pending', outputAssetId: previousOutputId });
            }
            operation.progress(index + 1, targets.length);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The review decision could not be applied.';
          next = targetIds.reduce((value, id) => id === activeAssetId
            ? updateBuildDecision(value, id, decision, { application:'failed', validation:'error', error:message })
            : before.records[id] ? { ...value, records:{ ...value.records, [id]:before.records[id] } } : value, next);
          throw error;
        } finally {
          if (isHistoryEpochCurrent(epoch)) {
            // Merge only the target records so concurrent triage and suggestion patches are not clobbered.
            updateSession((latest) => ({
              ...latest,
              records: {
                ...latest.records,
                ...Object.fromEntries(targetIds.flatMap((id) => next.records[id] ? [[id, {
                  ...next.records[id],
                  ...(latest.records[id]?.triage ? { triage: latest.records[id]!.triage } : {}),
                  ...(latest.records[id]?.proposal ? { proposal: latest.records[id]!.proposal } : {}),
                }]] : [])),
              },
            }));
            const after = next;
            historyWriter.push({ label: 'Review decision', undo: () => updateSession(before), redo: () => updateSession(after) });
          }
        }
      });
      operation.finish('completed', `${targets.length} review decision${targets.length === 1 ? '' : 's'} applied`);
      if (targets.length === 1 && isHistoryEpochCurrent(epoch)) patchSession((value) => {
        const nextQueue = selectBuildQueue(value, candidates);
        return { ...value, cursor: nextBuildCursor(queue, nextQueue, cursor, targetIds[0]) };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The review decision could not be applied.';
      operation.finish('failed', message);
      notify('error', message);
      if (propagateError) throw error;
    } finally { setBusy(false); }
  }, [busy, candidates, createTransformedOutput, current, cursor, draft, notify, operation, patchSession, projectId, queue, saveCaption, updateSession]);

  const pipeline = useBuildAutoPipeline({
    active, enabled: reconciled.profile.autoPipeline !== false, busy, candidates, effectiveItems, session: reconciled,
    patchSession, dataset, commitDecision, localTagger, taggingConfig, root, viewId, notify, encoderFactory: semanticEncoderFactory,
  });
  const triageCounts = useMemo(() => getBuildTriageCounts(reconciled, candidates), [candidates, reconciled]);
  const lastFocusPass = useRef(0);
  useEffect(() => {
    if (pipeline.passCount === lastFocusPass.current) return;
    lastFocusPass.current = pipeline.passCount;
    patchSession((value) => value.filter === 'all' && triageCounts.needsDecision > 0 ? { ...value, filter: 'needs-decision', cursor: 0 } : value);
  }, [pipeline.passCount, patchSession, triageCounts.needsDecision]);

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

  useEffect(() => {
    if (!localTagger || !active || busy) return;
    let cancelled = false;
    const targets = queue.slice(cursor, cursor + 3).filter((item) => item.kind !== 'video' && item.kind !== 'psd' &&
      !(pipeline.phase === 'tagging' && getBuildTriageGroup(reconciled.records[getBuildAssetId(item)] ?? { decision: 'unreviewed' } as never) === 'accepted'));
    void (async () => {
      for (const item of targets) {
        const id = getBuildAssetId(item); const revision = reconciled.records[id]?.revision ?? getBuildAssetRevision(item);
        if (reconciled.records[id]?.proposal?.revision === revision) continue;
        try {
          const predictions = await predictLocalTags(localTagger, item.imageData, taggingConfig.threshold, taggingConfig.maxTags);
          if (cancelled) return;
          patchSession((value) => {
            const record = value.records[id];
            if (!record || record.revision !== revision || record.decision === 'accepted') return value;
            return { ...value, records: { ...value.records, [id]: { ...record, proposal: { tags: predictions.map((prediction) => prediction.tag), revision } } } };
          });
        } catch { return; }
      }
    })();
    return () => { cancelled = true; };
  }, [active, busy, cursor, localTagger, patchSession, pipeline.phase, queue, reconciled.records, taggingConfig.threshold, taggingConfig.maxTags]);

  useCommands([
    { id: 'build.accept', label: 'Build: Accept', shortcut: 'A', active, disabled: busy || !current || current.kind === 'video', run: () => commitDecision('accepted') },
    { id: 'build.skip', label: 'Build: Reject', shortcut: 'X', active, disabled: busy || !current, run: () => commitDecision('skipped') },
    { id: 'build.defer', label: 'Build: Defer', shortcut: 'D', active, disabled: busy || !current, run: () => commitDecision('deferred') },
    { id: 'build.previous', label: 'Build: Previous', shortcut: 'ArrowLeft', active, disabled: cursor <= 0, run: () => moveCursor(-1) },
    { id: 'build.next', label: 'Build: Next', shortcut: 'ArrowRight', active, disabled: cursor >= queue.length - 1, run: () => moveCursor(1) },
    { id: 'build.finish', label: 'Build: Finish review', shortcut: 'Mod+Enter', active, disabled: busy, run: () => counts.unresolved || counts.errors ? patchSession((value) => ({ ...value, filter: counts.errors ? 'errors' : 'unresolved', cursor: 0 })) : setShowExport(true) },
  ], () => root.current);

  const proposal = currentRecord?.proposal && currentRecord.proposal.revision === currentRecord.revision ? currentRecord.proposal.tags : [];
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
  const queueGroupActive = ['needs-decision', 'accepted', 'rejected'].includes(reconciled.filter);
  const acceptTargets = queueGroupActive ? queue.filter((item) => {
    const record = reconciled.records[getBuildAssetId(item)];
    return item.kind !== 'video' && !(record?.decision === 'accepted' && record.application === 'applied');
  }) : [];
  const rejectTargets = queueGroupActive ? queue.filter((item) => reconciled.records[getBuildAssetId(item)]?.decision !== 'skipped') : [];
  const setFilter = (filter: BuildSession['filter']) => patchSession((value) => ({ ...value, filter, cursor: 0 }));
  const setMinShortSide = (minShortSide: number) => patchSession((value) => ({
    ...value,
    profile: { ...value.profile, minShortSide },
    records: Object.fromEntries(Object.entries(value.records).map(([id, record]) => [id, record.decision === 'unreviewed' && record.triage?.stage === 'quality' ? { ...record, triage: undefined } : record])),
    auto: undefined,
  }));
  const canExport = counts.unresolved === 0 && counts.errors === 0 && (counts.ready >= counts.target || allowShortfall);
  const setProfileTransform = (value: string) => patchSession((currentSession) => ({ ...currentSession, profile: {
    ...currentSession.profile,
    transform: value === 'original' ? undefined : { mode: value === 'fit-512' ? 'fit' : 'crop', width: value === 'crop-768' ? 768 : 512, height: value === 'crop-768' ? 768 : 512, allowUpscale: false },
  } }));

  return <div ref={root} className="flex h-full min-h-0 flex-col bg-background" data-build-workspace>
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <div className="mr-auto"><h1 className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4 text-primary" />Build Dataset</h1><p className="text-xs text-muted-foreground">One queue from import to export</p></div>
      <div role="status" className="rounded-lg bg-secondary px-3 py-2 text-xs"><strong>Ready {counts.ready} / target {counts.target}</strong> · saving {counts.saving} · <button onClick={() => patchSession((value) => ({ ...value, filter: 'unresolved', cursor: 0 }))} className="underline">needs decision {counts.unresolved}</button> · <button onClick={() => patchSession((value) => ({ ...value, filter: 'errors', cursor: 0 }))} className={counts.errors ? 'text-destructive underline' : ''}>errors {counts.errors}</button></div>
      <div role="group" aria-label="Triage groups" className="flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => setFilter('needs-decision')} className="rounded bg-amber-500/15 px-2 py-1 text-amber-800 dark:text-amber-200">Needs decision {triageCounts.needsDecision}</button>
        <button onClick={() => setFilter('accepted')} className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-800 dark:text-emerald-200">Accepted {triageCounts.accepted}</button>
        <button onClick={() => setFilter('rejected')} className="rounded bg-red-500/15 px-2 py-1 text-red-800 dark:text-red-200">Rejected {triageCounts.rejected}</button>
        {triageCounts.pending > 0 && <span className="rounded bg-secondary px-2 py-1">Analyzing {triageCounts.pending}</span>}
        {pipeline.phase !== 'idle' && <span role="status" className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{pipeline.phase === 'triage' ? 'Analyzing images' : pipeline.phase === 'assembly' ? 'Selecting Dataset images' : 'Preparing caption suggestions'}{pipeline.progress.total > 0 && ` ${pipeline.progress.completed}/${pipeline.progress.total}`}<button className="ml-1 underline" onClick={pipeline.cancel}>Cancel</button></span>}
        {pipeline.phase === 'idle' && pipeline.paused && <button className="underline" onClick={pipeline.resume}>Resume automatic pipeline</button>}
      </div>
      <button className="rounded border border-border px-3 py-2 text-sm" onClick={() => setShowImport((value) => !value)}>Add materials</button>
      <button className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={busy} onClick={() => {
        if (!canExport) { patchSession((value) => ({ ...value, filter: counts.errors ? 'errors' : 'unresolved', cursor: 0 })); return; }
        setShowExport(true);
      }}>Finish</button>
    </header>

    {showImport || !candidates.length ? <div className="min-h-0 flex-1 overflow-auto p-4"><ImportTool active={active} onImportFiles={onImportFiles} /></div> : showExport ? <div className="min-h-0 flex-1 overflow-auto"><div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background p-3"><button onClick={() => setShowExport(false)} className="rounded border border-border px-3 py-1.5 text-sm">Back to review</button><span className="text-sm text-muted-foreground">Export uses the same physical Dataset and caption plan as the Export tool.</span></div><ExportTool active={active} onExportComplete={(plan) => patchSession((value) => ({ ...value, lastExport: { fingerprint: plan.fingerprint, completedAt: new Date().toISOString(), entries: plan.entries.length } }))} /></div> : <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
        <label>Target <input type="number" min={0} value={reconciled.profile.target} onChange={(event) => patchSession((value) => ({ ...value, profile: { ...value.profile, target: Math.max(0, Number(event.target.value) || 0) } }))} className="ml-1 w-20 rounded border border-border bg-background px-2 py-1" /></label>
        <label>Review <select value={reconciled.profile.reviewMode} onChange={(event) => patchSession((value) => ({ ...value, profile: { ...value.profile, reviewMode: event.target.value as BuildSession['profile']['reviewMode'] } }))} className="ml-1 rounded border border-border bg-background px-2 py-1"><option value="every-item">Every photo</option><option value="uncertain-only">Uncertain only</option></select></label>
        <label>Output <select value={!reconciled.profile.transform ? 'original' : `${reconciled.profile.transform.mode}-${reconciled.profile.transform.width}`} onChange={(event) => setProfileTransform(event.target.value)} className="ml-1 rounded border border-border bg-background px-2 py-1"><option value="original">Original</option><option value="fit-512">Fit within 512</option><option value="crop-512">Center crop 512</option><option value="crop-768">Center crop 768</option></select></label>
        <label>Min short side <select aria-label="Min short side" value={reconciled.profile.minShortSide ?? DEFAULT_MIN_SHORT_SIDE} onChange={(event) => setMinShortSide(Number(event.target.value))} className="ml-1 rounded border border-border bg-background px-2 py-1">{[...new Set<number>([...MIN_SHORT_SIDE_PRESETS, reconciled.profile.minShortSide ?? DEFAULT_MIN_SHORT_SIDE])].map((value) => <option key={value} value={value}>{value}px</option>)}</select></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={reconciled.profile.autoPipeline !== false} onChange={(event) => patchSession((value) => ({ ...value, profile: { ...value.profile, autoPipeline: event.target.checked } }))} />Auto pipeline</label>
        <label>Trigger word <input value={dataset.triggerWord} onChange={(event) => { updateDataset(dataset.id, { triggerWord: event.target.value }); patchSession((value) => ({ ...value, records:Object.fromEntries(Object.entries(value.records).map(([id,record]) => [id,record.decision === 'accepted' ? { ...record, validation:'stale' as const } : record])) })); }} className="ml-1 w-32 rounded border border-border bg-background px-2 py-1" /></label>
        <button className="ml-auto rounded border border-border px-2 py-1" onClick={() => setShowAssembly(true)}>Automatic selection</button>
        <select aria-label="Queue filter" value={reconciled.filter} onChange={(event) => patchSession((value) => ({ ...value, filter: event.target.value as BuildSession['filter'], cursor: 0 }))} className="rounded border border-border bg-background px-2 py-1"><option value="all">All</option><option value="unresolved">Unresolved</option><option value="needs-decision">Needs decision</option><option value="accepted">Accepted (proposed)</option><option value="rejected">Rejected (proposed)</option><option value="errors">Errors</option></select>
        {queueGroupActive && (acceptTargets.length > 0 || rejectTargets.length > 0) && <>
          <button disabled={busy || !acceptTargets.length} onClick={() => void commitDecision('accepted', acceptTargets)} className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40">Accept all {acceptTargets.length}</button>
          <button disabled={busy || !rejectTargets.length} onClick={() => void commitDecision('skipped', rejectTargets)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Reject all {rejectTargets.length}</button>
        </>}
      </div>

      <main className="grid min-h-0 flex-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="relative flex min-h-0 flex-col items-center justify-center overflow-auto bg-black/5 p-4 dark:bg-black/20">
          {current?.kind === 'video' ? <div className="h-full w-full overflow-auto"><VideoFramesTool active={active} tabId={`${viewId}:video:${current.id}`} projectDirectoryHandle={directory} file={current.imageData} fileName={current.fileName} onSaved={onRefresh} /></div>
          : current && previews[current.id] ? <div className="relative flex h-full w-full items-center justify-center">{cropGeometry
            ? <svg role="img" aria-label={itemName(current)} viewBox={`${cropGeometry.sourceX} ${cropGeometry.sourceY} ${cropGeometry.sourceWidth} ${cropGeometry.sourceHeight}`} className="max-h-full max-w-full rounded-lg shadow-lg" style={{ aspectRatio: `${cropGeometry.outputWidth} / ${cropGeometry.outputHeight}`, height: '100%', width: 'auto' }}><image href={previews[current.id]} width={current.width} height={current.height} preserveAspectRatio="none" /></svg>
            : <img src={previews[current.id]} alt={itemName(current)} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />}</div>
          : <div className="text-center text-sm text-muted-foreground"><ImageIcon className="mx-auto mb-2 h-10 w-10" />{current ? 'Preview unavailable' : 'No items match this queue'}</div>}
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
            {current.kind !== 'video' && <div className="space-y-1"><p className="text-xs font-medium">Caption</p><CaptionEditor key={currentId} value={draft} onChange={changeDraft} suggestions={captionSuggestions} rows={6} disabled={busy} ariaLabel="Caption" placeholder="tag one, tag two" />{dataset.triggerWord.trim() && <p className="text-xs text-muted-foreground">Export adds trigger: <span className="font-mono">{dataset.triggerWord}</span></p>}</div>}
            {!!proposal.length && <div className="rounded border border-primary/30 bg-primary/5 p-2 text-xs"><p className="font-medium">Local model suggestions</p><p className="mt-1 text-muted-foreground">{proposal.join(', ')}</p><button className="mt-2 rounded border border-border px-2 py-1" onClick={() => changeDraft([...new Set([...parseTags(draft), ...proposal])].join(', '))}>Merge suggestions</button></div>}
            {!localTagger && current.kind !== 'video' && <div className="text-xs text-muted-foreground"><p>No local caption model connected. Manual review remains available.</p><input ref={taggerInput} type="file" multiple accept=".onnx,.csv" className="hidden" onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value=''; if (!files.length) return; void connectLocalTaggerSource({kind:'files',name:'Build workspace model',files}).then((connected) => { if (!connected) notify('error', useLocalTaggerStore.getState().message); }); }} /><button className="mt-2 rounded border border-border px-2 py-1" onClick={() => taggerInput.current?.click()}>Connect model.onnx + selected_tags.csv</button>{savedTaggerFileNames.model && savedTaggerFileNames.tags && <button className="mt-2 ml-2 rounded border border-border px-2 py-1" onClick={() => void restoreSavedLocalTagger(true)}>Restore saved model</button>}</div>}
            {currentTransform?.mode === 'crop' && current.kind !== 'video' && current.kind !== 'psd' && <fieldset className="space-y-2 rounded border border-border p-2 text-xs"><legend className="px-1 font-medium">Crop frame</legend><label className="grid grid-cols-[4rem_1fr] items-center gap-2">Zoom<input type="range" min={100} max={250} value={cropZoom} onChange={(event)=>updateCrop(Number(event.target.value),cropCenterX,cropCenterY)} /></label><label className="grid grid-cols-[4rem_1fr] items-center gap-2">Horizontal<input type="range" min={0} max={100} value={cropCenterX} onChange={(event)=>updateCrop(cropZoom,Number(event.target.value),cropCenterY)} /></label><label className="grid grid-cols-[4rem_1fr] items-center gap-2">Vertical<input type="range" min={0} max={100} value={cropCenterY} onChange={(event)=>updateCrop(cropZoom,cropCenterX,Number(event.target.value))} /></label>{!currentTransform.allowUpscale && (current.width < currentTransform.width || current.height < currentTransform.height) && <p className="text-amber-700 dark:text-amber-300">Output stays below the profile size because upscale is disabled.</p>}</fieldset>}
            <div className="grid grid-cols-3 gap-2"><button disabled={busy || current.kind === 'video'} onClick={() => void commitDecision('accepted')} className="rounded bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40">Accept · A</button><button disabled={busy} onClick={() => void commitDecision('skipped')} className="rounded border border-border px-2 py-2 text-xs">Reject · X</button><button disabled={busy} onClick={() => void commitDecision('deferred')} className="rounded border border-border px-2 py-2 text-xs">Defer · D</button></div>
            <div className="flex justify-between"><button disabled={cursor <= 0} onClick={() => moveCursor(-1)} className="rounded p-2 disabled:opacity-30" aria-label="Previous"><ChevronLeft className="h-4 w-4" /></button><span className="self-center text-xs capitalize text-muted-foreground">{currentRecord?.decision} · {currentRecord?.validation}</span><button disabled={cursor >= queue.length - 1} onClick={() => moveCursor(1)} className="rounded p-2 disabled:opacity-30" aria-label="Next"><ChevronRight className="h-4 w-4" /></button></div>
          </div> : <div className="space-y-3 text-sm"><p>No visible items in this filter.</p>{missingRecords.map((record) => <div key={record.assetId} className="rounded border border-destructive/30 p-2 text-xs"><p className="break-all">Missing: {record.locator ?? record.assetId}</p><button className="mt-2 underline" onClick={() => patchSession((value) => updateBuildDecision(value, record.assetId, 'skipped', { application:'idle', validation:'pending', error:undefined }))}>Skip missing record</button></div>)}<button onClick={() => patchSession((value) => ({ ...value, filter: 'all', cursor: 0 }))} className="rounded border border-border px-3 py-2">Show all</button></div>}
        </aside>
      </main>

      <section className="border-t border-border bg-card p-3">
        {!!selected.size && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs"><strong>{selected.size} selected</strong><select value={batchMode} onChange={(event) => setBatchMode(event.target.value as 'add' | 'remove' | 'replace')} className="rounded border border-border bg-background px-2 py-1"><option value="add">Add tag</option><option value="remove">Remove tag</option><option value="replace">Replace tag</option></select><input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} className="rounded border border-border bg-background px-2 py-1" placeholder={batchMode === 'replace' ? 'old tag' : 'tag'} />{batchMode === 'replace' && <input value={batchReplacement} onChange={(event)=>setBatchReplacement(event.target.value)} className="rounded border border-border bg-background px-2 py-1" placeholder="new tag" />}<button onClick={() => void applyBatchCaption()} className="rounded border border-border px-2 py-1">Apply</button><button disabled={busy} onClick={() => void commitDecision('accepted', candidates.filter((item) => selected.has(getBuildAssetId(item))))} className="rounded bg-primary px-2 py-1 text-primary-foreground">Accept selected</button><button onClick={() => setSelected(new Set())}>Clear</button></div>}
        <div className="flex gap-2 overflow-x-auto" aria-label="Candidate filmstrip">{filmstrip.map((item) => { const id = getBuildAssetId(item); const record = reconciled.records[id]; const itemCursor = queue.indexOf(item); return <button key={id} onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey) setSelected((ids) => { const next = new Set(ids); if (next.has(id)) next.delete(id); else next.add(id); return next; }); else patchSession((value) => ({ ...value, cursor: itemCursor })); }} className={`relative h-16 w-20 shrink-0 overflow-hidden rounded border-2 ${itemCursor === cursor ? 'border-primary' : selected.has(id) ? 'border-sky-500' : 'border-transparent'}`} title={`${itemName(item)} · ${record?.decision}`}>
          {previews[item.id] ? <img src={previews[item.id]} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-secondary text-[10px]">{item.kind}</span>}
          {(record?.decision === 'skipped' || (record?.decision === 'unreviewed' && record.triage?.group === 'rejected')) && <span aria-label="Rejected" className="absolute right-1 top-1 rounded-full bg-red-600 p-0.5 text-white"><X className="h-3 w-3" /></span>}{(record?.decision === 'deferred' || (record?.decision === 'unreviewed' && record.triage?.group === 'needs-decision')) && <span aria-label="Needs decision" className="absolute right-1 top-1 rounded-full bg-amber-500 p-0.5 text-white"><HelpCircle className="h-3 w-3" /></span>}{record?.decision === 'accepted' && <span className="absolute right-1 top-1 rounded-full bg-emerald-600 p-0.5 text-white"><Check className="h-3 w-3" /></span>}{record?.validation === 'stale' && <span className="absolute left-1 top-1 rounded-full bg-amber-500 p-0.5 text-white"><RotateCcw className="h-3 w-3" /></span>}
        </button>; })}</div>
      </section>
    </>}

    {!canExport && counts.ready < counts.target && counts.unresolved === 0 && <div className="flex items-center gap-3 border-t border-border bg-amber-500/10 px-4 py-2 text-xs"><span>Only {counts.ready} of {counts.target} target items are ready.</span><button onClick={() => setAllowShortfall(true)} className="underline">Finish with fewer</button></div>}
    <DatasetAssemblyDialog open={showAssembly} onOpenChange={setShowAssembly} dataset={dataset} items={items} directory={directory ?? undefined} projectId={projectId} projectType={projectType} defaultMode="total" defaultTotal={reconciled.profile.target} excludedCategories={workspaceSettings.excludedProjectCategories ?? []} includedCategories={workspaceSettings.includedProjectCategories ?? []} onApply={async (paths) => {
      const selectedItems = candidates.filter((item) => item.assetPath && paths.some((path) => item.assetPath!.replace(/^Project\//, '') === path.replace(/^Project\//, '')));
      if (selectedItems.length !== paths.length) throw new Error('Some proposed files changed before the selection was applied. Run automatic selection again.');
      await commitDecision('accepted', selectedItems, 'auto', true);
    }} />
  </div>;
}
