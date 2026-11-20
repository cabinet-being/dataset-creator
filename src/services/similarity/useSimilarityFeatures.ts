import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { createSemanticFeatureEncoder, hexDigest, isSemanticModelError, SEMANTIC_FEATURE_MODEL } from '../analysis/semanticFeatureService';
import { readImageFeature } from '../analysis/semanticFeatureCache';
import { generateEmbedding } from '../image/embeddingService';
import { hasVideoModel } from '../video/videoCache';
import type { SimilarityBasis } from './similarityLevels';

export type SimilarityModelState = 'checking' | 'missing' | 'loading' | 'ready' | 'error';

export type SimilarityFeatures = {
  /** Feature space of `embeddings`. Never mixes DINOv2 and histogram vectors. */
  basis: SimilarityBasis;
  embeddings: Record<string, Float32Array>;
  sha256ById: Record<string, string>;
  modelState: SimilarityModelState;
  progress: { completed: number; total: number };
  error: string;
  /** Downloads DINOv2 (≈88 MB, cached in the browser) and switches to it. */
  loadModel: () => void;
};

type BlobEntry<Value> = { blob: Blob; value: Value };

const shaByBlob = new WeakMap<Blob, string>();
const histogramByBlob = new WeakMap<Blob, Float32Array>();
let modelPresence: Promise<boolean> | undefined;

const imageSha256 = async (blob: Blob): Promise<string> => {
  const cached = shaByBlob.get(blob);
  if (cached) {
    return cached;
  }
  const digest = await hexDigest(blob);
  shaByBlob.set(blob, digest);
  return digest;
};


const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Visual features for similarity. Uses DINOv2 (`semanticFeatureService`) when the model is in the
 * browser cache; until then the grayscale histogram is returned and `basis` says so.
 */
export const useSimilarityFeatures = (
  items: WorkspaceImage[],
  options: { active?: boolean; histogramFor?: (item: WorkspaceImage) => Float32Array | undefined } = {}
): SimilarityFeatures => {
  const active = options.active ?? true;
  const histogramFor = options.histogramFor;
  const [modelState, setModelState] = useState<SimilarityModelState>('checking');
  const [loadRequested, setLoadRequested] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [sha256ById, setSha256ById] = useState<Record<string, string>>({});
  const [histograms, setHistograms] = useState<Record<string, BlobEntry<Float32Array>>>({});
  const [dinoFeatures, setDinoFeatures] = useState<Record<string, BlobEntry<Float32Array>>>({});
  const dinoRef = useRef(dinoFeatures);
  dinoRef.current = dinoFeatures;

  useEffect(() => {
    let canceled = false;
    modelPresence ??= hasVideoModel().catch(() => false);
    void modelPresence.then((present) => {
      if (!canceled) {
        setModelState((current) => (current === 'checking' ? (present ? 'ready' : 'missing') : current));
      }
    });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    let canceled = false;
    const sync = async () => {
      const nextSha: Record<string, string> = {};
      const nextHistograms: Record<string, BlobEntry<Float32Array>> = {};
      for (const item of items) {
        try {
          nextSha[item.id] = await imageSha256(item.imageData);
          const provided = histogramFor?.(item);
          let histogram = provided ?? histogramByBlob.get(item.imageData);
          if (!histogram) {
            histogram = await generateEmbedding(item.imageData);
            histogramByBlob.set(item.imageData, histogram);
          }
          nextHistograms[item.id] = { blob: item.imageData, value: histogram };
        } catch {
          // Unreadable images are left out of similarity.
        }
        if (canceled) {
          return;
        }
      }
      setSha256ById(nextSha);
      setHistograms(nextHistograms);
    };
    void sync();
    return () => {
      canceled = true;
    };
  }, [active, histogramFor, items]);

  const modelUsable = modelState === 'ready' || modelState === 'loading' || (modelState === 'missing' && loadRequested);

  useEffect(() => {
    if (!active || !modelUsable) {
      return;
    }
    const controller = new AbortController();
    const run = async () => {
      const next: Record<string, BlobEntry<Float32Array>> = {};
      const missing: WorkspaceImage[] = [];
      for (const item of items) {
        const known = dinoRef.current[item.id];
        if (known && known.blob === item.imageData) {
          next[item.id] = known;
          continue;
        }
        try {
          const cached = await readImageFeature(`${await imageSha256(item.imageData)}:${SEMANTIC_FEATURE_MODEL.visual}`);
          if (cached) {
            next[item.id] = { blob: item.imageData, value: cached };
          } else {
            missing.push(item);
          }
        } catch {
          // Unreadable images are left out of similarity.
        }
      }
      controller.signal.throwIfAborted();
      if (missing.length) {
        setModelState('loading');
        setError('');
        setProgress({ completed: 0, total: missing.length });
        const encoder = await createSemanticFeatureEncoder(controller.signal);
        try {
          for (let index = 0; index < missing.length; index += 1) {
            const item = missing[index];
            try {
              const { image } = await encoder.encodeImage(item);
              next[item.id] = { blob: item.imageData, value: image };
            } catch (encodeError) {
              if (isAbort(encodeError) || isSemanticModelError(encodeError)) {
                throw encodeError;
              }
            }
            setProgress({ completed: index + 1, total: missing.length });
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          }
        } finally {
          await encoder.dispose();
        }
      }
      controller.signal.throwIfAborted();
      modelPresence = Promise.resolve(true);
      setModelState('ready');
      setDinoFeatures(next);
    };
    run().catch((runError: unknown) => {
      if (isAbort(runError) || controller.signal.aborted) {
        return;
      }
      setModelState('error');
      setError(runError instanceof Error ? runError.message : 'DINOv2 is unavailable.');
    });
    return () => controller.abort();
  }, [active, items, modelUsable]);

  const loadModel = useCallback(() => {
    setLoadRequested(true);
    setModelState((current) => (current === 'error' ? 'missing' : current));
  }, []);

  return useMemo(() => {
    const readable = items.filter((item) => histograms[item.id]?.blob === item.imageData);
    const dinoComplete =
      readable.length > 0 && readable.every((item) => dinoFeatures[item.id]?.blob === item.imageData);
    const source = dinoComplete ? dinoFeatures : histograms;
    const embeddings: Record<string, Float32Array> = {};
    for (const item of readable) {
      embeddings[item.id] = source[item.id].value;
    }
    return {
      basis: dinoComplete ? 'dinov2' : 'histogram',
      embeddings,
      sha256ById,
      modelState,
      progress,
      error,
      loadModel,
    };
  }, [dinoFeatures, error, histograms, items, loadModel, modelState, progress, sha256ById]);
};
