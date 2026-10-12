import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import { getEdgeScrollVelocity } from '../../lib/viewportGeometry';

type ExplorerMarquee = {
  pointerId: number;
  startContentX: number;
  startContentY: number;
  currentContentX: number;
  currentContentY: number;
  clientX: number;
  clientY: number;
  additive: boolean;
  previousPaths: string[];
};

type Props = {
  panelRef: RefObject<HTMLDivElement>;
  error: string | null;
  children: ReactNode;
  selectedPaths: ReadonlySet<string>;
  onDismissContextMenu: () => void;
  onSelectionChange: (paths: string[]) => void;
  onRootContextMenu: (x: number, y: number) => void;
  onDropTargetChange: (path: string | null) => void;
  onDropFiles: (event: DragEvent) => void;
};

export function ExplorerPanel({ panelRef, error, children, selectedPaths, onDismissContextMenu, onSelectionChange, onRootContextMenu, onDropTargetChange, onDropFiles }: Props) {
  const [explorerMarquee, setExplorerMarquee] = useState<ExplorerMarquee | null>(null);
  const marqueeRef = useRef<ExplorerMarquee | null>(null);
  const frameRef = useRef<number>();

  const updateSelection = useCallback((marquee: ExplorerMarquee) => {
    const panel = panelRef.current;
    if (!panel) return;
    const panelBounds = panel.getBoundingClientRect();
    const startX = panelBounds.left + marquee.startContentX - panel.scrollLeft;
    const startY = panelBounds.top + marquee.startContentY - panel.scrollTop;
    const currentX = panelBounds.left + marquee.currentContentX - panel.scrollLeft;
    const currentY = panelBounds.top + marquee.currentContentY - panel.scrollTop;
    const left = Math.min(startX, currentX); const right = Math.max(startX, currentX);
    const top = Math.min(startY, currentY); const bottom = Math.max(startY, currentY);
    const hit = Array.from(panel.querySelectorAll<HTMLElement>('[data-explorer-row][data-explorer-path]'))
      .filter(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.left < right && bounds.right > left && bounds.top < bottom && bounds.bottom > top;
      })
      .map(row => row.dataset.explorerPath)
      .filter((path): path is string => Boolean(path) && path !== 'Project');
    onSelectionChange(marquee.additive ? [...new Set([...marquee.previousPaths, ...hit])] : hit);
  }, [onSelectionChange, panelRef]);

  const stopMarquee = useCallback((restore = false) => {
    const marquee = marqueeRef.current;
    if (!marquee) return;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined; marqueeRef.current = null; setExplorerMarquee(null);
    if (restore) onSelectionChange(marquee.previousPaths);
  }, [onSelectionChange]);

  const tick = useCallback(() => {
    const panel = panelRef.current; const marquee = marqueeRef.current;
    if (!panel || !marquee) { frameRef.current = undefined; return; }
    const bounds = panel.getBoundingClientRect();
    const dx = getEdgeScrollVelocity(marquee.clientX, bounds.left, bounds.right);
    const dy = getEdgeScrollVelocity(marquee.clientY, bounds.top, bounds.bottom);
    if (dx || dy) panel.scrollBy(dx, dy);
    const next = {
      ...marquee,
      currentContentX: marquee.clientX - bounds.left + panel.scrollLeft,
      currentContentY: marquee.clientY - bounds.top + panel.scrollTop,
    };
    marqueeRef.current = next; setExplorerMarquee(next); updateSelection(next);
    frameRef.current = requestAnimationFrame(tick);
  }, [panelRef, updateSelection]);

  useEffect(() => {
    if (!explorerMarquee || frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(tick);
  }, [explorerMarquee, tick]);
  useEffect(() => {
    const cancel = () => stopMarquee(true);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); stopMarquee(); };
  }, [stopMarquee]);

  const marqueeBox = (() => {
    const panel = panelRef.current;
    if (!explorerMarquee || !panel) return undefined;
    const bounds = panel.getBoundingClientRect();
    const startX = bounds.left + explorerMarquee.startContentX - panel.scrollLeft;
    const startY = bounds.top + explorerMarquee.startContentY - panel.scrollTop;
    const currentX = bounds.left + explorerMarquee.currentContentX - panel.scrollLeft;
    const currentY = bounds.top + explorerMarquee.currentContentY - panel.scrollTop;
    const left = Math.max(bounds.left, Math.min(startX, currentX));
    const top = Math.max(bounds.top, Math.min(startY, currentY));
    const right = Math.min(bounds.right, Math.max(startX, currentX));
    const bottom = Math.min(bounds.bottom, Math.max(startY, currentY));
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  })();

  return <div ref={panelRef} className="min-h-0 flex-1 overflow-auto p-2" tabIndex={0}
    onKeyDown={event => { if (event.key === 'Escape' && marqueeRef.current) { event.preventDefault(); stopMarquee(true); } }}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('[data-explorer-row], input, button, [contenteditable="true"]')) return;
      const panel = event.currentTarget; const bounds = panel.getBoundingClientRect();
      panel.focus(); panel.setPointerCapture(event.pointerId); onDismissContextMenu();
      const previousPaths = [...selectedPaths]; const additive = event.ctrlKey || event.metaKey;
      const marquee = { pointerId:event.pointerId, startContentX:event.clientX-bounds.left+panel.scrollLeft, startContentY:event.clientY-bounds.top+panel.scrollTop,
        currentContentX:event.clientX-bounds.left+panel.scrollLeft, currentContentY:event.clientY-bounds.top+panel.scrollTop,
        clientX:event.clientX, clientY:event.clientY, additive, previousPaths };
      marqueeRef.current = marquee; setExplorerMarquee(marquee); if (!additive) onSelectionChange([]);
    }}
    onPointerMove={event => {
      const marquee = marqueeRef.current; if (!marquee || marquee.pointerId !== event.pointerId) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const next = { ...marquee, clientX:event.clientX, clientY:event.clientY,
        currentContentX:event.clientX-bounds.left+event.currentTarget.scrollLeft,
        currentContentY:event.clientY-bounds.top+event.currentTarget.scrollTop };
      marqueeRef.current = next; setExplorerMarquee(next); updateSelection(next);
    }}
    onPointerUp={event => { if (marqueeRef.current?.pointerId !== event.pointerId) return; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); stopMarquee(); }}
    onPointerCancel={event => { if (marqueeRef.current?.pointerId === event.pointerId) stopMarquee(true); }}
    onLostPointerCapture={() => { if (marqueeRef.current) stopMarquee(); }}
    onContextMenu={event => { if ((event.target as HTMLElement).closest('[data-explorer-row]')) return; event.preventDefault(); onRootContextMenu(event.clientX,event.clientY); }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect=event.dataTransfer.types.includes('Files')?'copy':'move'; onDropTargetChange('Project'); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node|null)) onDropTargetChange(null); }}
    onDrop={event => { event.preventDefault(); onDropTargetChange(null); onDropFiles(event); }}>
    {error && <p className="mb-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-xs text-yellow-600">Showing workspace state. {error}</p>}
    {children}
    {marqueeBox && <div aria-hidden="true" className="pointer-events-none fixed z-[900] border border-primary bg-primary/15" style={marqueeBox} />}
  </div>;
}
