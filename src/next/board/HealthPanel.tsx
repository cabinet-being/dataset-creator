import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, XCircle } from 'lucide-react';
import { ModelDownloadPrompt } from '../../components/workspace/ModelDownloadPrompt';
import { cn } from '../../lib/utils';
import type { QualityAction, QualityBucket, QualityHint, QualityMetric, QualityReport, QualityStatus } from '../../services/quality/metrics';
import type { SimilarityFeatures } from '../../services/similarity/useSimilarityFeatures';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const STATUS_CLASS: Record<QualityStatus, string> = {
  ok: 'text-emerald-700 dark:text-emerald-300', warn: 'text-amber-700 dark:text-amber-300', fail: 'text-destructive',
};
const STATUS_WORD: Record<QualityStatus, string> = { ok: 'OK', warn: 'Check', fail: 'Fix' };
const round = (value: number) => (Math.round(value * 10) / 10).toString();

const StatusMark = ({ metric }: { metric: Pick<QualityMetric, 'status' | 'evaluated'> }) => {
  if (!metric.evaluated) return <CircleSlash aria-label="Not evaluated" className="h-4 w-4 shrink-0 text-muted-foreground" />;
  const Icon = metric.status === 'ok' ? CheckCircle2 : metric.status === 'warn' ? AlertTriangle : XCircle;
  return <Icon aria-label={STATUS_WORD[metric.status]} className={cn('h-4 w-4 shrink-0', STATUS_CLASS[metric.status])} />;
};

const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) =>
  <section data-health-section={id} className="space-y-2"><h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>{children}</section>;

type Props = {
  /** False until the first Assemble: only an explanation is shown. */
  assembled: boolean;
  report: QualityReport;
  /** Dataset images the report was made from. */
  datasetCount: number;
  features: Pick<SimilarityFeatures, 'basis' | 'modelState' | 'progress' | 'loadModel'>;
  /** Puts a local filter on the grid: only these frames, with a label for the chip. */
  onShowIds: (label: string, ids: string[]) => void;
  /** Applies a hint's action (tag removal, or selecting the flagged files in the grid). */
  onApplyAction: (hint: QualityHint, action: QualityAction) => void;
  canApplyAction: (hint: QualityHint, action: QualityAction) => boolean;
};

