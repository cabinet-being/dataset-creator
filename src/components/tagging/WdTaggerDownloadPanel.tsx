import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { cancelWdTaggerDownload, downloadWdTaggerModel } from '../../services/tagging/wdTaggerDownloadService';
import { WD_TAGGER_MODEL } from '../../services/tagging/wdTaggerModelManifest';

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const button = 'rounded border border-border px-2 py-1';

export function WdTaggerDownloadPanel({ className = '' }: { className?: string }) {
  const state = useLocalTaggerStore((store) => store.modelDownload);
  const model = WD_TAGGER_MODEL;
  const busy = state.status === 'downloading' || state.status === 'saving';
  const percent = state.total ? Math.min(100, Math.round(state.completed / state.total * 100)) : 0;
  const start = () => { void downloadWdTaggerModel(); };
  return <div data-testid="wd-tagger-download" className={`space-y-2 text-xs ${className}`}>
    <p className="font-medium">{model.name} · {megabytes(model.totalBytes)}</p>
    <p className="text-muted-foreground">Downloaded from Hugging Face only after you click. License: {model.license}. <a className="underline" href={model.sourceUrl} target="_blank" rel="noreferrer">Source</a> · <a className="underline" href={model.licenseUrl} target="_blank" rel="noreferrer">License</a></p>
    {!busy && state.status !== 'error' && state.status !== 'cancelled' && <button type="button" data-testid="wd-tagger-download-start" className={button} onClick={start}>Download {model.name} ({megabytes(model.totalBytes)})</button>}
    {busy && <div className="space-y-1">
      <div role="progressbar" data-testid="wd-tagger-download-progress" aria-label="Model download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded bg-secondary"><div className="h-full bg-primary" style={{ width: `${percent}%` }} /></div>
      <p className="text-muted-foreground">{state.status === 'saving' ? 'Saving model…' : `${megabytes(state.completed)} of ${megabytes(state.total)} (${percent}%)`}</p>
      {state.status === 'downloading' && <button type="button" data-testid="wd-tagger-download-cancel" className={button} onClick={cancelWdTaggerDownload}>Cancel</button>}
    </div>}
    {state.status === 'error' && <div className="space-y-1"><p role="alert" data-testid="wd-tagger-download-error" className="text-destructive">{state.error}</p><button type="button" data-testid="wd-tagger-download-retry" className={button} onClick={start}>Retry</button></div>}
    {state.status === 'cancelled' && <div className="space-y-1"><p className="text-muted-foreground">Download cancelled. Nothing was saved.</p><button type="button" data-testid="wd-tagger-download-retry" className={button} onClick={start}>Retry</button></div>}
    {state.status === 'done' && <p role="status" className="text-muted-foreground">Model downloaded and connected.</p>}
  </div>;
}
