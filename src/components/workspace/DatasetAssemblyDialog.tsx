import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Pin, Sparkles, X } from 'lucide-react';
import type { Dataset, ProjectType } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { resolveAssetCaption } from '../../services/caption/captionResolver';
import { createSemanticFeatureEncoder } from '../../services/analysis/semanticFeatureService';
import { assembleDataset, createAssemblyFingerprint, encodeAssemblyInputs, type AssemblyInputAsset, type AssemblyMode, type DatasetAssemblyPlan } from '../../services/dataset/datasetAssemblyService';
import { resolveDatasetMembership } from '../../services/dataset/datasetMembershipResolver';
import { scanSharedCandidates } from '../../services/dataset/sharedCandidateService';
import { useUIStore } from '../../stores/useUIStore';
import { PROJECT_LAYOUT } from '../../services/project/projectLayoutService';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataset: Dataset;
  items: WorkspaceImage[];
  directory?: ProjectDirectoryHandle;
  projectId: string;
  projectType: ProjectType;
  excludedCategories: string[];
  includedCategories: string[];
  onApply: (paths: string[]) => Promise<void>;
  defaultMode?: AssemblyMode['kind'];
  defaultTotal?: number;
};
type Result = { plan: DatasetAssemblyPlan; candidates: AssemblyInputAsset[]; fingerprintAssets: AssemblyInputAsset[]; skipped: number };
const percent = (value: number | null) => value === null ? 'Insufficient data' : `${Math.round(value * 100)}%`;

