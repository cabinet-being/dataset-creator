import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ExplorerTreeNode } from '../components/workspace/ExplorerTree';
import type { ExplorerContextMenuState } from '../components/workspace/WorkspaceTabMenus';
import type { useExplorerTree } from './useExplorerTree';

interface UseExplorerShortcutsOptions {
  explorer: ReturnType<typeof useExplorerTree>;
  explorerClipboard: unknown;
  explorerContextMenu: ExplorerContextMenuState | null;
  setExplorerContextMenu: Dispatch<SetStateAction<ExplorerContextMenuState | null>>;
  projectOperationBusyRef: MutableRefObject<boolean>;
  openExplorerFile: (node: ExplorerTreeNode) => Promise<void>;
}

export function useExplorerShortcuts({
  explorer,
  explorerClipboard,
  explorerContextMenu,
  setExplorerContextMenu,
  projectOperationBusyRef,
  openExplorerFile,
}: UseExplorerShortcutsOptions) {
  const {
    activeExplorerDirectoryPath, expandedExplorerPaths, explorerPanelRef, explorerTree, focusExplorerNode,
    focusedExplorerPath, getFocusedExplorerNode, getParentExplorerNode, getVisibleExplorerNodes,
    moveExplorerKeyboardFocus, selectedExplorerPaths, setExpandedExplorerPaths, setFocusedExplorerPath,
    setSelectedExplorerPaths, setSelectionAnchorPath, toggleExplorerPath,
  } = explorer;

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      Boolean(target.closest('input, textarea, select, [contenteditable="true"], iframe'));

    const handleExplorerShortcut = (event: KeyboardEvent) => {
      if (projectOperationBusyRef.current) return;
      if (event.defaultPrevented || event.isComposing || event.repeat || event.getModifierState('AltGraph') || document.querySelector('[role=dialog][data-state=open], [role=menu][data-state=open]')) return;
      if (isEditableTarget(event.target)) {
        return;
      }
      const explorerHasFocus =
        document.activeElement instanceof HTMLElement &&
        Boolean(explorerPanelRef.current?.contains(document.activeElement));
      if (!explorerHasFocus && !explorerContextMenu) {
        return;
      }

      if (event.key === 'Escape' && selectedExplorerPaths.size > 0) {
        event.preventDefault();
        setSelectedExplorerPaths(new Set());
        setSelectionAnchorPath(null);
        setFocusedExplorerPath(null);
        setExplorerContextMenu(null);
        return;
      }

      if (event.key === 'Home' || event.key === 'End') {
        const nodes = getVisibleExplorerNodes();
        const node = event.key === 'Home' ? nodes[0] : nodes[nodes.length - 1];
        if (node) {
          event.preventDefault();
          focusExplorerNode(node, event.shiftKey);
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveExplorerKeyboardFocus(1, event.shiftKey);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveExplorerKeyboardFocus(-1, event.shiftKey);
        return;
      }

      if (event.key === 'ArrowRight') {
        const focusedNode = getFocusedExplorerNode();
        if (focusedNode?.kind === 'folder') {
          event.preventDefault();
          if (!expandedExplorerPaths.has(focusedNode.path)) {
            setExpandedExplorerPaths((paths) => new Set([...paths, focusedNode.path]));
          } else if (focusedNode.children?.[0]) {
            focusExplorerNode(focusedNode.children[0], false);
          }
        }
        return;
      }

      if (event.key === 'ArrowLeft') {
        const focusedNode = getFocusedExplorerNode();
        if (focusedNode) {
          event.preventDefault();
          if (focusedNode.kind === 'folder' && expandedExplorerPaths.has(focusedNode.path)) {
            setExpandedExplorerPaths((paths) => {
              const next = new Set(paths);
              next.delete(focusedNode.path);
              return next;
            });
          } else {
            const parent = getParentExplorerNode(focusedNode.path);
            if (parent && parent.path !== 'Project') {
              focusExplorerNode(parent, false);
            }
          }
        }
        return;
      }

      if (event.key === 'Enter') {
        const focusedNode = getFocusedExplorerNode();
        if (focusedNode) {
          event.preventDefault();
          if (focusedNode.kind === 'folder') {
            toggleExplorerPath(focusedNode.path);
          } else {
            void openExplorerFile(focusedNode);
          }
        }
        return;
      }

    };

    window.addEventListener('keydown', handleExplorerShortcut);
    return () => window.removeEventListener('keydown', handleExplorerShortcut);
  }, [activeExplorerDirectoryPath, explorerClipboard, explorerContextMenu, focusedExplorerPath, selectedExplorerPaths, explorerTree, expandedExplorerPaths]);
}
