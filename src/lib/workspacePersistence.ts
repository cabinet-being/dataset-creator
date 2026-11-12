import { createWorkspaceTabFromPersisted, migrateDatasetToolTabId, normalizeDatasetToolName, type PersistedWorkspaceTab, type WorkspaceTab } from './workspaceTabs';
import type { ToolSelectionScope } from './workspaceToolScope';
import { isToolName } from './constants';
import { DATASET_VIEW, DOCK_STORAGE_KEY, mapDockNode, normalizeDatasetDockLayout, parseDockLayout, type DockLayout, type DockNode } from './workspaceLayout';

export const WORKSPACE_STORAGE_KEY = 'dataset-creator-workspace-v2';
export const LEGACY_WORKSPACE_STORAGE_KEY = 'dataset-creator-workspace-layout';
type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'getItem' | 'setItem'>;
const readJson = (storage: StorageReader, key: string): unknown => {
  try { return JSON.parse(storage.getItem(key) ?? 'null'); } catch { return null; }
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const normalizeDatasetWorkspaceState = (workspace: unknown): unknown => {
  if (!record(workspace)) return workspace;
  const normalizeId = (id: unknown) => typeof id === 'string' ? /^dataset:[^:]+$/.test(id) ? DATASET_VIEW : migrateDatasetToolTabId(id) : id;
  const normalizeTabs = (value: unknown) => {
    if (!Array.isArray(value)) return value;
    let datasetPinned = false;
    const normalized = value.map((entry) => {
      if (!record(entry)) return entry;
      if (entry.kind === 'dataset' && typeof entry.datasetId === 'string') {
        datasetPinned ||= entry.pinned === true;
        return { kind: 'window', window: 'dataset', pinned: entry.pinned === true || undefined };
      }
      if (entry.kind === 'window' && entry.window === 'dataset') datasetPinned ||= entry.pinned === true;
      if (entry.kind === 'dataset-tool') return { ...entry, datasetId: 'global', tool: normalizeDatasetToolName(entry.tool) ?? entry.tool };
      return entry;
    });
    const seenDataset = new Set<string>();
    return normalized.filter((entry) => {
      if (!record(entry) || entry.kind !== 'window' || entry.window !== 'dataset') return true;
      if (seenDataset.has(DATASET_VIEW)) return false;
      seenDataset.add(DATASET_VIEW);
      if (datasetPinned) entry.pinned = true;
      return true;
    });
  };
  const next = { ...workspace };
  if ('activeTabId' in workspace) next.activeTabId = normalizeId(workspace.activeTabId);
  if ('openTabs' in workspace) next.openTabs = normalizeTabs(workspace.openTabs);
  if ('closedTabs' in workspace) next.closedTabs = normalizeTabs(workspace.closedTabs);
  return next;
};

/** Renames legacy dataset tool view ids (for example `dataset:global:select`) everywhere the dock refers to views. */
export const migrateDatasetToolDockIds = (layout: DockLayout): DockLayout => {
  const rename = (node: DockNode): DockNode => node.type === 'tabs'
    ? { ...node, tabs: [...new Set(node.tabs.map(migrateDatasetToolTabId))], active: node.active === null ? null : migrateDatasetToolTabId(node.active) }
    : node;
  const locations = Object.fromEntries(Object.entries(layout.locations).map(([id, location]) => [
    migrateDatasetToolTabId(id), location.neighbor ? { ...location, neighbor: migrateDatasetToolTabId(location.neighbor) } : location,
  ]));
  return {
    ...layout,
    left: layout.left ? mapDockNode(layout.left, rename) : null,
    main: mapDockNode(layout.main, rename),
    floating: layout.floating.map((float) => ({ ...float, root: mapDockNode(float.root, rename) })),
    locations,
    pinned: layout.pinned ? [...new Set(layout.pinned.map(migrateDatasetToolTabId))] : layout.pinned,
  };
};

const normalized = (workspace: unknown, dock: DockLayout | null) => {
  const nextWorkspace = normalizeDatasetWorkspaceState(workspace);
  let nextDock = dock ? migrateDatasetToolDockIds(normalizeDatasetDockLayout(dock)) : null;
  const datasetPinned = record(nextWorkspace) && Array.isArray(nextWorkspace.openTabs) && nextWorkspace.openTabs.some((entry) =>
    record(entry) && entry.kind === 'window' && entry.window === 'dataset' && entry.pinned === true);
  if (nextDock && datasetPinned && !nextDock.pinned?.includes(DATASET_VIEW)) nextDock = { ...nextDock, pinned: [...(nextDock.pinned ?? []), DATASET_VIEW] };
  return { workspace: nextWorkspace, dock: nextDock };
};

/** Legacy keys are read-only migration sources; views and docking now share one snapshot. */
export function readWorkspacePersistence(storage: StorageReader, projectId?: string): {workspace: unknown; dock: DockLayout | null} {
  const value = readJson(storage, WORKSPACE_STORAGE_KEY);
  if (record(value) && value.version === 2 && record(value.workspace)) {
    const saved = projectId && record(value.projects) ? value.projects[projectId] : undefined;
    if (record(saved) && record(saved.workspace) && saved.workspace.projectId === projectId) {
      return normalized(saved.workspace, parseDockLayout(saved.dock));
    }
    return normalized(value.workspace, parseDockLayout(value.dock));
  }
  return normalized(readJson(storage, LEGACY_WORKSPACE_STORAGE_KEY), parseDockLayout(readJson(storage, DOCK_STORAGE_KEY)));
}

export function writeWorkspacePersistence(storage: StorageWriter, workspace: object, dock: DockLayout, connectedProjectId?: string): void {
  const current = readJson(storage, WORKSPACE_STORAGE_KEY);
  if (record(current) && typeof current.version === 'number' && current.version > 2) {
    throw new Error('Workspace settings were saved by a newer version.');
  }
  const projects = record(current) && current.version === 2 && record(current.projects) ? {...current.projects} : {};
  if (!record(current) || !record(current.projects)) {
    const previous = readWorkspacePersistence(storage);
    if (record(previous.workspace) && typeof previous.workspace.projectId === 'string' && previous.dock) {
      projects[previous.workspace.projectId] = previous;
    }
  }
  // Only a connected project can replace its saved geometry. A temporary
  // workspace may still carry deferred tab metadata for the last project.
  if (connectedProjectId && record(workspace) && workspace.projectId === connectedProjectId) {
    projects[connectedProjectId] = {workspace, dock};
  }
  storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({version:2, workspace, dock, projects}));
}

