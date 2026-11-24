import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useOperation } from '../../hooks/useOperation';
import { flushProjectSave, runProjectFileOperation } from '../../hooks/useProjectSave';
import { isProjectPathIncluded } from '../../lib/projectCategories';
import { toWorkspaceImages } from '../../lib/workspaceImages';
import type { ExportResize } from '../../services/export/exportResize';
import { buildExportPlan, exportPlanAsZip, exportPlanToDirectory, type ExportPlan, type ExportRecoveryJournal, type ExportScope } from '../../services/export/exportPlan';
import { downloadZipFile, saveZipToProjectExports } from '../../services/export/exportService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';

export type ExportMethod = 'project' | 'download' | 'directory';
/** What the last successful run produced: `path` is the ZIP in `exports/` or the folder name; `files` lists what was written to a folder. */
export type ExportRunResult = { count: number; method: ExportMethod; path: string; files?: string[] };

type Options = {
  /** Fixes the source (Build exports the Dataset only); without it the scope can be changed. */
  fixedSource?: ExportScope;
  /** Called after a successful run with the plan that was exported. */
  onExportComplete?: (plan: ExportPlan) => void;
  /** Element the Export operation is attached to (progress, Cancel). */
  root: RefObject<HTMLElement>;
  viewId: string;
  /** Optional downscale of the exported copies; keep the object stable (memoize it). Off by default. */
  resize?: ExportResize;
};

/**
 * Export plan and run for ExportTool and the Board's export dialog: builds the plan for the chosen source, writes it as a ZIP in
 * `exports/`, a ZIP download or a folder (with recovery journal), reports progress and supports Cancel.
 */
export function useExportRun({ fixedSource, onExportComplete, root, viewId, resize }: Options) {
  const sources = useProjectStore(state => state.sourceImages);
  const edits = useProjectStore(state => state.datasetItems);
  const dataset = useProjectStore(state => state.dataset);
  const blacklist = useProjectStore(state => state.taggingConfig.blacklist);
  const workspaceSettings = useProjectStore(state => state.workspaceSettings);
  const excludedProjectCategories = useMemo(() => workspaceSettings.excludedProjectCategories ?? [], [workspaceSettings.excludedProjectCategories]);
  const includedProjectCategories = useMemo(() => workspaceSettings.includedProjectCategories ?? [], [workspaceSettings.includedProjectCategories]);
  const directory = useUIStore(state => state.projectDirectoryHandle);
  const refresh = useUIStore(state => state.assetPreviewRefreshKey);
  const requestExplorerRefresh = useUIStore(state => state.requestExplorerRefresh);
  const notify = useUIStore(state => state.addNotification);
  const [scope, setScope] = useState<ExportScope>(fixedSource ?? 'dataset');
  const [method, setMethod] = useState<ExportMethod>('project');
  const [savedPath, setSavedPath] = useState('');
  const [result, setResult] = useState<ExportRunResult>();
  const [plan, setPlan] = useState<ExportPlan>();
  const [loadError, setLoadError] = useState('');
  const operation = useOperation('Export', root, viewId);
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
    void flushProjectSave().then(() => buildExportPlan({ scope, items, dataset, directory, blacklist, resize })).then(next => { if (!cancelled) setPlan(next); })
      .catch(reason => { if (!cancelled) setLoadError(reason instanceof Error ? reason.message : 'Unable to read export files'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, items, dataset, directory, blacklist, refresh, revision, busy, resize]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [busy]);
  const effectiveMethod: ExportMethod = method === 'project' && !directory ? 'download' : method;
  const cancel = () => controller.current?.abort();
  const refreshPlan = () => { setError(''); setRevision(value => value + 1); };
  const resetRecovery = () => { recoveryJournal.current = undefined; setFolderRecovery(undefined); setError(''); };
  const run = async () => {
    if (!plan?.entries.length || busy || loading) return;
    const snapshot = plan; const next = new AbortController(); controller.current = next;
    operation.start(() => next.abort(), snapshot.entries.length);
    const report = (done: number, total: number) => { setProgress({ done, total }); operation.progress(done, total); };
    setBusy(true); setError(''); setSavedPath(''); setResult(undefined); setProgress({ done: 0, total: snapshot.entries.length });
    try {
      let completedMessage = `Exported ${snapshot.entries.length} images and captions`;
      let outcome: ExportRunResult = { count: snapshot.entries.length, method: effectiveMethod, path: '' };
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
        outcome = { ...outcome, path: target.name, files: snapshot.entries.map(entry => entry.imageName) };
      } else {
        const blob = await exportPlanAsZip(snapshot, next.signal, report);
        if (effectiveMethod === 'project' && directory) {
          const saved = await runProjectFileOperation(() => saveZipToProjectExports(directory, blob, dataset.name || 'dataset'));
          setSavedPath(saved); requestExplorerRefresh();
          completedMessage = `Saved to ${saved}`;
          outcome = { ...outcome, path: saved };
        } else {
          downloadZipFile(blob, `${dataset.name || 'dataset'}.zip`);
          outcome = { ...outcome, path: `${dataset.name || 'dataset'}.zip` };
        }
      }
      operation.finish('completed', `${snapshot.entries.length} images and captions exported`);
      setResult(outcome);
      onExportComplete?.(snapshot);
      notify('success', completedMessage);
    } catch (reason) {
      const cancelled = next.signal.aborted || (reason instanceof Error && reason.name === 'AbortError');
      operation.finish(cancelled ? 'cancelled' : 'failed', cancelled ? 'Completed files remain in the destination.' : reason instanceof Error ? reason.message : 'Export failed');
      if (next.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')) setError(effectiveMethod === 'directory' ? 'Export cancelled. Files already written remain in the destination; retry to resume.' : 'Export cancelled.');
      else setError(reason instanceof Error ? reason.message : 'Export failed');
    } finally { setBusy(false); }
  };
  return {
    directory, dataset, scope, setScope, method, setMethod, effectiveMethod, plan, loading, loadError, busy, progress,
    error, savedPath, result, folderRecovery, run, cancel, refreshPlan, resetRecovery,
  };
}
