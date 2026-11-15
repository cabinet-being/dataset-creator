import { useHistoryStore } from '../stores/useHistoryStore';
import { useCommands, type Command } from '../components/workspace/Commands';
import type { ExplorerTreeNode } from '../components/workspace/ExplorerTree';
import { ADVANCED_TOOL_GROUP_LABEL, TOOL_DEFINITIONS, type DatasetToolName } from '../lib/toolDefinitions';
import type { WorkspaceTab } from '../lib/workspaceTabs';
import type { ProjectTypeProfile } from '../lib/projectProfiles';
import type { Dataset, ToolName } from '../types';
import { WORKSPACE_WINDOWS } from '../components/workspace/WorkspaceMenus';
import { TOOLS, TOOL_LABELS } from '../lib/constants';
import { DATASET_VIEW, EXPLORER_VIEW, findDockGroup, floatDockSource, moveDockSource, migrateDockLayout, pinDockHost, focusDockView } from '../lib/workspaceLayout';
import type { ProjectDirectoryHandle } from '../services/project/projectDirectoryService';
import type { useDockWorkspace } from './useDockWorkspace';
import type { useProjectSave } from './useProjectSave';

export type ExplorerItemEntry = {
  path: string;
  name: string;
  kind: ExplorerTreeNode['kind'];
  workspaceImageId?: string;
};

export type ExplorerClipboard = {
  mode: 'copy' | 'cut';
  entries: ExplorerItemEntry[];
};

type WorkspaceCommandsOptions = {
  activeExplorerDirectoryPath: string;
  activeTab: WorkspaceTab | null;
  activeTabId: string | null;
  activeTool: ToolName | null;
  closedTabs: WorkspaceTab[];
  closeWorkspaceViews: (ids: string[]) => void | Promise<unknown>;
  dock: ReturnType<typeof useDockWorkspace>;
  explorerClipboard: ExplorerClipboard | null;
  explorerPanelRef: { current: HTMLElement | null };
  findExplorerNodeByPath: (path: string) => ExplorerTreeNode | null;
  focusView: (id: string) => void;
  getActiveDirectoryChildren: () => ExplorerTreeNode[];
  getSelectedExplorerEntries: () => ExplorerItemEntry[];
  globalDataset: Dataset;
  handleExplorerDelete: (node: ExplorerTreeNode) => void | Promise<unknown>;
  handleExplorerDuplicate: (node: ExplorerTreeNode) => void | Promise<unknown>;
  handleExplorerPaste: (node: ExplorerTreeNode) => void | Promise<unknown>;
  handleExplorerRename: (node: ExplorerTreeNode) => void | Promise<unknown>;
  handleNewProject: () => void | Promise<unknown>;
  handleOpenProject: () => void | Promise<unknown>;
  handleRenameProject: () => void | Promise<unknown>;
  isProjectDirectoryBusy: boolean;
  navigateToTool: (tool: ToolName) => void | Promise<unknown>;
  openCommands: (help?: boolean) => void;
  openProjectHome: () => void;
  openDatasetToolTab: (datasetId: string, tool: DatasetToolName) => void | Promise<unknown>;
  openProjectDataset: () => void | Promise<unknown>;
  openProjectVersions: () => void | Promise<unknown>;
  toggleExplorer: () => void;
  openTabs: WorkspaceTab[];
  profile: ProjectTypeProfile;
  projectDirectoryHandle: ProjectDirectoryHandle | undefined;
  projectSave: ReturnType<typeof useProjectSave>;
  reopenClosedTab: () => void | Promise<unknown>;
  setExplorerClipboard: (clipboard: ExplorerClipboard | null) => void;
  setIsWorkspaceSettingsOpen: (open: boolean) => void;
  setSelectedExplorerPaths: (paths: Set<string>) => void;
  setSelectionAnchorPath: (path: string | null) => void;
  setTheme: (theme: 'system' | 'light' | 'dark') => void;
  stepTab: (direction: number) => void;
};