function CoverageBars({ metric, onShowIds }: { metric: QualityMetric; onShowIds: Props['onShowIds'] }) {
  const buckets = metric.buckets ?? [];
  const scale = Math.max(1, ...buckets.map(bucket => Math.max(bucket.count, bucket.recommended ?? 0)));
  const axis = metric.title.replace(/^Coverage:\s*/, '');
  const row = (bucket: QualityBucket) => {
    const lacking = bucket.recommended !== undefined && bucket.count < bucket.recommended;
    const bar = <span className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-left text-xs">{bucket.label}</span>
      <span aria-hidden className="relative h-2 min-w-0 flex-1 rounded-full bg-secondary">
        <span className={cn('absolute inset-y-0 left-0 rounded-full', lacking ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${(bucket.count / scale) * 100}%` }} />
        {bucket.recommended !== undefined && <span className="absolute inset-y-[-2px] w-px bg-foreground/60" style={{ left: `${(bucket.recommended / scale) * 100}%` }} />}
      </span>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{bucket.count}{bucket.recommended !== undefined ? ` / ${bucket.recommended}` : ''}</span>
    </span>;
    return <li key={bucket.id} data-coverage-bucket={bucket.id}>
      {bucket.ids?.length
        ? <button type="button" aria-label={`Show ${bucket.count} frames: ${axis}, ${bucket.label}`} onClick={() => onShowIds(`${axis}: ${bucket.label}`, bucket.ids!)}
          className={cn('block min-h-[32px] w-full rounded-md px-1 hover:bg-secondary', focusRing)}>{bar}</button>
        : <div className="min-h-[32px] px-1 py-1">{bar}</div>}
    </li>;
  };
  return <ul className="space-y-0.5">{buckets.map(row)}</ul>;
}

/** Right column of the Board: how varied and ready the dataset is, and what to do next. Every list item can filter the grid. */
export function HealthPanel({ assembled, report, datasetCount, features, onShowIds, onApplyAction, canApplyAction }: Props) {
  const [downloadDismissed, setDownloadDismissed] = useState(false);
  if (!assembled) {
    return <aside data-health aria-label="Health" className="w-full shrink-0 space-y-3 border-t border-border p-4 md:w-80 md:overflow-auto md:border-l md:border-t-0">
      <h2 className="text-sm font-semibold">Health</h2>
      <p data-health-intro className="text-sm text-muted-foreground">
        Assemble the dataset to see how varied it is, whether it is ready to export, which kinds of shots are missing and what to do next.
      </p>
    </aside>;
  }
  const effective = report.insights.find(metric => metric.id === 'effective-size');
  const saturation = report.insights.find(metric => metric.id === 'saturation');
  const coverage = (report.coverage ?? []).filter(metric => metric.evaluated && metric.buckets?.length);
  const hints = report.hints ?? [];
  const analysing = features.modelState === 'checking' || features.modelState === 'loading';

  return <aside data-health aria-label="Health" className="w-full shrink-0 space-y-5 border-t border-border p-4 md:w-80 md:overflow-auto md:border-l md:border-t-0">
    <h2 className="text-sm font-semibold">Health</h2>

    <Section id="effective-size" title="Effective size">
      {effective?.evaluated && effective.value !== null
        ? <div data-effective-size className="space-y-1">
          <p className={cn('text-lg font-semibold tabular-nums', STATUS_CLASS[effective.status])}>{datasetCount} {datasetCount === 1 ? 'image' : 'images'} ≈ {round(effective.value)} distinct</p>
          <p className="text-xs text-muted-foreground">{effective.explanation}</p>
        </div>
        : <div className="space-y-1 text-sm text-muted-foreground">
          {analysing
            ? <p role="status">Analysing images{features.progress.total ? ` (${features.progress.completed} / ${features.progress.total})` : ''}…</p>
            : <p>{effective?.explanation ?? 'Effective size is not available yet.'}</p>}
          {features.modelState === 'missing' && !downloadDismissed && <ModelDownloadPrompt testId="health-model-download" onConfirm={features.loadModel} onCancel={() => setDownloadDismissed(true)} />}
        </div>}
    </Section>

    <Section id="required" title="Required checks">
      <ul className="space-y-1">
        {report.required.map(metric => {
          const ids = metric.action?.ids ?? [];
          const row = <span className="flex items-start gap-2 text-left">
            <StatusMark metric={metric} />
            <span className="min-w-0 flex-1"><span className="block text-sm">{metric.title}</span>
              <span className={cn('block text-xs', metric.evaluated ? STATUS_CLASS[metric.status] : 'text-muted-foreground')}>{metric.display}</span></span>
          </span>;
          return <li key={metric.id} data-required-check={metric.id} data-status={metric.evaluated ? metric.status : 'not-evaluated'} title={metric.explanation}>
            {ids.length
              ? <button type="button" aria-label={`Show ${ids.length} frames: ${metric.title}`} onClick={() => onShowIds(metric.title, ids)}
                className={cn('block min-h-[44px] w-full rounded-md px-1 py-1 hover:bg-secondary', focusRing)}>{row}</button>
              : <div className="px-1 py-1">{row}</div>}
          </li>;
        })}
      </ul>
    </Section>

    {coverage.length > 0 && <Section id="coverage" title="Coverage">
      <div className="space-y-3">
        {coverage.map(metric => <div key={metric.id} data-coverage-axis={metric.id} className="space-y-1">
          <p className="text-sm">{metric.title.replace(/^Coverage:\s*/, '')}</p>
          <CoverageBars metric={metric} onShowIds={onShowIds} />
        </div>)}
      </div>
    </Section>}

    <Section id="next" title="What to do next">
      {hints.length === 0
        ? <p data-health-nothing className="text-sm text-muted-foreground">Nothing to fix right now.</p>
        : <ul className="space-y-2">
          {hints.map(hint => <li key={hint.id} data-hint={hint.id} className="space-y-1 text-sm" title={hint.explanation}>
            <p>{hint.text}</p>
            {hint.action && canApplyAction(hint, hint.action) && <button type="button" data-hint-action onClick={() => onApplyAction(hint, hint.action!)}
              className={cn('min-h-[44px] rounded-md border border-border px-3 text-xs hover:bg-secondary', focusRing)}>{hint.action.label}</button>}
          </li>)}
        </ul>}
    </Section>

    {saturation && <Section id="saturation" title="Saturation">
      <p data-saturation className={cn('text-sm', saturation.evaluated ? STATUS_CLASS[saturation.status] : 'text-muted-foreground')}>{saturation.display}</p>
      <p className="text-xs text-muted-foreground">{saturation.explanation}</p>
    </Section>}
  </aside>;
}