export function DatasetAssemblyDialog({ open, onOpenChange, dataset, items, directory, projectId, projectType, excludedCategories, includedCategories, onApply, defaultMode, defaultTotal }: Props) {
  const [mode, setMode] = useState<AssemblyMode['kind']>(defaultMode ?? 'auto');
  const [totalTarget, setTotalTarget] = useState(defaultTotal ?? 100);
  const [rangeMin, setRangeMin] = useState(80);
  const [rangeMax, setRangeMax] = useState(120);
  const [maxNew, setMaxNew] = useState(20);
  const [target, setTarget] = useState('');
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const membership = useMemo(() => resolveDatasetMembership(dataset, items), [dataset, items]);
  const proposedItems = useMemo(() => {
    if (!result) return [];
    const selected = new Set(result.plan.selected.map((step) => step.key));
    return result.candidates.filter((candidate) => selected.has((candidate.item.assetPath ?? candidate.item.id).replace(/^Project\//, ''))).map((candidate) => candidate.item);
  }, [result]);
  const previewUrls = useWorkspacePreviewUrls(proposedItems);
  const proposedByPath = useMemo(() => new Map(proposedItems.map((item) => [(item.assetPath ?? item.id).replace(/^Project\//, ''), item])), [proposedItems]);
  const existingCount = membership.effective.length;
  const running = Boolean(abortRef.current);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { if (!open) abortRef.current?.abort(); }, [open]);
  useEffect(() => { setResult(null); }, [assetPreviewRefreshKey, mode, totalTarget, rangeMin, rangeMax, maxNew, target]);

  const assemblyMode: AssemblyMode = mode === 'total'
    ? { kind:'total', target:Math.max(0,totalTarget) }
    : mode === 'range'
      ? { kind:'range', min:Math.max(0,Math.min(rangeMin,rangeMax)), max:Math.max(rangeMin,rangeMax) }
      : mode === 'max-new'
        ? { kind:'max-new', maxNew:Math.max(0,maxNew) }
        : { kind:'auto' };

  const run = async (constraints = { excluded, pinned }) => {
    if (!directory) { setError(`Reconnect the project folder to read ${PROJECT_LAYOUT.rawDir}.`); return; }
    abortRef.current?.abort();
    const controller = new AbortController(); abortRef.current = controller;
    setError(''); setResult(null); setPhase(`Scanning ${PROJECT_LAYOUT.rawDir}`); setProgress({ completed: 0, total: 0 });
    try {
      const scan = await scanSharedCandidates(directory, { excludedCategories, includedCategories, signal: controller.signal, onProgress: (completed, total) => setProgress({ completed, total }) });
      if (!scan.sharedAvailable) throw new Error(`Project/${PROJECT_LAYOUT.rawDir} was not found. Create the folder or restore access.`);
      const memberPaths = new Set(membership.members.flatMap((item) => item.assetPath ? [item.assetPath.replace(/^Project\//, '')] : []));
      const candidates = scan.candidates.filter((item) => !memberPaths.has((item.assetPath ?? '').replace(/^Project\//, '')));
      if (!candidates.length) throw new Error(`No eligible new images were found in ${PROJECT_LAYOUT.rawDir}.`);
      setPhase('Loading semantic model');
      const encoder = await createSemanticFeatureEncoder(controller.signal, setPhase);
      try {
        const all = [...membership.effective, ...candidates];
        setPhase('Understanding images and captions');
        const features = await encodeAssemblyInputs(all, {
          triggerWord: dataset.triggerWord, encoder, signal: controller.signal,
          onProgress: (completed, total) => { setPhase('Understanding images and captions'); setProgress({ completed, total }); },
        });
        const baseline = features.slice(0, membership.effective.length);
        const encodedCandidates = features.slice(membership.effective.length);
        setPhase('Maximizing coverage'); setProgress({ completed: all.length, total: all.length });
        const plan = await assembleDataset({
          projectId, projectType, dataset, baseline, candidates: encodedCandidates,
          mode: assemblyMode, target,
          excludedKeys: constraints.excluded, pinnedKeys: constraints.pinned,
        });
        setResult({ plan, candidates: encodedCandidates, fingerprintAssets: features, skipped: scan.skipped.length });
      } finally { await encoder.dispose(); }
    } catch (nextError) {
      if (!(nextError instanceof DOMException && nextError.name === 'AbortError')) setError(nextError instanceof Error ? nextError.message : 'Automatic assembly failed.');
    } finally { abortRef.current = null; setPhase(''); }
  };
  const updateConstraint = (key: string, kind: 'exclude' | 'pin') => {
    const nextExcluded = new Set(excluded); const nextPinned = new Set(pinned);
    if (kind === 'exclude') { nextExcluded.add(key); nextPinned.delete(key); }
    else if (nextPinned.has(key)) nextPinned.delete(key); else { nextPinned.add(key); nextExcluded.delete(key); }
    setExcluded(nextExcluded); setPinned(nextPinned); void run({ excluded: nextExcluded, pinned: nextPinned });
  };
  const apply = async () => {
    if (!result || applying) return;
    setApplying(true); setError('');
    try {
      const fingerprint = await createAssemblyFingerprint(dataset, result.fingerprintAssets.map((asset) => ({ ...asset, caption: resolveAssetCaption(asset.item, dataset.triggerWord).normalized })), {
        target:target.trim(), mode:assemblyMode, excludedKeys:excluded, pinnedKeys:pinned,
      });
      if (fingerprint !== result.plan.fingerprint) throw new Error('This preview is stale because the Dataset or captions changed. Run the selection again.');
      await onApply(result.plan.selected.map((step) => step.path));
      onOpenChange(false);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'Could not apply the selection.'); }
    finally { setApplying(false); }
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[2200] bg-black/55" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[2201] flex max-h-[90vh] w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border p-5">
          <Sparkles className="mt-0.5 h-5 w-5 text-primary" />
          <div className="min-w-0 flex-1"><Dialog.Title className="font-semibold">Automatic Dataset assembly</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">Maximize relevant visual and caption coverage using images from Project/{PROJECT_LAYOUT.rawDir} only.</Dialog.Description></div>
          <Dialog.Close className="rounded p-1 text-muted-foreground hover:bg-secondary" aria-label="Close"><X className="h-4 w-4" /></Dialog.Close>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
            <p className="text-sm"><span className="font-medium">Source</span><br /><span className="text-muted-foreground">Project/{PROJECT_LAYOUT.rawDir} · fixed</span></p>
            <p className="text-sm"><span className="font-medium">Baseline</span><br /><span className="text-muted-foreground">Existing {existingCount} {existingCount === 1 ? 'image will' : 'images will'} be preserved</span></p>
            <label className="text-sm"><span className="font-medium">Selection mode</span><select value={mode} onChange={(event) => setMode(event.target.value as AssemblyMode['kind'])} className="mt-1 w-full rounded border border-border bg-background px-2 py-2"><option value="auto">Auto · stop at saturation</option><option value="total">Total Dataset size</option><option value="range">Inclusive total range</option><option value="max-new">Maximum new images</option></select></label>
            {mode === 'total' && <label className="text-sm"><span className="font-medium">Total images</span><input type="number" min={0} max={100000} value={totalTarget} onChange={(event) => setTotalTarget(Math.max(0,Number(event.target.value)||0))} className="mt-1 w-full rounded border border-border bg-background px-2 py-2" /></label>}
            {mode === 'range' && <div className="grid grid-cols-2 gap-2"><label className="text-sm"><span className="font-medium">Minimum total</span><input type="number" min={0} value={rangeMin} onChange={(event)=>setRangeMin(Math.max(0,Number(event.target.value)||0))} className="mt-1 w-full rounded border border-border bg-background px-2 py-2" /></label><label className="text-sm"><span className="font-medium">Maximum total</span><input type="number" min={0} value={rangeMax} onChange={(event)=>setRangeMax(Math.max(0,Number(event.target.value)||0))} className="mt-1 w-full rounded border border-border bg-background px-2 py-2" /></label></div>}
            {mode === 'max-new' && <label className="text-sm"><span className="font-medium">Maximum new images</span><input type="number" min={0} max={10000} value={maxNew} onChange={(event) => setMaxNew(Math.max(0,Number(event.target.value)||0))} className="mt-1 w-full rounded border border-border bg-background px-2 py-2" /></label>}
            <label className="text-sm sm:col-span-2"><span className="font-medium">What should this Dataset cover? <span className="font-normal text-muted-foreground">Optional</span></span><textarea value={target} onChange={(event) => setTarget(event.target.value)} rows={2} placeholder="For example: the character in varied poses, angles and indoor/outdoor scenes" className="mt-1 w-full resize-y rounded border border-border bg-background px-3 py-2" /></label>
          </div>
          {phase && <div role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm"><div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{phase}</div>{progress.total > 0 && <div className="mt-2 h-1.5 overflow-hidden rounded bg-secondary"><div className="h-full bg-primary" style={{ width: `${Math.round(progress.completed / progress.total * 100)}%` }} /></div>}</div>}
          {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
          {result && <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[['Existing', result.plan.baselineCount], ['Proposed', result.plan.selected.length], ['Together', result.plan.baselineCount + result.plan.selected.length], ['Coverage', `${percent(result.plan.before.total)} → ${percent(result.plan.after.total)}`]].map(([label, value]) => <div key={label} className="rounded-lg bg-secondary p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-semibold">{value}</p></div>)}
            </div>
            <p className="text-xs text-muted-foreground">Visual {percent(result.plan.after.visual)} · Captions {percent(result.plan.after.text)} · Context {percent(result.plan.after.context)} · stopped: {result.plan.stoppedBecause}{result.plan.shortfall ? ` · shortfall ${result.plan.shortfall}` : ''}</p>
            <p className="text-xs text-muted-foreground">Pool {result.plan.funnel.pool} → {result.plan.funnel.eligible} eligible · {result.plan.funnel.exactDuplicates} exact + {result.plan.funnel.nearDuplicates} near duplicates · {result.plan.funnel.excluded} excluded · {result.plan.funnel.evaluated} evaluations · {result.skipped} unavailable files</p>
            <details className="rounded border border-border px-3 py-2 text-xs"><summary className="cursor-pointer font-medium">Pool balance and rejections</summary><div className="mt-2 space-y-1 text-muted-foreground">
              {result.plan.sceneGroups.map((group) => <p key={group.id}>{group.id}: {group.baseline} existing · {group.pool} eligible · {group.selected} selected</p>)}
              {result.plan.duplicatePairs.map((pair) => <p key={`${pair.kind}:${pair.rejected}`}>{pair.rejected}: {pair.kind} duplicate of {pair.kept} ({Math.round(pair.similarity*100)}%)</p>)}
              {result.plan.rejectedCandidates.filter((entry)=>entry.reason==='not-selected').slice(0,20).map((entry)=><p key={entry.path}>{entry.path}: not selected before {result.plan.stoppedBecause}</p>)}
            </div></details>
            {result.plan.selected.length ? <div className="divide-y divide-border rounded-lg border border-border">
              {result.plan.selected.map((step, index) => { const item = proposedByPath.get(step.key); return <div key={step.key} className="flex items-start gap-3 p-3 text-sm">{item && previewUrls[item.id] ? <img src={previewUrls[item.id]} alt="" className="h-14 w-14 shrink-0 rounded object-cover" /> : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">{index + 1}</span>}<div className="min-w-0 flex-1"><p className="truncate font-medium" title={step.path}>{step.path}</p>{item?.tags?.length ? <p className="truncate text-xs text-muted-foreground">{item.tags.join(', ')}</p> : null}<p className="mt-0.5 text-xs text-muted-foreground">{step.reason} · +{(step.gain * 100).toFixed(1)} coverage points</p></div><button type="button" aria-label={`Pin ${step.path}`} title="Keep this candidate" onClick={() => updateConstraint(step.key, 'pin')} className={`rounded p-1 ${pinned.has(step.key) ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}><Pin className="h-4 w-4" /></button><button type="button" aria-label={`Remove ${step.path}`} title="Remove and recalculate" onClick={() => updateConstraint(step.key, 'exclude')} className="rounded p-1 text-muted-foreground hover:bg-secondary"><X className="h-4 w-4" /></button></div>; })}
            </div> : <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">The available pool is already covered; no useful additions passed the saturation threshold.</p>}
          </div>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border p-4">
          {running ? <button type="button" onClick={() => abortRef.current?.abort()} className="rounded border border-border px-4 py-2 text-sm">Cancel</button> : <button type="button" onClick={() => void run()} className="inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"><Sparkles className="h-4 w-4" />Select images</button>}
          {result?.plan.selected.length ? <button type="button" disabled={applying || running} onClick={() => void apply()} className="inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Add {result.plan.selected.length} images</button> : null}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
