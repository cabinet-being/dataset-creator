import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { ImageIcon } from 'lucide-react';
import type { BuildReviewDecision, BuildSession } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useSizedPreviewUrls } from '../../lib/previewUrlCache';
import { getBuildAssetId } from '../../services/build/buildSessionService';
import { getBuildTriageGroup } from '../../services/build/buildTriageService';
import { useCommands } from '../workspace/Commands';

type GridState = 'accepted' | 'rejected' | 'undecided' | 'flagged';

type Props = {
  active: boolean;
  root: RefObject<HTMLElement>;
  /** Items of the current queue (already filtered by the Queue filter). */
  queue: WorkspaceImage[];
  session: BuildSession;
  cursor: number;
  busy: boolean;
  /** Multi-selection by Build asset id, owned by the Build workspace. */
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onCursor: (index: number) => void;
  onCommit: (entries: Array<{ item: WorkspaceImage; decision: BuildReviewDecision }>) => Promise<void> | void;
  /** Leaves the grid and shows the item in the list. */
  onOpenItem: (index: number) => void;
  /** Build asset ids on the active shortlist. */
  shortlisted?: ReadonlySet<string>;
};

const PAGE = 120;
const itemName = (item: WorkspaceImage) => item.originalFileName || item.fileName;
const STATE_LABEL: Record<GridState, string> = { accepted: 'Accepted', rejected: 'Rejected', undecided: 'Undecided', flagged: 'Flagged' };
const STATE_CLASS: Record<GridState, string> = {
  accepted: 'bg-emerald-600 text-white', rejected: 'bg-red-600 text-white', undecided: 'bg-secondary text-foreground', flagged: 'bg-amber-500 text-white',
};

const gridState = (session: BuildSession, item: WorkspaceImage): { state: GridState; reason: string } => {
  const record = session.records[getBuildAssetId(item)];
  if (!record) return { state: 'undecided', reason: 'No decision yet' };
  const reasons = record.triage?.reasons.map((reason) => reason.message).join('; ') ?? '';
  if (record.decision === 'accepted') return { state: 'accepted', reason: 'Accepted by you' };
  if (record.decision === 'skipped') return { state: 'rejected', reason: 'Rejected by you' };
  if (record.decision === 'deferred') return { state: 'flagged', reason: reasons ? `Deferred by you. ${reasons}` : 'Deferred by you' };
  const group = getBuildTriageGroup(record);
  if (group === 'accepted') return { state: 'accepted', reason: reasons ? `Proposed: ${reasons}` : 'Proposed accepted' };
  if (group === 'rejected') return { state: 'rejected', reason: reasons ? `Proposed: ${reasons}` : 'Proposed rejected' };
  if (group === 'needs-decision') return { state: 'flagged', reason: reasons ? `Needs a decision: ${reasons}` : 'Needs a decision' };
  return { state: 'undecided', reason: 'Not analyzed yet' };
};

