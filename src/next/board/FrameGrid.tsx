import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { Ban, Check, ImageIcon, Inbox, Pin, PinOff, Trash2, X } from 'lucide-react';
import { BOARD_FILTERS, matchesBoardFilter, type BoardFilter } from '../../lib/imageStatusLabels';
import { INBOX_PREFIX } from '../../lib/inboxFolders';
import { useSizedPreviewUrls } from '../../lib/previewUrlCache';
import { cn } from '../../lib/utils';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { BuildSession } from '../../types';
import type { BuildClusterResult } from '../../services/build/buildClusterService';
import { buildFrameEntries, countBoardFilters, groupFrameEntries, groupFrameEntriesByClusters, isDatasetEntry, moveFrameCursor, overrideKeyAction, type CursorMove, type FrameEntry } from './frameEntries';
import { Lightbox } from './Lightbox';
import { canChangeFrameFile, useFrameFiles } from './frameFiles';
import { StatusBadge } from './StatusBadge';
import type { BoardActions } from './useBoardPipeline';
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
  /** Similarity clusters of the candidates, once their features are ready; the grid then offers grouping by theme. */
  clusters?: Pick<BuildClusterResult, 'themes' | 'nearDuplicateGroups'> | null;
  /** Local filter from Health: only these frames (workspace image ids or Build asset ids) are shown. */
  idFilter?: { label: string; ids: ReadonlySet<string> } | null;
  onClearIdFilter?: () => void;
  /** Pin, Ban, Clear and Return; absent means the grid only browses. */
  actions?: BoardActions;
  /** Starts a drag of inbox frames; the owner puts them into the Explorer drag state. */
  onDragFrames?: (items: WorkspaceImage[]) => void;
  onDragFramesEnd?: () => void;
};

/**
 * Frame grid of the Board: statuses computed once, folder groups, local filter chips, local selection and cursor.
 * Thumbnails exist only for the rendered window of the virtual grid.
 */