export function useWorkspaceCommands({
  activeExplorerDirectoryPath, activeTab, activeTabId, activeTool, closedTabs, closeWorkspaceViews, dock, explorerClipboard,
  explorerPanelRef, findExplorerNodeByPath, focusView, getActiveDirectoryChildren, getSelectedExplorerEntries, globalDataset,
  handleExplorerDelete, handleExplorerDuplicate, handleExplorerPaste, handleExplorerRename, handleNewProject, handleOpenProject,
  handleRenameProject, isProjectDirectoryBusy, navigateToTool, openCommands, openProjectHome, openDatasetToolTab, openProjectDataset,
  openProjectVersions, openTabs, profile, projectDirectoryHandle, projectSave, reopenClosedTab, setExplorerClipboard, toggleExplorer,
  setIsWorkspaceSettingsOpen, setSelectedExplorerPaths, setSelectionAnchorPath, setTheme, stepTab,
}: WorkspaceCommandsOptions) {
  const history = useHistoryStore();
  const explorerSelection = getSelectedExplorerEntries();
  const explorerSelectionNode = explorerSelection.length ? findExplorerNodeByPath(explorerSelection[0].path) : null;
  const explorerCommandScope = () => explorerPanelRef.current;
  const explorerCommands: Command[] = [
    {id:'explorer.copy', label:'Explorer: Copy', shortcut:'Mod+C', disabled:!explorerSelection.length,
      run:() => setExplorerClipboard({mode:'copy', entries:explorerSelection})},
    {id:'explorer.cut', label:'Explorer: Cut', shortcut:'Mod+X', disabled:!explorerSelection.length,
      run:() => setExplorerClipboard({mode:'cut', entries:explorerSelection})},
    {id:'explorer.paste', label:'Explorer: Paste', shortcut:'Mod+V', disabled:!explorerClipboard || !projectDirectoryHandle,
      reason:!projectDirectoryHandle ? 'Open a project directory first' : !explorerClipboard ? 'Copy or cut files first' : undefined,
      run:() => handleExplorerPaste({name:activeExplorerDirectoryPath.split('/').pop() ?? 'Project', path:activeExplorerDirectoryPath, kind:'folder'})},
    {id:'explorer.duplicate', label:'Explorer: Duplicate', shortcut:'Mod+B', disabled:!explorerSelectionNode || !projectDirectoryHandle,
      run:() => {if (explorerSelectionNode) return handleExplorerDuplicate(explorerSelectionNode);}},
    {id:'explorer.rename', label:'Explorer: Rename', shortcut:'F2', disabled:explorerSelection.length !== 1 || !explorerSelectionNode || !projectDirectoryHandle,
      reason:!projectDirectoryHandle ? 'Open a project directory first' : 'Select one file or folder',
      run:() => {if (explorerSelectionNode) handleExplorerRename(explorerSelectionNode);}},
    {id:'explorer.delete', label:'Explorer: Delete', shortcut:'Delete', disabled:!explorerSelectionNode || !projectDirectoryHandle,
      run:() => {if (explorerSelectionNode) return handleExplorerDelete(explorerSelectionNode);}},
    {id:'explorer.selectAll', label:'Explorer: Select all in folder', shortcut:'Mod+A', run:() => {
      const nodes = getActiveDirectoryChildren();
      setSelectedExplorerPaths(new Set(nodes.map(node => node.path)));
      setSelectionAnchorPath(nodes[0]?.path ?? null);
    }},
  ];
  const workspaceCommands: Command[] = [
    ...explorerCommands.map(command => ({...command, group:'Explorer', scope:explorerCommandScope,
      reason:command.reason ?? (command.disabled ? !projectDirectoryHandle ? 'Open a project directory first' : 'Select files in Explorer' : undefined)})),
    { id: 'history.undo', label: `Undo${history.past.length ? " · " + history.past[history.past.length - 1].label : ""}`, shortcut: 'Mod+Z', disabled: !history.past.length || history.busy, run: history.undo },
    { id: 'history.redo', label: 'Redo', shortcut: 'Mod+Shift+Z', disabled: !history.future.length || history.busy, run: history.redo },
    { id: 'project.home', label: 'Project home', disabled: !projectDirectoryHandle, reason: !projectDirectoryHandle ? 'Open a project directory first' : undefined, run: openProjectHome },
    { id: 'project.new', label: 'New project', disabled: isProjectDirectoryBusy, run: handleNewProject },
    { id: 'project.open', label: 'Open project', disabled: isProjectDirectoryBusy, run: handleOpenProject },
    { id: 'project.rename', label: 'Rename project', disabled: isProjectDirectoryBusy, run: handleRenameProject },
    { id: 'project.versions', label: 'Project versions', disabled: !projectDirectoryHandle, reason: !projectDirectoryHandle ? 'Open a project directory first' : undefined, run: openProjectVersions },
    ...(['system', 'light', 'dark'] as const).map(mode => ({ id: `theme.${mode}`, label: `Theme: ${mode}`, run: () => setTheme(mode) })),
    ...WORKSPACE_WINDOWS.map(window => ({ id: `window.${window.id}`, label: `Toggle ${window.label}`, run: () => {
      const id = `window:${window.id}`;
      if (id === EXPLORER_VIEW) return toggleExplorer();
      if (dock.isOpen(id)) return closeWorkspaceViews([id]);
      if (id === DATASET_VIEW) return openProjectDataset();
      dock.show(id);
    } })),
    { id: 'dataset.open', label: 'Open Dataset', run: openProjectDataset },
    { id: 'dataset.add', label: 'Add files to Dataset', run: () => openDatasetToolTab(globalDataset.id, 'add-files') },
    { id: 'settings', label: 'Settings', run: () => setIsWorkspaceSettingsOpen(true) },
    { id: 'help', label: 'Keyboard shortcuts', run: () => openCommands(true) },
    { id: 'focus.editor', label: 'Return to active editor', disabled: !activeTabId, run: () => { if (activeTabId) focusView(activeTabId); } },
    { id: 'layout.reset', label: 'Reset workspace layout', run: () => dock.setLayout(layout => { const next = migrateDockLayout({ bottomPanelOpen: false }, openTabs.map(tab => tab.id), window.innerWidth - 40, window.innerHeight - 80); return { ...(activeTabId ? focusDockView(next, activeTabId) : next), pinned: layout.pinned }; }) },
    { id: 'tabs.next', label: 'Next editor tab', run: () => stepTab(1), disabled: openTabs.length < 2 },
    { id: 'tabs.previous', label: 'Previous editor tab', run: () => stepTab(-1), disabled: openTabs.length < 2 },
    { id: 'tabs.close', label: 'Close editor tab', run: () => { if (activeTab) closeWorkspaceViews([activeTab.id]); }, disabled: !activeTab || activeTab.pinned },
    { id: 'tabs.reopen', label: 'Reopen closed editor', run: reopenClosedTab, disabled: !closedTabs.length },
    { id: 'project.save', label: 'Save project', shortcut: 'Mod+S', shortcutEnabled: !(activeTool === 'clean' || activeTab?.kind === 'file-edit' || (activeTab?.kind === 'file-view' && activeTab.fileKind === 'psd')), allowInInput: true, disabled: !projectDirectoryHandle, run: projectSave.retry },
    ...(['explorer', 'inspector', 'output', 'dataset'] as const).map(id => ({ id: `focus.${id}`, label: `Focus ${id[0].toUpperCase() + id.slice(1)}`, run: () => focusView(`window:${id}`) })),
    ...TOOLS.filter(tool => profile.enabledTools.includes(tool)).map(tool => ({ id: `tool.${tool}`, label: TOOL_LABELS[tool],
      group: TOOL_DEFINITIONS[tool].tier === 'advanced' ? ADVANCED_TOOL_GROUP_LABEL : 'Tools', run: () => navigateToTool(tool) })),
    ...(['right', 'bottom'] as const).map(side => ({ id: `tabs.split.${side}`, label: `Split editor ${side}`, disabled: !activeTab || (findDockGroup(dock.layout, activeTab.id)?.group.tabs.length ?? 0) < 2, run: () => {
      if (!activeTab) return; const group = findDockGroup(dock.layout, activeTab.id); if (group) dock.setLayout(layout => moveDockSource(layout, { type: 'tab', id: activeTab.id }, { host: group.host, group: group.group.id, side }));
    } })),
    { id: 'tabs.dock', label: 'Dock / detach editor', disabled: !activeTab, run: () => { if (!activeTab) return; const group = findDockGroup(dock.layout, activeTab.id); if (group) dock.setLayout(layout => group.host !== 'main' && group.host !== 'left' ? pinDockHost(layout, group.host) : floatDockSource(layout, { type: 'tab', id: activeTab.id }, { x: 100, y: 80, width: 600, height: 450 })); } },
  ];
  useCommands(workspaceCommands.map(command => isProjectDirectoryBusy ? {...command,disabled:true,reason:'Wait for the project operation to finish'} : command));
}
