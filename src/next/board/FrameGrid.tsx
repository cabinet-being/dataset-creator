import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { Check, ImageIcon } from 'lucide-react';
import { BOARD_FILTERS, matchesBoardFilter, type BoardFilter } from '../../lib/imageStatusLabels';
import { INBOX_PREFIX } from '../../lib/inboxFolders';
import { useSizedPreviewUrls } from '../../lib/previewUrlCache';
import { cn } from '../../lib/utils';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { BuildSession } from '../../types';
import { buildFrameEntries, countBoardFilters, groupFrameEntries, moveFrameCursor, type CursorMove, type FrameEntry } from './frameEntries';
import { Lightbox } from './Lightbox';
import { StatusBadge } from './StatusBadge';
import { VirtualTileGrid } from './VirtualTileGrid';

const FILTER_LABELS: Record<BoardFilter, string> = { all: 'All', in: 'In', out: 'Out', pinned: 'Pinned', banned: 'Banned' };
const MOVE_KEYS: Record<string, CursorMove> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end',
};
const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const isTextField = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const isInbox = (item: WorkspaceImage) => Boolean(item.assetPath?.startsWith(INBOX_PREFIX));

type Props = {
  /** Build candidates. */
  candidates: readonly WorkspaceImage[];
  /** Every merged image; resolves transformed outputs. */
  effectiveItems: readonly WorkspaceImage[];
  session: BuildSession;
  /** Starts a drag of inbox frames; the owner puts them into the Explorer drag state. */
  onDragFrames?: (items: WorkspaceImage[]) => void;
  onDragFramesEnd?: () => void;
};

/**
 * Frame grid of the Board: statuses computed once, folder groups, local filter chips, local selection and cursor.
 * Thumbnails exist only for the rendered window of the virtual grid.
 */
