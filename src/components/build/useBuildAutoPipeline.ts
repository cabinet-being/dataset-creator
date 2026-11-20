import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { BuildReviewDecision, BuildSession, Dataset, TargetModelId } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useProjectStore } from '../../stores/useProjectStore';
import { useOperation } from '../../hooks/useOperation';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { resolveDatasetMembership, normalizeDatasetPath } from '../../services/dataset/datasetMembershipResolver';
import { assembleDataset, encodeAssemblyInputs, type SkippedAssemblyItem } from '../../services/dataset/datasetAssemblyService';
import { createSemanticFeatureEncoder } from '../../services/analysis/semanticFeatureService';
import { predictLocalTags } from '../../services/tagging/localTaggerService';
import { hasVideoModel } from '../../services/video/videoCache';
import type { LocalTaggerBundle } from '../../services/tagging/localTaggerService';
import { getMinShortSide, measureImageQuality, type ImageQualityReport } from '../../services/quality/imageQuality';
import { getBuildImageDigest } from '../../services/build/buildTransformService';
import { getBuildAssetId, getBuildAssetRevision, getBuildContentRevision } from '../../services/build/buildSessionService';
import {
  applyAssemblyTriage, applyTriageProposal, classifyQualityTriage, createAssemblyKey, findExactDuplicates,
  getBuildTriageGroup, selectAssemblyCandidates, selectTriageTargets,
} from '../../services/build/buildTriageService';

export type BuildAutoPipelinePhase = 'idle' | 'triage' | 'assembly' | 'tagging';

type Input = {
  active: boolean;
  enabled: boolean;
  busy: boolean;
  candidates: WorkspaceImage[];
  effectiveItems: WorkspaceImage[];
  session: BuildSession;
  targetModel: TargetModelId;
  patchSession: (patch: (value: BuildSession) => BuildSession) => void;
  dataset: Dataset;
  commitDecision: (decision: BuildReviewDecision, targets?: WorkspaceImage[], provenance?: 'manual' | 'auto', propagateError?: boolean) => Promise<void>;
  localTagger: LocalTaggerBundle | null | undefined;
  taggingConfig: { threshold: number; maxTags: number };
  root: RefObject<HTMLElement>;
  viewId: string;
  notify: (type: 'info' | 'success' | 'error' | 'warning', message: string) => void;
  encoderFactory?: typeof createSemanticFeatureEncoder;
};

const CHUNK = 8;
const TRIAGE_APPLY_INTERVAL_MS = 1000;
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const abortError = () => new DOMException('Auto pipeline stopped', 'AbortError');
const digestCache = new WeakMap<Blob, string>();
const cachedDigest = async (blob: Blob) => {
  const known = digestCache.get(blob);
  if (known) return known;
  const digest = await getBuildImageDigest(blob);
  digestCache.set(blob, digest);
  return digest;
};
const isMeasurable = (item: WorkspaceImage) => item.kind !== 'video' && item.kind !== 'psd';

const ENCODER_IDLE_MS = 5 * 60 * 1000;
type SemanticEncoder = Awaited<ReturnType<typeof createSemanticFeatureEncoder>>;

