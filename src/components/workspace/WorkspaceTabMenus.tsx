import type { Dispatch, SetStateAction } from 'react';
import { Pin } from 'lucide-react';
import { MenuSurface } from '../ui/MenuSurface';
import { ContextActionGroups, type ContextActionGroup } from '../ui/ContextActions';
import type { ExplorerTreeNode } from './ExplorerTree';
import type { DockView } from './DockWorkspace';
import { isFileBackedTab } from '../../lib/workspaceFileTabs';
import type { WorkspaceTab } from '../../lib/workspaceTabs';
import { EXPLORER_VIEW, findDockGroup, floatDockSource, moveDockSource, type DockLayout } from '../../lib/workspaceLayout';

export type WorkspaceContextMenuState = { id: string; x: number; y: number };
export type ExplorerContextMenuState = {
  node: ExplorerTreeNode;
  x: number;
  y: number;
  actionGroups?: ContextActionGroup[];
};

export function WorkspaceTabMenus({
  workspaceViews, dockLayout, setDockLayout, openTabs, closedTabs, 
  workspaceContextMenu, setWorkspaceContextMenu, explorerContextMenu, setExplorerContextMenu, closeTopMenus,
  reopenClosedTab, toggleTabPinned, closeWorkspaceViews, getFileContextActionGroups, getDirectoryContextActionGroups,
}: {
  workspaceViews: DockView[];
  dockLayout: DockLayout;
  setDockLayout: Dispatch<SetStateAction<DockLayout>>;
  openTabs: WorkspaceTab[];
  closedTabs: WorkspaceTab[];
  workspaceContextMenu: WorkspaceContextMenuState | null;
  setWorkspaceContextMenu: (menu: WorkspaceContextMenuState | null) => void;
  explorerContextMenu: ExplorerContextMenuState | null;
  setExplorerContextMenu: (menu: ExplorerContextMenuState | null) => void;
  closeTopMenus: () => void;
  reopenClosedTab: () => void;
  toggleTabPinned: (tabId: string) => void;
  closeWorkspaceViews: (ids: string[]) => void | Promise<void>;
  getFileContextActionGroups: (node: ExplorerTreeNode) => ContextActionGroup[];
  getDirectoryContextActionGroups: (node: ExplorerTreeNode) => ContextActionGroup[];
}) {
  const contextView = workspaceViews.find((view) => view.id === workspaceContextMenu?.id);
  const contextGroup = contextView ? findDockGroup(dockLayout, contextView.id) : null;
  const groupIds = contextGroup?.group.tabs ?? [];
  const sortedGroupIds = [...groupIds.filter((id) => workspaceViews.find((view) => view.id === id)?.pinned), ...groupIds.filter((id) => !workspaceViews.find((view) => view.id === id)?.pinned)];
  const menuClass = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-40';
  return <>
    {workspaceContextMenu && contextView && <>
      <button type="button" aria-label="Close tab menu" className="fixed inset-0 z-[1800] cursor-default" onClick={() => setWorkspaceContextMenu(null)} />
      <MenuSurface onDismiss={() => { closeTopMenus(); setWorkspaceContextMenu(null); }} className="fixed z-[1801] w-52 rounded border border-border bg-popover p-1 text-xs shadow-xl" style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y }}>
        <button type="button" className={menuClass} onClick={() => {
          if (openTabs.some((tab) => tab.id === contextView.id)) toggleTabPinned(contextView.id);
          else setDockLayout((layout) => ({ ...layout, pinned: contextView.pinned ? layout.pinned?.filter((id) => id !== contextView.id) : [...(layout.pinned ?? []), contextView.id] }));
          setWorkspaceContextMenu(null);
        }}><Pin className="h-3.5 w-3.5" />{contextView.pinned ? 'Unpin tab' : 'Pin tab'}</button>
        {contextView.id !== EXPLORER_VIEW && <>
          {(['right', 'bottom'] as const).map((side) => <button key={side} type="button" className={menuClass} disabled={groupIds.length < 2} onClick={() => {
            if (contextGroup) setDockLayout((layout) => moveDockSource(layout, { type: 'tab', id: contextView.id }, { host: contextGroup.host, group: contextGroup.group.id, side }));
            setWorkspaceContextMenu(null);
          }}>{side === 'right' ? 'Split right' : 'Split down'}</button>)}
          <button type="button" className={menuClass} onClick={() => { setDockLayout((layout) => floatDockSource(layout, { type: 'tab', id: contextView.id }, { x: 100, y: 80, width: 500, height: 400 })); setWorkspaceContextMenu(null); }}>Detach</button>
        </>}
        <button type="button" className={menuClass} disabled={contextView.pinned} onClick={() => closeWorkspaceViews([contextView.id])}>Close</button>
        <button type="button" className={menuClass} onClick={() => closeWorkspaceViews(groupIds.filter((id) => id !== contextView.id))}>Close others</button>
        <button type="button" className={menuClass} onClick={() => closeWorkspaceViews(sortedGroupIds.slice(sortedGroupIds.indexOf(contextView.id) + 1))}>Close to the right</button>
        <button type="button" className={menuClass} onClick={() => closeWorkspaceViews(groupIds)}>Close all</button>
        <button type="button" className={menuClass} disabled={!closedTabs.length} onClick={() => { reopenClosedTab(); setWorkspaceContextMenu(null); }}>Reopen closed tab</button>
        {(() => { const tab = openTabs.find((entry) => entry.id === contextView.id); return tab && isFileBackedTab(tab) ? <button type="button" className={menuClass} onClick={() => { setWorkspaceContextMenu(null); setExplorerContextMenu({ node: { name: tab.name, path: tab.path, kind: 'file' }, x: workspaceContextMenu.x, y: workspaceContextMenu.y }); }}>File actions</button> : null; })()}
      </MenuSurface>
    </>}
            {explorerContextMenu && (
              <>
                <button
                  type="button"
                  aria-label="Close Explorer context menu"
                  className="fixed inset-0 z-[950] cursor-default"
                  onClick={() => setExplorerContextMenu(null)}
                />
                <MenuSurface onDismiss={() => setExplorerContextMenu(null)}
                  className="fixed z-[1000] w-44 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-xl"
                  style={{ left: explorerContextMenu.x, top: explorerContextMenu.y }}
                >
                  {explorerContextMenu.actionGroups
                    ? <ContextActionGroups groups={explorerContextMenu.actionGroups} />
                    : explorerContextMenu.node.kind === 'file'
                    ? <ContextActionGroups groups={getFileContextActionGroups(explorerContextMenu.node)} />
                    : <ContextActionGroups groups={getDirectoryContextActionGroups(explorerContextMenu.node)} />}
                </MenuSurface>
              </>
            )}
  </>;
}
