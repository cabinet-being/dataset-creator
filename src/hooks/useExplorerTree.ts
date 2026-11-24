import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ExplorerItemEntry } from './useExplorerMutations';
import {
  buildEmptyExplorerTree,
  type ExplorerTreeNode,
  sanitizeExplorerTree,
  findExplorerTreeNode,
  moveExplorerTreeNodes,
  replaceExplorerTreeNode,
  getAllExplorerNodes as getAllNodes,
  getVisibleExplorerNodes as getVisibleNodes,
  getExplorerRangePaths,
  getParentExplorerPath,
  getTopLevelExplorerEntries,
  type ExplorerChanges,
} from '../lib/explorerTreeUpdates';
import { findWorkspaceImageIdForPath } from '../lib/workspaceImages';
import { invalidateWorkspaceFileAssetCache, updateWorkspaceFileAssetCache } from '../lib/workspaceFileAssets';
import { applyExplorerPathMoves } from '../lib/datasetAssets';
import {
  getDirectoryAtExplorerPath,
  getExplorerFileKind,
  getExplorerParentDirectory,
  readExplorerDirectory,
} from '../services/project/explorerFileService';
import type { ProjectDirectoryHandle } from '../services/project/projectDirectoryService';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';
import { getCaptionPathForImage } from '../services/caption/captionFileService';

interface UseExplorerTreeOptions {
  openFile: (node: ExplorerTreeNode) => Promise<void>;
}

