import JSZip from 'jszip';
import type { ProjectDirectoryHandle } from './projectDirectoryService';
import {
  LEGACY_CACHE_DIRECTORY,
  PROJECT_GIT_DIRECTORY,
  PROJECT_INTERNAL_DIRECTORY,
  PROJECT_INTERNAL_PRESERVED_DIRECTORIES,
  PROJECT_FILE,
  PROJECT_LAYOUT,
  PROJECT_PROJECT_FORMAT,
  REQUIRED_PROJECT_DIRECTORIES,
} from './projectLayoutService';

export const VERSION_INDEX_PATH = `${PROJECT_LAYOUT.versionsDir}/index.json`;
export const VERSION_SNAPSHOT_DIRECTORY = `${PROJECT_LAYOUT.versionsDir}/snapshots`;
export const RESTORE_BACKUP_DIRECTORY = `${PROJECT_LAYOUT.backupDir}/restore`;
// Pre-v3 location of version data inside .git; read as a fallback until the layout migration moves it.
export const LEGACY_VERSION_INDEX_PATH = `${PROJECT_GIT_DIRECTORY}/dataset-creator-versions.json`;

export class ProjectVersionRestoreError extends Error {
  constructor(message: string, readonly previousRestored: boolean, readonly recoveryPath?: string) {
    super(message);
    this.name = 'ProjectVersionRestoreError';
  }
}

export type ProjectVersionLayout = 'v3' | 'legacy';

export type ProjectVersion = {
  id: string;
  name: string;
  parentId?: string;
  createdAt: string;
};

export type VersionIndex = {
  format: 'dataset-creator-versions';
  version: 1;
  currentId?: string;
  versions: ProjectVersion[];
};

// Root entries that are never snapshotted nor removed by restore: a real Git repository and the old reproducible cache.
const PRESERVED_ROOT_ENTRIES = new Set([PROJECT_GIT_DIRECTORY, LEGACY_CACHE_DIRECTORY]);
// Service folders inside .datasetcreator are never snapshotted, applied from a ZIP or removed by restore.
const PRESERVED_INTERNAL_PATHS = PROJECT_INTERNAL_PRESERVED_DIRECTORIES.map((name) => `${PROJECT_INTERNAL_DIRECTORY}/${name}`);
/** True for paths that snapshots never contain and restore never touches. */
export const isSnapshotExcludedPath = (path: string) =>
  PRESERVED_ROOT_ENTRIES.has(path.split('/')[0]) || PRESERVED_INTERNAL_PATHS.some((entry) => path === entry || path.startsWith(`${entry}/`));
const isRejectedSnapshotPath = (path: string) =>
  path.split('/')[0] === PROJECT_GIT_DIRECTORY || PRESERVED_INTERNAL_PATHS.some((entry) => path === entry || path.startsWith(`${entry}/`));

const getPathParts = (path: string): string[] => path.split('/').filter(Boolean);

const getDirectoryAtPath = async (root: ProjectDirectoryHandle, path: string, create = false) => {
  let directory = root;
  for (const part of getPathParts(path)) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return directory;
};

const getParentPath = (path: string) => getPathParts(path).slice(0, -1).join('/');
const getFileName = (path: string) => {
  const parts = getPathParts(path);
  return parts[parts.length - 1] ?? '';
};

const writeFile = async (directory: ProjectDirectoryHandle, name: string, value: Blob | string) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
};

const readFile = async (directory: ProjectDirectoryHandle, name: string) =>
  (await directory.getFileHandle(name)).getFile();

const writeFileAtPath = async (root: ProjectDirectoryHandle, path: string, value: Blob | string) =>
  writeFile(await getDirectoryAtPath(root, getParentPath(path), true), getFileName(path), value);

const readFileAtPath = async (root: ProjectDirectoryHandle, path: string) =>
  readFile(await getDirectoryAtPath(root, getParentPath(path)), getFileName(path));

const parseVersionIndex = (text: string): VersionIndex | undefined => {
  const index = JSON.parse(text) as VersionIndex;
  return index.format === 'dataset-creator-versions' && index.version === 1 && Array.isArray(index.versions) ? index : undefined;
};

export const readVersionIndex = async (root: ProjectDirectoryHandle): Promise<VersionIndex> => {
  for (const path of [VERSION_INDEX_PATH, LEGACY_VERSION_INDEX_PATH]) {
    try {
      const index = parseVersionIndex(await (await readFileAtPath(root, path)).text());
      if (index) return index;
    } catch {
      // A missing or unreadable index falls through to the legacy location, then to an empty version graph.
    }
  }
  return { format: 'dataset-creator-versions', version: 1, versions: [] };
};

export const writeVersionIndex = async (root: ProjectDirectoryHandle, index: VersionIndex) =>
  writeFileAtPath(root, VERSION_INDEX_PATH, JSON.stringify(index, null, 2));

const addDirectoryToZip = async (zip: JSZip, directory: ProjectDirectoryHandle, prefix = ''): Promise<void> => {
  for await (const [name, entry] of directory.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (isSnapshotExcludedPath(path)) {
      continue;
    }
    if ('entries' in entry) {
      zip.folder(path);
      await addDirectoryToZip(zip, entry, path);
    } else {
      zip.file(path, await (await entry.getFile()).arrayBuffer());
    }
  }
};

const clearDirectoryContents = async (directory: ProjectDirectoryHandle, prefix: string) => {
  const entries: Array<[string, boolean]> = [];
  for await (const [name, entry] of directory.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (isSnapshotExcludedPath(path)) continue;
    // The service folder is emptied entry by entry so its preserved folders survive.
    entries.push([name, path === PROJECT_INTERNAL_DIRECTORY && 'entries' in entry]);
  }
  const results = await Promise.allSettled(entries.map(async ([name, partial]) => {
    if (!partial) return directory.removeEntry(name, { recursive: true });
    await clearDirectoryContents(await directory.getDirectoryHandle(name), name);
  }));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
};

