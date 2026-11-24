import { useEffect, useMemo, useState } from 'react';
import type { SimilarityFeatures } from '../../services/similarity/useSimilarityFeatures';
import type { SimilarityStrictnessId } from '../../services/similarity/similarityLevels';
import {
  computeBuildClusters, createBuildClusterKey, createClusterCache, type BuildClusterResult,
} from '../../services/build/buildClusterService';

export type BuildClustersState = 'idle' | 'computing' | 'ready' | 'error';

const cache = createClusterCache(4);
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Clusters of Build candidates for the current similarity features. Results are cached by
 * `createBuildClusterKey`, so decisions and caption edits never recompute them.
 */
export function useBuildClusters(input: {
  active: boolean;
  /** Candidate image ids in session order. */
  ids: string[];
  features: Pick<SimilarityFeatures, 'basis' | 'embeddings' | 'sha256ById'>;
  strictness: SimilarityStrictnessId;
}) {
  const { active, ids, features, strictness } = input;
  const { basis, embeddings, sha256ById } = features;
  const readyIds = useMemo(() => ids.filter((id) => embeddings[id]), [embeddings, ids]);
  const key = useMemo(() => createBuildClusterKey({ ids: readyIds, sha256ById, basis, strictness }), [basis, readyIds, sha256ById, strictness]);
  const [computed, setComputed] = useState<BuildClusterResult | null>(() => cache.get(key) ?? null);
  const [state, setState] = useState<BuildClustersState>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    // An inactive hook (e.g. after Undo of Assemble) must not keep showing stale clusters.
    if (!active) { setComputed(null); setState('idle'); return; }
    const known = cache.get(key);
    if (known) { setComputed(known); setState('ready'); return; }
    if (!readyIds.length) { setComputed(null); setState('idle'); return; }
    const controller = new AbortController();
    setState('computing'); setError('');
    computeBuildClusters({ ids: readyIds, embeddings, sha256ById, basis, strictness }, { signal: controller.signal, yieldToUi })
      .then((result) => {
        if (controller.signal.aborted) return;
        cache.set(result.key, result);
        setComputed(result); setState('ready');
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbort(cause)) return;
        setError(cause instanceof Error ? cause.message : 'Clustering failed.'); setState('error');
      });
    return () => controller.abort();
  }, [active, basis, embeddings, key, readyIds, sha256ById, strictness]);

  const result = active && computed?.key === key ? computed : null;
  return { result, state: result ? 'ready' as const : state, progress: { total: readyIds.length }, error };
}
