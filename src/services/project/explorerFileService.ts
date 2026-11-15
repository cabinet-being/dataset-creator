import type { ProjectDirectoryHandle } from './projectDirectoryService';
import { isAssetManifestName, isHiddenExplorerManifestName, isProjectManifestName } from './assetManifestService';
import { isSupportedProjectAsset, resolveProjectAssetKind } from './assetTypeService';
import { snapshotFile } from './fileSnapshotService';
import type { ExplorerTreeNode } from '../../components/workspace/ExplorerTree';
import { sortExplorerNodes } from '../../lib/explorerTreeUpdates';
import { isLegacyDatasetFileName } from './legacyDatasetFileService';
import { DATASET_MANIFEST_FILE, PROJECT_EXPORTS_DIRECTORY, isInternalProjectEntry } from './projectLayoutService';
import { getCaptionFileName } from '../caption/captionFileService';

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

export type ExplorerPathChange = { from: string; to: string };

class ExplorerMoveCommittedError extends Error {
  constructor(public readonly change: ExplorerPathChange, cause: unknown) {
    super(`File moved to "${change.to}", but its metadata could not be updated. ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ExplorerMoveCommittedError';
  }
}

export class ExplorerRecoveryError extends Error {
  constructor(public readonly recoveryPaths: string[], message: string) {
    super(message);
    this.name = 'ExplorerRecoveryError';
  }
}

/** Successful entries remain valid when a later entry in the batch fails. */
export class ExplorerBatchError extends Error {
  readonly recoveryPaths: string[];
  constructor(
    operation: string,
    public readonly completed: ExplorerPathChange[],
    public readonly failedPath: string,
    public readonly cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${operation} stopped at "${failedPath}". ${completed.length} item(s) completed. ${detail}`);
    this.name = 'ExplorerBatchError';
    this.recoveryPaths = cause instanceof ExplorerRecoveryError ? cause.recoveryPaths : [];
  }
}

const runExplorerBatch = async (
  operation: string,
  sources: ExplorerClipboardEntry[],
  action: (source: ExplorerClipboardEntry) => Promise<string>,
  onCompleted?: (change: ExplorerPathChange) => void | Promise<void>
): Promise<ExplorerPathChange[]> => {
  const completed: ExplorerPathChange[] = [];
  for (const source of sources) {
    try {
      const change = { from: source.path, to: await action(source) };
      completed.push(change);
      await onCompleted?.(change);
    } catch (error) {
      if (error instanceof ExplorerMoveCommittedError) {
        completed.push(error.change);
        try {
          await onCompleted?.(error.change);
        } catch (updateError) {
          throw new ExplorerBatchError(operation, completed, source.path,
            new Error(`${error.message} References could not be updated: ${updateError instanceof Error ? updateError.message : String(updateError)}`));
        }
      }
      throw new ExplorerBatchError(operation, completed, source.path, error);
    }
  }
  return completed;
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
    const wrapped = new Error(getExplorerOperationErrorMessage(error, path) ?? (error instanceof Error ? error.message : 'Unable to open project directory.'));
    if (error instanceof Error) wrapped.name = error.name;
    throw wrapped;
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
    const wrapped = new Error(getExplorerOperationErrorMessage(error, path) ?? (error instanceof Error ? error.message : 'Unable to open project path.'));
    if (error instanceof Error) wrapped.name = error.name;
    throw wrapped;
  }

  return { directory, name };
};

export const readExplorerFile = async (
  root: ProjectDirectoryHandle,
  path: string,
  options: { snapshot?: boolean } = {}
): Promise<File> => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  if (isProjectManifestName(name) || isAssetManifestName(name)) {
    throw new Error('Project metadata files cannot be opened from Explorer.');
  }
  try {
    const file = await directory.getFileHandle(name).then((handle) => handle.getFile());
    return options.snapshot === false ? file : await snapshotFile(file);
  } catch (error) {
    throw new Error(getExplorerOperationErrorMessage(error, path) ?? (error instanceof Error ? error.message : 'Unable to read file.'));
  }
};

const entryExists = async (directory: ProjectDirectoryHandle, name: string): Promise<boolean> => {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TypeMismatchError') return true;
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
    (!getCaptionFileName(name) || !(await entryExists(directory, getCaptionFileName(name)!)));

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

const writeFile = async (directory: ProjectDirectoryHandle, name: string, file: Blob | string) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(file);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* Keep the original write failure. */ }
    throw error;
  }
};

