import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useProjectStore } from '../../stores/useProjectStore';

type BrickMasonryProps<T> = {
  items: T[];
  getKey: (item: T) => string;
  getEstimate?: (item: T) => number;
  renderItem: (item: T) => ReactNode;
  className?: string;
  minColumnWidth?: number;
  maxColumnCount?: number;
};

const DEFAULT_MIN_COLUMN_WIDTH = 208;
const DEFAULT_MAX_COLUMN_COUNT = 5;
const COLUMN_GAP = 16;

const getColumnCount = (width: number, minColumnWidth: number, maxColumnCount: number): number =>
  Math.min(maxColumnCount, Math.max(1, Math.floor((width + COLUMN_GAP) / (minColumnWidth + COLUMN_GAP))));

export const BrickMasonry = <T,>({
  items,
  getKey,
  getEstimate,
  renderItem,
  className = '',
  minColumnWidth = DEFAULT_MIN_COLUMN_WIDTH,
  maxColumnCount = DEFAULT_MAX_COLUMN_COUNT,
}: BrickMasonryProps<T>) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const getEstimateRef = useRef(getEstimate);
  const brickColumnCount = useProjectStore(
    (state) => state.workspaceSettings?.brickColumnCount ?? 'auto'
  );
  const [columnCount, setColumnCount] = useState(1);

  useEffect(() => {
    getEstimateRef.current = getEstimate;
  }, [getEstimate]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateColumnCount = () => {
      const available = getColumnCount(container.clientWidth, minColumnWidth, maxColumnCount);
      const nextColumnCount = brickColumnCount === 'auto' ? available : Math.min(available, brickColumnCount);
      setColumnCount((current) => (current === nextColumnCount ? current : nextColumnCount));
    };

    updateColumnCount();

    const observer = new ResizeObserver(updateColumnCount);
    observer.observe(container);

    return () => observer.disconnect();
  }, [brickColumnCount, maxColumnCount, minColumnWidth]);

  const columns = useMemo(() => {
    const activeColumnCount = Math.max(1, columnCount);
    const nextColumns: T[][] = Array.from({ length: activeColumnCount }, () => []);
    const columnHeights = Array.from({ length: activeColumnCount }, () => 0);

    for (const item of items) {
      let targetColumnIndex = 0;

      for (let index = 1; index < columnHeights.length; index += 1) {
        if (columnHeights[index] < columnHeights[targetColumnIndex]) {
          targetColumnIndex = index;
        }
      }

      nextColumns[targetColumnIndex].push(item);
      columnHeights[targetColumnIndex] += Math.max(0.25, getEstimateRef.current?.(item) ?? 1);
    }

    return nextColumns;
  }, [columnCount, items]);

  return (
    <div ref={containerRef} className={`gallery-masonry ${className}`.trim()}>
      {columns.map((column, columnIndex) => (
        <div key={columnIndex} className="gallery-masonry-column">
          {column.map((item) => (
            <div key={getKey(item)}>{renderItem(item)}</div>
          ))}
        </div>
      ))}
    </div>
  );
};