export function FrameGrid({ candidates, effectiveItems, session, onDragFrames, onDragFramesEnd }: Props) {
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [columns, setColumns] = useState(1);
  const [windowEntries, setWindowEntries] = useState<FrameEntry[]>([]);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const focusAfterMove = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => buildFrameEntries(candidates, effectiveItems, session), [candidates, effectiveItems, session]);
  const counts = useMemo(() => countBoardFilters(entries), [entries]);
  const visible = useMemo(() => filter === 'all' ? entries : entries.filter(entry => matchesBoardFilter(filter, entry.status, entry.record)), [entries, filter]);
  const groups = useMemo(() => groupFrameEntries(visible), [visible]);
  const visibleIds = useMemo(() => new Set(visible.map(entry => entry.id)), [visible]);
  const activeSelection = useMemo(() => new Set([...selected].filter(id => visibleIds.has(id))), [selected, visibleIds]);
  const tabStopId = cursorId && visibleIds.has(cursorId) ? cursorId : visible[0]?.id ?? null;

  const windowImages = useMemo(() => windowEntries.map(entry => entry.item), [windowEntries]);
  const thumbs = useSizedPreviewUrls(windowImages, 'thumb', { focusId: tabStopId ?? undefined });
  const getKey = useCallback((entry: FrameEntry) => entry.id, []);

  useEffect(() => {
    if (!focusAfterMove.current || !cursorId) return;
    const frame = requestAnimationFrame(() => {
      const tile = [...(root.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])].find(element => element.dataset.tileId === cursorId);
      if (tile) { tile.focus({ preventScroll: true }); focusAfterMove.current = false; }
    });
    return () => cancelAnimationFrame(frame);
  }, [cursorId, windowEntries, openId]);

  const openIndex = openId ? visible.findIndex(entry => entry.id === openId) : -1;
  // A frame that leaves the filtered list while open (for example after a session change) closes the overlay.
  useEffect(() => { if (openId && openIndex < 0) setOpenId(null); }, [openId, openIndex]);
  const closeLightbox = useCallback(() => {
    focusAfterMove.current = true;
    setRevealId(openId);
    setCursorId(openId);
    setOpenId(null);
  }, [openId]);
  const showFrame = useCallback((index: number) => { const entry = visible[index]; if (entry) { setOpenId(entry.id); setCursorId(entry.id); setRevealId(entry.id); } }, [visible]);

  const toggleSelected = (id: string) => setSelected(current => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const onKeyDown = (event: KeyboardEvent) => {
    const move = MOVE_KEYS[event.key];
    if (openId || !move || isTextField(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = moveFrameCursor(groups, tabStopId, move, columns);
    if (!next) return;
    event.preventDefault();
    focusAfterMove.current = true;
    setCursorId(next);
    setRevealId(next);
  };

  const onTileClick = (event: MouseEvent, entry: FrameEntry) => {
    setCursorId(entry.id);
    if (event.ctrlKey || event.metaKey || event.shiftKey) { toggleSelected(entry.id); return; }
    setOpenId(entry.id);
  };

  const onDragStart = (event: DragEvent, entry: FrameEntry) => {
    const dragged = activeSelection.has(entry.id) ? visible.filter(candidate => activeSelection.has(candidate.id)) : [entry];
    const items = dragged.map(candidate => candidate.item).filter(isInbox);
    if (!items.length) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', items[0].assetPath ?? '');
    onDragFrames?.(items);
  };

  const renderTile = useCallback((entry: FrameEntry, size: number) => {
    const url = thumbs[entry.id];
    const isCursor = entry.id === tabStopId;
    const isSelected = activeSelection.has(entry.id);
    return <div data-frame-tile={entry.id} data-status={entry.label.badge} className={cn('relative overflow-hidden rounded-md border bg-secondary', isSelected ? 'border-primary ring-2 ring-primary' : 'border-border')}
      style={{ width: size, height: size }} draggable={isInbox(entry.item)} onDragStart={event => onDragStart(event, entry)} onDragEnd={onDragFramesEnd}>
      <button type="button" data-tile-id={entry.id} tabIndex={isCursor ? 0 : -1} title={`${entry.name}: ${entry.label.reason}`}
        aria-label={`${entry.name}, ${entry.label.badge}. ${entry.label.reason}`}
        onClick={event => onTileClick(event, entry)} onFocus={() => setCursorId(entry.id)}
        className={cn('absolute inset-0 text-left', focusRing)}>
        {url
          ? <img src={url} alt="" draggable={false} className={cn('h-full w-full object-cover', entry.label.muted && 'opacity-40 grayscale')} />
          : <span className="flex h-full w-full items-center justify-center text-muted-foreground"><ImageIcon aria-hidden className="h-6 w-6" /></span>}
        <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-2 py-1 text-xs">{entry.name}</span>
      </button>
      <StatusBadge label={entry.label} className="pointer-events-none absolute left-1.5 top-1.5" />
      <button type="button" aria-pressed={isSelected} aria-label={`Select ${entry.name}`} tabIndex={-1} onClick={() => toggleSelected(entry.id)}
        className={cn('absolute right-0 top-0 flex h-11 w-11 items-center justify-center', focusRing)}>
        <Check aria-hidden className={cn('h-5 w-5 rounded-full p-0.5', isSelected ? 'bg-primary text-primary-foreground' : 'bg-background/80 text-muted-foreground')} />
      </button>
    </div>;
  }, [thumbs, tabStopId, activeSelection, visible, onDragFrames, onDragFramesEnd]);

  return <div ref={root} data-frame-grid className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
    <div role="group" aria-label="Filter frames" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      {BOARD_FILTERS.map(option => <button key={option} type="button" aria-pressed={filter === option} data-filter={option} onClick={() => setFilter(option)}
        className={cn('inline-flex min-h-[44px] items-center gap-2 rounded-md border px-3 text-sm transition-colors', focusRing,
          filter === option ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground')}>
        {FILTER_LABELS[option]}<span data-filter-count className="text-xs tabular-nums">{counts[option]}</span>
      </button>)}
      {activeSelection.size > 0 && <button type="button" data-clear-selection onClick={() => setSelected(new Set())}
        className={cn('ml-auto min-h-[44px] rounded-md px-3 text-sm text-muted-foreground hover:text-foreground', focusRing)}>
        {activeSelection.size} selected · Clear
      </button>}
    </div>
    {visible.length === 0
      ? <p data-grid-empty className="m-6 rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {entries.length === 0 ? 'No images yet. Drop files or folders into Sources.' : 'No frames match this filter.'}
      </p>
      : <VirtualTileGrid groups={groups} getKey={getKey} renderTile={renderTile} onWindowChange={setWindowEntries}
        revealKey={revealId} onColumnsChange={setColumns} />}
    {openIndex >= 0 && <Lightbox entries={visible} index={openIndex} onIndexChange={showFrame} onClose={closeLightbox} />}
  </div>;
}
