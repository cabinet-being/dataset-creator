import { resolveProjectType, type ProjectTypeResolver } from '../../lib/projectProfiles';
import { URL_TOOL_ALIASES } from '../../lib/constants';
import {
  createProject,
  type ProjectState,
  type ProjectType,
  type SourceImage,
  type ToolName,
  type EditedAsset,
  type TaggingConfig,
  type WorkspaceSettings,
} from '../../types';
import { createThumbnail } from '../image/imageProcessor';
import { getAssetManifestName } from './assetManifestService';
import { snapshotFileIfNeeded } from './fileSnapshotService';
import { migrateLegacyCaptions, type PathCaptionAsset } from '../caption/captionMigrationService';
import { isLegacyProjectRootPath } from './projectPathFilters';
import { isLegacyDatasetFileName } from './legacyDatasetFileService';
import {
  DATASET_MANIFEST_FILE,
  PROJECT_DATASET_DIRECTORY,
  PROJECT_SHARED_DIRECTORY,
  ensureProjectLayout,
  isProjectWorkspacePath,
} from './projectLayoutService';
import { applyProjectRelativePathMoves } from '../../lib/datasetAssets';
import {
  createLegacyDatasetMigration,
  getLegacyDatasetPathMoves,
  migrateLegacyDatasetMembership,
  removeLegacyDatasetDocuments,
  type LegacyDatasetMigrationReport,
} from './legacyDatasetMigrationService';

export const PROJECT_DIRECTORY_MANIFEST = 'manifest.json';
export const PROJECT_DIRECTORY_FORMAT = 'dataset-creator-directory';
export const PROJECT_DIRECTORY_DESCRIPTION = 'Dataset Creator project directory';
export const PROJECT_DIRECTORY_CACHE = '.cache';
const PROJECT_PREVIEW_CACHE_DIRECTORY = `${PROJECT_DIRECTORY_CACHE}/previews`;
const PROJECT_PREVIEW_CACHE_SIZE = 512;
type ProjectPreviewKind = 'source' | 'edited' | 'psd';

export type ProjectDirectoryWritable = {
  write: (data: Blob | string) => Promise<void> | void;
  close: () => Promise<void> | void;
  abort?: () => Promise<void>;
};

export type ProjectDirectoryFileHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<ProjectDirectoryWritable>;
};

export type ProjectDirectoryHandle = {
  name: string;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<ProjectDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<ProjectDirectoryFileHandle>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  entries: () => AsyncIterableIterator<[string, ProjectDirectoryHandle | ProjectDirectoryFileHandle]>;
};

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<ProjectDirectoryHandle>;
  };

type DirectoryProjectManifest = {
  format: typeof PROJECT_DIRECTORY_FORMAT;
  version: 1 | 2;
  project: {
    id: string;
    name: string;
    projectType?: ProjectType;
    currentTool: ToolName;
    taggingConfig: Omit<TaggingConfig, 'autoTaggingEndpoint'>;
    workspaceSettings: WorkspaceSettings;
    sourceImageManifests?: Record<string, string>;
    editedAssetManifests?: Record<string, string>;
    datasetItemManifests?: Record<string, string>;
    dataset?: {
      name: string;
      triggerWord: string;
      assetOrder: string[];
      createdAt: string;
      updatedAt: string;
    };
    datasetMigration?: LegacyDatasetMigrationReport;
    /** @deprecated Read only while converting version-1 projects. */
    datasetFilePath?: string;
    captionMigration?: ProjectState['captionMigration'];
    lastModified: string;
    createdAt: string;
  };
};

type SourceManifest = {
  id: string;
  fileName: string;
  originalFileName?: string;
  width: number;
  height: number;
  mimeType: string;
  originalFilePath?: string;
  originalFileNameOnDisk: string;
  tags?: string[];
  hidden?: boolean;
  excludedFromDataset?: boolean;
  createdAt: string;
};

type EditedAssetDirectoryManifest = {
  id: string;
  sourceImageId: string;
  imageFileName: string;
  imageDataPath?: string;
  psdFileName?: string;
  psdDataPath?: string;
  width: number;
  height: number;
  type: EditedAsset['type'];
  cropFrame?: EditedAsset['cropFrame'];
  augmentationConfig?: EditedAsset['augmentationConfig'];
  cleanupOverlayId?: string;
  tags?: string[];
  aspectRatio: EditedAsset['aspectRatio'];
  deleted: boolean;
  deletedAt?: string;
  excludedFromDataset?: boolean;
  createdAt: string;
  exportOrder?: number;
};

const isNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name?: string }).name === 'NotFoundError';

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown file system error';

const getDirectoryPicker = (): DirectoryPickerWindow['showDirectoryPicker'] =>
  (window as DirectoryPickerWindow).showDirectoryPicker;

const requireDirectoryPicker = () => {
  const picker = getDirectoryPicker();
  if (!picker) {
    throw new Error('Directory projects require a browser with File System Access support.');
  }
  return picker;
};

const getChildDirectory = async (
  parent: ProjectDirectoryHandle,
  name: string,
  create = false
): Promise<ProjectDirectoryHandle> => parent.getDirectoryHandle(name, { create });

const getProjectFile = async (
  directory: ProjectDirectoryHandle,
  name: string,
  create = false
): Promise<ProjectDirectoryFileHandle> => directory.getFileHandle(name, { create });

const getPathParts = (path: string): string[] => path.split('/').filter(Boolean);

