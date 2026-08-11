import type { ProjectDirectoryHandle } from './projectDirectoryService';

export type ExplorerEntryKind = 'folder' | 'file';

export type ExplorerFileKind = 'image' | 'text' | 'json' | 'video' | 'psd' | 'unknown';

export type ExplorerClipboardEntry = {
  path: string;
  name: string;
  kind: ExplorerEntryKind;
};

export type ExplorerClipboard = {
  mode: 'copy' | 'cut';
  entries: ExplorerClipboardEntry[];
};

type MovableFileSystemHandle = {
  move?: (destination: ProjectDirectoryHandle, name?: string) => Promise<void>;
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

const getExtension = (name: string): string => name.split('.').pop()?.toLowerCase() ?? '';

const getPathParts = (path: string): string[] => path.split('/').filter(Boolean).slice(1);

const getParentPath = (path: string): string => path.split('/').slice(0, -1).join('/') || 'Project';

const isNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name?: string }).name === 'NotFoundError';

export const getExplorerFileKind = (name: string, mimeType = ''): ExplorerFileKind => {
  const extension = getExtension(name);

  if (extension === 'psd') {
    return 'psd';
  }

  if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }

  if (extension === 'json' || mimeType === 'application/json') {
    return 'json';
  }

  if (extension === 'txt' || mimeType.startsWith('text/')) {
    return 'text';
  }

  if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }

  return 'unknown';
};

export const canOpenExplorerFile = (kind: ExplorerFileKind): boolean => kind !== 'unknown';

export const isExplorerImageFileName = (name: string): boolean => {
  const kind = getExplorerFileKind(name);
  return kind === 'image';
};

export const getDirectoryAtExplorerPath = async (
  root: ProjectDirectoryHandle,
  path: string
): Promise<ProjectDirectoryHandle> => {
  let directory = root;
  for (const part of getPathParts(path)) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory;
};

export const getExplorerParentDirectory = async (
  root: ProjectDirectoryHandle,
  path: string
): Promise<{ directory: ProjectDirectoryHandle; name: string }> => {
  const parts = getPathParts(path);
  const name = parts.pop();
  if (!name) {
    throw new Error('The project root has no parent directory.');
  }

  let directory = root;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part);
  }

  return { directory, name };
};

export const readExplorerFile = async (
  root: ProjectDirectoryHandle,
  path: string
): Promise<File> => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  return directory.getFileHandle(name).then((handle) => handle.getFile());
};

const entryExists = async (directory: ProjectDirectoryHandle, name: string): Promise<boolean> => {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  try {
    await directory.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  return false;
};

const assertValidName = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Use a valid file or folder name.');
  }
};

const assertAvailableName = async (directory: ProjectDirectoryHandle, name: string) => {
  const trimmed = name.trim();
  assertValidName(trimmed);

  if (await entryExists(directory, trimmed)) {
    throw new Error(`"${trimmed}" already exists.`);
  }
};

const splitExtension = (name: string): { stem: string; extension: string } => {
  const index = name.lastIndexOf('.');
  if (index <= 0) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, index), extension: name.slice(index) };
};

export const getUniqueExplorerName = async (
  directory: ProjectDirectoryHandle,
  desiredName: string
): Promise<string> => {
  const trimmed = desiredName.trim() || 'New Folder';
  assertValidName(trimmed);
  if (!(await entryExists(directory, trimmed))) {
    return trimmed;
  }

  const { stem, extension } = splitExtension(trimmed);
  const baseStem = stem.replace(/\s+\d+$/, '') || stem;
  let index = 2;
  while (await entryExists(directory, `${baseStem} ${index}${extension}`)) {
    index += 1;
  }
  return `${baseStem} ${index}${extension}`;
};

export const createExplorerDirectory = async (
  root: ProjectDirectoryHandle,
  destinationPath: string,
  name: string
): Promise<string> => {
  const directory = await getDirectoryAtExplorerPath(root, destinationPath);
  const targetName = await getUniqueExplorerName(directory, name);
  await directory.getDirectoryHandle(targetName, { create: true });
  return `${destinationPath}/${targetName}`;
};

const writeFile = async (directory: ProjectDirectoryHandle, name: string, file: Blob) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
};

const copyDirectoryContents = async (
  source: ProjectDirectoryHandle,
  destination: ProjectDirectoryHandle
) => {
  for await (const [entryName, entry] of source.entries()) {
    if ('entries' in entry) {
      const childDestination = await destination.getDirectoryHandle(entryName, { create: true });
      await copyDirectoryContents(entry, childDestination);
    } else {
      await writeFile(destination, entryName, await entry.getFile());
    }
  }
};

