import { useEffect, useRef, useState } from 'react';
import { readWorkspaceLocation, sameWorkspaceLocation, writeWorkspaceLocation, type WorkspaceLocation } from '../lib/workspaceNavigation';

type Options<View extends { id: string }> = {
  projectId: string;
  activeId: string | null;
  views: View[];
  closedViews: View[];
  toolFromUrl: () => View | null;
  toolSlug: (view: View) => string | null;
  activate: (view: View | null) => void;
  unavailable: () => void;
};

/** A single history writer for every editor, including the Welcome screen. */
export function useWorkspaceNavigation<View extends { id: string }>(options: Options<View>) {
  const latest = useRef(options);
  latest.current = options;
  const [ready, setReady] = useState(false);
  const firstWrite = useRef(true);
  const initialized = useRef(false);
  const restored = useRef<WorkspaceLocation | null>(null);

  useEffect(() => {
    const restore = (initial: boolean) => {
      const current = latest.current;
      const location = readWorkspaceLocation(window.history.state);
      const tool = current.toolFromUrl();
      // On an ordinary first visit, keep the saved layout's active editor.
      if (initial && !location && !tool) return;
      let view = tool;
      if (!tool && location?.viewId) {
        view = location.projectId === current.projectId
          ? [...current.views, ...current.closedViews].find(item => item.id === location.viewId) ?? null
          : null;
        if (!view) current.unavailable();
      }
      restored.current = { projectId: current.projectId, viewId: view?.id ?? null };
      current.activate(view);
    };
    if (!initialized.current) {
      initialized.current = true;
      restore(true);
    }
    setReady(true);
    const onPopState = () => restore(false);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const view = options.views.find(item => item.id === options.activeId);
    // Let the owner repair a removed active tab before recording navigation.
    if (options.activeId && !view) return;
    const location = { projectId: options.projectId, viewId: view?.id ?? null };
    const mode = firstWrite.current || sameWorkspaceLocation(restored.current, location) ? 'replace' : 'push';
    writeWorkspaceLocation(window.history, window.location.href, location, view ? options.toolSlug(view) : null, mode);
    firstWrite.current = false;
    restored.current = null;
  }, [ready, options.projectId, options.activeId, options.views, options.toolSlug]);
}
