import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import type { AutoSelectStep, AutoSelectStepId, AutoSelectSteps } from '../../lib/autoSelectSteps';
import type { FolderRow } from '../../lib/inboxFolders';
import type { SkippedAssemblyItem } from '../../services/dataset/datasetAssemblyService';
import { FolderChecklist } from '../workspace/FolderChecklist';
import { ModelDownloadPrompt } from '../workspace/ModelDownloadPrompt';
import { LocalTaggerConnectPrompt } from '../tagging/LocalTaggerConnectPrompt';

type Props = {
  derived: AutoSelectSteps;
  datasetCount: number;
  target: number;
  /** Auto mode: no target size; one image per group of similar ones. */
  auto: boolean;
  /** Images compared when the candidate list was made. */
  comparedAtFind?: number;
  onAutoChange: (auto: boolean) => void;
  onTargetChange: (target: number) => void;
  folderRows: FolderRow[];
  deselectedFolders: ReadonlySet<string>;
  onToggleFolder: (folder: string) => void;
  analysisPaused: boolean;
  onResumeAnalysis: () => void;
  progress: { completed: number; total: number };
  /** Which step asked to download the image model, if any. */
  modelDownloadFor: 'find' | 'pick' | null;
  onConfirmDownload: () => void;
  onDismissDownload: () => void;
  skipped: SkippedAssemblyItem[];
  taggerConnected: boolean;
  /** Disables every action while a review decision is being saved. */
  busy: boolean;
  onFind: () => void;
  onDescribe: () => void;
  onPick: () => void;
  onApply: () => void;
  onCancel: () => void;
  onShowCandidates: () => void;
  onReviewPicks: () => void;
  onStartOver: () => void;
};