export const copyExplorerEntry = async (
  root: ProjectDirectoryHandle,
  source: ExplorerClipboardEntry,
  destinationPath: string,
  requestedName?: string
): Promise<string> => {
  const destination = await getDirectoryAtExplorerPath(root, destinationPath);
  const targetName = requestedName
    ? await getUniqueExplorerName(destination, requestedName)
    : await getUniqueExplorerName(destination, source.name);

  if (source.kind === 'folder') {
    if (destinationPath === source.path || destinationPath.startsWith(`${source.path}/`)) {
      throw new Error('Cannot paste a folder into itself.');
    }

    const sourceDirectory = await getDirectoryAtExplorerPath(root, source.path);
    const targetDirectory = await destination.getDirectoryHandle(targetName, { create: true });
    await copyDirectoryContents(sourceDirectory, targetDirectory);
    return `${destinationPath}/${targetName}`;
  }

  const file = await readExplorerFile(root, source.path);
  await writeFile(destination, targetName, file);
  return `${destinationPath}/${targetName}`;
};

export const copyExplorerEntries = async (
  root: ProjectDirectoryHandle,
  sources: ExplorerClipboardEntry[],
  destinationPath: string
): Promise<Array<{ from: string; to: string }>> => {
  const results: Array<{ from: string; to: string }> = [];
  for (const source of sources) {
    results.push({ from: source.path, to: await copyExplorerEntry(root, source, destinationPath) });
  }
  return results;
};

export const deleteExplorerEntry = async (
  root: ProjectDirectoryHandle,
  path: string,
  recursive = true
) => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  await directory.removeEntry(name, { recursive });
};

export const renameExplorerEntry = async (
  root: ProjectDirectoryHandle,
  path: string,
  entryKind: ExplorerEntryKind,
  nextName: string
): Promise<string> => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  const trimmedName = nextName.trim();
  if (trimmedName === name) {
    return path;
  }
  await assertAvailableName(directory, trimmedName);

  const handle =
    entryKind === 'folder'
      ? await directory.getDirectoryHandle(name)
      : await directory.getFileHandle(name);
  const movable = handle as unknown as MovableFileSystemHandle;
  if (typeof movable.move === 'function') {
    await movable.move(directory, trimmedName);
  } else {
    await copyExplorerEntry(
      root,
      { path, name, kind: entryKind },
      path.split('/').slice(0, -1).join('/'),
      trimmedName
    );
    await directory.removeEntry(name, { recursive: entryKind === 'folder' });
  }

  return `${path.split('/').slice(0, -1).join('/')}/${trimmedName}`;
};

const moveExplorerEntry = async (
  root: ProjectDirectoryHandle,
  source: ExplorerClipboardEntry,
  destinationPath: string
): Promise<string> => {
  if (source.kind === 'folder' && (destinationPath === source.path || destinationPath.startsWith(`${source.path}/`))) {
    throw new Error('Cannot move a folder into itself.');
  }
  if (getParentPath(source.path) === destinationPath) {
    return source.path;
  }

  const destination = await getDirectoryAtExplorerPath(root, destinationPath);
  const targetName = await getUniqueExplorerName(destination, source.name);
  const { directory, name } = await getExplorerParentDirectory(root, source.path);
  const handle =
    source.kind === 'folder'
      ? await directory.getDirectoryHandle(name)
      : await directory.getFileHandle(name);
  const movable = handle as unknown as MovableFileSystemHandle;

  if (typeof movable.move === 'function') {
    await movable.move(destination, targetName);
  } else {
    await copyExplorerEntry(root, source, destinationPath, targetName);
    await directory.removeEntry(name, { recursive: source.kind === 'folder' });
  }

  return `${destinationPath}/${targetName}`;
};

export const moveExplorerEntries = async (
  root: ProjectDirectoryHandle,
  sources: ExplorerClipboardEntry[],
  destinationPath: string
): Promise<Array<{ from: string; to: string }>> => {
  const results: Array<{ from: string; to: string }> = [];
  for (const source of sources) {
    results.push({ from: source.path, to: await moveExplorerEntry(root, source, destinationPath) });
  }
  return results;
};

export const duplicateExplorerEntries = async (
  root: ProjectDirectoryHandle,
  sources: ExplorerClipboardEntry[]
): Promise<Array<{ from: string; to: string }>> => {
  const results: Array<{ from: string; to: string }> = [];
  for (const source of sources) {
    results.push({ from: source.path, to: await copyExplorerEntry(root, source, getParentPath(source.path)) });
  }
  return results;
};
