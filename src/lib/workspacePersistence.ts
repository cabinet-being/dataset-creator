import { DOCK_STORAGE_KEY, parseDockLayout, type DockLayout } from './workspaceLayout';

export const WORKSPACE_STORAGE_KEY = 'dataset-creator-workspace-v2';
export const LEGACY_WORKSPACE_STORAGE_KEY = 'dataset-creator-workspace-layout';
type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'getItem' | 'setItem'>;
const readJson = (storage: StorageReader, key: string): unknown => {
  try { return JSON.parse(storage.getItem(key) ?? 'null'); } catch { return null; }
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Legacy keys are read-only migration sources; views and docking now share one snapshot. */
export function readWorkspacePersistence(storage: StorageReader, projectId?: string): {workspace: unknown; dock: DockLayout | null} {
  const value = readJson(storage, WORKSPACE_STORAGE_KEY);
  if (record(value) && value.version === 2 && record(value.workspace)) {
    const saved = projectId && record(value.projects) ? value.projects[projectId] : undefined;
    if (record(saved) && record(saved.workspace) && saved.workspace.projectId === projectId) {
      return {workspace:saved.workspace, dock:parseDockLayout(saved.dock)};
    }
    return {workspace:value.workspace, dock:parseDockLayout(value.dock)};
  }
  return {workspace:readJson(storage, LEGACY_WORKSPACE_STORAGE_KEY), dock:parseDockLayout(readJson(storage, DOCK_STORAGE_KEY))};
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