export function FrameGrid({ candidates, effectiveItems, session, clusters, idFilter, onClearIdFilter, actions, onDragFrames, onDragFramesEnd }: Props) {
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [grouping, setGrouping] = useState<'themes' | 'folders'>('themes');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [columns, setColumns] = useState(1);
  const [windowEntries, setWindowEntries] = useState<FrameEntry[]>([]);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const focusAfterMove = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => buildFrameEntries(candidates, effectiveItems, session), [candidates, effectiveItems, session]);
  const scoped = useMemo(() => idFilter ? entries.filter(entry => idFilter.ids.has(entry.id) || idFilter.ids.has(entry.assetId)) : entries, [entries, idFilter]);
  const counts = useMemo(() => countBoardFilters(scoped), [scoped]);
  const visible = useMemo(() => filter === 'all' ? scoped : scoped.filter(entry => matchesBoardFilter(filter, entry.status, entry.record)), [scoped, filter]);
  const hasClusters = Boolean(clusters && (clusters.themes.length || clusters.nearDuplicateGroups.length));
  const byTheme = hasClusters && grouping === 'themes';
  const groups = useMemo(() => byTheme && clusters ? groupFrameEntriesByClusters(visible, clusters) : groupFrameEntries(visible), [byTheme, clusters, visible]);
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

  // Targets of a membership action: the selection, else the frame under the cursor.
  const cursorEntry = visible.find(entry => entry.id === tabStopId);
  const actionTargets = useMemo(() => activeSelection.size ? visible.filter(entry => activeSelection.has(entry.id)) : cursorEntry ? [cursorEntry] : [], [activeSelection, cursorEntry, visible]);
  const act = (kind: 'pin' | 'ban' | 'clear' | 'return', targets: readonly FrameEntry[]) => {
    if (!actions || actions.busy || !targets.length) return;
    const items = targets.map(entry => entry.item);
    setSelected(new Set());
    void (kind === 'pin' ? actions.pinImages(items) : kind === 'ban' ? actions.banImages(items) : kind === 'clear' ? actions.clearOverride(items) : actions.returnToInbox(items));
  };

  const files = useFrameFiles();
  const deletable = actionTargets.filter(entry => canChangeFrameFile(entry.item));
  const deleteTargets = () => { if (!files || files.busy || !deletable.length) return; setSelected(new Set()); void files.deleteFrames(deletable.map(entry => entry.item)); };

  const onKeyDown = (event: KeyboardEvent) => {
    const hotkey = event.key.toLowerCase();
    if (actions && !openId && (hotkey === 'p' || hotkey === 'b') && !event.repeat && !isTextField(event.target) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const key = hotkey === 'p' ? 'pin' : 'ban';
      event.preventDefault();
      const action = overrideKeyAction(actionTargets, key);
      act(action, actionTargets);
      return;
    }
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
      {hasClusters && <div role="group" aria-label="Group frames by" className="ml-2 flex overflow-hidden rounded-md border border-border">
        {(['themes', 'folders'] as const).map(option => <button key={option} type="button" data-grouping={option} aria-pressed={grouping === option} onClick={() => setGrouping(option)}
          className={cn('min-h-[44px] px-3 text-sm', focusRing, grouping === option ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-secondary')}>
          {option === 'themes' ? 'Themes' : 'Folders'}</button>)}
      </div>}
      {idFilter && <span data-id-filter className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-primary bg-primary/10 pl-3 text-sm">
        Showing: {idFilter.label}
        <button type="button" data-clear-id-filter aria-label="Clear this filter" onClick={onClearIdFilter}
          className={cn('flex h-11 w-11 items-center justify-center rounded-md hover:bg-secondary', focusRing)}><X aria-hidden className="h-4 w-4" /></button>
      </span>}
      {activeSelection.size > 0 && <button type="button" data-clear-selection onClick={() => setSelected(new Set())}
        className={cn('ml-auto min-h-[44px] rounded-md px-3 text-sm text-muted-foreground hover:text-foreground', focusRing)}>
        {activeSelection.size} selected · Clear
      </button>}
    </div>
    {actions && activeSelection.size > 0 && <div role="toolbar" aria-label="Actions for selected frames" data-bulk-actions className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      {([
        ['pin', 'Pin', Pin, actionTargets.length > 0],
        ['ban', 'Ban', Ban, actionTargets.length > 0],
        ['clear', 'Clear override', PinOff, actionTargets.some(entry => entry.record?.override)],
        ['return', 'Return to inbox', Inbox, actionTargets.some(isDatasetEntry)],
      ] as const).map(([kind, label, Icon, applicable]) => <button key={kind} type="button" data-bulk-action={kind} disabled={actions.busy || !applicable}
        onClick={() => act(kind, kind === 'return' ? actionTargets.filter(isDatasetEntry) : kind === 'clear' ? actionTargets.filter(entry => entry.record?.override) : actionTargets)}
        className={cn('inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-secondary disabled:opacity-50', focusRing)}>
        <Icon aria-hidden className="h-4 w-4" />{label}
      </button>)}
      {files && <button type="button" data-bulk-action="delete" disabled={files.busy || !deletable.length} onClick={deleteTargets}
        className={cn('inline-flex min-h-[44px] items-center gap-2 rounded-md border border-destructive/60 px-3 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50', focusRing)}>
        <Trash2 aria-hidden className="h-4 w-4" />Delete files
      </button>}
    </div>}
    {visible.length === 0
      ? <p data-grid-empty className="m-6 rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {entries.length === 0 ? 'No images yet. Drop files or folders into Sources.' : 'No frames match this filter.'}
      </p>
      : <VirtualTileGrid groups={groups} getKey={getKey} renderTile={renderTile} onWindowChange={setWindowEntries}
        revealKey={revealId} onColumnsChange={setColumns} />}
    {openIndex >= 0 && <Lightbox entries={visible} index={openIndex} onIndexChange={showFrame} onClose={closeLightbox} actions={actions} />}
  </div>;
}