const clearProjectContents = async (root: ProjectDirectoryHandle) => clearDirectoryContents(root, '');

const applySnapshot = async (root: ProjectDirectoryHandle, zip: JSZip) => {
  await clearProjectContents(root);
  for (const entry of Object.values(zip.files)) {
    // Preserved entries (.git, .cache, service folders) are never applied from an old snapshot.
    if (isSnapshotExcludedPath(entry.name.replace(/\/$/, ''))) continue;
    if (entry.dir) await getDirectoryAtPath(root, entry.name, true);
    else await writeFileAtPath(root, entry.name, await entry.async('blob'));
  }
  for (const path of REQUIRED_PROJECT_DIRECTORIES) await getDirectoryAtPath(root, path, true);
};

// A snapshot holds either a v3 `.datasetcreator/project.json` or a legacy `manifest.json` (format v1/v2).
const readSnapshotLayout = async (zip: JSZip): Promise<ProjectVersionLayout> => {
  const readManifest = async (path: string) => {
    const text = await zip.file(path)?.async('string');
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  };
  const v3 = await readManifest(PROJECT_FILE);
  if (v3?.format === PROJECT_PROJECT_FORMAT && v3.version === 3 && v3.project?.id && v3.project?.name) return 'v3';
  const legacy = await readManifest('manifest.json');
  if (legacy?.format === 'dataset-creator-directory' && [1, 2].includes(legacy.version) && legacy.project?.id && legacy.project?.name) return 'legacy';
  throw new Error('The version has no valid project manifest.');
};

/** Reports whether restoring this version needs a layout upgrade afterwards (legacy snapshot). */
export const getProjectVersionLayout = async (root: ProjectDirectoryHandle, id: string): Promise<ProjectVersionLayout> => {
  const snapshot = await readFile(await getDirectoryAtPath(root, VERSION_SNAPSHOT_DIRECTORY), `${id}.zip`);
  return readSnapshotLayout(await JSZip.loadAsync(await snapshot.arrayBuffer()));
};

export const listProjectVersions = async (root: ProjectDirectoryHandle): Promise<{ currentId?: string; versions: ProjectVersion[] }> => {
  const index = await readVersionIndex(root);
  return { currentId: index.currentId, versions: index.versions };
};

export const createProjectVersion = async (root: ProjectDirectoryHandle, name: string): Promise<ProjectVersion> => {
  const label = name.trim();
  if (!label) {
    throw new Error('Version name is required.');
  }
  const index = await readVersionIndex(root);
  if (index.versions.some((version) => version.name === label)) {
    throw new Error(`Version "${label}" already exists.`);
  }
  const version: ProjectVersion = {
    id: crypto.randomUUID(),
    name: label,
    parentId: index.currentId,
    createdAt: new Date().toISOString(),
  };
  const zip = new JSZip();
  await addDirectoryToZip(zip, root);
  await writeFileAtPath(root, `${VERSION_SNAPSHOT_DIRECTORY}/${version.id}.zip`, await zip.generateAsync({ type: 'blob' }));
  await writeVersionIndex(root, {
    ...index,
    currentId: version.id,
    versions: [...index.versions, version],
  });
  return version;
};

export const restoreProjectVersion = async (
  root: ProjectDirectoryHandle,
  id: string,
  validate?: () => Promise<void>
): Promise<ProjectVersion> => {
  const index = await readVersionIndex(root);
  const version = index.versions.find((entry) => entry.id === id);
  if (!version) {
    throw new Error('Project version was not found.');
  }
  const snapshot = await readFile(await getDirectoryAtPath(root, VERSION_SNAPSHOT_DIRECTORY), `${version.id}.zip`);
  const zip = await JSZip.loadAsync(await snapshot.arrayBuffer(), {checkCRC32:true});
  for (const entry of Object.values(zip.files)) {
    const path = entry.dir ? entry.name.replace(/\/$/, '') : entry.name;
    const originalName = (entry as typeof entry & {unsafeOriginalName?: string}).unsafeOriginalName;
    if (path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\\') || isRejectedSnapshotPath(path) || (originalName && originalName !== entry.name)) {
      throw new Error('The version contains an invalid project path.');
    }
  }
  await readSnapshotLayout(zip);
  const backup = new JSZip();
  await addDirectoryToZip(backup, root);
  const recoveryPath = `${RESTORE_BACKUP_DIRECTORY}/${crypto.randomUUID()}.zip`;
  await writeFileAtPath(root, recoveryPath, await backup.generateAsync({type:'blob'}));
  let retainBackup = false;
  try {
    await applySnapshot(root, zip);
    await validate?.();
    await writeVersionIndex(root, { ...index, currentId: version.id });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await applySnapshot(root, backup);
      await writeVersionIndex(root, index);
    } catch {
      retainBackup = true;
      throw new ProjectVersionRestoreError(`Restore failed: ${detail}. Recovery also failed. The previous files are backed up in ${recoveryPath}.`, false, recoveryPath);
    }
    throw new ProjectVersionRestoreError(`Restore failed: ${detail}. Your previous files were restored.`, true);
  } finally {
    if (!retainBackup) {
      try { await (await getDirectoryAtPath(root, RESTORE_BACKUP_DIRECTORY)).removeEntry(getFileName(recoveryPath)); }
      catch { /* A leftover recovery copy does not change the restore result. */ }
    }
  }
  return version;
};

export const getProjectVersionPath = (versions: ProjectVersion[], id?: string): ProjectVersion[] => {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const path: ProjectVersion[] = [];
  let current = id ? byId.get(id) : undefined;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
};
