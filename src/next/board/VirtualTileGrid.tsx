import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type TileGroup<T> = { key: string; label: string; items: T[] };

type GridRow<T> =
  | { kind: 'header'; key: string; top: number; height: number; label: string; count: number }
  | { kind: 'tiles'; key: string; top: number; height: number; items: T[] };

type Props<T> = {
  groups: TileGroup<T>[];
  getKey: (item: T) => string;
  /** Renders one tile; the root element must be exactly `size` px wide and tall. */
  renderTile: (item: T, size: number) => ReactNode;
  /** Items of the rendered window (visible rows plus overscan); changes only when the window moves to other rows. */
  onWindowChange?: (items: T[]) => void;
  /** Scrolls this item into view when it changes. */
  revealKey?: string | null;
  /** Number of tiles per row of the current layout, for keyboard navigation by rows. */
  onColumnsChange?: (columns: number) => void;
  tileSize?: number;
  gap?: number;
  headerHeight?: number;
  /** Extra rows rendered above and below the viewport. */
  overscanRows?: number;
  className?: string;
};

const PADDING = 12;

/**
 * Windowed grid of fixed-size tiles grouped under header rows. Only the rows near the viewport are in the DOM,
 * so the node count stays bounded for thousands of frames. No dependencies: positions are computed from the
 * container width (ResizeObserver) and the scroll offset.
 */
export function VirtualTileGrid<T>({
  groups, getKey, renderTile, onWindowChange, revealKey, onColumnsChange,
  tileSize = 168, gap = 8, headerHeight = 44, overscanRows = 1, className,
}: Props<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef(0);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setSize(previous => previous.width === element.clientWidth && previous.height === element.clientHeight
      ? previous : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (scroller.current) setScrollTop(scroller.current.scrollTop);
    });
  }, []);

  const columns = Math.max(1, Math.floor((size.width - PADDING * 2 + gap) / (tileSize + gap)));
  useEffect(() => { onColumnsChange?.(columns); }, [columns, onColumnsChange]);

  const { rows, total, rowOfKey } = useMemo(() => {
    const built: GridRow<T>[] = [];
    const keyRows = new Map<string, number>();
    let top = PADDING;
    for (const group of groups) {
      if (!group.items.length) continue;
      built.push({ kind: 'header', key: `h:${group.key}`, top, height: headerHeight, label: group.label, count: group.items.length });
      top += headerHeight;
      for (let start = 0; start < group.items.length; start += columns) {
        const items = group.items.slice(start, start + columns);
        for (const item of items) keyRows.set(getKey(item), built.length);
        built.push({ kind: 'tiles', key: `t:${group.key}:${start}`, top, height: tileSize, items });
        top += tileSize + gap;
      }
    }
    return { rows: built, total: top + PADDING, rowOfKey: keyRows };
  }, [groups, columns, getKey, tileSize, gap, headerHeight]);

  const overscanPx = overscanRows * (tileSize + gap);
  const [first, last] = useMemo(() => {
    const from = scrollTop - overscanPx;
    const to = scrollTop + size.height + overscanPx;
    let low = 0; let high = rows.length;
    while (low < high) { const mid = (low + high) >> 1; if (rows[mid].top + rows[mid].height < from) low = mid + 1; else high = mid; }
    let end = low;
    while (end < rows.length && rows[end].top <= to) end += 1;
    return [low, end];
  }, [rows, scrollTop, size.height, overscanPx]);

  const windowRows = useMemo(() => rows.slice(first, last), [rows, first, last]);
  const windowItems = useMemo(() => windowRows.flatMap(row => row.kind === 'tiles' ? row.items : []), [windowRows]);
  useEffect(() => { onWindowChange?.(windowItems); }, [windowItems, onWindowChange]);

  useEffect(() => {
    const element = scroller.current;
    const index = revealKey ? rowOfKey.get(revealKey) : undefined;
    if (!element || index === undefined) return;
    const row = rows[index];
    // Keep the group header above the first row of a group visible when scrolling up.
    const previous = rows[index - 1];
    const top = previous?.kind === 'header' ? previous.top : row.top;
    if (top < element.scrollTop) element.scrollTop = top - gap;
    else if (row.top + row.height > element.scrollTop + element.clientHeight) element.scrollTop = row.top + row.height - element.clientHeight + gap;
  }, [revealKey, rowOfKey, rows, gap]);

  return <div ref={scroller} onScroll={onScroll} data-virtual-grid data-columns={columns} className={className ?? 'min-h-0 flex-1 overflow-auto'}>
    <div style={{ height: total, position: 'relative' }}>
      {windowRows.map(row => row.kind === 'header'
        ? <div key={row.key} data-grid-header role="heading" aria-level={3} className="absolute flex items-center gap-2 text-sm font-medium"
          style={{ top: row.top, height: row.height, left: PADDING, right: PADDING }}>
          <span className="truncate">{row.label}</span><span className="text-xs font-normal tabular-nums text-muted-foreground">{row.count}</span>
        </div>
        : <div key={row.key} data-grid-row className="absolute flex" style={{ top: row.top, height: row.height, left: PADDING, gap }}>
          {row.items.map(item => <Fragment key={getKey(item)}>{renderTile(item, tileSize)}</Fragment>)}
        </div>)}
    </div>
  </div>;
}