/** Runs quality triage automatically; assembly and caption suggestions run only when requested. */
export function useBuildAutoPipeline(input: Input) {
  const [phase, setPhase] = useState<BuildAutoPipelinePhase>('idle');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [paused, setPaused] = useState(false);
  const [passCount, setPassCount] = useState(0);
  const [tick, setTick] = useState(0);
  const [needsModelDownload, setNeedsModelDownload] = useState(false);
  const phaseRef = useRef<BuildAutoPipelinePhase>('idle');
  const encoderRef = useRef<{ encoder: SemanticEncoder; factory: unknown; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef(input);
  const running = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const attempted = useRef(new Set<string>());
  const didWork = useRef(false);
  const triageOperation = useOperation('Build triage', input.root, input.viewId);
  const assemblyOperation = useOperation('Build auto-select', input.root, input.viewId);
  const taggingOperation = useOperation('Build caption suggestions', input.root, input.viewId);
  const projectId = useProjectStore((state) => state.id);

  useEffect(() => { latest.current = input; });

  const cancel = useCallback(() => { abortRef.current?.abort(); if (phaseRef.current === 'triage') setPaused(true); }, []);
  const releaseEncoder = useCallback(() => {
    const held = encoderRef.current; encoderRef.current = null;
    if (held?.timer) clearTimeout(held.timer);
    if (held) void held.encoder.dispose().catch(() => {});
  }, []);
  const resume = useCallback(() => setPaused(false), []);

  useEffect(() => () => { abortRef.current?.abort(); releaseEncoder(); attempted.current.clear(); didWork.current = false; setPaused(false); setNeedsModelDownload(false); }, [projectId, releaseEncoder]);
  useEffect(() => { setPaused(false); }, [input.enabled]);

  const minShortSideOf = (targetModel: TargetModelId) => getMinShortSide(targetModel);
  const triageKey = (session: BuildSession, item: WorkspaceImage, targetModel: TargetModelId) => {
    const record = session.records[getBuildAssetId(item)];
    return `triage:${getBuildAssetId(item)}:${getBuildContentRevision(item, record?.transform ?? session.profile.transform)}:${minShortSideOf(targetModel)}`;
  };

  useEffect(() => {
    if (!input.active || !input.enabled || input.busy || paused || running.current) return;
    const { session, candidates } = input;
    const triageTargets = selectTriageTargets(session, candidates).filter((item) => !attempted.current.has(triageKey(session, item, input.targetModel)));
    if (!triageTargets.length) {
      if (didWork.current) { didWork.current = false; setPassCount((value) => value + 1); }
      return;
    }
    launch('triage', runTriage, 'Automatic analysis failed.');
    didWork.current = true;
  }, [input.active, input.enabled, input.busy, input.session.order, input.session.records, input.session.profile, input.targetModel, input.candidates, paused, tick, projectId]);

  /** Starts one background job; only one runs at a time. Returns false when another job is running. */
  const launch = (stage: 'triage' | 'assembly' | 'tagging', run: (ctx: Ctx) => Promise<void>, failure: string) => {
    if (running.current) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    running.current = true;
    const startedProject = useProjectStore.getState().id;
    const isCurrent = () => !controller.signal.aborted && useProjectStore.getState().id === startedProject;
    const ctx = { signal: controller.signal, isCurrent, startedProject };
    phaseRef.current = stage;
    setPhase(stage); setProgress({ completed: 0, total: 0 });
    void run(ctx).catch((error) => {
      if (controller.signal.aborted || !isCurrent() || isAbort(error)) return;
      latest.current.notify('error', error instanceof Error ? error.message : failure);
    }).finally(() => {
      running.current = false; abortRef.current = null; phaseRef.current = 'idle';
      setPhase('idle'); setProgress({ completed: 0, total: 0 });
      setTick((value) => value + 1);
    });
    return true;
  };

  const needsTags = (item: WorkspaceImage, session: BuildSession) => {
    const record = session.records[getBuildAssetId(item)];
    return !!record && record.proposal?.revision !== (record.revision ?? getBuildAssetRevision(item));
  };
  /** Explicit scope wins; otherwise accepted images. */
  const taggingTargets = (session: BuildSession, candidates: WorkspaceImage[], scope?: WorkspaceImage[]) =>
    (scope ?? candidates.filter((item) => { const record = session.records[getBuildAssetId(item)]; return !!record && getBuildTriageGroup(record) === 'accepted'; }))
      .filter((item) => isMeasurable(item) && needsTags(item, session));

  const waitIdle = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (signal.aborted) { reject(abortError()); return; }
      if (!latest.current.busy) { resolve(); return; }
      setTimeout(check, 100);
    };
    check();
  });

  type Ctx = { signal: AbortSignal; isCurrent: () => boolean; startedProject: string; allowDownload?: boolean };
  const guarded = async (ctx: Ctx, operation: ReturnType<typeof useOperation>, run: () => Promise<void>) => {
    try { await run(); }
    catch (error) {
      if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) { operation.finish('cancelled', 'Stopped'); return; }
      operation.finish('failed', error instanceof Error ? error.message : 'Failed');
      throw error;
    }
  };

  const runTriage = (ctx: Ctx) => guarded(ctx, triageOperation, async () => {
    const { session: startSession, candidates, targetModel: startModel } = latest.current;
    const minShortSide = minShortSideOf(startModel);
    const targets = selectTriageTargets(startSession, candidates).filter((item) => !attempted.current.has(triageKey(startSession, item, startModel)));
    if (!targets.length) return;
    triageOperation.start(() => cancel(), targets.length);
    const targetIds = new Set(targets.map(getBuildAssetId));
    const digests = new Map<string, string>();
    let flushReceived = () => {};
    try {
      for (const item of candidates) {
        ctx.signal.throwIfAborted();
        const id = getBuildAssetId(item); const record = startSession.records[id];
        if (item.kind === 'video') continue;
        const stored = record?.triage?.digest;
        if (stored && !targetIds.has(id)) { digests.set(id, stored); continue; }
        if (targetIds.has(id) || isProjectDatasetPath(item.assetPath)) {
          try { digests.set(id, await cachedDigest(item.imageData)); } catch { /* unreadable source stays unmeasured */ }
        }
      }
      const entries = candidates.flatMap((item) => {
        const id = getBuildAssetId(item); const digest = digests.get(id);
        const inDataset = isProjectDatasetPath(item.assetPath);
        if (!digest || (startSession.records[id]?.decision === 'skipped' && !inDataset)) return [];
        return [{ assetId: id, digest, inDataset }];
      });
      const duplicates = findExactDuplicates(entries);
      // Results are applied in one session patch at most once per interval instead of once per chunk.
      const received: { item: WorkspaceImage; report: ImageQualityReport | undefined }[] = [];
      let lastApplied = Date.now();
      let completed = 0;
      const applyReceived = () => {
        lastApplied = Date.now();
        triageOperation.progress(completed, targets.length);
        setProgress({ completed, total: targets.length });
        if (!received.length) return;
        const batch = received.splice(0);
        const now = new Date().toISOString();
        latest.current.patchSession((value) => batch.reduce((next, { item, report }) => {
          const id = getBuildAssetId(item); const record = next.records[id];
          const revision = getBuildContentRevision(item, record?.transform ?? next.profile.transform);
          return applyTriageProposal(next, id, classifyQualityTriage({
            item, report, digest: digests.get(id), duplicateOf: duplicates.get(id),
            inDataset: isProjectDatasetPath(item.assetPath), revision, now,
          }));
        }, value));
        for (const { item } of batch) attempted.current.add(triageKey(startSession, item, startModel));
      };
      flushReceived = () => { if (ctx.isCurrent()) applyReceived(); };
      for (let start = 0; start < targets.length; start += CHUNK) {
        const chunk = targets.slice(start, start + CHUNK);
        const reports = await Promise.all(chunk.map(async (item): Promise<ImageQualityReport | undefined> => {
          if (!isMeasurable(item)) return undefined;
          try { return await measureImageQuality(item.imageData, { minShortSide }, ctx.signal); }
          catch { return undefined; }
        }));
        ctx.signal.throwIfAborted();
        await waitIdle(ctx.signal);
        if (!ctx.isCurrent() || minShortSideOf(latest.current.targetModel) !== minShortSide || !latest.current.enabled) throw abortError();
        chunk.forEach((item, index) => received.push({ item, report: reports[index] }));
        if (Date.now() - lastApplied >= TRIAGE_APPLY_INTERVAL_MS) applyReceived();
        completed = Math.min(targets.length, start + chunk.length);
        await yieldToUi();
      }
      applyReceived();
    } catch (error) {
      flushReceived();
      for (const item of targets) if (!ctx.signal.aborted && !isAbort(error)) attempted.current.add(triageKey(startSession, item, startModel));
      throw error;
    }
    triageOperation.finish('completed', `${targets.length} image${targets.length === 1 ? '' : 's'} analyzed`);
  });

  const runAssembly = (ctx: Ctx) => guarded(ctx, assemblyOperation, async () => {
    const { session: startSession, candidates, effectiveItems, dataset, encoderFactory = createSemanticFeatureEncoder } = latest.current;
    const pool = selectAssemblyCandidates(startSession, candidates);
    const target = startSession.profile.target;
    if (!pool.length) return;
    if (!encoderRef.current && !ctx.allowDownload && encoderFactory === createSemanticFeatureEncoder && !(await hasVideoModel().catch(() => false))) {
      if (ctx.isCurrent()) setNeedsModelDownload(true);
      return;
    }
    setNeedsModelDownload(false);
    const assemblyKey = createAssemblyKey(target, pool, startSession);
    assemblyOperation.start(() => cancel());
    const failWith = (message: string, severity: 'warning' | 'error') => {
      if (!ctx.isCurrent()) return;
      latest.current.patchSession((value) => ({ ...value, auto: { ...value.auto, assemblyKey, assemblyError: message } }));
      latest.current.notify(severity, `Auto-select failed: ${message}. Proposals stay for manual review.`);
    };
    let selectedIds: string[] = [];
    try {
      const baseline = resolveDatasetMembership(dataset, effectiveItems).effective;
      const all = [...baseline, ...pool];
      let lastTotal = all.length;
      const held = encoderRef.current;
      if (held?.timer) clearTimeout(held.timer);
      let encoder: SemanticEncoder;
      if (held && held.factory === encoderFactory) encoder = held.encoder;
      else {
        releaseEncoder();
        encoder = await encoderFactory(ctx.signal, (message) => assemblyOperation.progress(0, lastTotal, message), { allowDownload: ctx.allowDownload });
      }
      let reusable = false;
      try {
        const skipped: SkippedAssemblyItem[] = [];
        const features = await encodeAssemblyInputs(all, {
          triggerWord: dataset.triggerWord, encoder, signal: ctx.signal,
          onProgress: (completed, total) => { lastTotal = total; assemblyOperation.progress(completed, total, 'Understanding images and captions'); setProgress({ completed, total }); },
          onSkip: (entry) => skipped.push(entry),
        });
        if (skipped.length && ctx.isCurrent()) {
          const reasons = new Map<string, number>();
          for (const { reason } of skipped) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
          latest.current.notify('warning', `Auto-select skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}: ${[...reasons].map(([reason, count]) => `${reason} (${count})`).join('; ')}.`);
        }
        assemblyOperation.progress(all.length, all.length, 'Maximizing coverage');
        const baselineSet = new Set(baseline);
        const plan = await assembleDataset({
          projectId: ctx.startedProject, projectType: useProjectStore.getState().projectType, dataset,
          baseline: features.filter((entry) => baselineSet.has(entry.item)), candidates: features.filter((entry) => !baselineSet.has(entry.item)),
          mode: { kind: 'total', target }, signal: ctx.signal,
          onProgress: ({ completed, total }) => { setProgress({ completed, total }); assemblyOperation.progress(completed, total, 'Maximizing coverage'); },
        });
        ctx.signal.throwIfAborted();
        if (!ctx.isCurrent()) throw abortError();
        const assetIdByKey = new Map(all.map((item) => [normalizeDatasetPath(item.assetPath ?? item.id), getBuildAssetId(item)]));
        selectedIds = plan.selected.flatMap((step) => assetIdByKey.get(step.key) ?? []);
        const now = new Date().toISOString();
        latest.current.patchSession((value) => ({
          ...applyAssemblyTriage(value, plan, assetIdByKey, now),
          auto: { ...value.auto, assemblyKey, assembledAt: now, assemblyError: undefined },
        }));
        reusable = true;
      } finally {
        if (reusable && ctx.isCurrent()) {
          encoderRef.current = { encoder, factory: encoderFactory, timer: setTimeout(releaseEncoder, ENCODER_IDLE_MS) };
        } else { if (encoderRef.current?.encoder === encoder) encoderRef.current = null; await encoder.dispose(); }
      }
    } catch (error) {
      if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) throw error;
      assemblyOperation.finish('failed', error instanceof Error ? error.message : 'Failed');
      failWith(error instanceof Error ? error.message : 'unknown error', 'warning');
      return;
    }
    assemblyOperation.finish('completed', `${selectedIds.length} image${selectedIds.length === 1 ? '' : 's'} selected`);
    // This is the only place the pipeline changes Dataset membership.
    const wanted = new Set(selectedIds);
    const fresh = useProjectStore.getState().buildSession;
    const targets = latest.current.candidates.filter((item) => {
      const id = getBuildAssetId(item); const record = fresh.records[id];
      return wanted.has(id) && record?.decision === 'unreviewed' && record.triage?.group === 'accepted';
    });
    if (!targets.length) return;
    await waitIdle(ctx.signal);
    if (!ctx.isCurrent()) throw abortError();
    try {
      await latest.current.commitDecision('accepted', targets, 'auto', true);
      latest.current.notify('success', `Auto-select added ${targets.length} image${targets.length === 1 ? '' : 's'} to the Dataset.`);
    } catch (error) {
      if (!ctx.isCurrent()) return;
      latest.current.patchSession((value) => ({ ...value, auto: { ...value.auto, assemblyKey, assemblyError: error instanceof Error ? error.message : 'Could not apply the selection.' } }));
    }
  });

  const runTagging = (ctx: Ctx & { scope?: WorkspaceImage[] }) => guarded(ctx, taggingOperation, async () => {
    const { session: startSession, candidates, localTagger, taggingConfig } = latest.current;
    if (!localTagger) return;
    const targets = taggingTargets(startSession, candidates, ctx.scope);
    if (!targets.length) return;
    taggingOperation.start(() => cancel(), targets.length);
    for (const [index, item] of targets.entries()) {
      ctx.signal.throwIfAborted();
      const id = getBuildAssetId(item);
      const record = latest.current.session.records[id] ?? startSession.records[id];
      const revision = record?.revision ?? getBuildAssetRevision(item);
      try {
        const predictions = await predictLocalTags(localTagger, item.imageData, taggingConfig.threshold, taggingConfig.maxTags);
        ctx.signal.throwIfAborted();
        if (!ctx.isCurrent() || latest.current.localTagger !== localTagger) throw abortError();
        // Raw model tags: character traits are applied when suggestions are shown or merged.
        const tags = predictions.map((prediction) => prediction.tag);
        latest.current.patchSession((value) => {
          const target = value.records[id];
          if (!target || target.revision !== revision) return value;
          return { ...value, records: { ...value.records, [id]: { ...target, proposal: { tags, revision } } } };
        });
      } catch (error) {
        if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) throw error;
        latest.current.notify('warning', 'Caption suggestions stopped: the local model failed.');
        taggingOperation.finish('failed', 'The local model failed');
        return;
      }
      taggingOperation.progress(index + 1, targets.length);
      setProgress({ completed: index + 1, total: targets.length });
    }
    taggingOperation.finish('completed', `${targets.length} suggestion${targets.length === 1 ? '' : 's'} prepared`);
  });

  /** Explicit Auto-select; never started automatically. */
  const startAssembly = (options: { allowDownload?: boolean } = {}) => {
    if (!launch('assembly', (ctx) => runAssembly({ ...ctx, allowDownload: options.allowDownload }), 'Auto-select failed.')) latest.current.notify('info', 'Another background task is still running.');
  };
  /** Explicit caption suggestions for the scope (default: accepted images). */
  const startTagging = (scope?: WorkspaceImage[]) => {
    if (!latest.current.localTagger) { latest.current.notify('info', 'Connect a local tagger model first.'); return; }
    if (!launch('tagging', (ctx) => runTagging({ ...ctx, scope }), 'Caption suggestions failed.')) latest.current.notify('info', 'Another background task is still running.');
  };
  const countTaggingTargets = (scope?: WorkspaceImage[]) => taggingTargets(input.session, input.candidates, scope).length;

  return { phase, progress, cancel, resume, paused, passCount, startAssembly, startTagging, countTaggingTargets, needsModelDownload, dismissModelDownload: () => setNeedsModelDownload(false) };
}
