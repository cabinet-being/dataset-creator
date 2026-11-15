import { useOperation } from '../../hooks/useOperation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { toWorkspaceImages } from '../../lib/workspaceImages';
import { buildExportPlan, exportPlanAsZip, exportPlanToDirectory, type ExportPlan, type ExportRecoveryJournal, type ExportScope } from '../../services/export/exportPlan';
import { downloadZipFile, saveZipToProjectExports } from '../../services/export/exportService';
import { flushProjectSave, runProjectFileOperation } from '../../hooks/useProjectSave';
import { useCommands } from '../workspace/Commands';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { isProjectPathIncluded } from '../../lib/projectCategories';

export function ExportTool({ active = true, onExportComplete }: { active?: boolean; onExportComplete?: (plan: ExportPlan) => void }) {
  const sources = useProjectStore(state => state.sourceImages);
  const edits = useProjectStore(state => state.datasetItems);
  const dataset = useProjectStore(state => state.dataset);
  const blacklist = useProjectStore(state => state.taggingConfig.blacklist);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const excludedProjectCategories = useMemo(() => workspaceSettings.excludedProjectCategories ?? [], [workspaceSettings.excludedProjectCategories]);
  const includedProjectCategories = useMemo(() => workspaceSettings.includedProjectCategories ?? [], [workspaceSettings.includedProjectCategories]);
  const directory = useUIStore(state => state.projectDirectoryHandle);
  const refresh = useUIStore(state => state.assetPreviewRefreshKey);
  const requestExplorerRefresh = useUIStore(state => state.requestExplorerRefresh);
  const notify = useUIStore(state => state.addNotification);
  const [scope, setScope] = useState<ExportScope>('dataset');
  const [method, setMethod] = useState<'project' | 'download' | 'directory'>('project');
  const [savedPath, setSavedPath] = useState('');
  const [plan, setPlan] = useState<ExportPlan>();
  const [loadError, setLoadError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const operation = useOperation('Export', root, 'tool:export');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [folderRecovery, setFolderRecovery] = useState<{ fingerprint: string; completed: string[]; target: ProjectDirectoryHandle }>();
  const recoveryJournal = useRef<ExportRecoveryJournal>();
  const [revision, setRevision] = useState(0); const controller = useRef<AbortController>();
  const allItems = useMemo(() => toWorkspaceImages(Object.values(sources), Object.values(edits).filter(item => !item.deleted)), [sources, edits]);
  const items = useMemo(() => scope === 'workspace'
    ? allItems.filter((item) => isProjectPathIncluded(item.assetPath, excludedProjectCategories, includedProjectCategories))
    : allItems,
  [allItems, excludedProjectCategories, includedProjectCategories, scope]);
  useEffect(() => {
    if (busy) return;
    let cancelled = false; setLoading(true); setLoadError(''); setPlan(undefined);
    void flushProjectSave().then(() => buildExportPlan({ scope, items, dataset, directory, blacklist })).then(next => { if (!cancelled) setPlan(next); })
      .catch(reason => { if (!cancelled) setLoadError(reason instanceof Error ? reason.message : 'Unable to read export files'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, items, dataset, directory, blacklist, refresh, revision, busy]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [busy]);
  const effectiveMethod = method === 'project' && !directory ? 'download' : method;
  const run = async () => {
    if (!plan?.entries.length || busy || loading) return;
    const snapshot = plan; const next = new AbortController(); controller.current = next;
    operation.start(() => next.abort(), snapshot.entries.length);
    const report = (done: number, total: number) => { setProgress({ done, total }); operation.progress(done, total); };
    setBusy(true); setError(''); setSavedPath(''); setProgress({ done: 0, total: snapshot.entries.length });
    try {
      let completedMessage = `Exported ${snapshot.entries.length} images and captions`;
      if (effectiveMethod === 'directory') {
        const picker = (window as unknown as { showDirectoryPicker?: () => Promise<ProjectDirectoryHandle> }).showDirectoryPicker;
        if (!picker) throw new Error('Folder export is unavailable in this browser. Choose ZIP.');
        let journal = recoveryJournal.current;
        const target = journal?.fingerprint === snapshot.fingerprint ? journal.root! : await picker();
        if (!journal || journal.fingerprint !== snapshot.fingerprint) {
          journal = { completedEntryNames: new Set(), startedEntryNames: new Set(), pendingOutputNames: new Set(), root: target, fingerprint: snapshot.fingerprint };
          recoveryJournal.current = journal;
        }
        const publishRecovery = () => setFolderRecovery({ fingerprint: snapshot.fingerprint, completed: [...journal!.completedEntryNames], target });
        journal.onEntryStart = publishRecovery;
        journal.onEntryComplete = publishRecovery;
        publishRecovery();
        await exportPlanToDirectory(snapshot, target, next.signal, report, journal);
        recoveryJournal.current = undefined;
        setFolderRecovery(undefined);
      } else {
        const blob = await exportPlanAsZip(snapshot, next.signal, report);
        if (effectiveMethod === 'project' && directory) {
          const saved = await runProjectFileOperation(() => saveZipToProjectExports(directory, blob, dataset.name || 'dataset'));
          setSavedPath(saved); requestExplorerRefresh();
          completedMessage = `Saved to ${saved}`;
        } else downloadZipFile(blob, `${dataset.name || 'dataset'}.zip`);
      }
      operation.finish('completed', `${snapshot.entries.length} images and captions exported`);
      onExportComplete?.(snapshot);
      notify('success', completedMessage);
    } catch (reason) {
      const cancelled = next.signal.aborted || (reason instanceof Error && reason.name === 'AbortError');
      operation.finish(cancelled ? 'cancelled' : 'failed', cancelled ? 'Completed files remain in the destination.' : reason instanceof Error ? reason.message : 'Export failed');
      if (next.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')) setError(effectiveMethod === 'directory' ? 'Export cancelled. Files already written remain in the destination; retry to resume.' : 'Export cancelled.');
      else setError(reason instanceof Error ? reason.message : 'Export failed');
    } finally { setBusy(false); requestAnimationFrame(() => runButton.current?.focus()); }
  };
  useCommands([{ id: 'export.run', label: 'Export reviewed files', active, disabled: busy || loading || !plan?.entries.length, run }, { id: 'export.cancel', label: 'Cancel export', active, disabled: !busy, run: () => controller.current?.abort() }], () => root.current?.closest<HTMLElement>('[data-dock-view]') ?? root.current);
  return <div ref={root} className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">Export</h1><button ref={runButton} onClick={() => void run()} disabled={busy || loading || !plan?.entries.length} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40">{busy ? 'Exporting…' : `Export${plan ? ` ${plan.entries.length}` : ''}`}</button></header>
    <div className="flex flex-wrap gap-3">
      <label className="grid gap-1 text-xs text-muted-foreground">Source<select className="rounded-md border border-border bg-background p-2 text-sm text-foreground" value={scope} disabled={busy} onChange={e => setScope(e.target.value as ExportScope)}><option value="dataset">Dataset selection</option><option value="workspace">All workspace images</option>{directory && <option value="directory">Images in dataset/ folder</option>}</select></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Destination<select className="rounded-md border border-border bg-background p-2 text-sm text-foreground" value={effectiveMethod} disabled={busy} onChange={e => setMethod(e.target.value as 'project' | 'download' | 'directory')}>{directory && <option value="project">ZIP in project (exports/)</option>}<option value="download">ZIP download</option><option value="directory" disabled={!('showDirectoryPicker' in window)}>Destination directory</option></select></label>
      <div className="ml-auto self-end text-xs text-muted-foreground">{plan?.entries.length ?? 0} images · {plan?.entries.filter(entry => entry.caption).length ?? 0} captions · original image formats{plan?.entries.some(entry => entry.conversion === 'psd') ? ' · PSD → PNG via Photopea' : ''}</div>
    </div>
    {(error || loadError) && <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm"><span className="flex-1">{error || loadError}</span><button onClick={() => { setError(''); setRevision(value => value + 1); }} disabled={busy}>Refresh</button></div>}
    {folderRecovery && effectiveMethod === 'directory' ? <div className="flex items-center gap-3 text-xs text-muted-foreground"><p className="flex-1">Recovery journal: {folderRecovery.completed.length} completed entr{folderRecovery.completed.length === 1 ? 'y' : 'ies'} will be verified when you retry this export.</p><button disabled={busy} onClick={() => { recoveryJournal.current = undefined; setFolderRecovery(undefined); setError(''); }}>Choose another folder / start new export</button></div> : null}
    {savedPath && <p role="status" className="text-sm">Saved to <span className="font-mono">{savedPath}</span></p>}
    {loading && <p role="status" className="py-8 text-center text-sm text-muted-foreground">Preparing preview…</p>}
    {plan && !plan.entries.length && <div className="py-12 text-center text-sm text-muted-foreground">No images in this source.</div>}
    {!!plan?.warnings?.length && <details className="text-sm text-muted-foreground" open><summary>{plan.warnings.length} warning{plan.warnings.length === 1 ? '' : 's'}</summary><ul className="mt-2 space-y-1">{plan.warnings.map((entry, i) => <li key={i}>{entry}</li>)}</ul></details>}
    {!!plan?.skipped.length && <details className="text-sm text-muted-foreground"><summary>{plan.skipped.length} skipped</summary><ul className="mt-2 space-y-1">{plan.skipped.map((entry, i) => <li key={i}>{entry}</li>)}</ul></details>}
    {plan && plan.entries.length > 0 && <div className="overflow-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-secondary"><tr><th className="p-3 font-medium">Output</th><th className="p-3 font-medium">Caption</th></tr></thead><tbody>{plan.entries.map(entry => <tr key={entry.imageName} className="border-t border-border"><td className="p-3"><p className="font-mono text-xs">{entry.imageName}</p><p className="text-xs text-muted-foreground">{entry.textName}</p></td><td className="max-w-lg break-words p-3 text-muted-foreground">{entry.caption || 'No caption'}</td></tr>)}</tbody></table></div>}
    {busy && <div role="status" className="sticky bottom-0 flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm"><progress aria-label="Export progress" value={progress.done} max={progress.total || 1} className="flex-1" /><span>{progress.done}/{progress.total}</span><button onClick={() => controller.current?.abort()}>Cancel</button></div>}
  </div>;
}
