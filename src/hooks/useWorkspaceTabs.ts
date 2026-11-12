import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, SetStateAction } from 'react';
import {
  createToolTab, dedupeWorkspaceTabs, orderWorkspaceTabs, persistWorkspaceTab,
  type PersistedWorkspaceTab, type ToolWorkspaceTab, type WorkspaceTab,
} from '../lib/workspaceTabs';
import {
  readWorkspacePersistence, writeWorkspacePersistence, getRestorableWorkspaceTabs, readWorkspaceLayout, type WorkspaceLayout,
} from '../lib/workspacePersistence';
import { checkDirtyDocuments, useDocumentStateStore } from '../stores/useDocumentStateStore';
import { hasBusyVideoTabs } from '../services/video/videoClient';
import type { ProjectDirectoryHandle } from '../services/project/projectDirectoryService';
import type { ProjectState, ToolName } from '../types';
import type { useDockWorkspace } from './useDockWorkspace';

/** Tab state; must run before useDockWorkspace, which consumes openTabs and activeTabId. */
export function useWorkspaceTabsState(storedWorkspaceLayout: Partial<WorkspaceLayout>) {
  const [initialWorkspaceTabs] = useState<WorkspaceTab[]>(() =>
    getRestorableWorkspaceTabs(storedWorkspaceLayout).filter((tab) => tab.kind !== 'window' || tab.window === 'dataset')
  );
  const [openTabs, setOpenTabsState] = useState<WorkspaceTab[]>(initialWorkspaceTabs);
  const openTabsRef = useRef(openTabs);
  const setOpenTabs = useCallback((update: SetStateAction<WorkspaceTab[]>) => {
    const next = typeof update === 'function' ? update(openTabsRef.current) : update;
    openTabsRef.current = next;
    setOpenTabsState(next);
  }, []);
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    storedWorkspaceLayout.activeTabId === null ? null : initialWorkspaceTabs.some((tab) => tab.id === storedWorkspaceLayout.activeTabId)
      ? storedWorkspaceLayout.activeTabId ?? null
      : initialWorkspaceTabs[0]?.id ?? null
  );
  const [closedTabs, setClosedTabs] = useState<WorkspaceTab[]>([]);
  return { openTabs, openTabsRef, setOpenTabs, activeTabId, setActiveTabId, closedTabs, setClosedTabs };
}

type WorkspaceTabActionsOptions = {
  state: ReturnType<typeof useWorkspaceTabsState>;
  dock: ReturnType<typeof useDockWorkspace>;
  storedWorkspaceLayout: Partial<WorkspaceLayout>;
  persistWorkspaceRef: MutableRefObject<(() => void) | null>;
  projectDirectoryHandle: ProjectDirectoryHandle | undefined;
  projectId: string;
  activeActivityView: 'explorer' | 'versions';
  setActiveActivityView: (view: 'explorer' | 'versions') => void;
  setWorkspaceContextMenu: (menu: null) => void;
  setNavigationRecovery: (value: boolean) => void;
  setCurrentTool: (tool: ToolName) => void;
  setOpenMenu: (menu: null) => void;
  setTabMenuOpen: (open: boolean) => void;
  addNotification: (type: 'error', message: string) => void;
};

