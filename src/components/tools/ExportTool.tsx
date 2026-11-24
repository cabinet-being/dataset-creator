import { useRef } from 'react';
import { useCommands } from '../workspace/Commands';
import type { ExportPlan, ExportScope } from '../../services/export/exportPlan';
import { useExportRun, type ExportMethod } from '../export/useExportRun';

export function ExportTool({ active = true, onExportComplete, fixedSource }: { active?: boolean; onExportComplete?: (plan: ExportPlan) => void; fixedSource?: ExportScope }) {
  const root = useRef<HTMLDivElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const { directory, scope, setScope, setMethod, effectiveMethod, plan, loading, loadError, busy, progress, error, savedPath, folderRecovery, run: runExport, cancel, refreshPlan, resetRecovery } =
    useExportRun({ fixedSource, onExportComplete, root, viewId: 'tool:export' });
  const run = async () => { await runExport(); requestAnimationFrame(() => runButton.current?.focus()); };
  useCommands([{ id: 'export.run', label: 'Export reviewed files', active, disabled: busy || loading || !plan?.entries.length, run }, { id: 'export.cancel', label: 'Cancel export', active, disabled: !busy, run: () => cancel() }], () => root.current?.closest<HTMLElement>('[data-dock-view]') ?? root.current);
  return <div ref={root} className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
    <header className="flex flex-wrap items-center justify-between gap-3">{fixedSource ? <h2 className="text-lg font-semibold">Export Dataset</h2> : <h1 className="text-xl font-semibold">Export</h1>}<button ref={runButton} onClick={() => void run()} disabled={busy || loading || !plan?.entries.length} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40">{busy ? 'Exporting…' : `Export${plan ? ` ${plan.entries.length}` : ''}`}</button></header>
    <div className="flex flex-wrap gap-3">
      {!fixedSource && <label className="grid gap-1 text-xs text-muted-foreground">Source<select className="rounded-md border border-border bg-background p-2 text-sm text-foreground" value={scope} disabled={busy} onChange={e => setScope(e.target.value as ExportScope)}><option value="dataset">Dataset selection</option><option value="workspace">All workspace images</option>{directory && <option value="directory">Images in dataset/ folder</option>}</select></label>}
      <label className="grid gap-1 text-xs text-muted-foreground">Destination<select className="rounded-md border border-border bg-background p-2 text-sm text-foreground" value={effectiveMethod} disabled={busy} onChange={e => setMethod(e.target.value as ExportMethod)}>{directory && <option value="project">ZIP in project (exports/)</option>}<option value="download">ZIP download</option><option value="directory" disabled={!('showDirectoryPicker' in window)}>Destination directory</option></select></label>
      <div className="ml-auto self-end text-xs text-muted-foreground">{plan?.entries.length ?? 0} images · {plan?.entries.filter(entry => entry.caption).length ?? 0} captions · original image formats{plan?.entries.some(entry => entry.conversion === 'psd') ? ' · PSD → PNG via Photopea' : ''}</div>
    </div>
    {(error || loadError) && <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm"><span className="flex-1">{error || loadError}</span><button onClick={refreshPlan} disabled={busy}>Refresh</button></div>}
    {folderRecovery && effectiveMethod === 'directory' ? <div className="flex items-center gap-3 text-xs text-muted-foreground"><p className="flex-1">Recovery journal: {folderRecovery.completed.length} completed entr{folderRecovery.completed.length === 1 ? 'y' : 'ies'} will be verified when you retry this export.</p><button disabled={busy} onClick={resetRecovery}>Choose another folder / start new export</button></div> : null}
    {savedPath && <p role="status" className="text-sm">Saved to <span className="font-mono">{savedPath}</span></p>}
    {loading && <p role="status" className="py-8 text-center text-sm text-muted-foreground">Preparing preview…</p>}
    {plan && !plan.entries.length && <div className="py-12 text-center text-sm text-muted-foreground">No images in this source.</div>}
    {!!plan?.warnings?.length && <details className="text-sm text-muted-foreground" open><summary>{plan.warnings.length} warning{plan.warnings.length === 1 ? '' : 's'}</summary><ul className="mt-2 space-y-1">{plan.warnings.map((entry, i) => <li key={i}>{entry}</li>)}</ul></details>}
    {!!plan?.skipped.length && <details className="text-sm text-muted-foreground"><summary>{plan.skipped.length} skipped</summary><ul className="mt-2 space-y-1">{plan.skipped.map((entry, i) => <li key={i}>{entry}</li>)}</ul></details>}
    {plan && plan.entries.length > 0 && <div className="overflow-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-secondary"><tr><th className="p-3 font-medium">Output</th><th className="p-3 font-medium">Caption</th></tr></thead><tbody>{plan.entries.map(entry => <tr key={entry.imageName} className="border-t border-border"><td className="p-3"><p className="font-mono text-xs">{entry.imageName}</p><p className="text-xs text-muted-foreground">{entry.textName}</p></td><td className="max-w-lg break-words p-3 text-muted-foreground">{entry.caption || 'No caption'}</td></tr>)}</tbody></table></div>}
    {busy && <div role="status" className="sticky bottom-0 flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm"><progress aria-label="Export progress" value={progress.done} max={progress.total || 1} className="flex-1" /><span>{progress.done}/{progress.total}</span><button onClick={() => cancel()}>Cancel</button></div>}
  </div>;
}
