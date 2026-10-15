import { DATASET_VIEW, DOCK_STORAGE_KEY, normalizeDatasetDockLayout, parseDockLayout, type DockLayout } from './workspaceLayout';

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
  const normalizeId = (id: unknown) => typeof id === 'string' && /^dataset:[^:]+$/.test(id) ? DATASET_VIEW : id;
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
      if (entry.kind === 'dataset-tool') return { ...entry, datasetId: 'global' };
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

const normalized = (workspace: unknown, dock: DockLayout | null) => {
  const nextWorkspace = normalizeDatasetWorkspaceState(workspace);
  let nextDock = dock ? normalizeDatasetDockLayout(dock) : null;
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
