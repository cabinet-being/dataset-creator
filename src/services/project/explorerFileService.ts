import type { ProjectDirectoryHandle } from './projectDirectoryService';
import { getAssetManifestName, isAssetManifestName, isProjectManifestName } from './assetManifestService';
import { resolveProjectAssetKind } from './assetTypeService';
import { snapshotFile } from './fileSnapshotService';

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

const getPathParts = (path: string): string[] => {
  const parts = path.split('/').filter(Boolean);
  return parts[0] === 'Project' ? parts.slice(1) : parts;
};

const getParentPath = (path: string): string => {
  const parts = getPathParts(path);
  return parts.length > 1 ? ['Project', ...parts.slice(0, -1)].join('/') : 'Project';
};

const isNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name?: string }).name === 'NotFoundError';

const getExplorerOperationErrorMessage = (error: unknown, path: string): string | null => {
  if (isNotFoundError(error)) {
    return `"${path}" no longer exists. Refresh Explorer or reopen the project directory.`;
  }

  return null;
};

export const getExplorerFileKind = (name: string, mimeType = ''): ExplorerFileKind => {
  return resolveProjectAssetKind(name, mimeType);
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
  try {
    for (const part of getPathParts(path)) {
      directory = await directory.getDirectoryHandle(part);
    }
  } catch (error) {
    throw new Error(getExplorerOperationErrorMessage(error, path) ?? (error instanceof Error ? error.message : 'Unable to open project directory.'));
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
    throw new Error('Select a file or folder inside the project.');
  }

  let directory = root;
  try {
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part);
    }
  } catch (error) {
    throw new Error(getExplorerOperationErrorMessage(error, path) ?? (error instanceof Error ? error.message : 'Unable to open project path.'));
  }

  return { directory, name };
};

export const readExplorerFile = async (
  root: ProjectDirectoryHandle,
  path: string
): Promise<File> => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  if (isProjectManifestName(name) || isAssetManifestName(name)) {
    throw new Error('Project metadata files cannot be opened from Explorer.');
  }
  try {
    return await directory.getFileHandle(name).then((handle) => handle.getFile()).then(snapshotFile);
  } catch (error) {
    throw new Error(getExplorerOperationErrorMessage(error, path) ?? (error instanceof Error ? error.message : 'Unable to read file.'));
  }
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

