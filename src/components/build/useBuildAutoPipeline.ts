import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { BuildAssemblySummary, BuildReviewDecision, BuildSession, CharacterTrait, Dataset, TargetModelId } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useProjectStore } from '../../stores/useProjectStore';
import { useOperation } from '../../hooks/useOperation';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { resolveDatasetMembership, normalizeDatasetPath } from '../../services/dataset/datasetMembershipResolver';
import type { DuplicatePair, RejectedCandidate, SkippedAssemblyItem } from '../../services/dataset/datasetAssemblyService';
import { computeNarrowing, computeShortlist, qualityScoreFromSummary, type NarrowResult, type ShortlistResult } from '../../services/dataset/shortlistService';
import { applyCharacterTraits } from '../../services/tagging/characterTraits';
import { createSemanticFeatureEncoder, isModelDownloadRequired } from '../../services/analysis/semanticFeatureService';
import { predictLocalTags } from '../../services/tagging/localTaggerService';
import { TAGGER_MEMORY_MESSAGE } from '../../services/tagging/taggerWorkerClient';
import type { LocalTaggerBundle } from '../../services/tagging/localTaggerService';
import { getMinShortSide, measureImageQuality, type ImageQualityReport } from '../../services/quality/imageQuality';
import { getBuildImageDigest } from '../../services/build/buildTransformService';
import { clearBuildShortlist, createBuildShortlist, getActiveShortlist, getBuildAssetId, getBuildAssetRevision, getBuildContentRevision, getBuildRecordForItem, setBuildShortlistNarrowed } from '../../services/build/buildSessionService';
import {
  applyAssemblyTriage, applyTriageProposal, classifyQualityTriage, createAssemblyKey, findExactDuplicates,
  getBuildTriageGroup, selectAssemblyBaseline, selectAssemblyCandidates, selectTriageTargets,
} from '../../services/build/buildTriageService';
import { captureHistoryEpoch, isHistoryEpochCurrent } from '../../stores/useHistoryStore';
import type { ApplyMembershipOptions, MembershipEntry } from './useApplyMembership';

export type BuildAutoPipelinePhase = 'idle' | 'triage' | 'assembly' | 'tagging';
/** Finer step of a running assembly, for progress text. */
export type BuildAssemblyStep = 'triage' | 'understanding' | 'similarity' | 'selecting' | 'applying';

