import type { BuildStage } from '../../types';
import { BUILD_STAGE_LABELS, type BuildStageSummaryEntry } from '../../lib/buildStageSummary';

const STATE_TEXT = { empty: 'Not started', 'in-progress': 'In progress', done: 'Done' } as const;
const STATE_DOT = { empty: 'border-border bg-background', 'in-progress': 'border-amber-500 bg-amber-500/30', done: 'border-emerald-600 bg-emerald-600 text-white' } as const;

type Props = { stages: BuildStageSummaryEntry[]; current: BuildStage; onSelect: (stage: BuildStage) => void };

/** Compact horizontal stage bar at the top of Build. */
export function BuildStepper({ stages, current, onSelect }: Props) {
  return <nav aria-label="Build stages" data-testid="build-stepper" className="border-b border-border bg-card px-3 py-2">
    <ol className="flex flex-wrap gap-1">
      {stages.map((stage, index) => <li key={stage.id} className="min-w-0 flex-1 basis-32">
        <button type="button" data-testid={`build-stage-${stage.id}`} data-state={stage.state} aria-current={current === stage.id ? 'step' : undefined}
          onClick={() => onSelect(stage.id)}
          className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs ${current === stage.id ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-secondary'}`}>
          <span aria-hidden className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${STATE_DOT[stage.state]}`}>{stage.state === 'done' ? '✓' : index + 1}</span>
          <span className="min-w-0"><span className="block font-medium">{stage.label}<span className="sr-only"> — {STATE_TEXT[stage.state]}</span></span>
            <span className="block truncate text-muted-foreground">{stage.counter}</span></span>
        </button>
      </li>)}
    </ol>
  </nav>;
}

/** Footer shown under the stage content: advances to the following stage. */
export function BuildNextStageFooter({ current, onNext }: { current: BuildStage; onNext: (stage: BuildStage) => void }) {
  const order: BuildStage[] = ['add', 'select', 'caption', 'check', 'export'];
  const next = order[order.indexOf(current) + 1];
  if (!next) return null;
  return <footer className="flex shrink-0 justify-end border-t border-border bg-card px-4 py-2">
    <button type="button" data-testid="build-next-stage" onClick={() => onNext(next)} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Next: {BUILD_STAGE_LABELS[next]} →</button>
  </footer>;
}
