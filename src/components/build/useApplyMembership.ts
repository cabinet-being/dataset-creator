import { useCallback } from 'react';
import type { BuildImageOverride, BuildReviewDecision, BuildSession, EditedAsset } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { toWorkspaceImages } from '../../lib/workspaceImages';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { runHistoryTransaction, captureHistoryEpoch, isHistoryEpochCurrent, type HistoryTransactionWriter } from '../../stores/useHistoryStore';
import { flushProjectSave } from '../../hooks/useProjectSave';
import type { useOperation } from '../../hooks/useOperation';
import { persistCaptionTagsForItems } from '../../services/caption/captionMutationService';
import { setAssetsDatasetMembership } from '../../lib/assetActions';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { PROJECT_EDITS_DIRECTORY } from '../../services/project/projectLayoutService';
import {
  assertBuildSourceCurrent, getBuildAssetId, getBuildAssetRevision, getBuildValidation, updateBuildDecision,
} from '../../services/build/buildSessionService';
import { createBuildOutputAssetId, getBuildImageDigest, renderBuildTransform } from '../../services/build/buildTransformService';
import { sameTags } from './buildCaptionTags';

export type MembershipEntry = {
  item: WorkspaceImage;
  decision: BuildReviewDecision;
  /** Caption being edited for this item: it is saved first and the item is applied with exactly these tags. */
  tags?: string[];
  /** `pin`/`ban` set the override together with the decision, `null` removes it, absent keeps it. */
  override?: BuildImageOverride | null;
  /** Overrides the batch provenance for this entry. */
  provenance?: 'manual' | 'auto';
};

export type ApplyMembershipOptions = {
  provenance?: 'manual' | 'auto';
  /** Rethrow after the failure is reported (the caller continues its own flow). */
  propagateError?: boolean;
  /** History label; derived from the decisions when absent. */
  label?: string;
  /** Session patch applied in the same transaction (and the same Undo step) before the decisions. */
  prepare?: (session: BuildSession) => BuildSession;
  /** Runs after a successful, still current apply. */
  onApplied?: () => void;
  /** Runs right before the session is patched (not when the call is ignored): the caller flushes its pending UI state here. */
  beforeStart?: (targetIds: string[]) => void;
};

type Input = {
  directory?: ProjectDirectoryHandle | null;
  operation: ReturnType<typeof useOperation>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
};

const currentRegisteredItem = (assetId: string): WorkspaceImage | undefined => {
  const state = useProjectStore.getState();
  return toWorkspaceImages(Object.values(state.sourceImages), Object.values(state.datasetItems))
    .find((item) => getBuildAssetId(item) === assetId);
};

/**
 * Owner of "apply review decisions to Dataset membership": one history transaction per call with batched membership moves,
 * transformed outputs and a session snapshot for Undo. Also hosts the Pin / Ban / Return actions built on top of it.
 */