const hasOtherCaptionOwner = async (directory: ProjectDirectoryHandle, sourceName: string): Promise<boolean> => {
  const caption = getCaptionFileName(sourceName);
  if (!caption) return false;
  const stem = splitExtension(sourceName).stem.toLowerCase();
  for await (const [name, entry] of directory.entries()) {
    if ('entries' in entry || name === sourceName) continue;
    const kind = resolveProjectAssetKind(name);
    if ((kind === 'image' || kind === 'psd') && splitExtension(name).stem.toLowerCase() === stem) return true;
  }
  return false;
};

const copyAssetCaption = async (
  sourceDirectory: ProjectDirectoryHandle,
  destinationDirectory: ProjectDirectoryHandle,
  sourceName: string,
  targetName: string
) => {
  const sourceCaption = getCaptionFileName(sourceName);
  const targetCaption = getCaptionFileName(targetName);
  if (!sourceCaption || !targetCaption) return;
  const caption = await readOptionalTextFile(sourceDirectory, sourceCaption);
  if (caption !== null) await writeFile(destinationDirectory, targetCaption, caption);
};

const removeMovedAssetCaption = async (sourceDirectory: ProjectDirectoryHandle, sourceName: string) => {
  const sourceCaption = getCaptionFileName(sourceName);
  if (sourceCaption && !await hasOtherCaptionOwner(sourceDirectory, sourceName)) await removeOptionalFile(sourceDirectory, sourceCaption);
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

/** Only remove the new destination; the source has not been touched by copying. */
const discardFailedCopy = async (
  destination: ProjectDirectoryHandle,
  destinationPath: string,
  name: string,
  kind: ExplorerEntryKind,
  cause: unknown
): Promise<never> => {
  const names = [name];
  const cleanup = await Promise.allSettled(names.map(async entry => {
    try { await destination.removeEntry(entry, {recursive: kind === 'folder'}); }
    catch (error) { if (!isNotFoundError(error)) throw error; }
  }));
  const remaining = names.filter((_, index) => cleanup[index].status === 'rejected');
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (remaining.length) {
    throw new Error(`${detail} The original is unchanged. Could not remove the incomplete copy: ${remaining.map(entry => `${destinationPath}/${entry}`).join(', ')}.`);
  }
  throw cause;
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
    try {
      await copyDirectoryContents(sourceDirectory, targetDirectory);
    } catch (error) {
      return discardFailedCopy(destination, destinationPath, targetName, source.kind, error);
    }
    return `${destinationPath}/${targetName}`;
  }

  const file = await readExplorerFile(root, source.path);
  const { directory: sourceDirectory, name: sourceName } = await getExplorerParentDirectory(root, source.path);
  const targetPath = `${destinationPath}/${targetName}`;
  try {
    await writeFile(destination, targetName, file);
    await copyAssetCaption(sourceDirectory, destination, sourceName, targetName);
  } catch (error) {
    return discardFailedCopy(destination, destinationPath, targetName, source.kind, error);
  }
  return targetPath;
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
  return runExplorerBatch('Copy', sources, source => copyExplorerEntry(root, source, destinationPath));
};

export const deleteExplorerEntry = async (
  root: ProjectDirectoryHandle,
  path: string,
  recursive = true,
  onDeleted?: () => void | Promise<void>
) => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  if (isProjectManifestName(name) || isAssetManifestName(name)) {
    throw new Error('Project metadata files cannot be deleted from Explorer.');
  }
  await directory.removeEntry(name, { recursive });
  await onDeleted?.();
};

