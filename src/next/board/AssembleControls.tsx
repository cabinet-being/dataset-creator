import { Loader2, PackageCheck, RotateCw, Wand2, X } from 'lucide-react';
import type { BuildAssemblyStep, useBuildAutoPipeline } from '../../components/build/useBuildAutoPipeline';
import { ModelDownloadPrompt } from '../../components/workspace/ModelDownloadPrompt';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type { BuildSession } from '../../types';

type Pipeline = ReturnType<typeof useBuildAutoPipeline>;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const STEP_LABELS: Record<BuildAssemblyStep, string> = {
  understanding: 'Understanding images', similarity: 'Comparing images', selecting: 'Choosing the best of each group', applying: 'Adding to the dataset',
};

/** Text of what the pipeline is doing now, or null when idle. */
export const describePipelineWork = (phase: Pipeline['phase'], step: Pipeline['step']): string | null => {
  if (phase === 'triage') return 'Checking quality';
  if (phase === 'tagging') return 'Describing images';
  if (phase === 'assembly') return step ? STEP_LABELS[step] : 'Preparing';
  return null;
};

type Props = {
  pipeline: Pipeline;
  session: BuildSession;
  /** Frames in the ticked Sources folders. */
  sourceCount: number;
  /** Images (with their captions) the export would contain. */
  exportCount: number;
  busy: boolean;
  onSizeModeChange: (mode: 'auto' | 'target', target?: number) => void;
  onExport: () => void;
};

/** The primary action of the Board header: Assemble, its progress with Cancel, and Re-assemble + Export afterwards. */
export function AssembleControls({ pipeline, session, sourceCount, exportCount, busy, onSizeModeChange, onExport }: Props) {
  const work = describePipelineWork(pipeline.phase, pipeline.step);
  const assembled = Boolean(session.auto?.assembledAt);
  const auto = session.profile.sizeMode === 'auto';
  const { completed, total } = pipeline.progress;
  const disabled = busy || pipeline.phase !== 'idle' || sourceCount === 0;
  const title = sourceCount === 0 ? 'Tick a Sources folder with images first' : undefined;

  return <div data-assemble className="flex flex-wrap items-center gap-2">
    {work
      ? <div role="status" data-assemble-progress className="flex min-h-[44px] items-center gap-3 rounded-md border border-border px-3 text-sm">
        <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
        <span data-assemble-phase>{work}</span>
        {total > 0 && <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <progress aria-label={work} value={completed} max={total} className="h-1.5 w-24" />{completed} / {total}
        </span>}
        <Button variant="outline" size="sm" data-assemble-cancel className="min-h-[44px]" onClick={pipeline.cancel}><X className="h-4 w-4" />Cancel</Button>
      </div>
      : <>
        <div role="group" aria-label="Dataset size" className="flex items-center gap-2 text-sm">
          <label className="flex items-center gap-1 text-muted-foreground">Size
            <select data-size-mode value={auto ? 'auto' : 'target'} disabled={disabled}
              onChange={event => onSizeModeChange(event.target.value === 'auto' ? 'auto' : 'target')}
              className={cn('min-h-[44px] rounded-md border border-input bg-background px-2 text-foreground', focusRing)}>
              <option value="auto">Auto</option><option value="target">Target</option>
            </select>
          </label>
          {!auto && <label className="flex items-center gap-1 text-muted-foreground">
            <span className="sr-only">Target images</span>
            <input data-target-size type="number" min={1} value={session.profile.target} disabled={disabled}
              onChange={event => onSizeModeChange('target', Math.max(1, Math.floor(Number(event.target.value) || 1)))}
              className={cn('min-h-[44px] w-20 rounded-md border border-input bg-background px-2 text-foreground', focusRing)} />
          </label>}
        </div>
        {assembled
          ? <>
            <Button variant="outline" data-reassemble className="min-h-[44px]" disabled={disabled} title={title} onClick={() => pipeline.startAssemble()}><RotateCw className="h-4 w-4" />Re-assemble</Button>
            <Button data-export className="min-h-[44px]" disabled={busy || exportCount === 0} onClick={onExport}><PackageCheck className="h-4 w-4" />Export {exportCount} {exportCount === 1 ? 'pair' : 'pairs'}</Button>
          </>
          : <Button data-assemble-button className="min-h-[44px]" disabled={disabled} title={title} onClick={() => pipeline.startAssemble()}><Wand2 className="h-4 w-4" />Assemble dataset</Button>}
      </>}
    {pipeline.modelDownloadFor && <div className="basis-full">
      <ModelDownloadPrompt testId="next-model-download" onConfirm={pipeline.confirmModelDownload} onCancel={pipeline.dismissModelDownload} />
    </div>}
  </div>;
}

/** One line over the grid with the numbers of the last Assemble (only what the pipeline recorded). */
export function AssembleSummary({ session }: { session: BuildSession }) {
  const summary = session.auto?.assemblySummary;
  if (!summary) return null;
  const parts = [
    `${summary.images} ${summary.images === 1 ? 'image' : 'images'}${summary.groups === undefined ? '' : ` → ${summary.groups} ${summary.groups === 1 ? 'group' : 'groups'}`}`,
    `${summary.added} added`,
    ...(summary.duplicates ? [`${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'}`] : []),
    ...(summary.outOnQuality ? [`${summary.outOnQuality} out on quality`] : []),
  ];
  return <p data-assemble-summary className="border-b border-border px-3 py-2 text-sm text-muted-foreground">{parts.join(' · ')}</p>;
}
