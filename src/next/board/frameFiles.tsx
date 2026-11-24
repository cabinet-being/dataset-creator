import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { isInboxItem } from '../../lib/inboxFolders';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { useProjectRuntime } from '../useProjectRuntime';

type Runtime = ReturnType<typeof useProjectRuntime>;

/** File actions on frames of the inbox (Delete, Rename); they run through the Explorer mutations of the runtime. */
export type FrameFiles = {
  busy: boolean;
  /** Inline rename in progress for the file at `path`. */
  rename: { path: string; value: string } | null;
  startRename: (item: WorkspaceImage) => void;
  setRenameValue: (value: string) => void;
  commitRename: () => Promise<void>;
  cancelRename: () => void;
  /** Asks for confirmation, then deletes the files; only inbox frames are deleted. */
  deleteFrames: (items: readonly WorkspaceImage[]) => Promise<void>;
};

export const FrameFilesContext = createContext<FrameFiles | null>(null);
/** Absent outside the Board, so the matching buttons are hidden. */
export const useFrameFiles = () => useContext(FrameFilesContext);
/** Only frames of the inbox can be deleted or renamed here; Dataset frames are returned to inbox first. */
export const canChangeFrameFile = (item: WorkspaceImage) => isInboxItem(item) && item.kind !== 'video';

export function useFrameFilesValue(runtime: Runtime): FrameFiles {
  const { explorer, explorerMutations, isProjectDirectoryBusy } = runtime;
  const { inlineExplorerEdit, setInlineExplorerEdit } = explorerMutations;
  const committing = useRef(false);
  useEffect(() => { if (!inlineExplorerEdit) committing.current = false; }, [inlineExplorerEdit]);
  const mutations = useRef(explorerMutations);
  mutations.current = explorerMutations;
  const tree = useRef(explorer);
  tree.current = explorer;
  const edit = inlineExplorerEdit?.mode === 'rename' && inlineExplorerEdit.kind === 'file' && inlineExplorerEdit.path
    ? { path: inlineExplorerEdit.path, value: inlineExplorerEdit.value } : null;
  const editPath = edit?.path;
  const editValue = edit?.value;

  return useMemo<FrameFiles>(() => ({
    busy: isProjectDirectoryBusy,
    rename: editPath === undefined ? null : { path: editPath, value: editValue ?? '' },
    startRename: item => {
      const node = item.assetPath ? tree.current.findExplorerNodeByPath(item.assetPath) : null;
      if (node && canChangeFrameFile(item)) void mutations.current.handleExplorerRename(node);
    },
    setRenameValue: value => setInlineExplorerEdit(current => current ? { ...current, value } : current),
    commitRename: async () => {
      if (committing.current) return;
      committing.current = true;
      try { await mutations.current.commitInlineExplorerEdit(); }
      finally { requestAnimationFrame(() => { committing.current = false; }); }
    },
    cancelRename: () => { committing.current = true; mutations.current.cancelInlineExplorerEdit(); },
    deleteFrames: async items => {
      const entries = items.filter(canChangeFrameFile).flatMap(item => item.assetPath
        ? [{ path: item.assetPath, name: item.assetPath.split('/').pop() ?? item.fileName, kind: 'file' as const, workspaceImageId: item.id }] : []);
      if (entries.length) await mutations.current.deleteExplorerEntries(entries);
    },
  }), [editPath, editValue, isProjectDirectoryBusy, setInlineExplorerEdit]);
}