const relocateExplorerEntry = async (
  root: ProjectDirectoryHandle,
  source: ExplorerClipboardEntry,
  destinationPath: string,
  targetName: string
): Promise<string> => {
  const destination = await getDirectoryAtExplorerPath(root, destinationPath);
  const { directory, name } = await getExplorerParentDirectory(root, source.path);
  const handle =
    source.kind === 'folder'
      ? await directory.getDirectoryHandle(name)
      : await directory.getFileHandle(name);
  const movable = handle as unknown as MovableFileSystemHandle;

  let moved = false;
  const change = { from: source.path, to: `${destinationPath}/${targetName}` };
  try {
    if (typeof movable.move === 'function') {
      await movable.move(destination, targetName);
      moved = true;
      if (source.kind === 'file') {
        await copyAssetCaption(directory, destination, name, targetName);
        await removeMovedAssetCaption(directory, name);
      }
    } else {
      await copyExplorerEntry(root, source, destinationPath, targetName);
      try {
        await directory.removeEntry(name, { recursive: source.kind === 'folder' });
      } catch (error) {
        const sourcePresent = await entryExists(directory, name).catch(() => null);
        if (sourcePresent === false) {
          // Some providers can report failure after committing the removal.
          moved = true;
          throw error;
        }
        if (source.kind === 'file' && sourcePresent === true) {
          // A file removal is indivisible: the surviving original permits
          // rollback of the newly copied destination and its sidecar.
          return discardFailedCopy(destination, destinationPath, targetName, source.kind, error);
        }
        // Recursive removal can fail after deleting children. Never discard
        // the complete destination copy in that case.
        throw new ExplorerRecoveryError([source.path, change.to], `Move incomplete. A complete copy is kept at "${change.to}". ` +
          `Check and recover "${source.path}" from that copy before retrying. ` +
          `${error instanceof Error ? error.message : String(error)}`);
      }
      moved = true;
      if (source.kind === 'file') {
        await removeMovedAssetCaption(directory, name);
      }
    }
  } catch (error) {
    if (moved) throw new ExplorerMoveCommittedError(change, error);
    throw error;
  }

  return change.to;
};

export const renameExplorerEntry = async (
  root: ProjectDirectoryHandle,
  path: string,
  entryKind: ExplorerEntryKind,
  nextName: string,
  onRenamed?: (change: ExplorerPathChange) => void | Promise<void>
): Promise<string> => {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  if (isProjectManifestName(name) || isAssetManifestName(name)) {
    throw new Error('Project metadata files cannot be renamed from Explorer.');
  }
  const trimmedName = nextName.trim();
  if (trimmedName === name) return path;
  await assertAvailableName(directory, trimmedName);
  const results = await runExplorerBatch('Rename', [{path,name,kind:entryKind}],
    source => relocateExplorerEntry(root, source, getParentPath(path), trimmedName), onRenamed);
  return results[0].to;
};

const moveExplorerEntry = async (
  root: ProjectDirectoryHandle,
  source: ExplorerClipboardEntry,
  destinationPath: string
): Promise<string> => {
  if (source.kind === 'folder' && (destinationPath === source.path || destinationPath.startsWith(`${source.path}/`))) {
    throw new Error('Cannot move a folder into itself.');
  }
  if (getParentPath(source.path) === destinationPath) return source.path;
  const destination = await getDirectoryAtExplorerPath(root, destinationPath);
  const targetName = await getUniqueExplorerName(destination, source.name);
  return relocateExplorerEntry(root, source, destinationPath, targetName);
};

export const moveExplorerEntries = async (
  root: ProjectDirectoryHandle,
  sources: ExplorerClipboardEntry[],
  destinationPath: string,
  onMoved?: (move: ExplorerPathChange) => void | Promise<void>
): Promise<Array<{ from: string; to: string }>> => {
  assertCanPlaceExplorerEntries(sources, destinationPath, 'move');
  return runExplorerBatch('Move', sources, source => moveExplorerEntry(root, source, destinationPath), onMoved);
};

export const duplicateExplorerEntries = async (
  root: ProjectDirectoryHandle,
  sources: ExplorerClipboardEntry[]
): Promise<Array<{ from: string; to: string }>> => {
  return runExplorerBatch('Duplicate', sources, source => copyExplorerEntry(root, source, getParentPath(source.path)));
};

export const readExplorerDirectory = async (
  directory: ProjectDirectoryHandle,
  name = 'Project',
  path = 'Project'
): Promise<ExplorerTreeNode> => {
  const children: ExplorerTreeNode[] = [];

  for await (const [entryName, entry] of directory.entries()) {
    if (isHiddenExplorerManifestName(entryName)) {
      continue;
    }
    if (
      isInternalProjectEntry(entryName) ||
      isLegacyDatasetFileName(entryName) ||
      (path === 'Project' && entryName === DATASET_MANIFEST_FILE)
    ) {
      continue;
    }
    const childPath = `${path}/${entryName}`;
    if ('entries' in entry) {
      children.push(await readExplorerDirectory(entry, entryName, childPath));
    } else if (isSupportedProjectAsset(entryName) || path === `Project/${PROJECT_EXPORTS_DIRECTORY}`) {
      // Export archives are not project assets, but the user must see them in the exports folder.
      children.push({ name: entryName, path: childPath, kind: 'file' });
    }
  }

  return {
    name,
    path,
    kind: 'folder',
    children: sortExplorerNodes(children),
  };
};