const toProjectRelativePath = (path: string): string => path.replace(/^Project\//, '');

const getParentPath = (path: string): string => getPathParts(path).slice(0, -1).join('/');

const getFileName = (path: string): string => {
  const parts = getPathParts(path);
  return parts[parts.length - 1] ?? '';
};

const joinPath = (...parts: string[]): string => parts.flatMap(getPathParts).join('/');

const getDirectoryAtPath = async (
  root: ProjectDirectoryHandle,
  path: string,
  create = false
): Promise<ProjectDirectoryHandle> => {
  let directory = root;
  for (const part of getPathParts(path)) {
    directory = await getChildDirectory(directory, part, create);
  }
  return directory;
};

const getDirectoryForFilePath = async (
  root: ProjectDirectoryHandle,
  path: string,
  create = false
): Promise<ProjectDirectoryHandle> => getDirectoryAtPath(root, getParentPath(path), create);

const getExistingManifestName = async (directory: ProjectDirectoryHandle): Promise<string> => {
  try {
    await getProjectFile(directory, PROJECT_DIRECTORY_MANIFEST);
    return PROJECT_DIRECTORY_MANIFEST;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new Error(`Unable to access the project manifest: ${getErrorMessage(error)}`);
    }
    throw new DOMException(
      'The selected directory does not contain a supported Dataset Creator project.',
      'NotFoundError'
    );
  }
};

const writeTextFile = async (
  directory: ProjectDirectoryHandle,
  name: string,
  value: string
) => {
  const file = await getProjectFile(directory, name, true);
  const writable = await file.createWritable();
  await writable.write(value);
  await writable.close();
};

const writeTextFileAtPath = async (
  root: ProjectDirectoryHandle,
  path: string,
  value: string
) => {
  const directory = await getDirectoryForFilePath(root, path, true);
  await writeTextFile(directory, getFileName(path), value);
};

const writeBlobFile = async (
  directory: ProjectDirectoryHandle,
  name: string,
  value: Blob
) => {
  const file = await getProjectFile(directory, name, true);
  const writable = await file.createWritable();
  await writable.write(value);
  await writable.close();
};

const writeBlobFileAtPath = async (
  root: ProjectDirectoryHandle,
  path: string,
  value: Blob
) => {
  const directory = await getDirectoryForFilePath(root, path, true);
  await writeBlobFile(directory, getFileName(path), value);
};

const readTextFile = async (directory: ProjectDirectoryHandle, name: string): Promise<string> =>
  (await (await getProjectFile(directory, name)).getFile()).text();

const readBlobFile = async (directory: ProjectDirectoryHandle, name: string): Promise<Blob> =>
  snapshotFileIfNeeded(await (await getProjectFile(directory, name)).getFile());

const readBlobFileAtPath = async (root: ProjectDirectoryHandle, path: string): Promise<Blob> =>
  readBlobFile(await getDirectoryForFilePath(root, path), getFileName(path));