/** Thumbnail grid of the current Select queue with multi-select and bulk decisions. */
export function BuildGridView({ active, root, queue, session, cursor, busy, selected, onSelectedChange, onCursor, onCommit, onOpenItem, shortlisted }: Props) {
  const [limit, setLimit] = useState(PAGE);
  const anchor = useRef(cursor);
  const grid = useRef<HTMLUListElement>(null);
  const shown = Math.min(queue.length, Math.max(limit, Math.ceil((cursor + 1) / PAGE) * PAGE));
  const visible = useMemo(() => queue.slice(0, shown), [queue, shown]);
  const previews = useSizedPreviewUrls(useMemo(() => visible.filter((item) => item.kind !== 'video'), [visible]), 'thumb', { focusId: queue[cursor]?.id });
  const current = queue[cursor];

  const targets = () => {
    const picked = queue.filter((item) => selected.has(getBuildAssetId(item)));
    return picked.length ? picked : current ? [current] : [];
  };
  const decide = (decision: BuildReviewDecision) => {
    if (busy) return;
    const items = targets().filter((item) => decision !== 'accepted' || item.kind !== 'video');
    if (items.length) void onCommit(items.map((item) => ({ item, decision })));
  };
  useCommands([
    { id: 'build.grid.accept', label: 'Build grid: Accept selected', shortcut: 'A', active, disabled: busy || !targets().length, run: () => decide('accepted') },
    { id: 'build.grid.reject', label: 'Build grid: Reject selected', shortcut: 'X', active, disabled: busy || !targets().length, run: () => decide('skipped') },
  ], () => root.current);

  const focusCell = (index: number) => requestAnimationFrame(() => {
    const cell = grid.current?.querySelectorAll<HTMLElement>('[data-grid-cell]')[index];
    cell?.focus(); cell?.scrollIntoView?.({ block: 'nearest' });
  });
  const select = (index: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const id = getBuildAssetId(queue[index]);
    if (event.shiftKey) {
      const from = Math.max(0, Math.min(anchor.current, queue.length - 1));
      onSelectedChange(new Set(queue.slice(Math.min(from, index), Math.max(from, index) + 1).map(getBuildAssetId)));
    } else if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id);
      onSelectedChange(next); anchor.current = index;
    } else { onSelectedChange(new Set()); anchor.current = index; }
    onCursor(index);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (!(event.key in keys) && event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== ' ' && event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).closest('input,textarea,select')) return;
    const columns = Math.max(1, getComputedStyle(event.currentTarget).gridTemplateColumns.split(' ').length);
    if (event.key === ' ') { event.preventDefault(); select(cursor, { shiftKey: false, ctrlKey: true, metaKey: false }); return; }
    if (event.key === 'Enter') { event.preventDefault(); onOpenItem(cursor); return; }
    event.preventDefault();
    const step = event.key === 'ArrowUp' ? -columns : event.key === 'ArrowDown' ? columns : keys[event.key];
    const next = Math.max(0, Math.min(queue.length - 1, cursor + step));
    if (next === cursor) return;
    if (event.shiftKey) select(next, event); else { anchor.current = next; onCursor(next); }
    focusCell(next);
  };
  useEffect(() => { if (cursor < queue.length) anchor.current = Math.min(anchor.current, queue.length - 1); }, [cursor, queue.length]);

  if (!queue.length) return <div data-testid="build-grid-view" className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">No items match this queue</div>;
  return <div data-testid="build-grid-view" className="h-full w-full self-stretch overflow-auto">
    <p className="mb-2 text-xs text-muted-foreground">{queue.length} item{queue.length === 1 ? '' : 's'}{selected.size ? ` · ${selected.size} selected` : ''} · click to select, Shift or Ctrl/⌘ for several, A accept, X reject, double-click opens in List</p>
    <ul ref={grid} role="listbox" aria-multiselectable="true" aria-label="Queue items" onKeyDown={onKeyDown} className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
      {visible.map((item, index) => {
        const id = getBuildAssetId(item);
        const { state, reason } = gridState(session, item);
        const isCurrent = index === cursor;
        const isSelected = selected.has(id);
        return <li key={id} role="option" aria-selected={isSelected || isCurrent}>
          <button type="button" data-testid="build-grid-cell" data-state={state} data-current={isCurrent} data-selected={isSelected} data-grid-cell={id}
            tabIndex={isCurrent ? 0 : -1} title={`${itemName(item)} · ${STATE_LABEL[state]} · ${reason}`}
            onClick={(event: MouseEvent) => select(index, event)} onDoubleClick={() => onOpenItem(index)}
            className={`relative block aspect-square w-full overflow-hidden rounded border-2 bg-secondary ${isCurrent ? 'border-primary' : isSelected ? 'border-sky-500' : 'border-transparent'} ${isSelected ? 'ring-2 ring-sky-500/60' : ''}`}>
            {previews[item.id] ? <img src={previews[item.id]} alt={itemName(item)} loading="lazy" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center"><ImageIcon className="h-5 w-5" /></span>}
            <span data-testid="build-grid-badge" className={`absolute left-1 top-1 rounded px-1 text-[10px] ${STATE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
            {shortlisted?.has(id) && <span data-testid="build-shortlist-badge" className="absolute bottom-1 left-1 rounded bg-primary px-1 text-[10px] text-primary-foreground">Shortlist</span>}
          </button>
        </li>;
      })}
    </ul>
    {shown < queue.length && <button type="button" onClick={() => setLimit(shown + PAGE)} className="mt-3 rounded border border-border px-3 py-1 text-xs">Show more ({queue.length - shown} left)</button>}
  </div>;
}
