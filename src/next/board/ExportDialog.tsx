import { useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useExportRun, type ExportMethod } from '../../components/export/useExportRun';
import { TARGET_MODEL_PRESETS } from '../../lib/projectProfilePresets';
import { cn } from '../../lib/utils';
import type { ExportPlan } from '../../services/export/exportPlan';
import type { ExportResize } from '../../services/export/exportResize';
import type { QualityReport, QualityStatus } from '../../services/quality/metrics';
import type { TargetModelId } from '../../types';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass = cn('min-h-[44px] rounded-md border border-border px-4 text-sm hover:bg-secondary disabled:opacity-40', focusRing);
const fieldClass = 'min-h-[44px] rounded-md border border-border bg-background px-3 text-sm';
const STATUS_ICON: Record<QualityStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle };
const STATUS_CLASS: Record<QualityStatus, string> = { ok: 'text-emerald-700 dark:text-emerald-300', warn: 'text-amber-700 dark:text-amber-300', fail: 'text-destructive' };

type ResizeChoice = 'off' | 'longest' | 'bucket';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pairs in dataset/ as the Board counts them; the plan read from disk replaces it once ready. */
  pairCount: number;
  report: QualityReport;
  targetModel: TargetModelId;
  /** Called after a successful export with its plan (the owner records `lastExport`). */
  onExportComplete: (plan: ExportPlan) => void;
};

/**
 * Export dialog of the Board. Checks come from the quality report (`required`) and coverage warnings; neither blocks the export.
 * The optional resize only affects the exported copies.
 */
export function ExportDialog({ open, onOpenChange, ...rest }: Props) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
      {open && <ExportDialogBody {...rest} />}
    </Dialog.Portal>
  </Dialog.Root>;
}

