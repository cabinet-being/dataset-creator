import { OBJECT_STORES } from '../../lib/constants';
import type { ProjectType, TargetModelId } from '../../types';
import { dbDelete, dbGetAll, dbPut } from '../persistence/indexedDBService';
import type { ProjectDirectoryHandle } from './projectDirectoryService';

/**
 * Recently opened project folders. Handles live in IndexedDB (they are structured-cloneable), in the
 * `projects` store that no other module uses, so the database version and its migration stay untouched.
 */
export interface RecentProject {
  id: string;
  name: string;
  projectType: ProjectType;
  targetModel: TargetModelId;
  handle: ProjectDirectoryHandle;
  /** ISO time of the last change seen while the project was open (or when it was opened). */
  lastEditedAt: string;
  /** Frames inside dataset/ when the project was last seen. */
  datasetCount: number;
}

export type RecentProjectSummary = Pick<RecentProject, 'name' | 'projectType' | 'targetModel' | 'datasetCount'> & { lastEditedAt?: string };
export type RecentProjectAccess = 'granted' | 'prompt' | 'denied' | 'unknown';

export const MAX_RECENT_PROJECTS = 12;

type QueryableHandle = ProjectDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
};

const isRecentProject = (value: unknown): value is RecentProject => {
  const entry = value as Partial<RecentProject> | undefined;
  return Boolean(entry && typeof entry.id === 'string' && typeof entry.name === 'string' && entry.handle && typeof entry.lastEditedAt === 'string');
};

export const listRecentProjects = async (): Promise<RecentProject[]> => {
  const stored = await dbGetAll<unknown>(OBJECT_STORES.PROJECTS);
  return stored.filter(isRecentProject).sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
};

const findSameFolder = async (entries: RecentProject[], handle: ProjectDirectoryHandle): Promise<RecentProject | undefined> => {
  for (const entry of entries) {
    try { if (await entry.handle.isSameEntry?.(handle)) return entry; } catch { /* a stale handle is never the same folder */ }
  }
  return undefined;
};

/** Adds or refreshes the entry for this folder and trims the list to the most recent ones. */
export const rememberRecentProject = async (handle: ProjectDirectoryHandle, summary: RecentProjectSummary): Promise<void> => {
  const entries = await listRecentProjects();
  const existing = await findSameFolder(entries, handle);
  await dbPut<RecentProject>(OBJECT_STORES.PROJECTS, {
    ...summary,
    id: existing?.id ?? crypto.randomUUID(),
    handle,
    lastEditedAt: summary.lastEditedAt ?? existing?.lastEditedAt ?? new Date().toISOString(),
  });
  const remaining = entries.filter((entry) => entry.id !== existing?.id);
  await Promise.all(remaining.slice(MAX_RECENT_PROJECTS - 1).map((entry) => dbDelete(OBJECT_STORES.PROJECTS, entry.id)));
};

export const forgetRecentProject = (id: string): Promise<void> => dbDelete(OBJECT_STORES.PROJECTS, id);

export const getRecentProjectAccess = async (handle: ProjectDirectoryHandle): Promise<RecentProjectAccess> => {
  const queryable = handle as QueryableHandle;
  if (!queryable.queryPermission) return 'unknown';
  try { return await queryable.queryPermission({ mode: 'readwrite' }); } catch { return 'denied'; }
};