export function useApplyMembership({ directory, operation, busy, setBusy }: Input) {
  const notify = useUIStore((state) => state.addNotification);
  const updateSession = useProjectStore((state) => state.updateBuildSession);
  const addDatasetItem = useProjectStore((state) => state.addDatasetItem);
  const removeDatasetItem = useProjectStore((state) => state.removeDatasetItem);

  const saveCaption = useCallback(async (item: WorkspaceImage, tags: string[], historyWriter: HistoryTransactionWriter) => {
    if (item.kind === 'video' || sameTags(item.tags, tags)) return;
    await persistCaptionTagsForItems({ items: [item], resolveTags: () => tags, directory, flush: flushProjectSave, historyWriter });
  }, [directory]);

  const createTransformedOutput = useCallback(async (item: WorkspaceImage, assetId: string, assertCurrent: () => void, historyWriter: HistoryTransactionWriter): Promise<string | undefined> => {
    const session = useProjectStore.getState().buildSession;
    const recipe = session.records[assetId]?.transform ?? session.profile.transform;
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
      imageDataPath: `${PROJECT_EDITS_DIRECTORY}/${outputId}.png`,
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
  }, [addDatasetItem, removeDatasetItem, saveCaption]);

  /** Applies one decision per item inside a single history transaction (one Undo). Returns false when nothing was applied. */
  const applyDecisions = useCallback(async (entries: MembershipEntry[], options: ApplyMembershipOptions = {}): Promise<boolean> => {
    const { provenance = 'manual', propagateError = false, prepare, onApplied, beforeStart } = options;
    if (!entries.length || busy) return false;
    const targets = entries.map((entry) => entry.item);
    const targetIds = targets.map(getBuildAssetId);
    beforeStart?.(targetIds);
    const epoch = captureHistoryEpoch();
    const before = useProjectStore.getState().buildSession;
    const decisionById = new Map(entries.map((entry) => [getBuildAssetId(entry.item), entry.decision]));
    const provenanceById = new Map(entries.map((entry) => [getBuildAssetId(entry.item), entry.provenance ?? provenance]));
    const uniform = entries.every((entry) => entry.decision === entries[0].decision) ? entries[0].decision : undefined;
    const overrideUpdate = (entry: MembershipEntry): Partial<{ override: BuildImageOverride }> =>
      entry.override === undefined ? {} : { override: entry.override ?? undefined };
    updateSession((value) => entries.reduce((next, entry) => updateBuildDecision(next, getBuildAssetId(entry.item), entry.decision, {
      application: entry.decision === 'accepted' ? 'pending' : 'idle', validation: 'pending', provenance: provenanceById.get(getBuildAssetId(entry.item)), ...overrideUpdate(entry),
    }), prepare ? prepare(value) : value));
    setBusy(true);
    operation.start(undefined, targets.length);
    try {
      const label = options.label ?? `${uniform ? (uniform === 'accepted' ? 'Accept' : uniform === 'skipped' ? 'Skip' : 'Defer') : 'Review'} ${targets.length} item${targets.length === 1 ? '' : 's'}`;
      await runHistoryTransaction(label, async (historyWriter) => {
        let next = useProjectStore.getState().buildSession;
        let activeAssetId: string | undefined;
        // Plain membership moves of non-current items go through one batch (one registry write and Explorer pass) instead of one operation per file.
        const batched = new Set<string>();
        try {
          const toAdd: WorkspaceImage[] = []; const toRemove: WorkspaceImage[] = [];
          for (const { item, decision, tags } of entries) {
            if (tags !== undefined || item.kind === 'video') continue;
            const assetId = getBuildAssetId(item);
            const recipe = next.records[assetId]?.transform ?? next.profile.transform;
            const previousOutputId = next.records[assetId]?.outputAssetId;
            const outputItem = previousOutputId ? currentRegisteredItem(previousOutputId) : undefined;
            if (decision === 'accepted') {
              if (recipe && item.sourceImageId && item.kind !== 'psd') continue;
              if (outputItem && isProjectDatasetPath(outputItem.assetPath)) toRemove.push(outputItem);
              toAdd.push({ ...item, tags: item.tags ?? [] });
            } else {
              if (outputItem && isProjectDatasetPath(outputItem.assetPath)) toRemove.push(outputItem);
              if (isProjectDatasetPath(item.assetPath)) toRemove.push(item);
            }
            batched.add(assetId);
          }
          if (toRemove.length) await setAssetsDatasetMembership(toRemove, false, historyWriter);
          if (toAdd.length) await setAssetsDatasetMembership(toAdd, true, historyWriter);
          for (const [index, entry] of entries.entries()) {
            const { item, decision } = entry;
            const entryProvenance = entry.provenance ?? provenance;
            if (!isHistoryEpochCurrent(epoch)) throw new Error('The project changed while applying the review decision.');
            const assetId = getBuildAssetId(item); activeAssetId = assetId;
            const recipe = next.records[assetId]?.transform ?? next.profile.transform;
            const assertCurrentAsset = () => {
              assertBuildSourceCurrent(item, item.sourceImageId ? currentRegisteredItem(assetId) : item, recipe, isHistoryEpochCurrent(epoch));
            };
            const edited = entry.tags !== undefined;
            const tags = entry.tags ?? item.tags ?? [];
            assertCurrentAsset();
            if (edited && item.kind !== 'video') await saveCaption(item, tags, historyWriter);
            assertCurrentAsset();
            const revision = getBuildAssetRevision(item, tags, recipe);
            const previousOutputId = next.records[assetId]?.outputAssetId;
            const outputItem = previousOutputId ? currentRegisteredItem(previousOutputId) : undefined;
            if (decision === 'accepted') {
              if (item.kind === 'video') throw new Error('Save one or more frames before accepting a video.');
              const outputAssetId = await createTransformedOutput({ ...item, tags }, assetId, assertCurrentAsset, historyWriter);
              assertCurrentAsset();
              if (!batched.has(assetId) && previousOutputId && previousOutputId !== outputAssetId) {
                const oldOutput = currentRegisteredItem(previousOutputId);
                if (oldOutput && isProjectDatasetPath(oldOutput.assetPath)) await setAssetsDatasetMembership([oldOutput], false, historyWriter);
                assertCurrentAsset();
              }
              if (!outputAssetId && !batched.has(assetId)) await setAssetsDatasetMembership([{ ...item, tags }], true, historyWriter);
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
                acceptedRevision: revision, revision, provenance: entryProvenance, outputAssetId, outputRevision,
                draft: undefined,
              });
            } else {
              if (!batched.has(assetId) && outputItem && isProjectDatasetPath(outputItem.assetPath)) await setAssetsDatasetMembership([outputItem], false, historyWriter);
              assertCurrentAsset();
              if (!batched.has(assetId) && isProjectDatasetPath(item.assetPath)) await setAssetsDatasetMembership([item], false, historyWriter);
              assertCurrentAsset();
              next = updateBuildDecision(next, assetId, decision, { application: 'idle', validation: 'pending', outputAssetId: previousOutputId });
            }
            operation.progress(index + 1, targets.length);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The review decision could not be applied.';
          next = targetIds.reduce((value, id) => id === activeAssetId
            ? updateBuildDecision(value, id, decisionById.get(id)!, { application:'failed', validation:'error', error:message, override: before.records[id]?.override })
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
      if (isHistoryEpochCurrent(epoch)) onApplied?.();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The review decision could not be applied.';
      operation.finish('failed', message);
      notify('error', message);
      if (propagateError) throw error;
      return false;
    } finally { setBusy(false); }
  }, [busy, createTransformedOutput, notify, operation, saveCaption, setBusy, updateSession]);

  /** Applies a session-only change as one Undo step. */
  const patchWithHistory = useCallback(async (label: string, patch: (session: BuildSession) => BuildSession) => {
    const before = useProjectStore.getState().buildSession;
    const after = patch(before);
    if (after === before) return;
    await runHistoryTransaction(label, async (historyWriter) => {
      updateSession(patch);
      const applied = useProjectStore.getState().buildSession;
      historyWriter.push({ label, undo: () => updateSession(before), redo: () => updateSession(applied) });
    });
  }, [updateSession]);

  /** Pin: keeps the images in the Dataset baseline and moves them into the Dataset now (one transaction). Videos cannot be pinned. */
  const pinImages = useCallback((items: WorkspaceImage[]) => {
    const targets = items.filter((item) => item.kind !== 'video');
    return applyDecisions(targets.map((item) => ({ item, decision: 'accepted' as const, override: 'pin' as const })), { label: `Pin ${targets.length} image${targets.length === 1 ? '' : 's'}` });
  }, [applyDecisions]);

  /** Ban: keeps the images out of everything; images in the Dataset go back to their inbox folder (one transaction). */
  const banImages = useCallback((items: WorkspaceImage[]) =>
    applyDecisions(items.map((item) => ({ item, decision: 'skipped' as const, override: 'ban' as const })), { label: `Ban ${items.length} image${items.length === 1 ? '' : 's'}` }), [applyDecisions]);

  /** Removes only the override; membership does not change. */
  const clearOverride = useCallback(async (items: WorkspaceImage[]) => {
    const ids = new Set(items.map(getBuildAssetId));
    await patchWithHistory(`Clear override on ${ids.size} image${ids.size === 1 ? '' : 's'}`, (value) => {
      let records = value.records;
      for (const id of ids) {
        const record = records[id];
        if (!record?.override) continue;
        const { override: _removed, ...rest } = record;
        void _removed;
        records = { ...records, [id]: { ...rest, updatedAt: new Date().toISOString() } };
      }
      return records === value.records ? value : { ...value, records };
    });
  }, [patchWithHistory]);

  /** Takes the images out of the Dataset without banning them; a Pin is dropped with it, a Ban is left untouched. */
  const returnToInbox = useCallback((items: WorkspaceImage[]) => {
    const session = useProjectStore.getState().buildSession;
    return applyDecisions(items.map((item) => ({
      item, decision: 'unreviewed' as const,
      ...(session.records[getBuildAssetId(item)]?.override === 'pin' ? { override: null } : {}),
    })), { label: `Return ${items.length} image${items.length === 1 ? '' : 's'} to the inbox` });
  }, [applyDecisions]);

  return { applyDecisions, pinImages, banImages, clearOverride, returnToInbox };
}