const readOptionalTextFile = async (
  directory: ProjectDirectoryHandle,
  name: string
): Promise<string | null> => {
  try {
    return await (await directory.getFileHandle(name)).getFile().then((file) => file.text());
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
};

const removeOptionalFile = async (
  directory: ProjectDirectoryHandle,
  name: string
) => {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
};

const rewriteAssetManifest = (
  value: string,
  previousName: string,
  nextName: string
): string => {
  try {
    const manifest = JSON.parse(value) as Record<string, unknown>;
    for (const key of ['fileName', 'originalFileName', 'originalFileNameOnDisk', 'imageFileName', 'psdFileName']) {
      if (manifest[key] === previousName) {
        manifest[key] = nextName;
      }
    }
    for (const key of ['originalFilePath', 'imageDataPath', 'psdDataPath']) {
      if (typeof manifest[key] === 'string') {
        manifest[key] = (manifest[key] as string).replace(new RegExp(`${escapeRegExp(previousName)}$`), nextName);
      }
    }
    return JSON.stringify(manifest, null, 2);
  } catch {
    return value;
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const canUseName = async (name: string): Promise<boolean> =>
    !(await entryExists(directory, name)) &&
    (isAssetManifestName(name) || !(await entryExists(directory, getAssetManifestName(name))));

  if (await canUseName(trimmed)) {
    return trimmed;
  }

  const { stem, extension } = splitExtension(trimmed);
  const baseStem = stem.replace(/\s+\d+$/, '') || stem;
  let index = 2;
  while (!(await canUseName(`${baseStem} ${index}${extension}`))) {
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

const writeTextFile = async (directory: ProjectDirectoryHandle, name: string, value: string) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
};

const copyAssetManifest = async (
  sourceDirectory: ProjectDirectoryHandle,
  destinationDirectory: ProjectDirectoryHandle,
  sourceName: string,
  targetName: string
) => {
  const manifest = await readOptionalTextFile(sourceDirectory, getAssetManifestName(sourceName));
  if (manifest === null) {
    return;
  }
  await writeTextFile(
    destinationDirectory,
    getAssetManifestName(targetName),
    rewriteAssetManifest(manifest, sourceName, targetName)
  );
};

const moveAssetManifest = async (
  sourceDirectory: ProjectDirectoryHandle,
  destinationDirectory: ProjectDirectoryHandle,
  sourceName: string,
  targetName: string
) => {
  await copyAssetManifest(sourceDirectory, destinationDirectory, sourceName, targetName);
  await removeOptionalFile(sourceDirectory, getAssetManifestName(sourceName));
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
      await writeFile(destination, entryName, await snapshotFile(await entry.getFile()));
    }
  }
};

export const copyExplorerEntry = async (
  root: ProjectDirectoryHandle,
  source: ExplorerClipboardEntry,
  destinationPath: string,
  requestedName?: string
): Promise<string> => {
  if (source.kind === 'file' && (isProjectManifestName(source.name) || isAssetManifestName(source.name))) {
    throw new Error('Project metadata files cannot be copied from Explorer.');
  }
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
  const { directory: sourceDirectory, name: sourceName } = await getExplorerParentDirectory(root, source.path);
  await copyAssetManifest(sourceDirectory, destination, sourceName, targetName);
  return `${destinationPath}/${targetName}`;
};

const assertCanPlaceExplorerEntries = (
  sources: ExplorerClipboardEntry[],
  destinationPath: string,
  operation: 'copy' | 'move'
) => {
  const invalidFolder = sources.find(
    (source) =>
      source.kind === 'folder' &&
      (destinationPath === source.path || destinationPath.startsWith(`${source.path}/`))
  );
  if (!invalidFolder) {
    return;
  }

  throw new Error(
    operation === 'copy'
      ? 'Cannot paste a folder into itself.'
      : 'Cannot move a folder into itself.'
  );
};

export const copyExplorerEntries = async (
  root: ProjectDirectoryHandle,
  sources: ExplorerClipboardEntry[],
  destinationPath: string
): Promise<Array<{ from: string; to: string }>> => {
  assertCanPlaceExplorerEntries(sources, destinationPath, 'copy');
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
  if (isProjectManifestName(name) || isAssetManifestName(name)) {
    throw new Error('Project metadata files cannot be deleted from Explorer.');
  }
  await directory.removeEntry(name, { recursive });
  await removeOptionalFile(directory, getAssetManifestName(name));
};

export const renameExplorerEntry = async (
  root: ProjectDirectoryHandle,
  path: string,
  entryKind: ExplorerEntryKind,
  nextName: string
): Promise<string> => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  if (isProjectManifestName(name) || isAssetManifestName(name)) {
    throw new Error('Project metadata files cannot be renamed from Explorer.');
  }
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
    if (entryKind === 'file') {
      await moveAssetManifest(directory, directory, name, trimmedName);
    }
  } else {
    await copyExplorerEntry(
      root,
      { path, name, kind: entryKind },
      path.split('/').slice(0, -1).join('/'),
      trimmedName
    );
    await directory.removeEntry(name, { recursive: entryKind === 'folder' });
    if (entryKind === 'file') {
      await removeOptionalFile(directory, getAssetManifestName(name));
    }
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
    if (source.kind === 'file') {
      await moveAssetManifest(directory, destination, name, targetName);
    }
  } else {
    await copyExplorerEntry(root, source, destinationPath, targetName);
    await directory.removeEntry(name, { recursive: source.kind === 'folder' });
    if (source.kind === 'file') {
      await removeOptionalFile(directory, getAssetManifestName(name));
    }
  }

  return `${destinationPath}/${targetName}`;
};

export const moveExplorerEntries = async (
  root: ProjectDirectoryHandle,
  sources: ExplorerClipboardEntry[],
  destinationPath: string
): Promise<Array<{ from: string; to: string }>> => {
  assertCanPlaceExplorerEntries(sources, destinationPath, 'move');
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
