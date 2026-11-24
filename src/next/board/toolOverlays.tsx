import { createContext, useContext, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { VideoFramesTool } from '../../components/tools/VideoFramesTool';
import { hasBusyVideoTasks } from '../../services/video/videoClient';
import { PROJECT_LAYOUT } from '../../services/project/projectLayoutService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { cn } from '../../lib/utils';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Opens the full-screen tools of the Board; absent outside the Board, so the matching buttons are hidden. */
export type BoardTools = { openVideo: (item: WorkspaceImage) => void };
export const BoardToolsContext = createContext<BoardTools | null>(null);
export const useBoardTools = () => useContext(BoardToolsContext);

/** Default folder for frames cut from a video: `Project/inbox/<video name>`. */
export const videoFramesDestination = (fileName: string): string => {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return `Project/${PROJECT_LAYOUT.rawDir}/${stem || 'video'}`;
};

/** Full-screen frame above the Board; Escape (captured, so the lightbox below keeps its state) asks `onRequestClose`. */
function Overlay({ label, onRequestClose, viewId, children }: { label: string; onRequestClose: () => void; viewId?: string; children: React.ReactNode }) {
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  return <div role="dialog" aria-modal="true" aria-label={label} data-tool-overlay data-dock-view={viewId}
    className="fixed inset-0 z-[2200] flex flex-col bg-background text-foreground">
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</h2>
      <button type="button" data-overlay-close aria-label="Close" onClick={onRequestClose}
        className={cn('flex h-11 w-11 items-center justify-center rounded-md border border-border hover:bg-secondary', focusRing)}><X aria-hidden className="h-5 w-5" /></button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">{children}</div>
  </div>;
}

/** Video Frames over the Board: frames go to `inbox/<video name>` by default and are indexed after each save. */
export function VideoOverlay({ item, directory, onClose, onSaved }: { item: WorkspaceImage; directory: ProjectDirectoryHandle; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const requestClose = () => {
    if (hasBusyVideoTasks() && !window.confirm('Cancel the running video operation and close? Already saved frames will remain in the project.')) return;
    onClose();
  };
  return <Overlay label={`Video frames: ${item.fileName}`} onRequestClose={requestClose}>
    <VideoFramesTool tabId={`next:video:${item.id}`} projectDirectoryHandle={directory} file={item.imageData} fileName={item.fileName}
      defaultDestination={videoFramesDestination(item.fileName)} onSaved={onSaved} />
  </Overlay>;
}
