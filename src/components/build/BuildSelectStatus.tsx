import type { ReactNode } from 'react';
import { Settings } from 'lucide-react';

type Props = {
  datasetCount: number;
  target: number;
  /** Images still waiting for the quality analysis. */
  analysisLeft: number;
  analysisRunning: boolean;
  analysisPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  errors: number;
  onShowErrors: () => void;
  /** Contents of the settings popover. */
  settings: ReactNode;
};

/** One status line for Select: Dataset size, analysis progress with Pause/Resume, errors, and the settings popover. */
export function BuildSelectStatus({ datasetCount, target, analysisLeft, analysisRunning, analysisPaused, onPause, onResume, errors, onShowErrors, settings }: Props) {
  return <div data-testid="build-select-status" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
    <p role="status" className="flex flex-wrap items-center gap-1">
      <strong>Dataset {datasetCount} / {target}</strong>
      <span>· {Math.max(0, target - datasetCount)} to add</span>
      {analysisLeft > 0 && <span className="text-muted-foreground">· {analysisPaused ? 'Analysis paused' : 'Analyzing'} {analysisLeft} left</span>}
      {analysisRunning && <button type="button" className="underline" onClick={onPause}>Pause</button>}
      {analysisPaused && <button type="button" className="underline" onClick={onResume}>Resume</button>}
      {errors > 0 && <span>· <button type="button" className="text-destructive underline" onClick={onShowErrors}>{errors} {errors === 1 ? 'error' : 'errors'}</button></span>}
    </p>
    <details className="relative ml-auto" data-build-settings>
      <summary aria-label="Settings" title="Settings" className="flex cursor-pointer list-none items-center rounded border border-border p-1.5"><Settings className="h-4 w-4" /></summary>
      <div className="absolute right-0 top-full z-20 mt-1 flex w-72 flex-col gap-2 rounded border border-border bg-popover p-3 text-popover-foreground shadow-lg">{settings}</div>
    </details>
  </div>;
}