type Input = {
  active: boolean;
  busy: boolean;
  candidates: WorkspaceImage[];
  /** Images in the folders selected for Auto-select; the only source of the "Find candidates" pool. */
  sources: WorkspaceImage[];
  effectiveItems: WorkspaceImage[];
  session: BuildSession;
  targetModel: TargetModelId;
  patchSession: (patch: (value: BuildSession) => BuildSession) => void;
  dataset: Dataset;
  commitDecision: (decision: BuildReviewDecision, targets?: WorkspaceImage[], provenance?: 'manual' | 'auto', propagateError?: boolean) => Promise<void>;
  /** One history transaction for the entries; returns false when nothing was applied. */
  applyDecisions: (entries: MembershipEntry[], options?: ApplyMembershipOptions) => Promise<boolean>;
  localTagger: LocalTaggerBundle | null | undefined;
  taggingConfig: { threshold: number; maxTags: number };
  root: RefObject<HTMLElement>;
  viewId: string;
  notify: (type: 'info' | 'success' | 'error' | 'warning', message: string) => void;
  encoderFactory?: typeof createSemanticFeatureEncoder;
  characterTraits: CharacterTrait[];
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

/** Runs quality triage automatically; finding candidates, describing them and picking run only when requested. */
export function useBuildAutoPipeline(input: Input) {
  const [phase, setPhase] = useState<BuildAutoPipelinePhase>('idle');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [paused, setPaused] = useState(false);
  const [step, setStep] = useState<BuildAssemblyStep | null>(null);
  const [tick, setTick] = useState(0);
  const [modelDownloadFor, setModelDownloadFor] = useState<'find' | 'pick' | null>(null);
  const [skipped, setSkipped] = useState<SkippedAssemblyItem[]>([]);
  const phaseRef = useRef<BuildAutoPipelinePhase>('idle');
  const encoderRef = useRef<{ encoder: SemanticEncoder; factory: unknown; allowDownload: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef(input);
  const running = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastRequest = useRef<{ kind: 'shortlist' } | { kind: 'assemble' } | { kind: 'narrow'; apply?: boolean }>({ kind: 'shortlist' });
  const attempted = useRef(new Set<string>());
  const assemblyTask = useRef<'find' | 'pick' | 'apply'>('find');
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

  useEffect(() => () => { abortRef.current?.abort(); releaseEncoder(); attempted.current.clear(); setPaused(false); setModelDownloadFor(null); setSkipped([]); }, [projectId, releaseEncoder]);

  const minShortSideOf = (targetModel: TargetModelId) => getMinShortSide(targetModel);
  const triageKey = (session: BuildSession, item: WorkspaceImage, targetModel: TargetModelId) => {
    const record = session.records[getBuildAssetId(item)];
    return `triage:${getBuildAssetId(item)}:${getBuildContentRevision(item, record?.transform ?? session.profile.transform)}:${minShortSideOf(targetModel)}`;
  };

  useEffect(() => {
    if (!input.active || input.busy || paused || running.current) return;
    const { session, candidates } = input;
    const triageTargets = selectTriageTargets(session, candidates).filter((item) => !attempted.current.has(triageKey(session, item, input.targetModel)));
    if (!triageTargets.length) return;
    launch('triage', runTriage, 'Automatic analysis failed.');
  }, [input.active, input.busy, input.session.order, input.session.records, input.session.profile, input.targetModel, input.candidates, paused, tick, projectId]);

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
      setPhase('idle'); setStep(null); setProgress({ completed: 0, total: 0 });
      setTick((value) => value + 1);
    });
    return true;
  };

  const needsTags = (item: WorkspaceImage, session: BuildSession) => {
    const record = getBuildRecordForItem(session, item);
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
    setStep('triage');
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
        if (!ctx.isCurrent() || minShortSideOf(latest.current.targetModel) !== minShortSide) throw abortError();
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

  /**
   * Runs `work` with the shared DINOv2 encoder (kept warm afterwards). The encoder loads the model only on the first cache miss and
   * never downloads it unless `allowDownload` was confirmed, so a fully cached run needs no model; a miss throws a download-required error.
   */
  const withEncoder = async (ctx: Ctx, operation: ReturnType<typeof useOperation>, work: (encoder: SemanticEncoder) => Promise<void>, total: number) => {
    const encoderFactory = latest.current.encoderFactory ?? createSemanticFeatureEncoder;
    setModelDownloadFor(null);
    const held = encoderRef.current;
    if (held?.timer) clearTimeout(held.timer);
    let encoder: SemanticEncoder;
    if (held && held.factory === encoderFactory && (held.allowDownload || !ctx.allowDownload)) encoder = held.encoder;
    else {
      releaseEncoder();
      encoder = await encoderFactory(ctx.signal, (message) => operation.progress(0, total, message), { allowDownload: !!ctx.allowDownload });
    }
    let reusable = false;
    try {
      await work(encoder);
      reusable = true;
    } finally {
      if (reusable && ctx.isCurrent()) encoderRef.current = { encoder, factory: encoderFactory, allowDownload: !!ctx.allowDownload || !!held?.allowDownload, timer: setTimeout(releaseEncoder, ENCODER_IDLE_MS) };
      else { if (encoderRef.current?.encoder === encoder) encoderRef.current = null; await encoder.dispose(); }
    }
  };
  /** Stops a run that needs the model and asks the user for the download; returns false for any other error. */
  const askForModelDownload = (ctx: Ctx, error: unknown, kind: 'find' | 'pick', operation: ReturnType<typeof useOperation>) => {
    if (!isModelDownloadRequired(error)) return false;
    operation.finish('cancelled', 'Needs the image model');
    if (ctx.isCurrent()) setModelDownloadFor(kind);
    return true;
  };
  /** Keeps unreadable files in state for the panel's list; a later run on the same files does not duplicate them. */
  const recordSkipped = (ctx: Ctx, entries: SkippedAssemblyItem[], replace: boolean) => {
    if (!ctx.isCurrent()) return;
    setSkipped((previous) => {
      const merged = new Map((replace ? [] : previous).map((entry) => [entry.item.id, entry]));
      for (const entry of entries) merged.set(entry.item.id, entry);
      return [...merged.values()];
    });
  };
  const qualityOf = (session: BuildSession) => (item: WorkspaceImage) => {
    const summary = session.records[getBuildAssetId(item)]?.triage?.quality;
    return summary ? qualityScoreFromSummary(summary) : undefined;
  };

  /** Pass 1 with the shared encoder; throws on failure (the callers decide how to report it). */
  const shortlistStep = async (ctx: Ctx, args: { baseline: WorkspaceImage[]; pool: WorkspaceImage[]; needed: number | 'auto'; session: BuildSession; unreadable: SkippedAssemblyItem[] }): Promise<ShortlistResult> => {
    const { dataset } = latest.current;
    let result: ShortlistResult | null = null;
    await withEncoder(ctx, assemblyOperation, async (encoder) => {
      result = await computeShortlist({
        baselineItems: args.baseline, poolItems: args.pool, needed: args.needed, triggerWord: dataset.triggerWord, encoder, signal: ctx.signal, qualityOf: qualityOf(args.session),
        onEncodeProgress: (completed, count) => { assemblyOperation.progress(completed, count, 'Understanding images'); setStep('understanding'); setProgress({ completed, total: count }); },
        onProgress: ({ phase, completed, total: count }) => { setStep(phase === 'selecting' ? 'selecting' : 'similarity'); setProgress({ completed, total: count }); assemblyOperation.progress(completed, count, phase === 'selecting' ? 'Choosing varied candidates' : 'Comparing images'); },
        onSkip: (entry) => args.unreadable.push(entry),
      });
      ctx.signal.throwIfAborted();
      if (!ctx.isCurrent()) throw abortError();
    }, args.baseline.length + args.pool.length);
    return result as unknown as ShortlistResult;
  };

  /** Pass 2 with the shared encoder; throws on failure. */
  const narrowStep = async (ctx: Ctx, args: { baseline: WorkspaceImage[]; items: WorkspaceImage[]; needed: number; session: BuildSession; unreadable: SkippedAssemblyItem[] }): Promise<NarrowResult> => {
    const { dataset, characterTraits } = latest.current;
    let result: NarrowResult | null = null;
    await withEncoder(ctx, assemblyOperation, async (encoder) => {
      result = await computeNarrowing({
        baselineItems: args.baseline, shortlistItems: args.items, target: args.needed, triggerWord: dataset.triggerWord, encoder, signal: ctx.signal,
        tagsOf: narrowTagsOf(args.session, characterTraits), ignoredTags: [dataset.triggerWord, ...characterTraits.map((trait) => trait.tag)],
        qualityOf: qualityOf(args.session),
        onEncodeProgress: (completed, count) => { assemblyOperation.progress(completed, count, 'Understanding images'); setStep('understanding'); setProgress({ completed, total: count }); },
        onProgress: ({ completed, total: count }) => { setStep('selecting'); setProgress({ completed, total: count }); assemblyOperation.progress(completed, count, 'Picking the most varied'); },
        onSkip: (entry) => args.unreadable.push(entry),
      });
      ctx.signal.throwIfAborted();
      if (!ctx.isCurrent()) throw abortError();
    }, args.baseline.length + args.items.length);
    return result as unknown as NarrowResult;
  };

  /** Pass 1: marks a visually diverse shortlist; never changes decisions or Dataset membership. */
  const runShortlist = (ctx: Ctx) => guarded(ctx, assemblyOperation, async () => {
    const { session: startSession, sources, effectiveItems, dataset } = latest.current;
    const pool = selectAssemblyCandidates(startSession, sources);
    if (!pool.length) { latest.current.notify('info', 'No analyzed images are available in the selected folders yet.'); return; }
    const baseline = resolveDatasetMembership(dataset, effectiveItems).effective;
    const auto = startSession.profile.sizeMode === 'auto';
    const needed = Math.max(0, startSession.profile.target - baseline.length);
    if (!auto && !needed) { latest.current.notify('info', 'The Dataset already reached its target size.'); return; }
    const assemblyKey = createAssemblyKey(auto ? 'auto' : startSession.profile.target, pool, startSession);
    assemblyOperation.start(() => cancel());
    let result: ShortlistResult | null = null;
    const unreadable: SkippedAssemblyItem[] = [];
    try {
      result = await shortlistStep(ctx, { baseline, pool, needed: auto ? 'auto' : needed, session: startSession, unreadable });
    } catch (error) {
      if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) throw error;
      if (askForModelDownload(ctx, error, 'find', assemblyOperation)) return;
      const message = error instanceof Error ? error.message : 'unknown error';
      assemblyOperation.finish('failed', message);
      latest.current.patchSession((value) => ({ ...value, auto: { ...value.auto, assemblyKey, assemblyError: message } }));
      latest.current.notify('warning', `Finding candidates failed: ${message}.`);
      return;
    }
    recordSkipped(ctx, unreadable, true);
    const done = result as ShortlistResult | null;
    if (!done) return;
    latest.current.patchSession((value) => {
      const next = createBuildShortlist(value, { needed: done.needed, requested: done.requested, duplicates: done.duplicates.length, items: done.items, mode: done.mode, poolCount: done.poolCount }, new Date().toISOString());
      return { ...next, filter: 'shortlisted', cursor: 0, auto: { ...next.auto, assemblyKey } };
    });
    assemblyOperation.finish('completed', `${done.items.length} candidate${done.items.length === 1 ? '' : 's'} found`);
  });

  /** Tags used by pass 2: the resolved caption, else the model suggestion with character traits applied. */
  const narrowTagsOf = (session: BuildSession, traits: CharacterTrait[]) => (item: WorkspaceImage): string[] => {
    if (item.tags !== undefined && item.tags.length) return item.tags;
    const record = session.records[getBuildAssetId(item)];
    return record?.proposal && record.proposal.revision === record.revision ? applyCharacterTraits(record.proposal.tags, traits) : [];
  };

  /** Pass 2: narrows the shortlist to the target; with `apply` the result is moved into the Dataset in one batch. */
  const runNarrow = (ctx: Ctx & { apply?: boolean }) => guarded(ctx, assemblyOperation, async () => {
    const { session: startSession, candidates, effectiveItems, dataset } = latest.current;
    const active = getActiveShortlist(startSession, candidates);
    if (!active?.entries.length) { latest.current.notify('info', 'There are no candidates to pick from.'); return; }
    const baseline = resolveDatasetMembership(dataset, effectiveItems).effective;
    const auto = startSession.profile.sizeMode === 'auto';
    const needed = auto ? active.entries.length : Math.max(0, startSession.profile.target - baseline.length);
    if (!needed) { latest.current.notify('info', 'The Dataset already reached its target size.'); return; }
    assemblyOperation.start(() => cancel());
    let result: NarrowResult | null = null;
    const unreadable: SkippedAssemblyItem[] = [];
    try {
      result = await narrowStep(ctx, { baseline, items: active.entries.map(({ item }) => item), needed, session: startSession, unreadable });
    } catch (error) {
      if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) throw error;
      if (askForModelDownload(ctx, error, 'pick', assemblyOperation)) return;
      const message = error instanceof Error ? error.message : 'unknown error';
      assemblyOperation.finish('failed', message);
      latest.current.notify('warning', `Picking failed: ${message}.`);
      return;
    }
    recordSkipped(ctx, unreadable, false);
    const done = result as NarrowResult | null;
    if (!done) return;
    const itemByKey = new Map(active.entries.map(({ item }) => [normalizeDatasetPath(item.assetPath ?? item.id), item]));
    const narrowedItems = done.items.flatMap((entry) => itemByKey.get(entry.key) ?? []);
    latest.current.patchSession((value) => setBuildShortlistNarrowed(value, narrowedItems.map(getBuildAssetId), needed));
    assemblyOperation.finish('completed', `${narrowedItems.length} image${narrowedItems.length === 1 ? '' : 's'} picked`);
    if (!ctx.apply) return;
    await applyNarrowedItems(ctx, narrowedItems);
  });

  /**
   * Assemble: triage (if needed) -> shortlist -> [Target: describe + narrow] -> one apply. The Dataset plus pinned images are the baseline;
   * the outcome of every pool image is written to its record and everything that changes membership is one history transaction.
   * Auto size needs no narrowing: pass 1 already keeps one image per group of similar ones, so pass 2 would only re-pick the same set.
   */
  const runAssemble = (ctx: Ctx) => guarded(ctx, assemblyOperation, async () => {
    const epoch = captureHistoryEpoch();
    {
      const { session, candidates, targetModel } = latest.current;
      if (selectTriageTargets(session, candidates).some((item) => !attempted.current.has(triageKey(session, item, targetModel)))) await runTriage(ctx);
      ctx.signal.throwIfAborted();
    }
    const { sources, candidates, effectiveItems, dataset, localTagger } = latest.current;
    const session = useProjectStore.getState().buildSession;
    const auto = session.profile.sizeMode === 'auto';
    const pool = selectAssemblyCandidates(session, sources);
    const members = resolveDatasetMembership(dataset, effectiveItems).effective;
    const baseline = selectAssemblyBaseline(session, members, candidates);
    const memberSet = new Set(members);
    const pinsOutside = baseline.filter((item) => !memberSet.has(item));
    const needed = auto ? pool.length : Math.max(0, session.profile.target - baseline.length);
    if (!pool.length && !pinsOutside.length) { latest.current.notify('info', 'No analyzed images are available in the selected folders yet.'); return; }
    if (!auto && !needed && !pinsOutside.length) { latest.current.notify('info', 'The Dataset already reached its target size.'); return; }
    const assemblyKey = createAssemblyKey(auto ? 'auto' : session.profile.target, pool, session, baseline);
    assemblyOperation.start(() => cancel());
    const unreadable: SkippedAssemblyItem[] = [];
    let shortlist: ShortlistResult | null = null;
    let picked: WorkspaceImage[] = [];
    let narrowDuplicates: ShortlistResult['duplicates'] = [];
    try {
      if (pool.length && needed > 0) {
        shortlist = await shortlistStep(ctx, { baseline, pool, needed: auto ? 'auto' : needed, session, unreadable });
        picked = shortlist.items.map(({ item }) => item);
        if (!auto && picked.length > needed) {
          if (localTagger) {
            assemblyOperation.progress(0, picked.length, 'Describing images');
            try { await runTagging({ ...ctx, scope: picked }); } catch (error) { if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) throw error; }
            ctx.signal.throwIfAborted();
          }
          const narrowed = await narrowStep(ctx, { baseline, items: picked, needed, session: useProjectStore.getState().buildSession, unreadable });
          const byKey = new Map(shortlist.items.map((entry) => [entry.key, entry.item]));
          picked = narrowed.items.flatMap((entry) => byKey.get(entry.key) ?? []);
          narrowDuplicates = narrowed.duplicates;
        }
      }
    } catch (error) {
      if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) throw error;
      if (askForModelDownload(ctx, error, 'find', assemblyOperation)) return;
      const message = error instanceof Error ? error.message : 'unknown error';
      assemblyOperation.finish('failed', message);
      latest.current.patchSession((value) => ({ ...value, auto: { ...value.auto, assemblyKey, assemblyError: message } }));
      latest.current.notify('warning', `Assemble failed: ${message}.`);
      return;
    }
    recordSkipped(ctx, unreadable, true);

    // The project may have changed while the model ran: re-check bans, rejections and the epoch right before applying.
    await waitIdle(ctx.signal);
    if (!ctx.isCurrent() || !isHistoryEpochCurrent(epoch)) throw abortError();
    const fresh = useProjectStore.getState().buildSession;
    const allowed = (item: WorkspaceImage) => { const record = fresh.records[getBuildAssetId(item)]; return !!record && record.override !== 'ban' && record.decision !== 'skipped'; };
    const keyOf = (item: WorkspaceImage) => normalizeDatasetPath(item.assetPath ?? item.id);
    const unreadableIds = new Set(unreadable.map((entry) => entry.item.id));
    const evaluated = pool.filter((item) => !unreadableIds.has(item.id) && allowed(item));
    const chosen = picked.filter((item) => allowed(item) && !isProjectDatasetPath(item.assetPath));
    const chosenKeys = new Set(chosen.map(keyOf));
    const duplicates = new Map<string, DuplicatePair>();
    for (const entry of [...(shortlist?.duplicates ?? []), ...narrowDuplicates]) {
      if (chosenKeys.has(entry.key) || duplicates.has(entry.key)) continue;
      duplicates.set(entry.key, { kept: entry.keptKey, rejected: entry.key, kind: entry.kind, similarity: entry.similarity });
    }
    const reasonByKey = new Map((shortlist?.items ?? []).map((entry) => [entry.key, entry.reason]));
    const rejectedCandidates: RejectedCandidate[] = evaluated.filter((item) => !chosenKeys.has(keyOf(item)) && !duplicates.has(keyOf(item)))
      .map((item) => ({ path: keyOf(item), reason: 'not-selected' as const }));
    const plan = {
      selected: chosen.map((item) => ({ key: keyOf(item), reason: reasonByKey.get(keyOf(item)) ?? 'Selected' })),
      duplicatePairs: [...duplicates.values()], rejectedCandidates,
      stoppedBecause: auto || chosen.length >= needed ? 'target-reached' as const : 'exhausted' as const,
    };
    const assetIdByKey = new Map([...baseline, ...evaluated].map((item) => [keyOf(item), getBuildAssetId(item)]));
    const now = new Date().toISOString();
    // Only numbers the pipeline itself has: the compared pool, the quality rejections among the sources, what it added and left out.
    const outOnQuality = sources.filter((item) => { const record = fresh.records[getBuildAssetId(item)]; return item.kind !== 'video' && record?.override !== 'pin' && record?.triage?.stage === 'quality' && record.triage.group === 'rejected'; }).length;
    const summary: BuildAssemblySummary = {
      images: pool.length + outOnQuality, ...(auto ? { groups: picked.length } : {}), added: chosen.length, outOnQuality, duplicates: duplicates.size,
    };
    const prepare = (value: BuildSession): BuildSession => {
      const next = clearBuildShortlist(applyAssemblyTriage(value, plan, assetIdByKey, now));
      return {
        ...next, cursor: 0, filter: next.filter === 'shortlisted' || next.filter === 'picked' ? 'all' : next.filter,
        auto: { ...next.auto, assemblyKey, assembledAt: now, assemblyError: undefined, assemblySummary: summary },
      };
    };
    const entries: MembershipEntry[] = [
      ...chosen.map((item) => ({ item, decision: 'accepted' as const, provenance: 'auto' as const })),
      ...pinsOutside.filter((item) => fresh.records[getBuildAssetId(item)]?.override === 'pin' && allowed(item))
        .map((item) => ({ item, decision: 'accepted' as const, provenance: 'manual' as const })),
    ];
    setStep('applying');
    try {
      if (entries.length) {
        const applied = await latest.current.applyDecisions(entries, { propagateError: true, prepare, label: `Assemble: add ${entries.length} image${entries.length === 1 ? '' : 's'}` });
        if (!applied) throw new Error('Could not apply the selection.');
      } else latest.current.patchSession(prepare);
    } catch (error) {
      if (!ctx.isCurrent()) return;
      const message = error instanceof Error ? error.message : 'Could not apply the selection.';
      assemblyOperation.finish('failed', message);
      latest.current.patchSession((value) => ({ ...value, auto: { ...value.auto, assemblyKey, assemblyError: message } }));
      return;
    }
    assemblyOperation.finish('completed', `${entries.length} image${entries.length === 1 ? '' : 's'} added`);
    latest.current.notify(entries.length ? 'success' : 'info', entries.length ? `Added ${entries.length} image${entries.length === 1 ? '' : 's'} to the Dataset.` : 'Nothing new to add to the Dataset.');
  });

  /** The only place the pipeline changes Dataset membership: one batch, one Undo. */
  const applyNarrowedItems = async (ctx: Ctx, targets: WorkspaceImage[]) => {
    if (!targets.length) return;
    await waitIdle(ctx.signal);
    if (!ctx.isCurrent()) throw abortError();
    try {
      await latest.current.commitDecision('accepted', targets, 'auto', true);
      latest.current.patchSession((value) => ({ ...clearBuildShortlist(value), filter: value.filter === 'shortlisted' || value.filter === 'picked' ? 'all' : value.filter, cursor: 0 }));
      latest.current.notify('success', `Added ${targets.length} image${targets.length === 1 ? '' : 's'} to the Dataset.`);
      setSkipped([]);
    } catch (error) {
      if (!ctx.isCurrent()) return;
      latest.current.patchSession((value) => ({ ...value, auto: { ...value.auto, assemblyError: error instanceof Error ? error.message : 'Could not apply the selection.' } }));
    }
  };

  const runTagging = (ctx: Ctx & { scope?: WorkspaceImage[] }) => guarded(ctx, taggingOperation, async () => {
    const { session: startSession, candidates, localTagger, taggingConfig } = latest.current;
    if (!localTagger) return;
    const targets = taggingTargets(startSession, candidates, ctx.scope);
    if (!targets.length) return;
    taggingOperation.start(() => cancel(), targets.length);
    // The image encoder shares the page's memory budget with the tagger model.
    releaseEncoder();
    // Proposals are applied in one session patch at most once per interval; revision checks happen inside the patch.
    const proposals: { id: string; revision: string; tags: string[] }[] = [];
    let lastApplied = Date.now();
    const flushProposals = () => {
      lastApplied = Date.now();
      if (!proposals.length || !ctx.isCurrent()) { proposals.length = 0; return; }
      const batch = proposals.splice(0);
      latest.current.patchSession((value) => {
        let records = value.records;
        for (const { id, revision, tags } of batch) {
          const target = records[id];
          if (!target || target.revision !== revision) continue;
          records = { ...records, [id]: { ...target, proposal: { tags, revision } } };
        }
        return records === value.records ? value : { ...value, records };
      });
    };
    try {
      for (const [index, item] of targets.entries()) {
        ctx.signal.throwIfAborted();
        const record = getBuildRecordForItem(latest.current.session, item) ?? getBuildRecordForItem(startSession, item);
        const id = record?.assetId ?? getBuildAssetId(item);
        const revision = record?.revision ?? getBuildAssetRevision(item);
        try {
          const predictions = await predictLocalTags(localTagger, item.imageData, taggingConfig.threshold, taggingConfig.maxTags);
          ctx.signal.throwIfAborted();
          if (!ctx.isCurrent() || latest.current.localTagger !== localTagger) throw abortError();
          // Raw model tags: character traits are applied when suggestions are shown or merged.
          proposals.push({ id, revision, tags: predictions.map((prediction) => prediction.tag) });
          if (Date.now() - lastApplied >= TRIAGE_APPLY_INTERVAL_MS) flushProposals();
        } catch (error) {
          if (ctx.signal.aborted || !ctx.isCurrent() || isAbort(error)) throw error;
          flushProposals();
          const memory = error instanceof Error && error.message === TAGGER_MEMORY_MESSAGE;
          latest.current.notify(memory ? 'error' : 'warning', memory ? TAGGER_MEMORY_MESSAGE : 'Describing stopped: the local model failed.');
          taggingOperation.finish('failed', memory ? 'Not enough memory' : 'The local model failed');
          return;
        }
        taggingOperation.progress(index + 1, targets.length);
        setProgress({ completed: index + 1, total: targets.length });
      }
    } finally {
      flushProposals();
    }
    taggingOperation.finish('completed', `${targets.length} image${targets.length === 1 ? '' : 's'} described`);
  });

  /** Explicit "Find candidates"; never started automatically and never moves files. */
  const startShortlist = (options: { allowDownload?: boolean } = {}) => {
    lastRequest.current = { kind: 'shortlist' };
    assemblyTask.current = 'find';
    if (!launch('assembly', (ctx) => runShortlist({ ...ctx, allowDownload: options.allowDownload }), 'Finding candidates failed.')) latest.current.notify('info', 'Another background task is still running.');
  };
  /** Explicit Assemble: finds, picks and adds in one pass (one Undo). */
  const startAssemble = (options: { allowDownload?: boolean } = {}) => {
    lastRequest.current = { kind: 'assemble' };
    assemblyTask.current = 'find';
    if (!launch('assembly', (ctx) => runAssemble({ ...ctx, allowDownload: options.allowDownload }), 'Assemble failed.')) latest.current.notify('info', 'Another background task is still running.');
  };
  /** Explicit "Pick": chooses the most varied candidates; `apply` also adds the result to the Dataset. */
  const startNarrow = (options: { allowDownload?: boolean; apply?: boolean } = {}) => {
    lastRequest.current = { kind: 'narrow', apply: options.apply };
    assemblyTask.current = 'pick';
    if (!launch('assembly', (ctx) => runNarrow({ ...ctx, allowDownload: options.allowDownload, apply: options.apply }), 'Picking failed.')) latest.current.notify('info', 'Another background task is still running.');
  };
  /** Adds the picks to the Dataset (one batch, one Undo). */
  const startApplyNarrowed = (targets: WorkspaceImage[]) => {
    assemblyTask.current = 'apply';
    if (!launch('assembly', (ctx) => guarded(ctx, assemblyOperation, () => applyNarrowedItems(ctx, targets)), 'Could not add the picks.')) latest.current.notify('info', 'Another background task is still running.');
  };
  /** Repeats the request that stopped at the model-download prompt, now allowed to download. */
  const confirmModelDownload = () => {
    const request = lastRequest.current;
    if (request.kind === 'narrow') startNarrow({ allowDownload: true, apply: request.apply }); else if (request.kind === 'assemble') startAssemble({ allowDownload: true }); else startShortlist({ allowDownload: true });
  };
  /** Describes the scope (default: accepted images) with the local caption model. */
  const startTagging = (scope?: WorkspaceImage[]) => {
    if (!latest.current.localTagger) { latest.current.notify('info', 'Connect a local tagger model first.'); return; }
    if (!launch('tagging', (ctx) => runTagging({ ...ctx, scope }), 'Describing failed.')) latest.current.notify('info', 'Another background task is still running.');
  };
  const countTaggingTargets = (scope?: WorkspaceImage[]) => taggingTargets(input.session, input.candidates, scope).length;
  /** Which Auto-select task is running, if any (triage is not part of the panel's steps). */
  const task: 'find' | 'describe' | 'pick' | 'apply' | null = phase === 'assembly' ? assemblyTask.current : phase === 'tagging' ? 'describe' : null;
  /** Forgets the unreadable-files list (Start over). */
  const clearSkipped = () => setSkipped([]);

  return {
    phase, step, task, progress, cancel, resume, paused, skipped, clearSkipped, startShortlist, startNarrow, startAssemble, confirmModelDownload, startApplyNarrowed, startTagging, countTaggingTargets,
    modelDownloadFor, dismissModelDownload: () => setModelDownloadFor(null),
  };
}