export function useExplorerTree({ openFile }: UseExplorerTreeOptions) {
  const projectName = useProjectStore((state) => state.name);
  const projectDirectoryHandle = useUIStore(state => state.projectDirectoryHandle);
  const projectDirectoryName = useUIStore(state => state.projectDirectoryName);
  const [explorerTree, setExplorerTree] = useState<ExplorerTreeNode | null>(null);
  const explorerTreeRef = useRef(explorerTree);
  explorerTreeRef.current = explorerTree;
  const explorerReadRevision = useRef(0);
  const explorerMutationChanges = useRef<ExplorerChanges | null>(null);
  const [explorerDropTargetPath, setExplorerDropTargetPath] = useState<string | null>(null);
  const visibleExplorerTree = useMemo(() => sanitizeExplorerTree(explorerTree), [explorerTree]);
  const [, setExplorerStatus] = useState<'ready' | 'loading' | 'error'>('ready');
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [expandedExplorerPaths, setExpandedExplorerPaths] = useState<Set<string>>(
    () => new Set(['Project'])
  );
  const explorerPanelRef = useRef<HTMLDivElement | null>(null);
  const [selectedExplorerPaths, setSelectedExplorerPaths] = useState<Set<string>>(new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [focusedExplorerPath, setFocusedExplorerPath] = useState<string | null>(null);
  const [draggedExplorerEntries, setDraggedExplorerEntries] = useState<ExplorerItemEntry[] | null>(null);
  const draggedExplorerEntriesRef = useRef<ExplorerItemEntry[] | null>(null);
  const [activeExplorerDirectoryPath, setActiveExplorerDirectoryPath] = useState('Project');
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const externalExplorerRevision = useUIStore((state) => state.explorerRevision);

  useEffect(() => {
    let canceled = false;

    const loadExplorerTree = async () => {
      const revision = ++explorerReadRevision.current;
      if (projectDirectoryHandle) {
        setExplorerStatus('loading');
        setExplorerError(null);
        try {
          const tree = await readExplorerDirectory(
            projectDirectoryHandle,
            projectDirectoryName ?? projectDirectoryHandle.name,
            'Project'
          );
          if (!canceled && revision === explorerReadRevision.current) {
            setExplorerTree(tree);
            setExplorerStatus('ready');
          }
        } catch (error) {
          if (!canceled && revision === explorerReadRevision.current) {
            setExplorerTree(buildEmptyExplorerTree(projectName));
            setExplorerStatus('error');
            setExplorerError(error instanceof Error ? error.message : 'Unable to read project files');
          }
        }
        return;
      }

      setExplorerTree(buildEmptyExplorerTree(projectName));
      setExplorerStatus('ready');
      setExplorerError(null);
    };

    void loadExplorerTree();

    return () => {
      canceled = true;
    };
  }, [explorerRefreshKey, externalExplorerRevision, projectDirectoryHandle, projectDirectoryName, projectName]);

  const toggleExplorerPath = (path: string) => {
    setExpandedExplorerPaths((paths) => {
      const next = new Set(paths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const getVisibleExplorerNodes = (node: ExplorerTreeNode | null = visibleExplorerTree): ExplorerTreeNode[] =>
    getVisibleNodes(node, expandedExplorerPaths);

  const getAllExplorerNodes = (node: ExplorerTreeNode | null = visibleExplorerTree): ExplorerTreeNode[] =>
    getAllNodes(node);

  const findExplorerNodeByPath = (path: string, node: ExplorerTreeNode | null = visibleExplorerTree): ExplorerTreeNode | null => {
    if (!node) {
      return null;
    }
    if (node.path === path) {
      return node;
    }
    for (const child of node.children ?? []) {
      const match = findExplorerNodeByPath(path, child);
      if (match) {
        return match;
      }
    }
    return null;
  };

  const getActiveDirectoryChildren = (): ExplorerTreeNode[] => {
    const directory = findExplorerNodeByPath(activeExplorerDirectoryPath);
    return directory?.kind === 'folder' ? directory.children ?? [] : [];
  };

  const getFocusedExplorerNode = (): ExplorerTreeNode | null => {
    if (focusedExplorerPath) {
      return findExplorerNodeByPath(focusedExplorerPath);
    }
    const firstSelectedPath = getVisibleExplorerNodes().find((node) => selectedExplorerPaths.has(node.path))?.path;
    return firstSelectedPath ? findExplorerNodeByPath(firstSelectedPath) : null;
  };

  const getParentExplorerNode = (path: string): ExplorerTreeNode | null => {
    const parentPath = getParentExplorerPath(path);
    return parentPath === path ? null : findExplorerNodeByPath(parentPath);
  };

  const focusExplorerNode = (node: ExplorerTreeNode, extendSelection: boolean) => {
    setActiveExplorerNode(node);
    const row = Array.from(explorerPanelRef.current?.querySelectorAll<HTMLElement>('[data-explorer-row]') ?? [])
      .find(element => element.dataset.explorerPath === node.path);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
    if (extendSelection) {
      const anchor = selectionAnchorPath ?? focusedExplorerPath ?? node.path;
      setSelectionAnchorPath(anchor);
      selectExplorerRange(anchor, node.path);
      return;
    }
    setSelectedExplorerPaths(new Set([node.path]));
    setSelectionAnchorPath(node.path);
  };

  const moveExplorerKeyboardFocus = (direction: -1 | 1, extendSelection: boolean) => {
    const visibleNodes = getVisibleExplorerNodes();
    if (visibleNodes.length === 0) {
      return;
    }
    const focusedPath = focusedExplorerPath ?? selectedExplorerPaths.values().next().value;
    const currentIndex = visibleNodes.findIndex((node) => node.path === focusedPath);
    const nextIndex = Math.max(0, Math.min(visibleNodes.length - 1, currentIndex + direction));
    focusExplorerNode(visibleNodes[nextIndex], extendSelection);
  };

  const getSelectedExplorerEntries = (): ExplorerItemEntry[] =>
    getTopLevelExplorerEntries(
      getVisibleExplorerNodes()
        .flatMap((node): ExplorerItemEntry[] =>
          selectedExplorerPaths.has(node.path)
            ? [{
                path: node.path,
                name: node.name,
                kind: node.kind,
                workspaceImageId: node.kind === 'file' ? findWorkspaceImageIdForPath(node.path, useProjectStore.getState()) ?? undefined : undefined,
              }]
            : []
        )
    );

  const getExplorerEntriesForPaths = (paths: Set<string>): ExplorerItemEntry[] =>
    getTopLevelExplorerEntries(
      getVisibleExplorerNodes()
        .flatMap((node): ExplorerItemEntry[] =>
          paths.has(node.path)
            ? [{
                path: node.path,
                name: node.name,
                kind: node.kind,
                workspaceImageId: node.kind === 'file' ? findWorkspaceImageIdForPath(node.path, useProjectStore.getState()) ?? undefined : undefined,
              }]
            : []
        )
    );

  const createExplorerEntryForNode = (node: ExplorerTreeNode): ExplorerItemEntry => ({
    path: node.path,
    name: node.name,
    kind: node.kind,
    workspaceImageId: node.kind === 'file' ? findWorkspaceImageIdForPath(node.path, useProjectStore.getState()) ?? undefined : undefined,
  });

  const getExplorerEntriesFromTransferPath = (path: string): ExplorerItemEntry[] => {
    const node = findExplorerNodeByPath(path);
    return node ? [createExplorerEntryForNode(node)] : [];
  };

  const setCurrentDraggedExplorerEntries = (entries: ExplorerItemEntry[] | null) => {
    draggedExplorerEntriesRef.current = entries;
    setDraggedExplorerEntries(entries);
  };

  const getContextEntries = (node: ExplorerTreeNode): ExplorerItemEntry[] => {
    if (selectedExplorerPaths.has(node.path) && selectedExplorerPaths.size > 1) {
      return getSelectedExplorerEntries();
    }
    return [{ path: node.path, name: node.name, kind: node.kind }];
  };

  const setActiveExplorerNode = (node: ExplorerTreeNode) => {
    setFocusedExplorerPath(node.path);
    setActiveExplorerDirectoryPath(
      node.kind === 'folder'
        ? node.path
        : getParentExplorerPath(node.path)
    );
  };

  const selectExplorerRange = (anchorPath: string, targetPath: string) => {
    const visibleNodes = getVisibleExplorerNodes();
    const rangePaths = getExplorerRangePaths(visibleNodes, anchorPath, targetPath);
    if (!rangePaths) {
      return false;
    }
    setSelectedExplorerPaths(new Set(rangePaths));
    return true;
  };

  const handleExplorerMarqueeSelection = useCallback((paths: string[]) => {
    setSelectedExplorerPaths(new Set(paths));
    setSelectionAnchorPath(paths[0] ?? null);
    setFocusedExplorerPath(paths[0] ?? null);
  }, []);

  const selectExplorerNode = (node: ExplorerTreeNode, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
    setActiveExplorerNode(node);
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (node.kind === 'file') {
        void openFile(node);
      }
    }

    if (event.shiftKey && selectionAnchorPath) {
      if (selectExplorerRange(selectionAnchorPath, node.path)) {
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedExplorerPaths((paths) => {
        const next = new Set(paths);
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
      setSelectionAnchorPath(node.path);
      return;
    }

    setSelectedExplorerPaths(new Set([node.path]));
    setSelectionAnchorPath(node.path);
  };

  const startExplorerDrag = (node: ExplorerTreeNode) => {
    if (selectedExplorerPaths.has(node.path)) {
      setCurrentDraggedExplorerEntries(getSelectedExplorerEntries());
      return;
    }

    const nextSelection = new Set([node.path]);
    setActiveExplorerNode(node);
    setSelectedExplorerPaths(nextSelection);
    setSelectionAnchorPath(node.path);
    setCurrentDraggedExplorerEntries(getExplorerEntriesForPaths(nextSelection));
  };

  const refreshExplorer = () => {
    if (projectDirectoryHandle) invalidateWorkspaceFileAssetCache(projectDirectoryHandle);
    setExplorerRefreshKey((key) => key + 1);
  };

  const refreshChangedExplorer = async (directory: ProjectDirectoryHandle, changes: ExplorerChanges) => {
    if (!changes.moves.length && !changes.paths.length) return;
    const operationProjectId = useProjectStore.getState().id;
    const isCurrent = () => useUIStore.getState().projectDirectoryHandle === directory && useProjectStore.getState().id === operationProjectId;
    if (!isCurrent()) return;
    ++explorerReadRevision.current;
    const paths = new Set(changes.paths);
    for (const move of changes.moves) {
      if (!findExplorerTreeNode(explorerTreeRef.current, move.from)) paths.add(move.to);
      for (const path of [move.from, move.to]) {
        const kind = getExplorerFileKind(path);
        if (kind === 'image' || kind === 'psd') paths.add(getCaptionPathForImage(path));
      }
    }
    const replacements: Array<{ path: string; node?: ExplorerTreeNode }> = [];
    for (const path of paths) {
      const name = path.split('/').pop()!;
      try {
        let node: ExplorerTreeNode;
        try {
          const folder = await getDirectoryAtExplorerPath(directory, path);
          node = await readExplorerDirectory(folder, name, path);
        } catch (error) {
          if (!(error instanceof Error) || !['NotFoundError', 'TypeMismatchError'].includes(error.name)) throw error;
          const parent = await getExplorerParentDirectory(directory, path);
          await parent.directory.getFileHandle(name);
          node = { name, path, kind: 'file' };
        }
        replacements.push({ path, node });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'NotFoundError')) throw error;
        replacements.push({ path });
      }
    }
    await updateWorkspaceFileAssetCache(directory, changes);
    if (!isCurrent()) return;
    setExplorerTree(previous => {
      let next = moveExplorerTreeNodes(previous ?? buildEmptyExplorerTree(projectName), changes.moves);
      for (const { path, node } of replacements) next = replaceExplorerTreeNode(next, path, node);
      return next;
    });
    setExpandedExplorerPaths(paths => new Set([...paths].map(path => applyExplorerPathMoves(path, changes.moves))));
    useUIStore.getState().refreshAssetPreviews();
  };

  return {
    activeExplorerDirectoryPath, createExplorerEntryForNode, draggedExplorerEntries, draggedExplorerEntriesRef, expandedExplorerPaths,
    explorerDropTargetPath, explorerError, explorerMutationChanges, explorerPanelRef, explorerTree, findExplorerNodeByPath,
    focusExplorerNode, focusedExplorerPath, getActiveDirectoryChildren, getAllExplorerNodes, getContextEntries,
    getExplorerEntriesFromTransferPath, getFocusedExplorerNode, getParentExplorerNode, getSelectedExplorerEntries,
    getVisibleExplorerNodes, handleExplorerMarqueeSelection, moveExplorerKeyboardFocus, refreshChangedExplorer, refreshExplorer,
    selectExplorerNode, selectedExplorerPaths, setActiveExplorerDirectoryPath, setActiveExplorerNode,
    setCurrentDraggedExplorerEntries, setExpandedExplorerPaths, setExplorerDropTargetPath, setFocusedExplorerPath,
    setSelectedExplorerPaths, setSelectionAnchorPath, startExplorerDrag, toggleExplorerPath, visibleExplorerTree,
  };
}
