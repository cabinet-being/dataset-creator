import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { QualityAction, QualityBucket, QualityHint, QualityMetric, QualityReport as QualityReportData, QualityStatus } from '../../services/quality/metrics';

type QualityReportProps = {
  report: QualityReportData;
  /** Human label for an item or candidate id (file name). Defaults to the id. */
  labelFor?: (id: string) => string;
  /** Called when the user applies a metric action; omit to show actions read-only. */
  onAction?: (metric: QualityMetric | QualityHint, action: QualityAction) => void;
  /** Which actions have a handler; when omitted every action shows an apply button (if onAction is set). */
  canApply?: (metric: QualityMetric | QualityHint, action: QualityAction) => boolean;
  /** Called when the user clicks an id in an action list. */
  onSelectId?: (id: string) => void;
  className?: string;
};

export const QUALITY_STATUS_TEXT: Record<QualityStatus, string> = { ok: 'Готово', warn: 'Є зауваження', fail: 'Не готово' };
const STATUS_CLASS: Record<QualityStatus, string> = {
  ok: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  fail: 'text-destructive',
};
const ACTION_PREVIEW = 8;

const StatusIcon = ({ metric }: { metric: Pick<QualityMetric, 'status' | 'evaluated'> }) => {
  if (!metric.evaluated) return <CircleSlash className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Не оцінено" />;
  if (metric.status === 'ok') return <CheckCircle2 className={cn('h-4 w-4 shrink-0', STATUS_CLASS.ok)} aria-label="Добре" />;
  if (metric.status === 'warn') return <AlertTriangle className={cn('h-4 w-4 shrink-0', STATUS_CLASS.warn)} aria-label="Попередження" />;
  return <XCircle className={cn('h-4 w-4 shrink-0', STATUS_CLASS.fail)} aria-label="Помилка" />;
};

const Sparkline = ({ series }: { series: number[] }) => {
  if (series.length < 2) return null;
  const width = 120;
  const height = 28;
  const points = series.map((value, index) => `${(index / (series.length - 1)) * width},${height - Math.max(0, Math.min(1, value)) * height}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="text-primary" role="img" aria-label="Крива насичення покриття">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

type RowProps = { labelFor: (id: string) => string; onAction?: QualityReportProps['onAction']; canApply?: QualityReportProps['canApply']; onSelectId?: QualityReportProps['onSelectId'] };

const ActionBlock = ({ metric, action, labelFor, onAction, canApply, onSelectId }: RowProps & {
  metric: QualityMetric | QualityHint; action: QualityAction;
}) => {
  const [expanded, setExpanded] = useState(false);
  const values = action.ids?.length ? action.ids : action.tags ?? [];
  const isIds = Boolean(action.ids?.length);
  const visible = expanded ? values : values.slice(0, ACTION_PREVIEW);
  return (
    <div className="mt-1 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{action.label} ({values.length})</span>
        {onAction && (canApply?.(metric, action) ?? true) && (
          <button type="button" onClick={() => onAction(metric, action)} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-secondary">
            Застосувати
          </button>
        )}
      </div>
      <ul className="flex flex-wrap gap-1">
        {visible.map((value) => (
          <li key={value}>
            {isIds && onSelectId
              ? <button type="button" onClick={() => onSelectId(value)} className="max-w-[14rem] truncate rounded bg-secondary px-1.5 py-0.5 text-[11px] hover:underline">{labelFor(value)}</button>
              : <span className="block max-w-[14rem] truncate rounded bg-secondary px-1.5 py-0.5 text-[11px]">{isIds ? labelFor(value) : value}</span>}
          </li>
        ))}
        {values.length > ACTION_PREVIEW && (
          <li>
            <button type="button" onClick={() => setExpanded(!expanded)} className="px-1 text-[11px] text-muted-foreground underline">
              {expanded ? 'Згорнути' : `Ще ${values.length - ACTION_PREVIEW}`}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
};

const BucketBars = ({ buckets, unlabeled, evaluated }: { buckets: QualityBucket[]; unlabeled?: number; evaluated: boolean }) => {
  if (!evaluated) return <p className="text-[11px] italic text-muted-foreground">Вісь не оцінено, розподіл не показано.</p>;
  const scale = Math.max(1, ...buckets.map((bucket) => Math.max(bucket.count, bucket.recommended ?? 0)));
  return (
    <div className="mt-1 space-y-1">
      {buckets.map((bucket) => {
        const short = bucket.recommended !== undefined && bucket.count < bucket.recommended;
        return (
          <div key={bucket.id} data-bucket={bucket.id} className="flex items-center gap-2 text-[11px]" title={bucket.recommendedFrom}>
            <span className="w-28 shrink-0 truncate">{bucket.label}</span>
            <div className="relative h-2 flex-1 rounded bg-secondary">
              <div className={cn('h-2 rounded', short ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${(bucket.count / scale) * 100}%` }} />
              {bucket.recommended !== undefined && <div className="absolute top-[-2px] h-3 w-px bg-foreground" style={{ left: `${(bucket.recommended / scale) * 100}%` }} aria-hidden="true" />}
            </div>
            <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">{bucket.count}{bucket.recommended !== undefined && ` з ${bucket.recommended}`}</span>
          </div>
        );
      })}
      {!!unlabeled && <p className="text-[11px] text-muted-foreground">Без ознаки осі: {unlabeled} (не враховано в розподілі)</p>}
    </div>
  );
};