function ExportDialogBody({ pairCount, report, targetModel, onExportComplete }: Omit<Props, 'open' | 'onOpenChange'>) {
  const root = useRef<HTMLDivElement>(null);
  const [resizeChoice, setResizeChoice] = useState<ResizeChoice>('off');
  const [side, setSide] = useState(1024);
  const [showFiles, setShowFiles] = useState(false);
  const resize = useMemo<ExportResize | undefined>(() => resizeChoice === 'longest' && side > 0 ? { kind: 'longest', side }
    : resizeChoice === 'bucket' ? { kind: 'bucket', model: targetModel } : undefined, [resizeChoice, side, targetModel]);
  const run = useExportRun({ fixedSource: 'dataset', onExportComplete, root, viewId: 'next-export', resize });
  const { plan, loading, busy, progress, result, error, loadError, effectiveMethod, directory } = run;
  const count = plan?.entries.length ?? pairCount;
  const coverageWarnings = (report.coverage ?? []).filter(metric => metric.evaluated && metric.status !== 'ok');
  // One line for all files without a caption file instead of one warning per file.
  const noCaption = (plan?.warnings ?? []).filter(warning => warning.endsWith('has no caption file; it is exported without a .txt.')).length;
  const planWarnings = [...(noCaption ? [`${noCaption} ${noCaption === 1 ? 'file has' : 'files have'} no caption file and will be exported without a .txt.`] : []),
    ...(plan?.warnings ?? []).filter(warning => !warning.endsWith('has no caption file; it is exported without a .txt.'))];

  return <Dialog.Content ref={root} data-export-dialog aria-describedby="export-dialog-description"
    onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
    className="fixed left-1/2 top-1/2 z-[2101] flex max-h-[90vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-lg border border-border bg-card p-6 shadow-xl">
    <div>
      <Dialog.Title className="text-lg font-semibold">Export {count} {count === 1 ? 'pair' : 'pairs'}</Dialog.Title>
      <Dialog.Description id="export-dialog-description" className="mt-1 text-sm text-muted-foreground">
        Images and caption files from dataset/. Checks below never block the export.</Dialog.Description>
    </div>

    <section data-export-checks aria-label="Checks" className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Checks</h3>
      <ul className="space-y-1 text-sm">{report.required.map(metric => {
        const Icon = STATUS_ICON[metric.status];
        return <li key={metric.id} data-export-check={metric.id} data-status={metric.evaluated ? metric.status : 'skipped'} className="flex items-start gap-2">
          <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', metric.evaluated ? STATUS_CLASS[metric.status] : 'text-muted-foreground')} />
          <span><span className="font-medium">{metric.title}</span>: {metric.display}{metric.status !== 'ok' && metric.explanation ? <span className="block text-xs text-muted-foreground">{metric.explanation}</span> : null}</span></li>;
      })}</ul>
    </section>

    {(coverageWarnings.length > 0 || planWarnings.length > 0) && <section data-export-warnings aria-label="Warnings" className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Warnings</h3>
      <ul className="space-y-1">
        {coverageWarnings.map(metric => <li key={metric.id} data-export-warning={metric.id}><span className="font-medium">{metric.title}</span>: {metric.display}. <span className="text-muted-foreground">{metric.explanation}</span></li>)}
        {planWarnings.map((warning, index) => <li key={`plan-${index}`} data-export-warning="plan">{warning}</li>)}
      </ul>
    </section>}

    <div className="flex flex-wrap gap-3">
      <label className="grid gap-1 text-xs text-muted-foreground">Format
        <select aria-label="Format" data-export-format value={effectiveMethod} disabled={busy} onChange={event => run.setMethod(event.target.value as ExportMethod)} className={cn(fieldClass, 'text-foreground')}>
          {directory && <option value="project">ZIP in project (exports/)</option>}
          <option value="download">ZIP download</option>
          <option value="directory" disabled={!('showDirectoryPicker' in window)}>Folder</option>
        </select></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Resize copies
        <select aria-label="Resize" data-export-resize value={resizeChoice} disabled={busy} onChange={event => setResizeChoice(event.target.value as ResizeChoice)} className={cn(fieldClass, 'text-foreground')}>
          <option value="off">Original size</option>
          <option value="longest">Longest side</option>
          <option value="bucket">{TARGET_MODEL_PRESETS[targetModel]?.label ?? targetModel} buckets</option>
        </select></label>
      {resizeChoice === 'longest' && <label className="grid gap-1 text-xs text-muted-foreground">Pixels
        <input type="number" min={64} step={64} aria-label="Longest side in pixels" value={side} disabled={busy} onChange={event => setSide(Math.max(0, Math.floor(Number(event.target.value) || 0)))} className={cn(fieldClass, 'w-28 text-foreground')} /></label>}
    </div>
    {resize && <p data-export-resize-note className="text-xs text-muted-foreground">Only the exported copies are made smaller (never larger); the images in the project stay as they are. PNG, JPEG and WebP only.</p>}

    {(error || loadError) && <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">{error || loadError}</div>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Preparing the export…</p>}
    {busy && <div role="status" data-export-progress className="flex items-center gap-3 rounded-md border border-border p-3 text-sm">
      <progress aria-label="Export progress" value={progress.done} max={progress.total || 1} className="flex-1" /><span className="tabular-nums">{progress.done}/{progress.total}</span>
      <button type="button" data-export-cancel onClick={run.cancel} className={buttonClass}>Cancel</button></div>}
    {result && !busy && <div role="status" data-export-result className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p>Exported {result.count} {result.count === 1 ? 'pair' : 'pairs'} → <span data-export-path className="break-all font-mono">{result.path}</span>
        {result.method === 'directory' && <button type="button" data-export-show aria-expanded={showFiles} onClick={() => setShowFiles(value => !value)} className="ml-3 underline">{showFiles ? 'Hide' : 'Show'}</button>}</p>
      {showFiles && result.files && <ul data-export-files className="max-h-40 overflow-auto font-mono text-xs text-muted-foreground">{result.files.map(file => <li key={file}>{file}</li>)}</ul>}
    </div>}
    {run.folderRecovery && effectiveMethod === 'directory' && !busy && !result && <p className="text-xs text-muted-foreground">
      {run.folderRecovery.completed.length} file{run.folderRecovery.completed.length === 1 ? '' : 's'} already written; they are verified when you export again.
      <button type="button" className="ml-2 underline" onClick={run.resetRecovery}>Choose another folder</button></p>}

    <div className="flex flex-wrap justify-end gap-2">
      <Dialog.Close asChild><button type="button" data-export-close disabled={busy} className={buttonClass}>{result ? 'Done' : 'Close'}</button></Dialog.Close>
      <button type="button" data-export-run disabled={busy || loading || !plan?.entries.length} onClick={() => void run.run()}
        className={cn('inline-flex min-h-[44px] items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-40', focusRing)}>
        {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}{busy ? 'Exporting…' : `Export ${count} ${count === 1 ? 'pair' : 'pairs'}`}</button>
    </div>
    {plan && !plan.entries.length && !loading && <p className="text-sm text-muted-foreground">No images in dataset/ yet.</p>}
  </Dialog.Content>;
}
