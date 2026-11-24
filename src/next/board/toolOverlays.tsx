import { createContext, useContext, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { CleanupTool } from '../../components/tools/CleanupTool';
import { VideoFramesTool } from '../../components/tools/VideoFramesTool';
import { checkDirtyDocuments } from '../../stores/useDocumentStateStore';
import { useUIStore } from '../../stores/useUIStore';
import { hasBusyVideoTasks } from '../../services/video/videoClient';
import { PROJECT_LAYOUT } from '../../services/project/projectLayoutService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { getWorkspaceDisplayName, type WorkspaceImage } from '../../lib/workspaceImages';
import { cn } from '../../lib/utils';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Dock view id of the Photopea overlay: the document-state tracking and the Mod+S exception use it. */
export const PHOTOPEA_OVERLAY_VIEW = 'next:photopea';

/** Opens the full-screen tools of the Board; absent outside the Board, so the matching buttons are hidden. */
export type BoardTools = { editInPhotopea: (item: WorkspaceImage) => void; openVideo: (item: WorkspaceImage) => void };
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
  return <Overlay label={`Video frames: ${getWorkspaceDisplayName(item)}`} onRequestClose={requestClose}>
    <VideoFramesTool tabId={`next:video:${item.id}`} projectDirectoryHandle={directory} file={item.imageData} fileName={getWorkspaceDisplayName(item)}
      defaultDestination={videoFramesDestination(getWorkspaceDisplayName(item))} onSaved={onSaved} />
  </Overlay>;
}

/** Photopea over the Board for one frame; closing asks about an unsaved document, a successful save closes it. */
export function PhotopeaOverlay({ item, directory, onClose }: { item: WorkspaceImage; directory: ProjectDirectoryHandle; onClose: () => void }) {
  const notify = useUIStore(state => state.addNotification);
  const requestClose = async () => {
    try {
      const dirty = await checkDirtyDocuments([PHOTOPEA_OVERLAY_VIEW]);
      if (dirty.length && !window.confirm('Close this image with unsaved changes?')) return;
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not verify unsaved changes');
      return;
    }
    onClose();
  };
  const refreshPreviews = useUIStore(state => state.refreshAssetPreviews);
  return <Overlay label={`Edit in Photopea: ${getWorkspaceDisplayName(item)}`} onRequestClose={() => void requestClose()} viewId={PHOTOPEA_OVERLAY_VIEW}>
    <CleanupTool singleFileMode selectedImageId={item.id} projectDirectoryHandle={directory} onSaved={() => { refreshPreviews(); onClose(); }} />
  </Overlay>;
}