const MetricRow = ({ metric, ...rest }: RowProps & { metric: QualityMetric }) => (
  <li className="flex gap-2 border-t border-border py-2 first:border-t-0" data-metric={metric.id} data-status={metric.evaluated ? metric.status : 'not-evaluated'}>
    <StatusIcon metric={metric} />
    <div className="min-w-0 flex-1 space-y-0.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-xs font-medium">{metric.title}</span>
        <span className={cn('text-xs tabular-nums', metric.evaluated ? STATUS_CLASS[metric.status] : 'text-muted-foreground')}>{metric.display}</span>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{metric.explanation}</p>
      {metric.series && <Sparkline series={metric.series} />}
      {metric.buckets && <BucketBars buckets={metric.buckets} unlabeled={metric.unlabeled} evaluated={metric.evaluated} />}
      {metric.action && <ActionBlock metric={metric} action={metric.action} {...rest} />}
    </div>
  </li>
);

export const QualityReport = ({ report, labelFor = (id) => id, onAction, canApply, onSelectId, className }: QualityReportProps) => {
  const [insightsOpen, setInsightsOpen] = useState(true);
  const rowProps = { labelFor, onAction, canApply, onSelectId };
  return (
    <section className={cn('space-y-3 text-sm', className)} aria-label="Звіт якості датасету">
      <header role="status" className="flex items-center gap-2 rounded-lg border border-border px-3 py-2" data-readiness={report.readiness}>
        <StatusIcon metric={{ status: report.readiness, evaluated: true }} />
        <span className={cn('font-semibold', STATUS_CLASS[report.readiness])}>{QUALITY_STATUS_TEXT[report.readiness]}</span>
        <span className="text-xs text-muted-foreground">готовність = найгірша з обов'язкових перевірок</span>
      </header>
      <div>
        <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Обов'язкові перевірки</h3>
        <ul>{report.required.map((metric) => <MetricRow key={metric.id} metric={metric} {...rowProps} />)}</ul>
      </div>
      <div>
        <button
          type="button"
          onClick={() => setInsightsOpen(!insightsOpen)}
          aria-expanded={insightsOpen}
          className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground"
        >
          {insightsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Різноманіття, покриття й підписи
        </button>
        {insightsOpen && <ul>{report.insights.map((metric) => <MetricRow key={metric.id} metric={metric} {...rowProps} />)}</ul>}
      </div>
      {!!report.coverage?.length && (
        <div data-section="profile-coverage">
          <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Покриття за профілем</h3>
          <ul>{report.coverage.map((metric) => <MetricRow key={metric.id} metric={metric} {...rowProps} />)}</ul>
        </div>
      )}
      {!!report.hints?.length && (
        <div data-section="hints">
          <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Що зробити</h3>
          <ul>
            {report.hints.map((hint) => (
              <li key={hint.id} className="border-t border-border py-2 first:border-t-0" data-hint={hint.id}>
                <p className="text-xs font-medium">{hint.text}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">{hint.explanation}</p>
                {hint.action && <ActionBlock metric={hint} action={hint.action} {...rowProps} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