const readJsonFile = async <T>(
  directory: ProjectDirectoryHandle,
  name: string,
  description: string
): Promise<T> => {
  let text: string;
  try {
    text = await readTextFile(directory, name);
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${getErrorMessage(error)}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Unable to read ${description}: invalid JSON.`);
  }
};

const toIsoString = (value: Date | string | undefined): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
};

const toDate = (value: string | undefined, fallback: Date): Date => {
  const parsed = value ? new Date(value) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const getFileExtension = (fileName: string, mimeType: string): string => {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension && extension !== fileName.toLowerCase()) {
    return extension.replace(/[^a-z0-9]/g, '') || 'bin';
  }

  return mimeType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
};

const getToolFromSlug = (value: string | undefined): ToolName =>
  ((value ? URL_TOOL_ALIASES[value] : undefined) ?? 'import') as ToolName;

const serializeSourceManifest = (
  source: SourceImage,
  originalFileNameOnDisk: string,
  originalFilePath: string
): SourceManifest => ({
  id: source.id,
  fileName: source.fileName,
  originalFileName: source.originalFileName,
  width: source.width,
  height: source.height,
  mimeType: source.mimeType,
  originalFilePath,
  originalFileNameOnDisk,
  tags: source.tags,
  hidden: source.hidden,
  excludedFromDataset: source.excludedFromDataset,
  createdAt: toIsoString(source.createdAt),
});

const serializeEditedAssetManifest = (
  item: EditedAsset,
  imageFileName: string,
  imageDataPath: string,
  psdFileName?: string,
  psdDataPath?: string
): EditedAssetDirectoryManifest => ({
  id: item.id,
  sourceImageId: item.sourceImageId,
  imageFileName,
  imageDataPath,
  psdFileName,
  psdDataPath,
  width: item.width,
  height: item.height,
  type: item.type,
  cropFrame: item.cropFrame,
  augmentationConfig: item.augmentationConfig,
  cleanupOverlayId: item.cleanupOverlayId,
  tags: item.tags,
  aspectRatio: item.aspectRatio,
  deleted: item.deleted,
  deletedAt: item.deletedAt ? toIsoString(item.deletedAt) : undefined,
  excludedFromDataset: item.excludedFromDataset,
  createdAt: toIsoString(item.createdAt),
  exportOrder: item.exportOrder,
});

const getProjectManifest = (
  project: ProjectState,
  paths: {
    sourceImageManifests?: Record<string, string>;
    editedAssetManifests?: Record<string, string>;
  } = {}
): DirectoryProjectManifest => ({
  format: PROJECT_DIRECTORY_FORMAT,
  version: 2,
  project: {
    id: project.id,
    name: project.name,
    projectType: project.projectType,
    currentTool: project.currentTool,
    taggingConfig: {
      datasetKeyword: project.taggingConfig.datasetKeyword,
      threshold: project.taggingConfig.threshold,
      maxTags: project.taggingConfig.maxTags,
      insertMode: project.taggingConfig.insertMode,
      blacklist: project.taggingConfig.blacklist,
    },
    workspaceSettings: project.workspaceSettings,
    sourceImageManifests: paths.sourceImageManifests,
    editedAssetManifests: paths.editedAssetManifests,
    dataset: {
      name: project.dataset.name,
      triggerWord: project.dataset.triggerWord,
      assetOrder: project.dataset.assetOrder,
      createdAt: toIsoString(project.dataset.createdAt),
      updatedAt: toIsoString(project.dataset.updatedAt),
    },
    datasetMigration: project.datasetMigration,
    captionMigration: project.captionMigration,
    lastModified: toIsoString(project.lastModified),
    createdAt: toIsoString(project.createdAt),
  },
});

const getDefaultSourceManifestPath = (source: SourceImage): string => {
  const fileName = `${source.id}.${getFileExtension(source.fileName, source.mimeType)}`;
  return joinPath(PROJECT_SHARED_DIRECTORY, getAssetManifestName(fileName));
};

const getDefaultEditedAssetManifestPath = (item: EditedAsset): string =>
  joinPath(PROJECT_DATASET_DIRECTORY, getAssetManifestName(`${item.id}.png`));

const getPreviewCachePath = (kind: ProjectPreviewKind, id: string): string => {
  const cacheKind = kind === 'psd' ? 'psd-v2' : kind;
  return joinPath(PROJECT_PREVIEW_CACHE_DIRECTORY, cacheKind, `${encodeURIComponent(id)}.jpg`);
};

const createProjectPreview = async (blob: Blob): Promise<Blob> =>
  createThumbnail(blob, PROJECT_PREVIEW_CACHE_SIZE);

const canLoadImageBlob = (blob: Blob): Promise<boolean> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const cleanup = (result: boolean) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };

    image.onload = () => cleanup(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => cleanup(false);
    image.src = url;
  });

export const readProjectPreviewUrl = async (
  root: ProjectDirectoryHandle | undefined,
  kind: ProjectPreviewKind,
  id: string
): Promise<string | undefined> => {
  if (!root) {
    return undefined;
  }

  try {
    const preview = await readBlobFileAtPath(root, getPreviewCachePath(kind, id));
    if (!(await canLoadImageBlob(preview))) {
      return undefined;
    }
    return URL.createObjectURL(preview);
  } catch {
    return undefined;
  }
};

export const getOrCreateProjectPreviewUrl = async (
  root: ProjectDirectoryHandle | undefined,
  kind: ProjectPreviewKind,
  id: string,
  blob: Blob
): Promise<string | undefined> => {
  const cachedUrl = await readProjectPreviewUrl(root, kind, id);
  if (cachedUrl) {
    return cachedUrl;
  }

  if (!root) {
    return undefined;
  }

  try {
    const preview = await createProjectPreview(blob);
    await writeBlobFileAtPath(root, getPreviewCachePath(kind, id), preview);
    return URL.createObjectURL(preview);
  } catch {
    return undefined;
  }
};

export const writeProjectPreview = async (
  root: ProjectDirectoryHandle,
  kind: ProjectPreviewKind,
  id: string,
  blob: Blob
): Promise<void> => {
  try {
    await writeBlobFileAtPath(root, getPreviewCachePath(kind, id), await createProjectPreview(blob));
  } catch {
    // Preview cache failures should not block saving the project data itself.
  }
};

const removeProjectPreview = async (
  root: ProjectDirectoryHandle,
  kind: ProjectPreviewKind,
  id: string
): Promise<void> => {
  try {
    await removeProjectFileAtPath(root, getPreviewCachePath(kind, id));
  } catch {
    // Cache entries are disposable and may already be absent.
  }
};

const getNormalizedAssetManifestPath = (
  currentPath: string | undefined,
  assetFileName: string,
  fallbackPath: string
): string => {
  const reusablePath = getReusableProjectPath(currentPath);
  if (!reusablePath) {
    return fallbackPath;
  }
  return getFileName(reusablePath) === PROJECT_DIRECTORY_MANIFEST
    ? joinPath(getParentPath(reusablePath), getAssetManifestName(assetFileName))
    : reusablePath;
};

const getReusableProjectPath = (path: string | undefined): string | undefined => {
  if (!path) {
    return undefined;
  }

  const relativePath = toProjectRelativePath(path);
  return isLegacyProjectRootPath(relativePath) ? undefined : relativePath;
};

const writeSource = async (root: ProjectDirectoryHandle, source: SourceImage): Promise<string> => {
  const defaultOriginalFileName = `original.${getFileExtension(source.fileName, source.mimeType)}`;
  const manifestPath = getNormalizedAssetManifestPath(
    source.manifestPath,
    defaultOriginalFileName,
    getDefaultSourceManifestPath(source)
  );
  const originalFilePath = source.originalFilePath
    ? toProjectRelativePath(source.originalFilePath)
    : joinPath(getParentPath(manifestPath), `${source.id}.${getFileExtension(source.fileName, source.mimeType)}`);
  const originalFileNameOnDisk = getFileName(originalFilePath);
  await writeBlobFileAtPath(root, originalFilePath, source.originalFile);
  await writeProjectPreview(root, 'source', source.id, source.originalFile);
  await writeTextFileAtPath(
    root,
    manifestPath,
    JSON.stringify(serializeSourceManifest(source, originalFileNameOnDisk, originalFilePath), null, 2)
  );
  if (source.manifestPath && toProjectRelativePath(source.manifestPath) !== manifestPath) {
    await removeProjectFileAtPath(root, source.manifestPath);
  }
  return manifestPath;
};

const writeSourceChanges = async (
  root: ProjectDirectoryHandle,
  source: SourceImage,
  previousSource?: SourceImage
): Promise<string> => {
  const defaultOriginalFileName = `original.${getFileExtension(source.fileName, source.mimeType)}`;
  const manifestPath = getNormalizedAssetManifestPath(
    source.manifestPath ?? previousSource?.manifestPath,
    defaultOriginalFileName,
    getDefaultSourceManifestPath(source)
  );
  const originalFilePath =
    source.originalFilePath
      ? toProjectRelativePath(source.originalFilePath)
      : previousSource?.originalFilePath
        ? toProjectRelativePath(previousSource.originalFilePath)
        : joinPath(getParentPath(manifestPath), `${source.id}.${getFileExtension(source.fileName, source.mimeType)}`);
  const originalFileNameOnDisk = getFileName(originalFilePath);
  if (!previousSource || source.originalFile !== previousSource.originalFile) {
    await writeBlobFileAtPath(root, originalFilePath, source.originalFile);
    await writeProjectPreview(root, 'source', source.id, source.originalFile);
  }
  await writeTextFileAtPath(
    root,
    manifestPath,
    JSON.stringify(serializeSourceManifest(source, originalFileNameOnDisk, originalFilePath), null, 2)
  );
  const previousManifestPath = source.manifestPath ?? previousSource?.manifestPath;
  if (previousManifestPath && toProjectRelativePath(previousManifestPath) !== manifestPath) {
    await removeProjectFileAtPath(root, previousManifestPath);
  }
  return manifestPath;
};

const writeEditedAsset = async (root: ProjectDirectoryHandle, item: EditedAsset): Promise<string> => {
  const defaultImageFileName = 'image.png';
  const manifestPath = getNormalizedAssetManifestPath(item.manifestPath, defaultImageFileName, getDefaultEditedAssetManifestPath(item));
  const imageDataPath = getReusableProjectPath(item.imageDataPath) ?? joinPath(getParentPath(manifestPath), `${item.id}.png`);
  const imageFileName = getFileName(imageDataPath);
  const psdDataPath = item.psdData
    ? getReusableProjectPath(item.psdDataPath) ?? joinPath(getParentPath(manifestPath), 'image.psd')
    : undefined;
  const psdFileName = psdDataPath ? getFileName(psdDataPath) : undefined;
  await writeBlobFileAtPath(root, imageDataPath, item.imageData);
  await writeProjectPreview(root, 'edited', item.id, item.imageData);
  if (item.psdData && psdFileName) {
    await writeBlobFileAtPath(root, psdDataPath ?? joinPath(getParentPath(manifestPath), psdFileName), item.psdData);
  }
  await writeTextFileAtPath(
    root,
    manifestPath,
    JSON.stringify(serializeEditedAssetManifest(item, imageFileName, imageDataPath, psdFileName, psdDataPath), null, 2)
  );
  if (item.manifestPath && toProjectRelativePath(item.manifestPath) !== manifestPath) {
    await removeProjectFileAtPath(root, item.manifestPath);
  }
  return manifestPath;
};

const writeEditedAssetChanges = async (
  root: ProjectDirectoryHandle,
  item: EditedAsset,
  previousItem?: EditedAsset
): Promise<string> => {
  const defaultImageFileName = 'image.png';
  const manifestPath = getNormalizedAssetManifestPath(
    item.manifestPath ?? previousItem?.manifestPath,
    defaultImageFileName,
    getDefaultEditedAssetManifestPath(item)
  );
  const imageDataPath =
    getReusableProjectPath(item.imageDataPath) ??
    getReusableProjectPath(previousItem?.imageDataPath) ??
    joinPath(getParentPath(manifestPath), `${item.id}.png`);
  const imageFileName = getFileName(imageDataPath);
  const psdDataPath = item.psdData
    ? getReusableProjectPath(item.psdDataPath) ??
      getReusableProjectPath(previousItem?.psdDataPath) ??
      joinPath(getParentPath(manifestPath), 'image.psd')
    : undefined;
  const psdFileName = psdDataPath ? getFileName(psdDataPath) : undefined;
  if (!previousItem || item.imageData !== previousItem.imageData) {
    await writeBlobFileAtPath(root, imageDataPath, item.imageData);
    await writeProjectPreview(root, 'edited', item.id, item.imageData);
  }
  if (item.psdData && (!previousItem || item.psdData !== previousItem.psdData)) {
    await writeBlobFileAtPath(root, psdDataPath ?? joinPath(getParentPath(manifestPath), 'image.psd'), item.psdData);
  } else if (!item.psdData && previousItem?.psdData) {
    try {
      const previousPsdPath = previousItem.psdDataPath ?? joinPath(getParentPath(manifestPath), 'image.psd');
      await (await getDirectoryForFilePath(root, previousPsdPath)).removeEntry(getFileName(previousPsdPath));
    } catch {
      // The PSD may already be absent.
    }
  }
  await writeTextFileAtPath(
    root,
    manifestPath,
    JSON.stringify(serializeEditedAssetManifest(item, imageFileName, imageDataPath, psdFileName, psdDataPath), null, 2)
  );
  const previousManifestPath = item.manifestPath ?? previousItem?.manifestPath;
  if (previousManifestPath && toProjectRelativePath(previousManifestPath) !== manifestPath) {
    await removeProjectFileAtPath(root, previousManifestPath);
  }
  return manifestPath;
};

const removeProjectEntryAtPath = async (
  root: ProjectDirectoryHandle,
  manifestPath: string,
  assetPaths: Array<string | undefined> = []
) => {
  const relativeManifestPath = toProjectRelativePath(manifestPath);
  if (!relativeManifestPath.startsWith('.dataset-creator-data/')) {
    await removeProjectFileAtPath(root, relativeManifestPath);
    await Promise.all(assetPaths.filter((path): path is string => Boolean(path)).map((path) => removeProjectFileAtPath(root, path)));
    return;
  }
  const entryPath = getParentPath(relativeManifestPath) || relativeManifestPath;
  const parentPath = getParentPath(entryPath);
  const name = getFileName(entryPath);
  try {
    await (await getDirectoryAtPath(root, parentPath)).removeEntry(name, { recursive: true });
  } catch {
    // The entry may already be absent after a partial save.
  }
};

const removeProjectFileAtPath = async (root: ProjectDirectoryHandle, path: string) => {
  try {
    await (await getDirectoryForFilePath(root, toProjectRelativePath(path))).removeEntry(getFileName(path));
  } catch {
    // The file may already be absent after a partial save or migration.
  }
};

export const pickProjectDirectory = async (): Promise<ProjectDirectoryHandle> => {
  const picker = requireDirectoryPicker();
  return picker.call(window, { mode: 'readwrite' });
};

export const createProjectDirectory = async (
  directory: ProjectDirectoryHandle,
  project: ProjectState
) => {
  await ensureProjectLayout(directory, project);
  const sourceImageManifests: Record<string, string> = {};
  const editedAssetManifests: Record<string, string> = {};

  await Promise.all([
    ...Object.values(project.sourceImages).map(async (source) => {
      sourceImageManifests[source.id] = await writeSource(directory, source);
    }),
    ...Object.values(project.datasetItems).map(async (item) => {
      editedAssetManifests[item.id] = await writeEditedAsset(directory, item);
    }),
  ]);
  await writeTextFile(
    directory,
    PROJECT_DIRECTORY_MANIFEST,
    JSON.stringify(getProjectManifest(project, { sourceImageManifests, editedAssetManifests }), null, 2)
  );
};

export const projectDirectoryHasManifest = async (directory: ProjectDirectoryHandle): Promise<boolean> => {
  try {
    await getExistingManifestName(directory);
    return true;
  } catch {
    return false;
  }
};

export const clearProjectDirectory = async (directory: ProjectDirectoryHandle) => {
  await Promise.all(
    [
      '.dataset-creator-data',
      PROJECT_DIRECTORY_CACHE,
      'sources',
      'edited',
      PROJECT_DIRECTORY_MANIFEST,
      DATASET_MANIFEST_FILE,
      PROJECT_DATASET_DIRECTORY,
      'src',
      '.git',
    ].map(async (entry) => {
      try {
        await directory.removeEntry(entry, { recursive: true });
      } catch {
        // A new directory may not contain all project entries yet.
      }
    })
  );
};

export const writeProjectDirectoryChanges = async (
  project: ProjectState,
  previousProject: ProjectState | undefined,
  directory: ProjectDirectoryHandle
) => {
  await ensureProjectLayout(directory, project);
  const previousSources = previousProject?.sourceImages ?? {};
  const previousEditedAssets = previousProject?.datasetItems ?? {};
  const sourceImageManifests: Record<string, string> = {};
  const editedAssetManifests: Record<string, string> = {};

  const assetWrites = await Promise.allSettled([
    ...Object.entries(project.sourceImages)
      .filter(([id, source]) => source !== previousSources[id])
      .map(async ([id, source]) => {
        sourceImageManifests[id] = await writeSourceChanges(directory, source, previousSources[id]);
      }),
    ...Object.keys(previousSources)
      .filter((id) => !project.sourceImages[id])
      .map(async (id) => {
        await removeProjectPreview(directory, 'source', id);
        if (previousSources[id]?.manifestPath) {
          await removeProjectEntryAtPath(directory, previousSources[id].manifestPath, [previousSources[id].originalFilePath]);
        }
      }),
    ...Object.entries(project.datasetItems)
      .filter(([id, item]) => item !== previousEditedAssets[id])
      .map(async ([id, item]) => {
        editedAssetManifests[id] = await writeEditedAssetChanges(directory, item, previousEditedAssets[id]);
      }),
    ...Object.keys(previousEditedAssets)
      .filter((id) => !project.datasetItems[id])
      .map(async (id) => {
        await removeProjectPreview(directory, 'edited', id);
        if (previousEditedAssets[id]?.manifestPath) {
          await removeProjectEntryAtPath(directory, previousEditedAssets[id].manifestPath, [
            previousEditedAssets[id].imageDataPath,
            previousEditedAssets[id].psdDataPath,
          ]);
        }
      }),
  ]);

  // Keep the save lane occupied until every started writer finishes, even if
  // another failed. A retry must not race an unfinished previous snapshot.
  const failedWrite = assetWrites.find((result) => result.status === 'rejected');
  if (failedWrite?.status === 'rejected') throw failedWrite.reason;

  for (const source of Object.values(project.sourceImages)) {
    sourceImageManifests[source.id] = source.manifestPath
      ? toProjectRelativePath(source.manifestPath)
      : sourceImageManifests[source.id] ?? getDefaultSourceManifestPath(source);
  }
  for (const item of Object.values(project.datasetItems)) {
    const reusableManifestPath = getReusableProjectPath(item.manifestPath);
    editedAssetManifests[item.id] = reusableManifestPath
      ? reusableManifestPath
      : editedAssetManifests[item.id] ?? getDefaultEditedAssetManifestPath(item);
  }
  await writeTextFile(
    directory,
    PROJECT_DIRECTORY_MANIFEST,
    JSON.stringify(getProjectManifest(project, { sourceImageManifests, editedAssetManifests }), null, 2)
  );
};

const readSource = async (
  directory: ProjectDirectoryHandle,
  root?: ProjectDirectoryHandle,
  paths?: { manifestPath?: string; originalFilePath?: string }
): Promise<SourceImage> => {
  const manifest = await readJsonFile<SourceManifest>(
    directory,
    paths?.manifestPath ? getFileName(paths.manifestPath) : PROJECT_DIRECTORY_MANIFEST,
    `source manifest in "${directory.name}"`
  );
  if (!manifest.id || !manifest.fileName || !manifest.originalFileNameOnDisk) {
    if ('originalFilePath' in manifest) {
      throw new Error(
        `Source manifest in "${directory.name}" uses an incompatible project format. ` +
          'It must be recreated using the current Dataset Creator project format.'
      );
    }
    throw new Error(`Source manifest in "${directory.name}" is missing required fields.`);
  }

  let originalFile: Blob;
  const originalFilePath = paths?.originalFilePath ?? manifest.originalFilePath;
  try {
    originalFile = originalFilePath && root
      ? await readBlobFileAtPath(root, originalFilePath)
      : await readBlobFile(directory, manifest.originalFileNameOnDisk);
  } catch (error) {
    throw new Error(
      `Unable to read source image "${manifest.originalFileName}": ${getErrorMessage(error)}`
    );
  }

  return {
    id: manifest.id,
    fileName: manifest.fileName,
    originalFileName: manifest.originalFileName,
    originalFile,
    width: manifest.width,
    height: manifest.height,
    mimeType: manifest.mimeType,
    previewUrl: await getOrCreateProjectPreviewUrl(root, 'source', manifest.id, originalFile),
    originalFilePath,
    manifestPath: paths?.manifestPath,
    tags: manifest.tags,
    hidden: manifest.hidden,
    excludedFromDataset: manifest.excludedFromDataset,
    createdAt: toDate(manifest.createdAt, new Date()),
  };
};

const readEditedAsset = async (
  directory: ProjectDirectoryHandle,
  root?: ProjectDirectoryHandle,
  paths?: { manifestPath?: string; imageDataPath?: string; psdDataPath?: string }
): Promise<EditedAsset> => {
  const manifest = await readJsonFile<EditedAssetDirectoryManifest>(
    directory,
    paths?.manifestPath ? getFileName(paths.manifestPath) : PROJECT_DIRECTORY_MANIFEST,
    `edited asset manifest in "${directory.name}"`
  );
  if (!manifest.id || !manifest.sourceImageId || !manifest.imageFileName) {
    throw new Error(`Edited asset manifest in "${directory.name}" is missing required fields.`);
  }

  let imageData: Blob;
  const imageDataPath = paths?.imageDataPath ?? manifest.imageDataPath;
  try {
    imageData = imageDataPath && root
      ? await readBlobFileAtPath(root, imageDataPath)
      : await readBlobFile(directory, manifest.imageFileName);
  } catch (error) {
    throw new Error(
      `Unable to read edited asset image "${manifest.imageFileName}": ${getErrorMessage(error)}`
    );
  }

  let psdData: Blob | undefined;
  const psdDataPath = paths?.psdDataPath ?? manifest.psdDataPath;
  if (manifest.psdFileName || psdDataPath) {
    try {
      psdData = psdDataPath && root
        ? await readBlobFileAtPath(root, psdDataPath)
        : await readBlobFile(directory, manifest.psdFileName ?? 'image.psd');
    } catch (error) {
      throw new Error(
        `Unable to read edited asset PSD "${manifest.psdFileName}": ${getErrorMessage(error)}`
      );
    }
  }

  return {
    id: manifest.id,
    sourceImageId: manifest.sourceImageId,
    imageData,
    psdData,
    previewUrl: await getOrCreateProjectPreviewUrl(root, 'edited', manifest.id, imageData),
    imageDataPath,
    psdDataPath,
    manifestPath: paths?.manifestPath,
    width: manifest.width,
    height: manifest.height,
    type: manifest.type,
    cropFrame: manifest.cropFrame,
    augmentationConfig: manifest.augmentationConfig,
    cleanupOverlayId: manifest.cleanupOverlayId,
    tags: manifest.tags,
    aspectRatio: manifest.aspectRatio,
    deleted: manifest.deleted,
    deletedAt: manifest.deletedAt ? toDate(manifest.deletedAt, new Date()) : undefined,
    excludedFromDataset: manifest.excludedFromDataset,
    createdAt: toDate(manifest.createdAt, new Date()),
    exportOrder: manifest.exportOrder,
  };
};

const readProjectChildren = async <T>(
  directory: ProjectDirectoryHandle,
  reader: (entry: ProjectDirectoryHandle) => Promise<T>
): Promise<T[]> => {
  const entries: T[] = [];
  for await (const [entryName, entry] of directory.entries()) {
    if ('getDirectoryHandle' in entry) {
      try {
        entries.push(await reader(entry));
      } catch (error) {
        throw new Error(`Unable to read project entry "${entryName}": ${getErrorMessage(error)}`);
      }
    }
  }
  return entries;
};

const readOptionalProjectChildren = async <T>(
  directory: ProjectDirectoryHandle,
  name: string,
  reader: (entry: ProjectDirectoryHandle) => Promise<T>
): Promise<T[]> => {
  try {
    const childDirectory = await getChildDirectory(directory, name);
    return readProjectChildren(childDirectory, reader);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw new Error(`Unable to open project directory "${name}": ${getErrorMessage(error)}`);
  }
};

const readCaptionPathAssets = async (root: ProjectDirectoryHandle, paths: string[]): Promise<{ assets: PathCaptionAsset[]; manifests: Map<string, Record<string, unknown>> }> => {
  const assets: PathCaptionAsset[] = [];
  const manifests = new Map<string, Record<string, unknown>>();
  for (const path of [...new Set(paths)]) {
    const relative = toProjectRelativePath(path);
    try {
      const directory = await getDirectoryForFilePath(root, relative);
      await directory.getFileHandle(getFileName(relative));
      const manifestName = getAssetManifestName(getFileName(relative));
      let manifest: Record<string, unknown> = { assetPath: path.startsWith('Project/') ? path : `Project/${path}`, fileName: getFileName(relative) };
      try { manifest = JSON.parse(await readTextFile(directory, manifestName)) as Record<string, unknown>; } catch (error) { if (!isNotFoundError(error)) throw error; }
      manifests.set(path.startsWith('Project/') ? path : `Project/${path}`, manifest);
      assets.push({ path, tags: Array.isArray(manifest.tags) ? manifest.tags.filter((tag): tag is string => typeof tag === 'string') : undefined, available: true });
    } catch { assets.push({ path, available: false }); }
  }
  return { assets, manifests };
};

const writeMigratedPathCaptions = async (root: ProjectDirectoryHandle, captions: Record<string, string[] | undefined>, manifests: Map<string, Record<string, unknown>>) => {
  for (const [path, tags] of Object.entries(captions)) {
    const relative = toProjectRelativePath(path);
    const directory = await getDirectoryForFilePath(root, relative);
    const manifest = { ...(manifests.get(path) ?? { assetPath: path, fileName: getFileName(relative) }), tags };
    await writeTextFile(directory, getAssetManifestName(getFileName(relative)), JSON.stringify(manifest, null, 2));
  }
};

export const readProjectDirectory = async (
  directory: ProjectDirectoryHandle,
  selectProjectType?: ProjectTypeResolver
): Promise<ProjectState> => {
  let manifestName: string;
  try {
    manifestName = await getExistingManifestName(directory);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    const projectType = await resolveProjectType(undefined, directory.name, selectProjectType);
    const project = createProject(directory.name, projectType);
    await createProjectDirectory(directory, project);
    return project;
  }
  const manifest = await readJsonFile<DirectoryProjectManifest>(
    directory,
    manifestName,
    'the project manifest'
  );
  if (manifest.format !== PROJECT_DIRECTORY_FORMAT || (manifest.version !== 1 && manifest.version !== 2)) {
    throw new Error('The selected directory is not a supported Dataset Creator project.');
  }
  if (!manifest.project || !manifest.project.id || !manifest.project.name) {
    throw new Error('The project manifest is missing required project fields.');
  }
  const datasetFilePath = manifest.project.datasetFilePath;
  if (manifest.version === 1 && datasetFilePath !== undefined && (
    typeof datasetFilePath !== 'string' ||
    !datasetFilePath.startsWith('Project/') ||
    !isLegacyDatasetFileName(datasetFilePath) ||
    datasetFilePath.includes('\\') ||
    datasetFilePath.split('/').some(part => !part || part === '.' || part === '..')
  )) {
    throw new Error('The project manifest contains an invalid Dataset file path.');
  }

  const projectType = await resolveProjectType(manifest.project.projectType, manifest.project.name, selectProjectType);
  if (manifest.project.projectType === undefined) {
    manifest.project.projectType = projectType;
    const handle = await directory.getFileHandle(manifestName);
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
  }
  const defaults = createProject(manifest.project.name, projectType);
  const legacyDatasetManifest = await ensureProjectLayout(directory, {
    ...defaults,
    taggingConfig: {
      ...defaults.taggingConfig,
      ...manifest.project.taggingConfig,
    },
  });
  const sourceManifestPaths = manifest.project.sourceImageManifests;
  const legacyEditedAssetManifestPaths = (manifest.project as Record<string, unknown>)[
    `syn${'thetic'}ImageManifests`
  ] as Record<string, string> | undefined;
  const editedAssetManifestPaths =
    manifest.project.editedAssetManifests ?? legacyEditedAssetManifestPaths ?? manifest.project.datasetItemManifests;
  const supportedEditedAssetManifestPaths = editedAssetManifestPaths
    ? Object.values(editedAssetManifestPaths).filter((manifestPath) => !isLegacyProjectRootPath(manifestPath))
    : undefined;
  const [sourceResults, editedAssetResults] = await Promise.all([
    sourceManifestPaths
      ? Promise.all(
          Object.values(sourceManifestPaths).map(async (manifestPath) => {
            try {
              return await readSource(await getDirectoryForFilePath(directory, manifestPath), directory, { manifestPath });
            } catch {
              return null;
            }
          })
        )
      : readOptionalProjectChildren(directory, 'sources', (entry) => readSource(entry)),
    supportedEditedAssetManifestPaths
      ? Promise.all(
          supportedEditedAssetManifestPaths.map(async (manifestPath) => {
            try {
              return await readEditedAsset(await getDirectoryForFilePath(directory, manifestPath), directory, { manifestPath });
            } catch {
              return null;
            }
          })
        )
      : readOptionalProjectChildren(directory, 'generated', (entry) => readEditedAsset(entry)),
  ]);
  let sources = sourceResults
    .filter((source): source is SourceImage => Boolean(source))
    // Explicitly registered sources retain their identity after an Explorer move.
    // Discovery of new sources remains limited to shared in assetIndexService.
    .filter((source) => sourceManifestPaths
      ? !isLegacyProjectRootPath(source.originalFilePath ?? '')
      : isProjectWorkspacePath(source.originalFilePath ?? '', 'shared'));
  let edited = editedAssetResults.filter((item): item is EditedAsset => Boolean(item));

  const datasetSettings = manifest.project.dataset;
  let datasetMigration = manifest.project.datasetMigration;
  if (manifest.version === 1 && legacyDatasetManifest && datasetMigration?.status !== 'complete') {
    const resolvedAssetPaths = (legacyDatasetManifest.assetIds ?? [])
      .map((id) => sources.find((source) => source.id === id)?.originalFilePath)
      .filter((path): path is string => Boolean(path));
    const pending = datasetMigration ?? createLegacyDatasetMigration({
      datasetFilePath,
      assetIds: legacyDatasetManifest.assetIds,
      assetPaths: legacyDatasetManifest.assetPaths,
      psdAssetPaths: legacyDatasetManifest.psdAssetPaths,
    }, resolvedAssetPaths);
    datasetMigration = await migrateLegacyDatasetMembership(directory, pending, async (report) => {
      manifest.project.datasetMigration = report;
      await writeTextFile(directory, manifestName, JSON.stringify(manifest, null, 2));
    });
    const moves = getLegacyDatasetPathMoves(datasetMigration);
    sources = sources.map((source) => ({
      ...source,
      originalFilePath: applyProjectRelativePathMoves(source.originalFilePath, moves),
      manifestPath: applyProjectRelativePathMoves(source.manifestPath, moves, true),
    }));
    edited = edited.map((item) => ({
      ...item,
      imageDataPath: applyProjectRelativePathMoves(item.imageDataPath, moves),
      psdDataPath: applyProjectRelativePathMoves(item.psdDataPath, moves),
      manifestPath: applyProjectRelativePathMoves(item.manifestPath, moves, true),
    }));
  }

  const sourceIds = new Set(sources.map((source) => source.id));
  const orphanEditedAsset = edited.find((item) => !sourceIds.has(item.sourceImageId));
  if (orphanEditedAsset) {
    throw new Error(
      `Edited asset "${orphanEditedAsset.id}" references a source image that is missing from the project.`
    );
  }

  const projectRecord = manifest.project as Record<string, unknown>;
  const legacyCurrentTool = projectRecord[`currentSta${'ge'}`];
  const currentTool = manifest.project.currentTool ?? (typeof legacyCurrentTool === 'string' ? getToolFromSlug(legacyCurrentTool) : 'import');

  const loadedProject: ProjectState = {
    ...defaults,
    id: manifest.project.id,
    name: manifest.project.name,
    currentTool,
    sourceImages: Object.fromEntries(sources.map((source) => [source.id, source])),
    datasetItems: Object.fromEntries(edited.map((item) => [item.id, item])),
    dataset: {
      ...defaults.dataset,
      name: datasetSettings?.name || legacyDatasetManifest?.name || defaults.dataset.name,
      triggerWord: datasetSettings?.triggerWord ?? legacyDatasetManifest?.triggerWord ?? defaults.dataset.triggerWord,
      assetOrder: datasetSettings?.assetOrder ?? legacyDatasetManifest?.assetOrder ?? [],
      createdAt: datasetSettings?.createdAt ? toDate(datasetSettings.createdAt, defaults.dataset.createdAt) : legacyDatasetManifest?.createdAt ? toDate(legacyDatasetManifest.createdAt, defaults.dataset.createdAt) : defaults.dataset.createdAt,
      updatedAt: datasetSettings?.updatedAt ? toDate(datasetSettings.updatedAt, defaults.dataset.updatedAt) : legacyDatasetManifest ? toDate(legacyDatasetManifest.updatedAt, defaults.dataset.updatedAt) : defaults.dataset.updatedAt,
    },
    taggingConfig: {
      ...defaults.taggingConfig,
      ...manifest.project.taggingConfig,
      datasetKeyword: datasetSettings?.triggerWord ?? legacyDatasetManifest?.triggerWord ?? manifest.project.taggingConfig.datasetKeyword ?? defaults.taggingConfig.datasetKeyword,
    },
    workspaceSettings: {
      ...defaults.workspaceSettings,
      ...manifest.project.workspaceSettings,
    },
    captionMigration: manifest.project.captionMigration,
    datasetMigration,
    lastModified: toDate(manifest.project.lastModified, new Date()),
    createdAt: toDate(manifest.project.createdAt, new Date()),
  };
  if (manifest.version === 1 && datasetMigration?.status === 'complete') {
    await writeTextFile(directory, manifestName, JSON.stringify(getProjectManifest(loadedProject, {
      sourceImageManifests: Object.fromEntries(sources.flatMap((source) => source.manifestPath ? [[source.id, toProjectRelativePath(source.manifestPath)]] : [])),
      editedAssetManifests: Object.fromEntries(edited.flatMap((item) => item.manifestPath ? [[item.id, toProjectRelativePath(item.manifestPath)]] : [])),
    }), null, 2));
    await removeProjectFileAtPath(directory, DATASET_MANIFEST_FILE);
    if (datasetFilePath) await removeProjectFileAtPath(directory, datasetFilePath);
    await removeLegacyDatasetDocuments(directory);
  }
  const previousMigration = manifest.project.captionMigration;
  const legacyOverrides = previousMigration?.status === 'pending'
    ? Object.fromEntries(Object.entries(previousMigration.legacyOverrides).filter(([key]) => previousMigration.unresolved.includes(key)))
    : legacyDatasetManifest?.captionOverrides ?? {};
  const legacyOverwriteEnabled = previousMigration?.overwriteEnabled ?? legacyDatasetManifest?.overwriteCaptions === true;
  const migrationNeeded = manifest.project.captionMigration?.status !== 'complete' && (legacyOverwriteEnabled || Object.keys(legacyOverrides).length > 0);
  if (!migrationNeeded) return loadedProject;
  const legacyDatasetForCaption = {
    ...loadedProject.dataset,
    assetIds: legacyDatasetManifest?.assetIds ?? [],
    assetPaths: legacyDatasetManifest?.assetPaths ?? [],
    psdAssetPaths: legacyDatasetManifest?.psdAssetPaths ?? [],
  };
  const paths = [...legacyDatasetForCaption.assetPaths, ...legacyDatasetForCaption.psdAssetPaths];
  const pathState = await readCaptionPathAssets(directory, paths);
  const migration = migrateLegacyCaptions({
    legacy: { overwriteCaptions: legacyOverwriteEnabled, captionOverrides: legacyOverrides, triggerWord: loadedProject.dataset.triggerWord },
    dataset: legacyDatasetForCaption,
    sourceImages: loadedProject.sourceImages,
    datasetItems: loadedProject.datasetItems,
    pathAssets: pathState.assets,
  });
  const previous = previousMigration;
  const migratedProject: ProjectState = {
    ...loadedProject,
    sourceImages: migration.sourceImages,
    datasetItems: migration.datasetItems,
    captionMigration: {
      ...migration.report,
      legacyOverrides: previous?.legacyOverrides ?? migration.report.legacyOverrides,
      assetSnapshots: { ...(previous?.assetSnapshots ?? {}), ...migration.report.assetSnapshots },
      applied: [...new Set([...(previous?.applied ?? []), ...migration.report.applied])],
      conflicts: [...(previous?.conflicts ?? []), ...migration.report.conflicts],
    },
  };
  await writeMigratedPathCaptions(directory, migration.pathCaptions, pathState.manifests);
  await writeProjectDirectoryChanges(migratedProject, loadedProject, directory);
  return migratedProject;
};