const TITLES: Record<AutoSelectStepId, string> = { sources: 'Sources', find: 'Find candidates', describe: 'Describe candidates', pick: 'Pick the most varied' };
const EXPLANATIONS: Record<AutoSelectStepId, string> = {
  sources: 'Choose the inbox folders to pick images from, and how many images the Dataset should have.',
  find: 'Looks at the images and keeps a varied set of candidates. Nothing is added yet.',
  describe: 'Suggests tags for the candidates with a local caption model so they can be compared by content.',
  pick: 'Chooses the most varied candidates to fill the Dataset, then adds them in one step.',
};
const primary = 'rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40';
const secondary = 'rounded border border-border px-3 py-1.5 text-xs disabled:opacity-40';
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The single entry point for automatic selection in Build → Select: four numbered steps, only the current one expanded. */
export function BuildAutoSelectPanel(props: Props) {
  const { derived, datasetCount, target, auto, busy } = props;
  const [expanded, setExpanded] = useState(auto || datasetCount < target);
  // A step the user opened explicitly; otherwise the first ready or running step is the open one.
  const [openId, setOpenId] = useState<AutoSelectStepId | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [sources, find, describe, pick] = derived.steps;
  const hasWork = find.state === 'done' || find.state === 'running';
  const hasPicks = pick.counts.picks > 0;
  const running = (step: AutoSelectStep) => step.state === 'running';
  const anyRunning = derived.steps.some(running);
  const current = derived.steps.find((step) => step.state === 'running' || step.state === 'ready');
  const activeId = openId ?? current?.id;
  // Moving on to another step closes whatever the user had opened.
  useEffect(() => { setOpenId(null); }, [current?.id]);
  const progress = props.progress.total > 0 ? ` ${props.progress.completed}/${props.progress.total}` : '';

  // Collapse once the Dataset reaches the target, and after the picks were added (the candidate list is gone afterwards).
  const wasBelowTarget = useRef(datasetCount < target);
  useEffect(() => {
    if (!auto && wasBelowTarget.current && datasetCount >= target) setExpanded(false);
    wasBelowTarget.current = datasetCount < target;
  }, [datasetCount, target, auto]);
  const applying = useRef(false);
  useEffect(() => {
    if (pick.state === 'running' && hasPicks) applying.current = true;
    else if (applying.current && !anyRunning) { applying.current = false; if (find.state !== 'done') { setExpanded(false); setOpenId(null); } }
  }, [pick.state, hasPicks, anyRunning, find.state]);

  const folderCount = props.folderRows.filter((row) => !props.deselectedFolders.has(row.path)).length;
  const folderLabel = props.deselectedFolders.size === 0 ? (props.folderRows.length <= 1 ? props.folderRows[0]?.name ?? 'inbox' : 'all folders') : plural(folderCount, 'folder');
  const compared = props.comparedAtFind || find.counts.found + find.counts.duplicates;
  const found = find.counts.found; const duplicates = find.counts.duplicates; const unreadable = find.counts.unreadable;
  const findDone = found > 0 && auto
    ? [`${plural(compared, 'image')} → ${plural(found, 'group')}`, duplicates > 0 && `${duplicates} similar skipped`, unreadable > 0 && `${unreadable} unreadable`].filter(Boolean).join(' · ')
    : found > 0
    ? [plural(found, 'candidate'), duplicates > 0 && `${plural(duplicates, 'near-duplicate')} skipped`, unreadable > 0 && `${unreadable} unreadable`].filter(Boolean).join(' · ')
    : 'All candidates have already been reviewed';

  const explanation = (id: AutoSelectStepId) => auto
    ? id === 'sources' ? 'Choose the inbox folders to pick images from. The Dataset gets one image from each group of similar images.'
      : id === 'find' ? 'Groups similar images and keeps one representative of each. Nothing is added yet.'
      : id === 'describe' ? 'Optional: suggests tags for the candidates with a local caption model so they can be compared by content.'
      : 'Orders the representatives by how much variety they add, then adds them all in one step.'
    : EXPLANATIONS[id];
  const reason = (step: AutoSelectStep) => step.reason && <p data-testid={`auto-step-${step.id}-reason`} className={`text-xs ${step.state === 'locked' ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground'}`}>{step.reason}</p>;
  const runningLine = (label: string) => <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{label}{progress}<button type="button" className="underline" onClick={props.onCancel}>Cancel</button></span>;

  /** One line per step; the explanation and controls appear only for the open step. */
  const stepShell = (step: AutoSelectStep, index: number, line: ReactNode, controls: ReactNode) => {
    const open = step.state === 'running' || activeId === step.id;
    const toggle = step.state === 'done' || (step.state === 'ready' && !open)
      ? <button type="button" className="ml-auto shrink-0 text-xs underline" aria-expanded={open} onClick={() => setOpenId(open ? (current?.id ?? null) : step.id)}>{open ? 'Close' : step.state === 'done' ? 'Change' : 'Open'}</button> : null;
    return <li key={step.id} data-testid={`auto-step-${step.id}`} data-state={step.state}
      className={`rounded border px-3 py-1.5 ${step.state === 'locked' ? 'border-border/60 opacity-70' : 'border-border'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${step.state === 'done' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-border'}`}>{step.state === 'done' ? <Check className="h-3 w-3" /> : index + 1}</span>
        <span className="text-sm font-medium">{TITLES[step.id]}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">{line}</div>
        {toggle}
      </div>
      {open && <div className="mt-1.5 space-y-1.5 pl-8"><p className="text-xs text-muted-foreground">{explanation(step.id)}</p>{controls}</div>}
    </li>;
  };

  // Next action shown in the header so the panel can stay collapsed.
  const next = anyRunning ? <span role="status" className="flex items-center gap-1 text-xs font-normal text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Working{progress}</span>
    : find.state === 'ready' ? <button type="button" className={primary} disabled={busy} onClick={props.onFind}>Find candidates</button>
    : find.state === 'locked' && !find.reason?.startsWith('The Dataset') ? <span className="text-xs font-normal text-muted-foreground">{find.reason}</span>
    : describe.state === 'ready' ? (props.taggerConnected
      ? <button type="button" className={primary} disabled={busy} onClick={props.onDescribe}>Tag {describe.counts.taggable} {describe.counts.taggable === 1 ? 'candidate' : 'candidates'}</button>
      : <button type="button" className={primary} onClick={() => { setExpanded(true); setOpenId('describe'); }}>Connect a caption model</button>)
    : pick.state === 'ready' ? <button type="button" className={primary} disabled={busy} onClick={props.onPick}>Pick {pick.counts.pickCount}</button>
    : pick.state === 'done' && hasPicks ? <button type="button" className={primary} disabled={busy} onClick={props.onApply}>Add {pick.counts.picks} to the Dataset</button>
    : <span className="text-xs font-normal text-muted-foreground">Done</span>;

  return <section aria-label="Auto-select" data-testid="build-auto-select" data-expanded={expanded} className="shrink-0 border-b border-border bg-card/50 px-4 py-1.5">
    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="flex items-center gap-2 text-left">
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}<Sparkles className="h-4 w-4 text-primary" />Auto-select
        <span className="text-xs font-normal text-muted-foreground">{auto ? `Dataset ${datasetCount} · auto` : `Dataset ${datasetCount} of ${target}`}</span>
      </button>
      {!expanded && <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">· Next: {next}</span>}
    </div>
    {expanded && <div className="mt-1.5 max-h-[35vh] space-y-2 overflow-auto">
      <ol className="space-y-1.5">
        {stepShell(sources, 0,
          sources.state === 'done' ? <span>{folderLabel} · {plural(sources.counts.images, 'image')} · {auto ? 'auto' : `target ${target}`}</span> : reason(sources),
          <>
            <div className="text-xs"><FolderChecklist rows={props.folderRows} deselected={props.deselectedFolders} onToggle={props.onToggleFolder} label="Source folders" emptyText="No images in the inbox." testId="auto-source-folders" /></div>
            <p className="text-xs text-muted-foreground" data-testid="auto-source-counts">{plural(sources.counts.images, 'image')} · {sources.counts.analyzed} analyzed</p>
            <div role="radiogroup" aria-label="Size mode" className="flex items-center gap-2 text-xs">Size:
              <button type="button" role="radio" aria-checked={auto} className={auto ? primary : secondary} disabled={busy || anyRunning} onClick={() => props.onAutoChange(true)}>Auto</button>
              <button type="button" role="radio" aria-checked={!auto} className={!auto ? primary : secondary} disabled={busy || anyRunning} onClick={() => props.onAutoChange(false)}>Target</button>
              {auto && <span className="text-muted-foreground">One image per group of similar images; no target size.</span>}
            </div>
            {!auto && <label className="flex items-center gap-2 text-xs">Target: <input type="number" min={0} aria-label="Target" value={target} onChange={(event) => props.onTargetChange(Math.max(0, Number(event.target.value) || 0))} className="w-20 rounded border border-border bg-background px-2 py-1" /> images in the Dataset</label>}
            {sources.state !== 'done' && reason(sources)}
          </>)}
        {stepShell(find, 1,
          running(find) ? runningLine('Finding candidates')
            : find.state === 'done' ? <span className="flex flex-wrap items-center gap-2" data-testid="auto-find-result">{findDone}
              {props.skipped.length > 0 && <button type="button" className="underline" aria-expanded={showSkipped} onClick={() => setShowSkipped((value) => !value)}>{showSkipped ? 'Hide' : 'Show'}</button>}
              {found > 0 && <button type="button" className="underline" onClick={props.onShowCandidates}>Show candidates</button>}</span>
            : find.state === 'locked' ? <>{reason(find)}{props.analysisPaused && find.reason?.startsWith('Waiting') && <button type="button" className="underline" onClick={props.onResumeAnalysis}>Resume</button>}</>
            : null,
          <>
            {find.state === 'ready' && <button type="button" className={primary} disabled={busy} onClick={props.onFind}>Find candidates</button>}
            {props.modelDownloadFor === 'find' && <ModelDownloadPrompt testId="auto-model-download" onConfirm={props.onConfirmDownload} onCancel={props.onDismissDownload} />}
          </>)}
        {props.skipped.length > 0 && showSkipped && find.state === 'done' && <li data-testid="auto-skipped-list" className="max-h-24 space-y-0.5 overflow-auto px-3 text-xs text-muted-foreground">{props.skipped.map(({ item, reason: why }) => <p key={item.id}>{item.assetPath ?? item.fileName}: {why}</p>)}</li>}
        {stepShell(describe, 2,
          running(describe) ? runningLine('Describing candidates')
            : describe.state === 'done' ? <span data-testid="auto-describe-result">{describe.counts.candidates > 0 ? `All ${describe.counts.candidates} described` : 'Nothing left to describe'}</span>
            : describe.state === 'locked' ? reason(describe) : null,
          <>
            {describe.state === 'ready' && <button type="button" className={secondary} disabled={busy || !props.taggerConnected} onClick={props.onDescribe}>Tag {describe.counts.taggable} {describe.counts.taggable === 1 ? 'candidate' : 'candidates'}</button>}
            {describe.state === 'ready' && !props.taggerConnected && <LocalTaggerConnectPrompt message="No local caption model connected. Connect one to tag the candidates." />}
          </>)}
        {stepShell(pick, 3,
          running(pick) ? runningLine(hasPicks ? 'Adding to the Dataset' : 'Picking the most varied')
            : pick.state === 'done' && hasPicks ? <span className="flex flex-wrap items-center gap-2" data-testid="auto-pick-result">
              <span>{pick.counts.picks} picked</span>
              <button type="button" className="underline" onClick={props.onReviewPicks}>Review picks</button>
              <button type="button" className={primary} disabled={busy} onClick={props.onApply}>Add {pick.counts.picks} to the Dataset</button></span>
            : pick.state === 'done' ? <span data-testid="auto-pick-result">Nothing left to pick</span>
            : pick.state === 'locked' ? reason(pick) : null,
          <>
            {pick.state === 'ready' && <button type="button" className={primary} disabled={busy} onClick={props.onPick}>Pick {pick.counts.pickCount}</button>}
            {props.modelDownloadFor === 'pick' && <ModelDownloadPrompt testId="auto-model-download" onConfirm={props.onConfirmDownload} onCancel={props.onDismissDownload} />}
            {pick.state === 'ready' && reason(pick)}
          </>)}
      </ol>
      <div className="flex items-center gap-2 text-xs">
        {confirmReset ? <>
          <span>Discard {plural(pick.counts.picks, 'pick')} and the candidate list?</span>
          <button type="button" className="underline" onClick={() => { setConfirmReset(false); props.onStartOver(); }}>Start over</button>
          <button type="button" className="underline" onClick={() => setConfirmReset(false)}>Keep</button></>
          : <button type="button" className={secondary} disabled={!hasWork || busy || anyRunning} onClick={() => hasPicks ? setConfirmReset(true) : props.onStartOver()}>Start over</button>}
      </div>
    </div>}
  </section>;
}
