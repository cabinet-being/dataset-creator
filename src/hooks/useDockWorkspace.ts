import { useCallback, useEffect, useState } from 'react';
import {
  DOCK_STORAGE_KEY, EXPLORER_VIEW, dockHosts, dockViews, findDockGroup, focusDockView,
  migrateDockLayout, openDockView, parseDockLayout, removeDockViews, mapDockNode,
  type DockLayout, type LegacyDockLayout,
} from '../lib/workspaceLayout';

export const useDockWorkspace = (legacy: LegacyDockLayout, editorIds: string[], activeEditor: string | null, pinnedEditorIds: string[]) => {
  const [layout, setLayout] = useState<DockLayout>(() => {
    try {
      const saved = parseDockLayout(JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null'));
      if (saved) return saved;
    } catch {}
    return migrateDockLayout(legacy, editorIds, window.innerWidth - 40, window.innerHeight - 36);
  });
  const editorSignature = JSON.stringify(editorIds);
  const pinnedSignature = JSON.stringify([...pinnedEditorIds, ...(layout.pinned ?? [])]);
  useEffect(() => {
    const pinned = new Set(JSON.parse(pinnedSignature) as string[]);
    setLayout((current) => {
      let changed = false;
      const sort = (root: typeof current.main) => mapDockNode(root, (node) => {
        if (node.type !== 'tabs') return node;
        const tabs = [...node.tabs.filter((id) => pinned.has(id)), ...node.tabs.filter((id) => !pinned.has(id))];
        if (tabs.some((id, index) => id !== node.tabs[index])) { changed = true; return { ...node, tabs }; }
        return node;
      });
      const next = { ...current, left: current.left ? sort(current.left) : null, main: sort(current.main), floating: current.floating.map((host) => ({ ...host, root: sort(host.root) })) };
      return changed ? next : current;
    });
  }, [pinnedSignature, layout]);
  useEffect(() => {
    const editors = JSON.parse(editorSignature) as string[];
    setLayout((current) => {
      const existing = dockHosts(current).flatMap((host) => dockViews(host.root));
      const removed = existing.filter((id) => !id.startsWith('window:') && !editors.includes(id));
      let next = removed.length ? removeDockViews(current, removed) : current;
      for (const id of editors) if (!findDockGroup(next, id)) next = openDockView(next, id);
      return next;
    });
  }, [editorSignature]);

  useEffect(() => {
    if (!activeEditor) return;
    setLayout((current) => focusDockView(openDockView(current, activeEditor), activeEditor));
  }, [activeEditor]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(layout)); } catch {}
    }, 120);
    return () => window.clearTimeout(timer);
  }, [layout]);

  const show = useCallback((id: string) => setLayout((current) => openDockView(current, id)), []);
  const close = useCallback((ids: string[]) => setLayout((current) => removeDockViews(current, ids)), []);
  const toggle = useCallback((id: string) => setLayout((current) => findDockGroup(current, id) ? removeDockViews(current, [id]) : openDockView(current, id)), []);
  const focus = useCallback((id: string) => setLayout((current) => focusDockView(current, id)), []);
  const isOpen = (id: string) => Boolean(findDockGroup(layout, id));
  return { layout, setLayout, show, close, toggle, focus, isOpen, explorerOpen: isOpen(EXPLORER_VIEW) };
};
