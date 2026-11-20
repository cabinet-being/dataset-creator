import type { BuildReviewView, BuildSession } from '../../types';

type Filter = BuildSession['filter'];
type Props = {
  filter: Filter;
  onFilter: (filter: Filter) => void;
  counts: { all: number; unresolved: number; needsDecision: number; accepted: number; rejected: number; candidates: number; picks: number; errors: number };
  /** A candidate list exists in the session. */
  hasCandidates: boolean;
  view: BuildReviewView;
  onView: (view: BuildReviewView) => void;
  /** Bulk targets for the current filter; null where bulk actions make no sense. */
  bulk: { accept: number; reject: number } | null;
  busy: boolean;
  onAcceptAll: () => void;
  onRejectAll: () => void;
};

const VIEWS: Array<[BuildReviewView, string]> = [['list', 'List'], ['grid', 'Grid'], ['clusters', 'Clusters']];

/** Segmented queue filter with counts, contextual bulk actions and the List/Grid/Clusters toggle. */
export function BuildReviewBar({ filter, onFilter, counts, hasCandidates, view, onView, bulk, busy, onAcceptAll, onRejectAll }: Props) {
  const options: Array<{ value: Filter; label: string; count: number }> = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'unresolved', label: 'Undecided', count: counts.unresolved },
    { value: 'needs-decision', label: 'Flagged', count: counts.needsDecision },
    { value: 'accepted', label: 'Accepted', count: counts.accepted },
    { value: 'rejected', label: 'Rejected', count: counts.rejected },
    ...(hasCandidates || filter === 'shortlisted' ? [{ value: 'shortlisted' as const, label: 'Candidates', count: counts.candidates }] : []),
    ...(counts.picks > 0 || filter === 'picked' ? [{ value: 'picked' as const, label: 'Picks', count: counts.picks }] : []),
    ...(counts.errors > 0 || filter === 'errors' ? [{ value: 'errors' as const, label: 'Errors', count: counts.errors }] : []),
  ];
  return <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
    <div role="radiogroup" aria-label="Queue filter" className="flex flex-wrap overflow-hidden rounded border border-border">
      {options.map(({ value, label, count }) => <button key={value} type="button" role="radio" aria-checked={filter === value} data-filter={value} onClick={() => onFilter(value)}
        className={`px-2.5 py-1.5 ${filter === value ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}>{label} {count}</button>)}
    </div>
    {bulk && (bulk.accept > 0 || bulk.reject > 0) && <>
      <button type="button" disabled={busy || !bulk.accept} onClick={onAcceptAll} className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40">Accept all {bulk.accept}</button>
      <button type="button" disabled={busy || !bulk.reject} onClick={onRejectAll} className="rounded border border-border px-2 py-1 disabled:opacity-40">Reject all {bulk.reject}</button>
    </>}
    <div role="group" aria-label="Review view" className="ml-auto flex overflow-hidden rounded border border-border text-sm">
      {VIEWS.map(([value, label]) => <button key={value} type="button" data-testid="build-view-toggle" data-view={value} aria-pressed={view === value} onClick={() => onView(value)} className={`px-3 py-1.5 ${view === value ? 'bg-primary text-primary-foreground' : ''}`}>{label}</button>)}
    </div>
  </div>;
}
