import { useState, type DragEvent, type ReactNode, type RefObject } from 'react';

type ExplorerMarquee = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type Props = {
  panelRef: RefObject<HTMLDivElement>;
  error: string | null;
  children: ReactNode;
  onDismissContextMenu: () => void;
  onSelectionChange: (paths: string[]) => void;
  onRootContextMenu: (x: number, y: number) => void;
  onDropTargetChange: (path: string | null) => void;
  onDropFiles: (event: DragEvent) => void;
};

export function ExplorerPanel({ panelRef, error, children, onDismissContextMenu, onSelectionChange, onRootContextMenu, onDropTargetChange, onDropFiles }: Props) {
  const [explorerMarquee, setExplorerMarquee] = useState<ExplorerMarquee | null>(null);
  return (
    <div
      ref={panelRef}
      className="min-h-0 flex-1 overflow-auto p-2"
      tabIndex={0}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          (event.target as HTMLElement).closest('[data-explorer-row], input, button, [contenteditable="true"]')
        ) {
          return;
        }
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        onDismissContextMenu();
        onSelectionChange([]);
        setExplorerMarquee({
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          currentX: event.clientX,
          currentY: event.clientY,
        });
      }}
      onPointerMove={(event) => {
        if (!explorerMarquee || explorerMarquee.pointerId !== event.pointerId) {
          return;
        }

        const nextMarquee = {
          ...explorerMarquee,
          currentX: event.clientX,
          currentY: event.clientY,
        };
        const left = Math.min(nextMarquee.startX, nextMarquee.currentX);
        const right = Math.max(nextMarquee.startX, nextMarquee.currentX);
        const top = Math.min(nextMarquee.startY, nextMarquee.currentY);
        const bottom = Math.max(nextMarquee.startY, nextMarquee.currentY);
        const paths = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-explorer-row][data-explorer-path]'))
          .filter((row) => {
            const bounds = row.getBoundingClientRect();
            return bounds.left < right && bounds.right > left && bounds.top < bottom && bounds.bottom > top;
          })
          .map((row) => row.dataset.explorerPath)
          .filter((path): path is string => Boolean(path) && path !== 'Project');

        setExplorerMarquee(nextMarquee);
        onSelectionChange(paths);
      }}
      onPointerUp={(event) => {
        if (!explorerMarquee || explorerMarquee.pointerId !== event.pointerId) {
          return;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setExplorerMarquee(null);
      }}
      onPointerCancel={(event) => {
        if (!explorerMarquee || explorerMarquee.pointerId !== event.pointerId) {
          return;
        }
        setExplorerMarquee(null);
      }}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('[data-explorer-row]')) {
          return;
        }
        event.preventDefault();
        onRootContextMenu(event.clientX, event.clientY);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
        onDropTargetChange('Project');
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDropTargetChange(null);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropTargetChange(null);
        onDropFiles(event);
      }}
    >
      {error && (
        <p className="mb-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-xs text-yellow-600">
          Showing workspace state. {error}
        </p>
      )}
      {children}
      {explorerMarquee && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[900] border border-primary bg-primary/15"
          style={{
            left: Math.min(explorerMarquee.startX, explorerMarquee.currentX),
            top: Math.min(explorerMarquee.startY, explorerMarquee.currentY),
            width: Math.abs(explorerMarquee.currentX - explorerMarquee.startX),
            height: Math.abs(explorerMarquee.currentY - explorerMarquee.startY),
          }}
        />
      )}
    </div>
  );
}