export type FloatingPanelState = {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
};

export type WorkspaceLayout = {
  openTabs: PersistedWorkspaceTab[];
  projectId?: string | null;
  activeTabId?: string | null;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  projectWindow: FloatingPanelState;
  datasetWindow: FloatingPanelState;
  inspectorWindow: FloatingPanelState;
  outputWindow: FloatingPanelState;
  projectWindowOpen: boolean;
  datasetWindowOpen: boolean;
  inspectorWindowOpen: boolean;
  outputWindowOpen: boolean;
  activeActivityView: 'explorer' | 'versions';
};

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const getRestorableWorkspaceTabs = (
  layout: Partial<WorkspaceLayout>,
  projectId?: string | null
): WorkspaceTab[] => {
  const restoreProjectTabs = Boolean(projectId && layout.projectId === projectId);
  return (layout.openTabs ?? [])
    .filter((tab) => tab.kind === 'tool' || tab.kind === 'window' || restoreProjectTabs)
    .map(createWorkspaceTabFromPersisted);
};

export const readWorkspaceLayout = (projectId?: string): Partial<WorkspaceLayout> => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const parsed = readWorkspacePersistence(window.localStorage, projectId).workspace;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const value = parsed as Record<string, unknown>;
    const openTabs = Array.isArray(value.openTabs)
      ? value.openTabs
          .map((tab): PersistedWorkspaceTab | null => {
            if (typeof tab === 'string' && isToolName(tab)) {
              return { kind: 'tool', tool: tab };
            }
            if (!tab || typeof tab !== 'object') {
              return null;
            }
            const entry = tab as { kind?: unknown; tool?: unknown; datasetId?: unknown; window?: unknown; pinned?: unknown; id?: unknown; scope?: unknown } & Record<string, unknown>;
            const pinned = typeof entry.pinned === 'boolean' ? entry.pinned : undefined;
            const legacyTool = entry[`sta${'ge'}`];
            const entryTool = typeof entry.tool === 'string' ? entry.tool : legacyTool;
            if (entry.kind === 'tool' && typeof entryTool === 'string' && isToolName(entryTool)) {
              let scope: Pick<ToolSelectionScope, 'review'> | undefined;
              if (entryTool === 'review' && entry.scope && typeof entry.scope === 'object') {
                const review = (entry.scope as {review?:unknown}).review;
                if (review && typeof review === 'object') {
                  const value = review as {kind?:unknown;path?:unknown;paths?:unknown;label?:unknown};
                  if (value.kind === 'directory' && typeof value.path === 'string' && typeof value.label === 'string') {
                    scope = {review:{kind:'directory',path:value.path,label:value.label}};
                  } else if (value.kind === 'selection' && Array.isArray(value.paths) && value.paths.every((path) => typeof path === 'string') && typeof value.label === 'string') {
                    scope = {review:{kind:'selection',paths:value.paths as string[],label:value.label}};
                  }
                }
              }
              return { kind:'tool', tool:entryTool, pinned, scope, id:typeof entry.id === 'string' ? entry.id : undefined };
            }
            if (entry.kind === 'dataset' && typeof entry.datasetId === 'string') {
              return { kind: 'dataset', datasetId: entry.datasetId, pinned };
            }
            const datasetTool = entry.kind === 'dataset-tool' ? normalizeDatasetToolName(entryTool) : null;
            if (entry.kind === 'dataset-tool' && typeof entry.datasetId === 'string' && datasetTool) {
              return { kind: 'dataset-tool', datasetId: entry.datasetId, tool: datasetTool, pinned };
            }
            if (entry.kind === 'window' && (entry.window === 'inspector' || entry.window === 'output' || entry.window === 'project' || entry.window === 'dataset')) {
              return { kind: 'window', window: entry.window, pinned };
            }
            return null;
          })
          .filter((tab): tab is PersistedWorkspaceTab => Boolean(tab))
      : undefined;
    const readPanel = (panel: unknown, fallback: FloatingPanelState): FloatingPanelState => {
      if (!panel || typeof panel !== 'object') {
        return fallback;
      }
      const value = panel as Record<string, unknown>;
      return {
        x: isFiniteNumber(value.x) ? value.x : fallback.x,
        y: isFiniteNumber(value.y) ? value.y : fallback.y,
        width: isFiniteNumber(value.width) ? value.width : fallback.width,
        height: isFiniteNumber(value.height) ? value.height : fallback.height,
        minimized: typeof value.minimized === 'boolean' ? value.minimized : fallback.minimized,
      };
    };

    return {
      openTabs: openTabs
        ? openTabs.filter(
            (tab, index, tabs) =>
              tabs.findIndex((entry) => {
                if (entry.kind !== tab.kind) {
                  return false;
                }
                if (entry.kind === 'tool' && tab.kind === 'tool') {
                  return entry.tool === tab.tool;
                }
                if (entry.kind === 'dataset' && tab.kind === 'dataset') {
                  return entry.datasetId === tab.datasetId;
                }
                if (entry.kind === 'window' && tab.kind === 'window') {
                  return entry.window === tab.window;
                }
                return (
                  entry.kind === 'dataset-tool' &&
                  tab.kind === 'dataset-tool' &&
                  entry.datasetId === tab.datasetId &&
                  entry.tool === tab.tool
                );
              }) === index
          )
        : undefined,
      projectId: typeof value.projectId === 'string' ? value.projectId : null,
      activeTabId: typeof value.activeTabId === 'string' ? value.activeTabId : null,
      leftPanelOpen: typeof value.leftPanelOpen === 'boolean' ? value.leftPanelOpen : undefined,
      rightPanelOpen: typeof value.rightPanelOpen === 'boolean' ? value.rightPanelOpen : undefined,
      bottomPanelOpen: typeof value.bottomPanelOpen === 'boolean' ? value.bottomPanelOpen : undefined,
      leftPanelWidth: isFiniteNumber(value.leftPanelWidth) ? value.leftPanelWidth : undefined,
      rightPanelWidth: isFiniteNumber(value.rightPanelWidth) ? value.rightPanelWidth : undefined,
      bottomPanelHeight: isFiniteNumber(value.bottomPanelHeight) ? value.bottomPanelHeight : undefined,
      projectWindow: readPanel(value.projectWindow, {
        x: 92,
        y: 112,
        width: 300,
        height: 360,
        minimized: false,
      }),
      datasetWindow: readPanel(value.datasetWindow, {
        x: 150,
        y: 132,
        width: 320,
        height: 380,
        minimized: false,
      }),
      inspectorWindow: readPanel(value.inspectorWindow, {
        x: 420,
        y: 144,
        width: 300,
        height: 330,
        minimized: false,
      }),
      outputWindow: readPanel(value.outputWindow, {
        x: 320,
        y: 420,
        width: 620,
        height: 260,
        minimized: false,
      }),
      projectWindowOpen: typeof value.projectWindowOpen === 'boolean' ? value.projectWindowOpen : undefined,
      datasetWindowOpen: typeof value.datasetWindowOpen === 'boolean' ? value.datasetWindowOpen : undefined,
      inspectorWindowOpen: typeof value.inspectorWindowOpen === 'boolean' ? value.inspectorWindowOpen : undefined,
      outputWindowOpen: typeof value.outputWindowOpen === 'boolean' ? value.outputWindowOpen : undefined,
      activeActivityView: value.activeActivityView === 'versions' ? 'versions' : 'explorer',
    };
  } catch {
    return {};
  }
};
