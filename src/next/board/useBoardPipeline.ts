import { useCallback, useMemo, type RefObject } from 'react';
import { useApplyMembership } from '../../components/build/useApplyMembership';
import { useBuildAutoPipeline } from '../../components/build/useBuildAutoPipeline';
import type { useBuildModel } from '../../components/build/useBuildModel';
import { useOperation } from '../../hooks/useOperation';
import { isInboxItem, isInboxItemInSources } from '../../lib/inboxFolders';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { createSemanticFeatureEncoder } from '../../services/analysis/semanticFeatureService';
import { getBuildAssetId } from '../../services/build/buildSessionService';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { selectActiveCharacterTraits, useProjectStore } from '../../stores/useProjectStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { useUIStore } from '../../stores/useUIStore';
import type { BuildReviewDecision } from '../../types';
import type { useProjectRuntime } from '../useProjectRuntime';

const VIEW_ID = 'next-board';

/** Membership actions the grid and the lightbox call; each one is a single Undo step (owned by `useApplyMembership`). */
export type BoardActions = Pick<ReturnType<typeof useApplyMembership>, 'pinImages' | 'banImages' | 'clearOverride' | 'returnToInbox'> & { busy: boolean };

type Input = {
  runtime: ReturnType<typeof useProjectRuntime>;
  model: ReturnType<typeof useBuildModel>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  root: RefObject<HTMLElement>;
  /** Test seam: replaces the DINOv2 encoder. */
  encoderFactory?: typeof createSemanticFeatureEncoder;
};

/**
 * Board services in one place: membership actions (Pin, Ban, Clear, Return; one Undo step each) and the Assemble pipeline.
 * Both share one `applyDecisions`, so the history, the busy flag and the session write-back have a single owner.
 */
export function useBoardPipeline({ runtime, model, busy, setBusy, root, encoderFactory }: Input) {
  const { effectiveItems, candidates, reconciled, patchSession } = model;
  const notify = useUIStore(state => state.addNotification);
  const dataset = useProjectStore(state => state.dataset);
  const targetModel = useProjectStore(state => state.targetModel);
  const taggingConfig = useProjectStore(state => state.taggingConfig);
  const characterTraits = useProjectStore(selectActiveCharacterTraits);
  const localTagger = useLocalTaggerStore(state => state.bundle);
  const operation = useOperation('Board review', root, VIEW_ID);
  const membership = useApplyMembership({ directory: runtime.projectDirectoryHandle, operation, busy, setBusy });
  const { applyDecisions } = membership;

  const commitDecision = useCallback(async (decision: BuildReviewDecision, targets: WorkspaceImage[] = [], provenance: 'manual' | 'auto' = 'manual', propagateError = false) => {
    if (!targets.length) return;
    await applyDecisions(targets.map(item => ({ item, decision })), { provenance, propagateError });
  }, [applyDecisions]);

  // Assemble works on the frames in the ticked Sources folders that the user has not banned or rejected.
  const sources = reconciled.profile.sources;
  const sourceItems = useMemo(() => candidates.filter(item => item.kind !== 'video' && isInboxItem(item) && !isProjectDatasetPath(item.assetPath)
    && isInboxItemInSources(item, sources) && reconciled.records[getBuildAssetId(item)]?.decision !== 'skipped'), [candidates, reconciled.records, sources]);

  const pipeline = useBuildAutoPipeline({
    // No background triage: Assemble runs the quality check itself, so statuses change only when the user asks.
    active: false, busy, candidates, sources: sourceItems, effectiveItems, session: reconciled, targetModel, patchSession, dataset,
    commitDecision, applyDecisions, localTagger, taggingConfig, root, viewId: VIEW_ID, notify, encoderFactory, characterTraits,
  });
  const { pinImages, banImages, clearOverride, returnToInbox } = membership;
  const actions = useMemo<BoardActions>(() => ({ pinImages, banImages, clearOverride, returnToInbox, busy }), [banImages, busy, clearOverride, pinImages, returnToInbox]);
  return { actions, pipeline, sourceItems };
}
