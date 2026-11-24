import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { BrickColumnCount, WorkspaceSettings } from '../../types';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { WdTaggerDownloadPanel } from '../tagging/WdTaggerDownloadPanel';
import { hasVideoModel } from '../../services/video/videoCache';
import { SIMILARITY_STRICTNESS, type SimilarityStrictnessId } from '../../services/similarity/similarityLevels';

type Props = {
  open: boolean; onOpenChange: (open: boolean) => void;
  theme: 'system' | 'light' | 'dark'; onThemeChange: (theme: Props['theme']) => void;
  density: string; onDensityChange: (density: string) => void;
  settings: WorkspaceSettings; onSettingsChange: (settings: Partial<WorkspaceSettings>) => void;
  onPickTaggerFile: (kind: 'model' | 'tags') => void;
  onRestoreTaggerAccess: () => void;
  onShortcuts: () => void;
  /** Absent in the next UI, which has no tool tabs: the tool shortcuts are then hidden. */
  onOpenTool?: (tool: 'tagging' | 'video') => void;
  /** Similarity strictness of the open project (`profile.similarityStrictness`); shown only when a project is open. */
  strictness?: { value: SimilarityStrictnessId; onChange: (value: SimilarityStrictnessId) => void };
};
export function WorkspaceSettingsDialog({ open, onOpenChange, theme, onThemeChange, density, onDensityChange, settings, onSettingsChange, onPickTaggerFile, onRestoreTaggerAccess, onShortcuts, onOpenTool, strictness }: Props) {
  const taggerStatus = useLocalTaggerStore(state => state.status);
  const taggerMessage = useLocalTaggerStore(state => state.message);
  const savedFileNames = useLocalTaggerStore(state => state.savedFileNames);
  const [videoStatus, setVideoStatus] = useState('Checking cache…');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void hasVideoModel().then(cached => { if (!cancelled) setVideoStatus(cached ? 'Model cached' : 'Not downloaded'); }).catch(error => { if (!cancelled) setVideoStatus(error instanceof Error ? error.message : 'Cache unavailable'); });
    return () => { cancelled = true; };
  }, [open]);
  const captionState = taggerStatus === 'running' ? 'Running' : taggerStatus === 'ready' ? 'Ready' : taggerStatus === 'loading' ? 'Connecting…' : taggerStatus === 'not-ready' ? 'Needs attention' : savedFileNames.model && savedFileNames.tags ? 'Saved files available' : 'Not configured';
  const closeThen = (action: () => void) => { onOpenChange(false); action(); };
  const control = 'rounded-md border border-border bg-background px-3 py-2 text-sm';
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-[2101] max-h-[90vh] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-card p-5 shadow-xl">
      <div className="mb-5 flex items-center justify-between"><Dialog.Title className="text-lg font-semibold">Settings</Dialog.Title><Dialog.Close aria-label="Close Settings" className="rounded p-2"><X size={18} /></Dialog.Close></div>
      <Dialog.Description className="sr-only">Appearance, shortcuts and local models</Dialog.Description>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-2 text-sm">Theme<select className={control} value={theme} onChange={event => onThemeChange(event.target.value as Props['theme'])}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label className="grid gap-2 text-sm">Density<select className={control} value={density} onChange={event => onDensityChange(event.target.value)}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
      </div>
      <button className={`${control} mt-3`} onClick={() => closeThen(onShortcuts)}>Keyboard shortcuts</button>
      <section className="mt-5 border-t border-border pt-4">
        <h2 className="font-medium">Interface</h2>
        {strictness && <label className="mt-3 grid gap-2 text-sm">Similarity strictness (this project)
          <select aria-label="Similarity strictness" className={control} value={strictness.value} onChange={event => strictness.onChange(event.target.value as SimilarityStrictnessId)}>
            {SIMILARITY_STRICTNESS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
      </section>
      <details className="mt-4 text-sm"><summary>Layout options</summary><label className="mt-3 grid gap-2">Masonry columns<select className={control} value={settings.brickColumnCount ?? 'auto'} onChange={event => onSettingsChange({ brickColumnCount: event.target.value === 'auto' ? 'auto' : Number(event.target.value) as BrickColumnCount })}>{['auto', 1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value === 'auto' ? 'Auto' : `${value} columns`}</option>)}</select></label></details>
      <section className="mt-5 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">Caption model</h2><span role="status" className="text-xs text-muted-foreground">{captionState}</span></div>
        {taggerStatus === 'not-ready' && <p className="mt-2 text-sm text-destructive">{taggerMessage}</p>}
        <WdTaggerDownloadPanel className="mt-3" />
        <div className="mt-3 space-y-3">{(['model', 'tags'] as const).map(kind => <div key={kind} className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="text-sm">{kind === 'model' ? 'model.onnx' : 'selected_tags.csv'}</p><p className="truncate text-xs text-muted-foreground">{savedFileNames[kind] ?? 'No file selected'}</p></div><button className={control} disabled={taggerStatus === 'running'} onClick={() => onPickTaggerFile(kind)}>Choose {kind}</button></div>)}</div>
        <div className="mt-3 flex gap-2"><button className={control} disabled={!savedFileNames.model || !savedFileNames.tags || taggerStatus === 'loading' || taggerStatus === 'running'} onClick={onRestoreTaggerAccess}>Reconnect</button>{onOpenTool && <button className={control} onClick={() => closeThen(() => onOpenTool('tagging'))}>Open Caption</button>}</div>
      </section>
      <section className="mt-5 border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">Image features model (DINOv2)</h2><span role="status" className="text-xs text-muted-foreground">{videoStatus}</span></div><p className="mt-2 text-xs text-muted-foreground">Local model used for image similarity, quality checks and video frame analysis.</p>{onOpenTool && <button className={`${control} mt-3`} onClick={() => closeThen(() => onOpenTool('video'))}>Open Video Frames</button>}</section>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
