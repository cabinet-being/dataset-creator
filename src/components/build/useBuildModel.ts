import { useCallback, useEffect, useMemo } from 'react';
import type { BuildSession } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { mergeBuildItems, selectBuildCandidates } from '../../lib/buildStageSummary';
import { getBuildCounts, reconcileBuildSession } from '../../services/build/buildSessionService';
import { useProjectStore } from '../../stores/useProjectStore';

interface BuildModelOptions {
  /** While busy the session is not reconciled (an operation is rewriting it). */
  busy?: boolean;
  /** The reconciled session is written back to the project. Exactly one mounted owner should set this. */
  writeBack?: boolean;
}

/**
 * Merges the registered images with the workspace items, selects Build candidates and reconciles the
 * session with them. Owner of the reconcile write-back so views do not each persist it.
 */
export function useBuildModel(items: WorkspaceImage[], { busy = false, writeBack = false }: BuildModelOptions = {}) {
  const session = useProjectStore((state) => state.buildSession);
  const updateSession = useProjectStore((state) => state.updateBuildSession);
  // Depend on the registered images themselves, not on the session: typing a caption draft or deciding
  // an item changes the session but not these, and merging thousands of items per keystroke is what lagged.
  const registeredSources = useProjectStore((state) => state.sourceImages);
  const registeredDatasetItems = useProjectStore((state) => state.datasetItems);
  const effectiveItems = useMemo(
    () => mergeBuildItems(items, Object.values(registeredSources), Object.values(registeredDatasetItems)),
    [items, registeredSources, registeredDatasetItems]
  );
  const candidates = useMemo(() => selectBuildCandidates(effectiveItems, session), [effectiveItems, session.records]);
  const reconciled = useMemo(() => busy ? session : reconcileBuildSession(session, candidates, undefined, effectiveItems), [busy, candidates, effectiveItems, session]);
  useEffect(() => { if (writeBack && reconciled !== session) updateSession(reconciled); }, [writeBack, reconciled, session, updateSession]);
  const counts = useMemo(() => getBuildCounts(reconciled, effectiveItems), [effectiveItems, reconciled.order, reconciled.records, reconciled.profile]);
  const patchSession = useCallback((patch: (value: BuildSession) => BuildSession) => updateSession(patch), [updateSession]);
  return { session, effectiveItems, candidates, reconciled, counts, patchSession };
}