export function useWorkspaceTabActions({
  state, dock, storedWorkspaceLayout, persistWorkspaceRef, projectDirectoryHandle, projectId, activeActivityView,
  setActiveActivityView, setWorkspaceContextMenu, setNavigationRecovery, setCurrentTool, setOpenMenu, setTabMenuOpen, addNotification,
}: WorkspaceTabActionsOptions) {
  const { openTabs, setOpenTabs, activeTabId, setActiveTabId, closedTabs, setClosedTabs } = state;
  useEffect(() => {
    if (activeTabId === null || openTabs.some((tab) => tab.id === activeTabId)) {
      return;
    }
    setActiveTabId(openTabs[0]?.id ?? null);
  }, [activeTabId, openTabs]);

  const activateTab = (tab: WorkspaceTab) => {
    setNavigationRecovery(false);
    dock.show(tab.id);
    setActiveTabId(tab.id);
    if (tab.kind === 'tool') {
      setCurrentTool(tab.tool);
    }
    setOpenMenu(null);
    setTabMenuOpen(false);
    setWorkspaceContextMenu(null);
  };

  const pushClosedTabs = (tabs: WorkspaceTab[]) => {
    if (tabs.length === 0) {
      return;
    }
    setClosedTabs((current) => [...tabs, ...current.filter((tab) => !tabs.some((closedTab) => closedTab.id === tab.id))].slice(0, 12));
  };

  const toggleTabPinned = (tabId: string) => {
    setOpenTabs((tabs) => orderWorkspaceTabs(tabs.map((tab) => (tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab))));
    setWorkspaceContextMenu(null);
  };

  const reopenClosedTab = () => {
    const [tabToRestore, ...remainingTabs] = closedTabs;
    if (!tabToRestore) {
      return;
    }
    setClosedTabs(remainingTabs);
    setOpenTabs((tabs) => {
      if (tabs.some((tab) => tab.id === tabToRestore.id)) {
        return tabs;
      }
      return [...tabs, tabToRestore];
    });
    setActiveTabId(tabToRestore.id);
    setWorkspaceContextMenu(null);
  };

  const applyWorkspaceTabsForProject = (nextProject: ProjectState) => {
    const nextProjectId = nextProject.id;
    const layout = readWorkspaceLayout(nextProjectId);
    if (layout.projectId === nextProjectId) {
      const savedDock = readWorkspacePersistence(window.localStorage, nextProjectId).dock;
      if (savedDock) dock.setLayout(savedDock);
      setActiveActivityView(layout.activeActivityView ?? 'explorer');
    }
    const datasets = { [nextProject.dataset.id]: nextProject.dataset };
    const restoredTabs = getRestorableWorkspaceTabs(layout, nextProjectId).filter((tab) => {
      if (tab.kind === 'tool') {
        return true;
      }
      if (tab.kind === 'dataset') {
        return Boolean(datasets[tab.datasetId]);
      }
      if (tab.kind === 'dataset-tool') {
        return Boolean(datasets[tab.datasetId]);
      }
      return tab.kind === 'window' && tab.window === 'dataset';
    });

    const currentToolTabs = openTabs.filter((tab): tab is ToolWorkspaceTab => tab.kind === 'tool').map(tab => ({
      ...tab,
      scope: tab.scope?.review ? { review: tab.scope.review } : undefined,
      nested: undefined,
      dirty: false,
    }));
    const restoredToolTabs = restoredTabs.filter((tab): tab is ToolWorkspaceTab => tab.kind === 'tool');
    const nextTabs = dedupeWorkspaceTabs([
      ...(restoredToolTabs.length > 0 ? restoredToolTabs : currentToolTabs),
      ...restoredTabs.filter((tab) => tab.kind !== 'tool'),
    ]);

    const restoredActiveTab = nextTabs.find((tab) => tab.id === layout.activeTabId);
    if (restoredActiveTab) {
      setOpenTabs(nextTabs);
      setActiveTabId(restoredActiveTab.id);
      return;
    }

    // Without a saved active editor, an opened project lands in Build, the main path.
    const buildTab = nextTabs.find((tab) => tab.kind === 'tool' && tab.tool === 'build') ?? createToolTab('build');
    setOpenTabs(nextTabs.includes(buildTab) ? nextTabs : [...nextTabs, buildTab]);
    dock.show(buildTab.id);
    setActiveTabId(buildTab.id);
    setCurrentTool('build');
  };

  const confirmClosingTabs = async (tabs: WorkspaceTab[]): Promise<boolean> => {
    if (hasBusyVideoTabs(tabs.map((tab) => tab.id)) && !window.confirm('Cancel the running video operation and close its tab? Already saved frames will remain in the project.')) return false;
    let checked: string[];
    try { checked = await checkDirtyDocuments(tabs.map(tab => tab.id)); }
    catch (error) { addNotification('error', error instanceof Error ? error.message : 'Could not verify unsaved changes'); return false; }
    const registered = useDocumentStateStore.getState().documents;
    const dirtyCount = tabs.filter(tab => checked.includes(tab.id) || (!registered[tab.id] && tab.dirty)).length;
    if (dirtyCount === 0) {
      return true;
    }
    return window.confirm(
      `Close ${dirtyCount === 1 ? '1 tab' : `${dirtyCount} tabs`} with unsaved changes?`
    );
  };

  useEffect(() => {
    const persist = () => {
      try {
        const persistableActiveTab = openTabs.find((tab) => tab.id === activeTabId);
        const persistedActiveTab = persistableActiveTab ? persistWorkspaceTab(persistableActiveTab) : null;
        const persistedOpenTabs = openTabs
          .map(persistWorkspaceTab)
          .filter((tab): tab is PersistedWorkspaceTab => Boolean(tab));
        const nextOpenTabs = projectDirectoryHandle
          ? persistedOpenTabs
          : [
              ...persistedOpenTabs.filter((tab) => tab.kind === 'tool'),
              ...(storedWorkspaceLayout.openTabs ?? []).filter((tab) => tab.kind !== 'tool'),
            ];
        writeWorkspacePersistence(
          window.localStorage,
          {
            openTabs: nextOpenTabs,
            activeTabId: persistedActiveTab
              ? persistableActiveTab?.id ?? null
              : projectDirectoryHandle
                ? null
                : storedWorkspaceLayout.activeTabId ?? null,
            projectId: projectDirectoryHandle ? projectId : storedWorkspaceLayout.projectId ?? null,
            activeActivityView,
          } satisfies Partial<WorkspaceLayout>,
          dock.layout,
          projectDirectoryHandle ? projectId : undefined
        );
      } catch {
        // Workspace layout is a convenience; private browsing can disable localStorage.
      }
    };
    persistWorkspaceRef.current = persist;
    const timer = window.setTimeout(persist, 120);
    window.addEventListener('pagehide', persist);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', persist);
    };
  }, [
    activeActivityView,
    activeTabId,
    openTabs,
    projectDirectoryHandle,
    projectId,
    dock.layout,
  ]);

  return { activateTab, pushClosedTabs, toggleTabPinned, reopenClosedTab, applyWorkspaceTabsForProject, confirmClosingTabs };
}
