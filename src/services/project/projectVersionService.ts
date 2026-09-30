import JSZip from 'jszip';
import type { ProjectDirectoryHandle } from './projectDirectoryService';
import { PROJECT_GIT_DIRECTORY, REQUIRED_PROJECT_DIRECTORIES } from './projectLayoutService';

const VERSION_INDEX_PATH = `${PROJECT_GIT_DIRECTORY}/dataset-creator-versions.json`;
const VERSION_SNAPSHOT_DIRECTORY = `${PROJECT_GIT_DIRECTORY}/snapshots`;

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
    if (!prefix && name === PROJECT_GIT_DIRECTORY) {
      continue;
    }
    const path = prefix ? `${prefix}/${name}` : name;
    if ('entries' in entry) {
      await addDirectoryToZip(zip, entry, path);
    } else {
      zip.file(path, await (await entry.getFile()).arrayBuffer());
    }
  }
};

const clearProjectContents = async (root: ProjectDirectoryHandle) => {
  const entries: string[] = [];
  for await (const [name] of root.entries()) {
    if (name !== PROJECT_GIT_DIRECTORY) {
      entries.push(name);
    }
  }
  await Promise.all(entries.map((name) => root.removeEntry(name, { recursive: true })));
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

export const restoreProjectVersion = async (root: ProjectDirectoryHandle, id: string): Promise<ProjectVersion> => {
  const index = await readVersionIndex(root);
  const version = index.versions.find((entry) => entry.id === id);
  if (!version) {
    throw new Error('Project version was not found.');
  }
  const snapshot = await readFile(await getDirectoryAtPath(root, VERSION_SNAPSHOT_DIRECTORY), `${version.id}.zip`);
  const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
  await clearProjectContents(root);
  await Promise.all(Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map(async (entry) => writeFileAtPath(root, entry.name, await entry.async('blob'))));
  await Promise.all(REQUIRED_PROJECT_DIRECTORIES.map((path) => getDirectoryAtPath(root, path, true)));
  await writeVersionIndex(root, { ...index, currentId: version.id });
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
