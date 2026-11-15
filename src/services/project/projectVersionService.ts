import JSZip from 'jszip';
import type { ProjectDirectoryHandle } from './projectDirectoryService';
import { PROJECT_CACHE_DIRECTORY, PROJECT_GIT_DIRECTORY, REQUIRED_PROJECT_DIRECTORIES } from './projectLayoutService';

const VERSION_INDEX_PATH = `${PROJECT_GIT_DIRECTORY}/dataset-creator-versions.json`;
const VERSION_SNAPSHOT_DIRECTORY = `${PROJECT_GIT_DIRECTORY}/snapshots`;
const RESTORE_BACKUP_DIRECTORY = `${PROJECT_GIT_DIRECTORY}/restore-backups`;

export class ProjectVersionRestoreError extends Error {
  constructor(message: string, readonly previousRestored: boolean, readonly recoveryPath?: string) {
    super(message);
    this.name = 'ProjectVersionRestoreError';
  }
}

export type ProjectVersion = {
  id: string;
  name: string;
  parentId?: string;
  createdAt: string;
};

type VersionIndex = {
  format: 'dataset-creator-versions';
  version: 1;
  currentId?: string;
  versions: ProjectVersion[];
};

// Root entries that are never snapshotted nor removed by restore: Git/version storage and the reproducible cache.
const PRESERVED_ROOT_ENTRIES = new Set([PROJECT_GIT_DIRECTORY, PROJECT_CACHE_DIRECTORY]);

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

const readVersionIndex = async (root: ProjectDirectoryHandle): Promise<VersionIndex> => {
  try {
    const file = await readFileAtPath(root, VERSION_INDEX_PATH);
    const index = JSON.parse(await file.text()) as VersionIndex;
    if (index.format === 'dataset-creator-versions' && index.version === 1 && Array.isArray(index.versions)) {
      return index;
    }
  } catch {
    // A project without version tags starts with an empty version graph.
  }
  return { format: 'dataset-creator-versions', version: 1, versions: [] };
};

const writeVersionIndex = async (root: ProjectDirectoryHandle, index: VersionIndex) =>
  writeFileAtPath(root, VERSION_INDEX_PATH, JSON.stringify(index, null, 2));

const addDirectoryToZip = async (zip: JSZip, directory: ProjectDirectoryHandle, prefix = ''): Promise<void> => {
  for await (const [name, entry] of directory.entries()) {
    if (!prefix && PRESERVED_ROOT_ENTRIES.has(name)) {
      continue;
    }
    const path = prefix ? `${prefix}/${name}` : name;
    if ('entries' in entry) {
      zip.folder(path);
      await addDirectoryToZip(zip, entry, path);
    } else {
      zip.file(path, await (await entry.getFile()).arrayBuffer());
    }
  }
};

const clearProjectContents = async (root: ProjectDirectoryHandle) => {
  const entries: string[] = [];
  for await (const [name] of root.entries()) {
    if (!PRESERVED_ROOT_ENTRIES.has(name)) {
      entries.push(name);
    }
  }
  const results = await Promise.allSettled(entries.map((name) => root.removeEntry(name, { recursive: true })));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
};

const applySnapshot = async (root: ProjectDirectoryHandle, zip: JSZip) => {
  await clearProjectContents(root);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) await getDirectoryAtPath(root, entry.name, true);
    else await writeFileAtPath(root, entry.name, await entry.async('blob'));
  }
  for (const path of REQUIRED_PROJECT_DIRECTORIES) await getDirectoryAtPath(root, path, true);
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
    if (path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\\') || path.split('/')[0] === PROJECT_GIT_DIRECTORY || (originalName && originalName !== entry.name)) {
      throw new Error('The version contains an invalid project path.');
    }
  }
  const manifestText = await zip.file('manifest.json')?.async('string');
  const manifest = manifestText ? JSON.parse(manifestText) : null;
  if (manifest?.format !== 'dataset-creator-directory' || ![1, 2].includes(manifest.version) || !manifest.project?.id || !manifest.project?.name) {
    throw new Error('The version has no valid project manifest.');
  }
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
