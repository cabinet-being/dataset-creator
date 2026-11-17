import { normalizeCharacterTraits } from '../tagging/characterTraits';
import { normalizeProjectType, resolveProjectType, resolveTargetModel, type ProjectTypeResolver } from '../../lib/projectProfiles';
import { URL_TOOL_ALIASES } from '../../lib/constants';
import {
  createProject,
  type ProjectState,
  type ProjectType,
  type TargetModelId,
  type SourceImage,
  type ToolName,
  type EditedAsset,
  type TaggingConfig,
  type WorkspaceSettings,
} from '../../types';
import { createThumbnail } from '../image/imageProcessor';
import { getAssetManifestName, getAssetManifestPath } from './assetManifestService';
import { snapshotFileIfNeeded } from './fileSnapshotService';
import { isTriggerMissing, readCaptionFile, readCaptionRaw, writeCaptionFile } from '../caption/captionFileService';
import { migrateLegacyCaptions, type PathCaptionAsset } from '../caption/captionMigrationService';
import { isLegacyProjectRootPath } from './projectPathFilters';
import { getCachedProjectJsonMigrations, setCachedProjectJsonMigrations } from './projectJsonMigrationsCache';
import { isLegacyDatasetFileName } from './legacyDatasetFileService';
import { migrateLegacyDatasetExclusions } from './legacyDatasetExclusionService';
import {
  DATASET_MANIFEST_FILE,
  LEGACY_CACHE_DIRECTORY,
  PROJECT_DATASET_DIRECTORY,
  PROJECT_DATA_DIRECTORY,
  PROJECT_FILE,
  PROJECT_GIT_DIRECTORY,
  PROJECT_INTERNAL_DIRECTORY,
  PROJECT_LAYOUT,
  PROJECT_PROJECT_FORMAT,
  PROJECT_INBOX_DIRECTORY,
  detectProjectLayout,
  ensureProjectLayout,
  isProjectWorkspacePath,
} from './projectLayoutService';
import { applyFileAssetOrderPathMoves, applyProjectRelativePathMoves, type ExplorerPathMove } from '../../lib/datasetAssets';
import { getImageDimensions } from '../image/imageProcessor';
import { hashAssetBlob, reconcileProjectAssets, type AssetReconcileReport } from './assetIndexService';
import {
  commitAssetRegistry,
  getActiveAssetRegistry,
  isAssetRegistrySaved,
  loadAssetRegistry,
  statProjectFile,
  updateAssetRegistry,
  type AssetRecord,
} from './assetRegistryService';
import { createOperationLogger } from '../logging/applicationLog';
import { applyBuildSessionPathMoves, normalizeBuildSession } from '../build/buildSessionService';
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
export const PROJECT_DIRECTORY_CACHE = PROJECT_LAYOUT.cacheDir;
const PROJECT_PREVIEW_CACHE_DIRECTORY = `${PROJECT_LAYOUT.cacheDir}/previews`;
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
  isSameEntry?: (other: ProjectDirectoryHandle) => Promise<boolean>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<ProjectDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<ProjectDirectoryFileHandle>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  entries: () => AsyncIterableIterator<[string, ProjectDirectoryHandle | ProjectDirectoryFileHandle]>;
};

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<ProjectDirectoryHandle>;
  };

/** `completedAt` is set when the migration journal finishes; until then only id and fromVersion are stored. */
export type LayoutV3Migration = { id: string; completedAt?: string; fromVersion: 1 | 2 };
/** Sidecar tags were turned into TXT captions; its presence means no further scan is needed. */
export type CaptionsTxtMigration = { id: string; completedAt: string };

/** The asset registry was folded out of the sidecars; its presence means no *.manifest.json is read any more. */
export type AssetsRegistryMigration = { id: string; completedAt: string };

/** `.datasetcreator/project.json` (v3). Per-file data lives in `.datasetcreator/assets.json`. */
export type ProjectJsonV3 = {
  format: typeof PROJECT_PROJECT_FORMAT;
  version: 3;
  project: Omit<DirectoryProjectManifest['project'], 'taggingConfig' | 'datasetMigration' | 'captionMigration' | 'datasetItemManifests' | 'datasetFilePath' | 'sourceImageManifests' | 'editedAssetManifests'> & {
    taggingConfig: Omit<TaggingConfig, 'autoTaggingEndpoint'>;
    migrations?: {
      layoutV3?: LayoutV3Migration;
      captionsTxt?: CaptionsTxtMigration;
      assetsRegistry?: AssetsRegistryMigration;
      legacy?: { datasetMigration?: LegacyDatasetMigrationReport; captionMigration?: ProjectState['captionMigration'] };
    };
  };
};

type DirectoryProjectManifest = {
  format: typeof PROJECT_DIRECTORY_FORMAT;
  version: 1 | 2;
  project: {
    id: string;
    name: string;
    projectType?: ProjectType;
    targetModel?: TargetModelId;
    characterTraits?: ProjectState['characterTraits'];
    currentTool: ToolName;
    taggingConfig: Omit<TaggingConfig, 'autoTaggingEndpoint'>;
    workspaceSettings: WorkspaceSettings;
    buildSession?: ProjectState['buildSession'];
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

/** Entities read from an unmigrated layout remember their sidecar until the reader moves it into the legacy map. */
type LegacySource = SourceImage & { manifestPath?: string };
type LegacyEdited = EditedAsset & { manifestPath?: string };

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
  originalFilePath: string,
  includeTags: boolean
): SourceManifest => ({
  id: source.id,
  fileName: source.fileName,
  originalFileName: source.originalFileName,
  width: source.width,
  height: source.height,
  mimeType: source.mimeType,
  originalFilePath,
  originalFileNameOnDisk,
  ...(includeTags ? { tags: source.tags } : {}),
  hidden: source.hidden,
  createdAt: toIsoString(source.createdAt),
});

const serializeEditedAssetManifest = (
  item: EditedAsset,
  imageFileName: string,
  imageDataPath: string,
  psdFileName: string | undefined,
  psdDataPath: string | undefined,
  includeTags: boolean
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
  ...(includeTags ? { tags: item.tags } : {}),
  aspectRatio: item.aspectRatio,
  deleted: item.deleted,
  deletedAt: item.deletedAt ? toIsoString(item.deletedAt) : undefined,
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
    targetModel: project.targetModel,
    ...(project.characterTraits?.length ? { characterTraits: project.characterTraits } : {}),
    currentTool: project.currentTool,
    taggingConfig: {
      threshold: project.taggingConfig.threshold,
      maxTags: project.taggingConfig.maxTags,
      insertMode: project.taggingConfig.insertMode,
      blacklist: project.taggingConfig.blacklist,
    },
    workspaceSettings: project.workspaceSettings,
    buildSession: project.buildSession,
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

type ManifestPaths = {
  sourceImageManifests?: Record<string, string>;
  editedAssetManifests?: Record<string, string>;
};

const serializeProjectJson = (
  project: ProjectState,
  migrations: NonNullable<ProjectJsonV3['project']['migrations']> | undefined
): ProjectJsonV3 => {
  const {
    taggingConfig, datasetMigration, captionMigration, datasetItemManifests: _items, datasetFilePath: _file,
    sourceImageManifests: _sources, editedAssetManifests: _edited, ...rest
  } = getProjectManifest(project).project;
  const legacy = datasetMigration || captionMigration ? { datasetMigration, captionMigration } : migrations?.legacy;
  const nextMigrations = migrations?.layoutV3 || migrations?.captionsTxt || migrations?.assetsRegistry || legacy
    ? { layoutV3: migrations?.layoutV3, captionsTxt: migrations?.captionsTxt, assetsRegistry: migrations?.assetsRegistry, legacy }
    : undefined;
  return {
    format: PROJECT_PROJECT_FORMAT,
    version: 3,
    project: { ...rest, taggingConfig, ...(nextMigrations ? { migrations: nextMigrations } : {}) },
  };
};

export type LegacyProjectManifest = DirectoryProjectManifest;

export const readLegacyProjectManifest = (directory: ProjectDirectoryHandle): Promise<LegacyProjectManifest> =>
  readJsonFile<DirectoryProjectManifest>(directory, PROJECT_DIRECTORY_MANIFEST, 'the project manifest');

/**
 * project.json written by the v2 upgrade still lists the sidecars of every asset; the asset registry
 * migration that follows folds them into assets.json and removes these maps.
 */
export type PendingProjectJsonV3 = ProjectJsonV3 & {
  project: { sourceImageManifests?: Record<string, string>; editedAssetManifests?: Record<string, string> };
};

/** Builds project.json from a (legacy-migrated) manifest.json and the project read from it. */
export const createLayoutV3ProjectJson = (
  manifest: LegacyProjectManifest,
  project: ProjectState,
  layoutV3: LayoutV3Migration
): PendingProjectJsonV3 => {
  const record = manifest.project as Record<string, unknown>;
  const editedAssetManifests = manifest.project.editedAssetManifests
    ?? (record[`syn${'thetic'}ImageManifests`] as Record<string, string> | undefined)
    ?? manifest.project.datasetItemManifests;
  const json = serializeProjectJson(project, { layoutV3 });
  return { ...json, project: { ...json.project, sourceImageManifests: manifest.project.sourceImageManifests, editedAssetManifests } };
};

/** Maps a v3 project.json to the in-memory shape shared with the legacy manifest reader. */
export const projectJsonToManifest = (json: ProjectJsonV3): DirectoryProjectManifest => {
  const { migrations, taggingConfig, ...rest } = json.project;
  return {
    format: PROJECT_DIRECTORY_FORMAT,
    version: 2,
    project: {
      ...rest,
      taggingConfig,
      datasetMigration: migrations?.legacy?.datasetMigration,
      captionMigration: migrations?.legacy?.captionMigration,
    },
  };
};

const readProjectJsonMigrations = async (directory: ProjectDirectoryHandle): Promise<ProjectJsonV3['project']['migrations']> => {
  const cached = getCachedProjectJsonMigrations<ProjectJsonV3['project']['migrations']>(directory);
  if (cached) return cached.value;
  try {
    const migrations = (JSON.parse(await readTextFile(await getDirectoryAtPath(directory, PROJECT_INTERNAL_DIRECTORY), 'project.json')) as ProjectJsonV3).project?.migrations;
    setCachedProjectJsonMigrations(directory, migrations);
    return migrations;
  } catch {
    return undefined;
  }
};

/** Writes the project manifest where the project lives: project.json for v3 (and new projects), manifest.json for an unmigrated legacy project. */
const writeProjectManifest = async (
  directory: ProjectDirectoryHandle,
  project: ProjectState,
  paths: ManifestPaths = {}
) => {
  const layout = await detectProjectLayout(directory);
  if (layout === 'v2') {
    await writeTextFile(directory, PROJECT_DIRECTORY_MANIFEST, JSON.stringify(getProjectManifest(project, paths), null, 2));
    return;
  }
  // A brand-new project has no sidecars or sidecar tags to convert, so it starts with those conversions marked complete.
  const completedAt = new Date().toISOString();
  const migrations = layout === 'v3'
    ? await readProjectJsonMigrations(directory)
    : { captionsTxt: { id: 'new-project', completedAt }, assetsRegistry: { id: 'new-project', completedAt } };
  const json = serializeProjectJson(project, migrations);
  await writeTextFileAtPath(directory, PROJECT_FILE, JSON.stringify(json, null, 2));
  // The file now holds exactly these markers; remembering them skips re-parsing it on the next save.
  setCachedProjectJsonMigrations(directory, json.project.migrations);
};

const getDefaultSourceManifestPath = (source: SourceImage): string => {
  const fileName = `${source.id}.${getFileExtension(source.fileName, source.mimeType)}`;
  return joinPath(PROJECT_INBOX_DIRECTORY, getAssetManifestName(fileName));
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

  return toProjectRelativePath(path);
};

/** Settings the asset writers need for captions: the TXT is the caption; sidecars keep tags only in an unmigrated legacy layout. */
type CaptionWriteContext = { trigger: string; legacy: boolean };

/** A newly saved asset that carries tags in memory gets its TXT unless one already exists. */
const writeNewCaption = async (root: ProjectDirectoryHandle, imagePath: string | undefined, tags: string[] | undefined, trigger: string) => {
  if (!imagePath || tags === undefined) return;
  if (await readCaptionRaw(root, imagePath) !== null) return;
  await writeCaptionFile(root, imagePath, tags, trigger);
};

// ---------------------------------------------------------------------------------------------------------
// Legacy (unmigrated, manifest.json) layout: sidecars. Entities do not carry a manifest path; the reader
// remembers where each sidecar lives and the writers derive the rest from the asset path.
// ---------------------------------------------------------------------------------------------------------

const legacyManifestPaths = new WeakMap<ProjectDirectoryHandle, Map<string, string>>();

const getLegacyManifests = (root: ProjectDirectoryHandle): Map<string, string> => {
  let manifests = legacyManifestPaths.get(root);
  if (!manifests) {
    manifests = new Map();
    legacyManifestPaths.set(root, manifests);
  }
  return manifests;
};

/** A `<file>.manifest.json` sidecar follows its file; a legacy `manifest.json` in a payload folder stays where it is. */
const resolveLegacyManifestPath = (root: ProjectDirectoryHandle, id: string, assetPath: string | undefined): string | undefined => {
  const known = getLegacyManifests(root).get(id);
  if (assetPath && (!known || known.endsWith('.manifest.json') && getFileName(known) !== PROJECT_DIRECTORY_MANIFEST)) {
    return getAssetManifestPath(toProjectRelativePath(assetPath));
  }
  return known;
};

const writeLegacySource = async (
  root: ProjectDirectoryHandle,
  source: SourceImage,
  previousSource: SourceImage | undefined,
  captions: CaptionWriteContext
): Promise<string> => {
  const defaultOriginalFileName = `original.${getFileExtension(source.fileName, source.mimeType)}`;
  const assetPath = source.originalFilePath ?? previousSource?.originalFilePath;
  const previousManifestPath = getLegacyManifests(root).get(source.id);
  const manifestPath = getNormalizedAssetManifestPath(
    resolveLegacyManifestPath(root, source.id, assetPath),
    defaultOriginalFileName,
    getDefaultSourceManifestPath(source)
  );
  const originalFilePath = assetPath
    ? toProjectRelativePath(assetPath)
    : joinPath(getParentPath(manifestPath), `${source.id}.${getFileExtension(source.fileName, source.mimeType)}`);
  const originalFileNameOnDisk = getFileName(originalFilePath);
  if (!previousSource || source.originalFile !== previousSource.originalFile) {
    await writeBlobFileAtPath(root, originalFilePath, source.originalFile);
    await writeProjectPreview(root, 'source', source.id, source.originalFile);
  }
  if (!previousSource) await writeNewCaption(root, originalFilePath, source.tags, captions.trigger);
  await writeTextFileAtPath(
    root,
    manifestPath,
    JSON.stringify(serializeSourceManifest(source, originalFileNameOnDisk, originalFilePath, captions.legacy), null, 2)
  );
  if (previousManifestPath && toProjectRelativePath(previousManifestPath) !== manifestPath) {
    await removeProjectFileAtPath(root, previousManifestPath);
  }
  getLegacyManifests(root).set(source.id, manifestPath);
  return manifestPath;
};

const writeLegacyEditedAsset = async (
  root: ProjectDirectoryHandle,
  item: EditedAsset,
  previousItem: EditedAsset | undefined,
  captions: CaptionWriteContext
): Promise<string> => {
  const defaultImageFileName = 'image.png';
  const assetPath = item.imageDataPath ?? previousItem?.imageDataPath;
  const previousManifestPath = getLegacyManifests(root).get(item.id);
  const manifestPath = getNormalizedAssetManifestPath(
    resolveLegacyManifestPath(root, item.id, assetPath),
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
  if (!previousItem) await writeNewCaption(root, imageDataPath, item.tags, captions.trigger);
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
    JSON.stringify(serializeEditedAssetManifest(item, imageFileName, imageDataPath, psdFileName, psdDataPath, captions.legacy), null, 2)
  );
  if (previousManifestPath && toProjectRelativePath(previousManifestPath) !== manifestPath) {
    await removeProjectFileAtPath(root, previousManifestPath);
  }
  getLegacyManifests(root).set(item.id, manifestPath);
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

// ---------------------------------------------------------------------------------------------------------
// v3 layout: the asset registry (.datasetcreator/assets.json) replaces the sidecars.
// ---------------------------------------------------------------------------------------------------------

const PSD_MIME_TYPE = 'image/vnd.adobe.photoshop';

/** Changes one save makes to the registry; applied in a single differential write after every file was written. */
type RegistryChanges = { upserts: AssetRecord[]; removeIds: Set<string>; removePaths: Set<string> };

const createRegistryChanges = (): RegistryChanges => ({ upserts: [], removeIds: new Set(), removePaths: new Set() });

const getLiveRecordById = (root: ProjectDirectoryHandle, id: string): AssetRecord | undefined =>
  getActiveAssetRegistry(root)?.assets[id];

const getLiveRecordByPath = (root: ProjectDirectoryHandle, path: string): AssetRecord | undefined => {
  const registry = getActiveAssetRegistry(root);
  return registry ? Object.values(registry.assets).find((record) => record.path === path) : undefined;
};

const writeSourceV3 = async (
  root: ProjectDirectoryHandle,
  source: SourceImage,
  previousSource: SourceImage | undefined,
  captions: CaptionWriteContext,
  changes: RegistryChanges
): Promise<void> => {
  const record = getLiveRecordById(root, source.id);
  const originalFilePath = source.originalFilePath
    ? toProjectRelativePath(source.originalFilePath)
    : previousSource?.originalFilePath
      ? toProjectRelativePath(previousSource.originalFilePath)
      : record?.path ?? joinPath(PROJECT_INBOX_DIRECTORY, `${source.id}.${getFileExtension(source.fileName, source.mimeType)}`);
  const contentChanged = !previousSource || source.originalFile !== previousSource.originalFile;
  if (contentChanged) {
    await writeBlobFileAtPath(root, originalFilePath, source.originalFile);
    await writeProjectPreview(root, 'source', source.id, source.originalFile);
  }
  if (!previousSource) await writeNewCaption(root, originalFilePath, source.tags, captions.trigger);
  const stat = await statProjectFile(root, originalFilePath);
  if (!stat) return;
  const keepHash = !contentChanged && record?.path === originalFilePath && record.size === stat.size && record.mtime === stat.mtime;
  // New content is fingerprinted while it is still in memory; unchanged content keeps its stored hash.
  const sha256 = keepHash ? record?.sha256 : contentChanged ? await hashAssetBlob(source.originalFile) : undefined;
  changes.upserts.push({
    id: source.id,
    path: originalFilePath,
    role: 'source',
    fileKind: 'image',
    size: stat.size,
    mtime: stat.mtime,
    ...(sha256 ? { sha256 } : {}),
    mimeType: source.mimeType,
    width: source.width,
    height: source.height,
    fileName: source.fileName,
    ...(source.originalFileName !== undefined ? { originalFileName: source.originalFileName } : {}),
    createdAt: toIsoString(source.createdAt),
    ...(source.hidden !== undefined ? { hidden: source.hidden } : {}),
    ...(source.modifiedAt !== undefined ? { modifiedAt: source.modifiedAt } : {}),
    ...(record?.legacyTags ? { legacyTags: record.legacyTags } : {}),
  });
};

const writeEditedAssetV3 = async (
  root: ProjectDirectoryHandle,
  item: EditedAsset,
  previousItem: EditedAsset | undefined,
  captions: CaptionWriteContext,
  changes: RegistryChanges
): Promise<void> => {
  const record = getLiveRecordById(root, item.id);
  const imageDataPath =
    getReusableProjectPath(item.imageDataPath) ??
    getReusableProjectPath(previousItem?.imageDataPath) ??
    record?.path ??
    joinPath(PROJECT_DATASET_DIRECTORY, `${item.id}.png`);
  const psdDataPath = item.psdData
    ? getReusableProjectPath(item.psdDataPath) ??
      getReusableProjectPath(previousItem?.psdDataPath) ??
      record?.edited?.psdPath ??
      joinPath(getParentPath(imageDataPath), 'image.psd')
    : undefined;
  const imageChanged = !previousItem || item.imageData !== previousItem.imageData;
  if (imageChanged) {
    await writeBlobFileAtPath(root, imageDataPath, item.imageData);
    await writeProjectPreview(root, 'edited', item.id, item.imageData);
  }
  if (!previousItem) await writeNewCaption(root, imageDataPath, item.tags, captions.trigger);
  const psdChanged = Boolean(item.psdData) && (!previousItem || item.psdData !== previousItem.psdData);
  if (item.psdData && psdDataPath && psdChanged) {
    await writeBlobFileAtPath(root, psdDataPath, item.psdData);
  } else if (!item.psdData && previousItem?.psdData) {
    const previousPsdPath = getReusableProjectPath(previousItem.psdDataPath) ?? record?.edited?.psdPath;
    if (previousPsdPath) {
      await removeProjectFileAtPath(root, previousPsdPath);
      changes.removePaths.add(previousPsdPath);
    }
  }
  const stat = await statProjectFile(root, imageDataPath);
  if (stat) {
    const keepHash = !imageChanged && record?.path === imageDataPath && record.size === stat.size && record.mtime === stat.mtime;
    const sha256 = keepHash ? record?.sha256 : imageChanged ? await hashAssetBlob(item.imageData) : undefined;
    changes.upserts.push({
      id: item.id,
      path: imageDataPath,
      role: 'edited',
      fileKind: 'image',
      size: stat.size,
      mtime: stat.mtime,
      ...(sha256 ? { sha256 } : {}),
      mimeType: 'image/png',
      width: item.width,
      height: item.height,
      fileName: getFileName(imageDataPath),
      createdAt: toIsoString(item.createdAt),
      ...(item.modifiedAt !== undefined ? { modifiedAt: item.modifiedAt } : {}),
      edited: {
        sourceImageId: item.sourceImageId,
        ...(psdDataPath ? { psdPath: psdDataPath } : {}),
        type: item.type,
        ...(item.cropFrame ? { cropFrame: item.cropFrame } : {}),
        ...(item.augmentationConfig ? { augmentationConfig: item.augmentationConfig } : {}),
        ...(item.cleanupOverlayId ? { cleanupOverlayId: item.cleanupOverlayId } : {}),
        aspectRatio: item.aspectRatio,
        deleted: item.deleted,
        ...(item.deletedAt ? { deletedAt: toIsoString(item.deletedAt) } : {}),
        ...(item.exportOrder !== undefined ? { exportOrder: item.exportOrder } : {}),
      },
    });
  }
  if (psdDataPath) {
    const psdStat = await statProjectFile(root, psdDataPath);
    if (psdStat) {
      const existing = getLiveRecordByPath(root, psdDataPath);
      const keepHash = !psdChanged && existing?.size === psdStat.size && existing.mtime === psdStat.mtime;
      const sha256 = keepHash ? existing?.sha256 : psdChanged && item.psdData ? await hashAssetBlob(item.psdData) : undefined;
      changes.upserts.push({
        id: existing?.id ?? crypto.randomUUID(),
        path: psdDataPath,
        role: 'file',
        fileKind: 'psd',
        size: psdStat.size,
        mtime: psdStat.mtime,
        ...(sha256 ? { sha256 } : {}),
        mimeType: PSD_MIME_TYPE,
        fileName: getFileName(psdDataPath),
        createdAt: existing?.createdAt ?? toIsoString(item.createdAt),
      });
    }
  }
};

const removeSourceV3 = async (root: ProjectDirectoryHandle, id: string, previous: SourceImage, changes: RegistryChanges) => {
  await removeProjectPreview(root, 'source', id);
  const path = getReusableProjectPath(previous.originalFilePath) ?? getLiveRecordById(root, id)?.path;
  if (path) await removeProjectFileAtPath(root, path);
  changes.removeIds.add(id);
};

const removeEditedAssetV3 = async (root: ProjectDirectoryHandle, id: string, previous: EditedAsset, changes: RegistryChanges) => {
  await removeProjectPreview(root, 'edited', id);
  const record = getLiveRecordById(root, id);
  const imagePath = getReusableProjectPath(previous.imageDataPath) ?? record?.path;
  const psdPath = getReusableProjectPath(previous.psdDataPath) ?? record?.edited?.psdPath;
  if (imagePath) await removeProjectFileAtPath(root, imagePath);
  if (psdPath) {
    await removeProjectFileAtPath(root, psdPath);
    changes.removePaths.add(psdPath);
  }
  changes.removeIds.add(id);
};

const applyRegistryChanges = (root: ProjectDirectoryHandle, changes: RegistryChanges) =>
  // Nothing to change and assets.json already exists: serializing the whole registry just to find it identical is wasted work.
  !changes.upserts.length && !changes.removeIds.size && !changes.removePaths.size && isAssetRegistrySaved(root)
    ? Promise.resolve(false)
    : updateAssetRegistry(root, (assets) => {
    for (const id of changes.removeIds) delete assets[id];
    for (const [id, record] of Object.entries(assets)) {
      if (changes.removePaths.has(record.path) && record.role === 'file') delete assets[id];
    }
    for (const record of changes.upserts) {
      // A plain-file record sitting at this path (made by indexing) gives way to the entity record.
      for (const [id, other] of Object.entries(assets)) {
        if (id !== record.id && other.path === record.path && other.role === 'file' && record.role !== 'file') delete assets[id];
      }
      assets[record.id] = record;
    }
  });

export const pickProjectDirectory = async (): Promise<ProjectDirectoryHandle> => {
  const picker = requireDirectoryPicker();
  return picker.call(window, { mode: 'readwrite' });
};

export const createProjectDirectory = async (
  directory: ProjectDirectoryHandle,
  project: ProjectState
) => {
  await ensureProjectLayout(directory, project);
  // A new project has no registry yet; the saved assets become its first records.
  await loadAssetRegistry(directory);
  const captions: CaptionWriteContext = { trigger: project.dataset.triggerWord, legacy: false };
  const changes = createRegistryChanges();

  await Promise.all([
    ...Object.values(project.sourceImages).map((source) => writeSourceV3(directory, source, undefined, captions, changes)),
    ...Object.values(project.datasetItems).map((item) => writeEditedAssetV3(directory, item, undefined, captions, changes)),
  ]);
  await applyRegistryChanges(directory, changes);
  await writeProjectManifest(directory, project);
};

export const projectDirectoryHasManifest = async (directory: ProjectDirectoryHandle): Promise<boolean> =>
  await detectProjectLayout(directory).catch(() => 'none' as const) !== 'none';

const CLEARED_PROJECT_ENTRIES = [
  PROJECT_INTERNAL_DIRECTORY,
  '.dataset-creator-data',
  LEGACY_CACHE_DIRECTORY,
  'sources',
  'edited',
  PROJECT_DIRECTORY_MANIFEST,
  DATASET_MANIFEST_FILE,
  PROJECT_DATASET_DIRECTORY,
  PROJECT_INBOX_DIRECTORY,
  'src',
];
const GIT_SERVICE_ENTRIES = new Set(['dataset-creator-versions.json', 'snapshots', 'restore-backups']);

// A .git folder holding anything besides Dataset Creator version files is a real repository.
// A .git file (worktree/submodule gitfile) or an unreadable .git is treated as a real repository too.
const hasRealGitRepository = async (directory: ProjectDirectoryHandle): Promise<boolean> => {
  try {
    const git = await directory.getDirectoryHandle(PROJECT_GIT_DIRECTORY);
    for await (const [name] of git.entries()) {
      if (!GIT_SERVICE_ENTRIES.has(name)) return true;
    }
    return false;
  } catch (error) {
    if ((error as { name?: string })?.name === 'NotFoundError') return false;
    return true;
  }
};

/** Names that clearProjectDirectory would delete from the folder (a real Git repository is never listed). */
export const listProjectDirectoryClearTargets = async (directory: ProjectDirectoryHandle): Promise<string[]> => {
  const names = new Set<string>();
  for await (const [name] of directory.entries()) names.add(name);
  const targets = CLEARED_PROJECT_ENTRIES.filter((name) => names.has(name));
  if (names.has(PROJECT_GIT_DIRECTORY) && !(await hasRealGitRepository(directory))) targets.push(PROJECT_GIT_DIRECTORY);
  return targets;
};

/** Counts files in a folder recursively, skipping .git, for user-facing confirmations. */
export const countProjectDirectoryFiles = async (directory: ProjectDirectoryHandle): Promise<number> => {
  let count = 0;
  const walk = async (current: ProjectDirectoryHandle, isRoot: boolean) => {
    for await (const [name, entry] of current.entries()) {
      if (isRoot && name === PROJECT_GIT_DIRECTORY) continue;
      if ('entries' in entry) await walk(entry as ProjectDirectoryHandle, false);
      else count += 1;
    }
  };
  await walk(directory, true);
  return count;
};

export const clearProjectDirectory = async (directory: ProjectDirectoryHandle) => {
  const entries = [...CLEARED_PROJECT_ENTRIES];
  if (!(await hasRealGitRepository(directory))) entries.push(PROJECT_GIT_DIRECTORY);
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await directory.removeEntry(entry, { recursive: true });
      } catch {
        // A new directory may not contain all project entries yet.
      }
    })
  );
};

const writeLegacyProjectDirectoryChanges = async (
  project: ProjectState,
  previousProject: ProjectState | undefined,
  directory: ProjectDirectoryHandle
) => {
  const previousSources = previousProject?.sourceImages ?? {};
  const previousEditedAssets = previousProject?.datasetItems ?? {};
  const captions: CaptionWriteContext = { trigger: project.dataset.triggerWord, legacy: true };
  const manifests = getLegacyManifests(directory);

  const assetWrites = await Promise.allSettled([
    ...Object.entries(project.sourceImages)
      .filter(([id, source]) => source !== previousSources[id])
      .map(async ([id, source]) => {
        await writeLegacySource(directory, source, previousSources[id], captions);
      }),
    ...Object.keys(previousSources)
      .filter((id) => !project.sourceImages[id])
      .map(async (id) => {
        await removeProjectPreview(directory, 'source', id);
        const manifestPath = manifests.get(id);
        if (manifestPath) {
          await removeProjectEntryAtPath(directory, manifestPath, [previousSources[id].originalFilePath]);
          manifests.delete(id);
        }
      }),
    ...Object.entries(project.datasetItems)
      .filter(([id, item]) => item !== previousEditedAssets[id])
      .map(async ([id, item]) => {
        await writeLegacyEditedAsset(directory, item, previousEditedAssets[id], captions);
      }),
    ...Object.keys(previousEditedAssets)
      .filter((id) => !project.datasetItems[id])
      .map(async (id) => {
        await removeProjectPreview(directory, 'edited', id);
        const manifestPath = manifests.get(id);
        if (manifestPath) {
          await removeProjectEntryAtPath(directory, manifestPath, [
            previousEditedAssets[id].imageDataPath,
            previousEditedAssets[id].psdDataPath,
          ]);
          manifests.delete(id);
        }
      }),
  ]);

  // Keep the save lane occupied until every started writer finishes, even if
  // another failed. A retry must not race an unfinished previous snapshot.
  const failedWrite = assetWrites.find((result) => result.status === 'rejected');
  if (failedWrite?.status === 'rejected') throw failedWrite.reason;

  const sourceImageManifests: Record<string, string> = {};
  const editedAssetManifests: Record<string, string> = {};
  for (const source of Object.values(project.sourceImages)) {
    sourceImageManifests[source.id] = toProjectRelativePath(manifests.get(source.id) ?? getDefaultSourceManifestPath(source));
  }
  for (const item of Object.values(project.datasetItems)) {
    editedAssetManifests[item.id] = toProjectRelativePath(manifests.get(item.id) ?? getDefaultEditedAssetManifestPath(item));
  }
  await writeProjectManifest(directory, project, { sourceImageManifests, editedAssetManifests });
};

const writeV3ProjectDirectoryChanges = async (
  project: ProjectState,
  previousProject: ProjectState | undefined,
  directory: ProjectDirectoryHandle
) => {
  // The registry is the live one of this root; a save that finds it unloaded reads it first instead of starting an empty one.
  if (!getActiveAssetRegistry(directory)) await loadAssetRegistry(directory);
  const previousSources = previousProject?.sourceImages ?? {};
  const previousEditedAssets = previousProject?.datasetItems ?? {};
  const captions: CaptionWriteContext = { trigger: project.dataset.triggerWord, legacy: false };
  const changes = createRegistryChanges();

  const assetWrites = await Promise.allSettled([
    ...Object.entries(project.sourceImages)
      .filter(([id, source]) => source !== previousSources[id])
      .map(([id, source]) => writeSourceV3(directory, source, previousSources[id], captions, changes)),
    ...Object.keys(previousSources)
      .filter((id) => !project.sourceImages[id])
      .map((id) => removeSourceV3(directory, id, previousSources[id], changes)),
    ...Object.entries(project.datasetItems)
      .filter(([id, item]) => item !== previousEditedAssets[id])
      .map(([id, item]) => writeEditedAssetV3(directory, item, previousEditedAssets[id], captions, changes)),
    ...Object.keys(previousEditedAssets)
      .filter((id) => !project.datasetItems[id])
      .map((id) => removeEditedAssetV3(directory, id, previousEditedAssets[id], changes)),
  ]);

  // Keep the save lane occupied until every started writer finishes, even if
  // another failed. A retry must not race an unfinished previous snapshot.
  const failedWrite = assetWrites.find((result) => result.status === 'rejected');
  if (failedWrite?.status === 'rejected') throw failedWrite.reason;

  // The registry is written only after every file was; a failed save leaves the saved state untouched.
  await applyRegistryChanges(directory, changes);
  await writeProjectManifest(directory, project);
};

export const writeProjectDirectoryChanges = async (
  project: ProjectState,
  previousProject: ProjectState | undefined,
  directory: ProjectDirectoryHandle
) => {
  await ensureProjectLayout(directory, project);
  if (await detectProjectLayout(directory) === 'v2') await writeLegacyProjectDirectoryChanges(project, previousProject, directory);
  else await writeV3ProjectDirectoryChanges(project, previousProject, directory);
};

/**
 * Captions come from the TXT next to the image. Only an unmigrated legacy project (read while the layout upgrade
 * runs) still takes them from the sidecar, because the upgrade moves them into TXT files.
 */
type CaptionReadContext = { trigger: string; legacy: boolean };

const readAssetTags = async (
  root: ProjectDirectoryHandle | undefined,
  imagePath: string | undefined,
  sidecarTags: string[] | undefined,
  captions: CaptionReadContext | undefined
): Promise<{ tags: string[] | undefined; captionTriggerMissing?: boolean }> => {
  // Data kept in the pre-v3 payload folder was never converted, so its sidecar stays the caption.
  if (!captions || captions.legacy || !root || !imagePath || imagePath.replace(/^Project\//, '').startsWith(`${PROJECT_DATA_DIRECTORY}/`)) return { tags: sidecarTags };
  const caption = await readCaptionFile(root, imagePath, captions.trigger);
  return { tags: caption.tags, captionTriggerMissing: isTriggerMissing(caption) };
};

const readSource = async (
  directory: ProjectDirectoryHandle,
  root?: ProjectDirectoryHandle,
  paths?: { manifestPath?: string; originalFilePath?: string },
  captions?: CaptionReadContext
): Promise<LegacySource> => {
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
    ...await readAssetTags(root, originalFilePath, manifest.tags, captions),
    hidden: manifest.hidden,
    createdAt: toDate(manifest.createdAt, new Date()),
  };
};

const readEditedAsset = async (
  directory: ProjectDirectoryHandle,
  root?: ProjectDirectoryHandle,
  paths?: { manifestPath?: string; imageDataPath?: string; psdDataPath?: string },
  captions?: CaptionReadContext
): Promise<LegacyEdited> => {
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
    ...await readAssetTags(root, imageDataPath, manifest.tags, captions),
    aspectRatio: manifest.aspectRatio,
    deleted: manifest.deleted,
    deletedAt: manifest.deletedAt ? toDate(manifest.deletedAt, new Date()) : undefined,
    createdAt: toDate(manifest.createdAt, new Date()),
    exportOrder: manifest.exportOrder,
  };
};

// ---------------------------------------------------------------------------------------------------------
// v3 reading: entities come from the asset registry, the files from the paths it holds.
// ---------------------------------------------------------------------------------------------------------

type RegistryReadResult = {
  sources: SourceImage[];
  edited: EditedAsset[];
  /** Records whose dimensions were measured again because the file changed. */
  measured: Map<string, { width: number; height: number }>;
};

const readImageRecord = async (root: ProjectDirectoryHandle, record: AssetRecord, refreshDimensions: boolean) => {
  const blob = await readBlobFileAtPath(root, record.path);
  let { width, height } = record;
  if (refreshDimensions || !width || !height) {
    const measured = await getImageDimensions(blob);
    width = measured.width;
    height = measured.height;
  }
  return { blob, width: width ?? 0, height: height ?? 0 };
};

const readSourceFromRecord = async (
  root: ProjectDirectoryHandle,
  record: AssetRecord,
  captions: CaptionReadContext,
  refreshDimensions: boolean,
  measured: RegistryReadResult['measured']
): Promise<SourceImage> => {
  const { blob, width, height } = await readImageRecord(root, record, refreshDimensions);
  if (width !== record.width || height !== record.height) measured.set(record.id, { width, height });
  return {
    id: record.id,
    fileName: record.fileName,
    originalFileName: record.originalFileName,
    originalFile: blob,
    width,
    height,
    mimeType: record.mimeType || blob.type,
    previewUrl: await getOrCreateProjectPreviewUrl(root, 'source', record.id, blob),
    originalFilePath: record.path,
    ...await readAssetTags(root, record.path, record.legacyTags, captions),
    hidden: record.hidden,
    modifiedAt: record.modifiedAt,
    createdAt: toDate(record.createdAt, new Date()),
  };
};

const readEditedFromRecord = async (
  root: ProjectDirectoryHandle,
  record: AssetRecord,
  captions: CaptionReadContext,
  refreshDimensions: boolean,
  measured: RegistryReadResult['measured']
): Promise<EditedAsset> => {
  const edited = record.edited;
  if (!edited) throw new Error(`Edited asset "${record.id}" has no edit data.`);
  const { blob, width, height } = await readImageRecord(root, record, refreshDimensions);
  if (width !== record.width || height !== record.height) measured.set(record.id, { width, height });
  const psdDataPath = edited.psdPath;
  const psdData = psdDataPath ? await readBlobFileAtPath(root, psdDataPath).catch(() => undefined) : undefined;
  return {
    id: record.id,
    sourceImageId: edited.sourceImageId,
    imageData: blob,
    psdData,
    previewUrl: await getOrCreateProjectPreviewUrl(root, 'edited', record.id, blob),
    imageDataPath: record.path,
    psdDataPath: psdData ? psdDataPath : undefined,
    width,
    height,
    type: edited.type,
    cropFrame: edited.cropFrame,
    augmentationConfig: edited.augmentationConfig,
    cleanupOverlayId: edited.cleanupOverlayId,
    ...await readAssetTags(root, record.path, record.legacyTags, captions),
    aspectRatio: edited.aspectRatio,
    deleted: edited.deleted,
    deletedAt: edited.deletedAt ? toDate(edited.deletedAt, new Date()) : undefined,
    createdAt: toDate(record.createdAt, new Date()),
    exportOrder: edited.exportOrder,
    modifiedAt: record.modifiedAt,
  };
};

/** Preview cache entry of a record (the PSD preview of a plain file is keyed by its Explorer path). */
const removeRecordPreview = (root: ProjectDirectoryHandle, record: AssetRecord) => {
  if (record.role === 'source') return removeProjectPreview(root, 'source', record.id);
  if (record.role === 'edited') return removeProjectPreview(root, 'edited', record.id);
  return record.fileKind === 'psd' ? removeProjectPreview(root, 'psd', `Project/${record.path}`) : Promise.resolve();
};

const readRegistryEntities = async (
  root: ProjectDirectoryHandle,
  records: AssetRecord[],
  captions: CaptionReadContext,
  modifiedIds: Set<string>
): Promise<RegistryReadResult> => {
  const measured: RegistryReadResult['measured'] = new Map();
  const [sources, edited] = await Promise.all([
    Promise.all(records.filter((record) => record.role === 'source' && record.fileKind === 'image').map(async (record) => {
      try { return await readSourceFromRecord(root, record, captions, modifiedIds.has(record.id), measured); } catch { return null; }
    })),
    Promise.all(records.filter((record) => record.role === 'edited' && record.edited).map(async (record) => {
      try { return await readEditedFromRecord(root, record, captions, modifiedIds.has(record.id), measured); } catch { return null; }
    })),
  ]);
  return {
    sources: sources.filter((source): source is SourceImage => Boolean(source)),
    edited: edited.filter((item): item is EditedAsset => Boolean(item)),
    measured,
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

const MAX_LOGGED_REGISTRY_CHANGES = 25;

/**
 * Persists the outcome of the registry reconciliation and reports it. project.json goes first when files were rebound
 * (it holds the moved Build session and Dataset order); assets.json is written last and only when it changed.
 */
const finishRegistryReconcile = async (
  directory: ProjectDirectoryHandle,
  project: ProjectState,
  reconciled: { report: AssetReconcileReport; measured: RegistryReadResult['measured'] },
  options: ReadProjectDirectoryOptions
) => {
  const { report, measured } = reconciled;
  if (report.pathMoves.length) await writeProjectManifest(directory, project);
  const assets = { ...report.registry.assets };
  for (const [id, size] of measured) if (assets[id]) assets[id] = { ...assets[id], ...size };
  const registry = { ...report.registry, assets };
  try {
    await commitAssetRegistry(directory, registry);
  } catch (error) {
    // The project opens from the reconciled registry; the next save retries the write.
    createOperationLogger('Project').warning(`Could not update .datasetcreator/assets.json: ${getErrorMessage(error)}`);
  }
  const logger = createOperationLogger('Project');
  const logLimited = <T,>(items: T[], log: (item: T) => void, summary: (rest: number) => string) => {
    items.slice(0, MAX_LOGGED_REGISTRY_CHANGES).forEach(log);
    if (items.length > MAX_LOGGED_REGISTRY_CHANGES) logger.warning(summary(items.length - MAX_LOGGED_REGISTRY_CHANGES));
  };
  logLimited(report.removed, (record) => logger.warning(`${record.path} is no longer in the project folder; its record was removed.`), (rest) => `${rest} more missing files were removed from the project.`);
  logLimited(report.rebound, (entry) => logger.info(`${entry.from} was moved to ${entry.to} outside the app; the file kept its identity.`), (rest) => `${rest} more moved files were recognised.`);
  logLimited(report.orphaned, (record) => logger.warning(`${record.path} lost its source image and is kept as a plain file.`), (rest) => `${rest} more edited files lost their source image.`);
  if (report.modified.length) logger.info(`${report.modified.length} file${report.modified.length === 1 ? '' : 's'} changed outside the app; cached previews were dropped.`);
  options.onAssetsReconciled?.(report);
};

export type ReadProjectDirectoryOptions = {
  /** Called with what reconciling the asset registry with the folder changed (moves that must reach tabs and the Explorer). */
  onAssetsReconciled?: (report: AssetReconcileReport) => void;
};

export const readProjectDirectory = async (
  directory: ProjectDirectoryHandle,
  selectProjectType?: ProjectTypeResolver,
  readOptions: ReadProjectDirectoryOptions = {}
): Promise<ProjectState> => {
  const layout = await detectProjectLayout(directory);
  // Legacy (v2) projects are read by this same reader only while the layout migration runs; legacy writes go to manifest.json.
  const legacyMode = layout === 'v2';
  const manifestName = PROJECT_DIRECTORY_MANIFEST;
  if (layout === 'none') {
    const projectType = await resolveProjectType(undefined, directory.name, selectProjectType);
    const project = createProject(directory.name, projectType);
    await createProjectDirectory(directory, project);
    return project;
  }
  let manifest: DirectoryProjectManifest;
  // A v3 project whose sidecars have not been folded into assets.json yet is still read through them; the migration runs before it is used.
  let registryReady = false;
  if (layout === 'v3') {
    const json = await readJsonFile<ProjectJsonV3>(
      await getDirectoryAtPath(directory, PROJECT_INTERNAL_DIRECTORY),
      PROJECT_FILE.split('/').pop()!,
      'the project manifest'
    );
    if (json.format !== PROJECT_PROJECT_FORMAT || json.version !== 3) {
      throw new Error('The selected directory is not a supported Dataset Creator project.');
    }
    registryReady = Boolean(json.project?.migrations?.assetsRegistry);
    manifest = projectJsonToManifest(json);
  } else {
    manifest = await readJsonFile<DirectoryProjectManifest>(directory, manifestName, 'the project manifest');
  }
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

  const projectType = normalizeProjectType(manifest.project.projectType);
  const targetModel = resolveTargetModel(manifest.project.targetModel, manifest.project.buildSession?.profile?.minShortSide);
  const defaults = createProject(manifest.project.name, projectType, targetModel);
  const legacyDatasetManifest = await ensureProjectLayout(directory, {
    ...defaults,
    taggingConfig: {
      ...defaults.taggingConfig,
      ...manifest.project.taggingConfig,
    },
  });
  const checkpointExclusionPaths = async (moves: Array<{from:string;to:string}>) => {
    for (const key of ['sourceImageManifests','editedAssetManifests','datasetItemManifests'] as const) {
      const paths = manifest.project[key];
      if (paths) manifest.project[key] = Object.fromEntries(Object.entries(paths).map(([id,path]) => [id,applyProjectRelativePathMoves(path,moves,true)!]));
    }
    await writeTextFile(directory,manifestName,JSON.stringify(manifest,null,2));
  };
  if (legacyMode) await migrateLegacyDatasetExclusions(directory, checkpointExclusionPaths, true);
  const captionContext: CaptionReadContext = {
    trigger: manifest.project.dataset?.triggerWord ?? legacyDatasetManifest?.triggerWord ?? '',
    legacy: legacyMode,
  };
  const datasetSettings = manifest.project.dataset;
  let datasetMigration = manifest.project.datasetMigration;
  let sources: LegacySource[] = [];
  let edited: LegacyEdited[] = [];
  let reconciled: { report: AssetReconcileReport; measured: RegistryReadResult['measured'] } | undefined;
  if (!registryReady) {
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
                return await readSource(await getDirectoryForFilePath(directory, manifestPath), directory, { manifestPath }, captionContext);
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
                return await readEditedAsset(await getDirectoryForFilePath(directory, manifestPath), directory, { manifestPath }, captionContext);
              } catch {
                return null;
              }
            })
          )
        : readOptionalProjectChildren(directory, 'generated', (entry) => readEditedAsset(entry)),
    ]);
    sources = sourceResults
      .filter((source): source is LegacySource => Boolean(source))
      // Explicitly registered sources retain their identity after an Explorer move.
      // Discovery of new sources remains limited to shared in assetIndexService.
      .filter((source) => sourceManifestPaths
        ? !isLegacyProjectRootPath(source.originalFilePath ?? '')
        : isProjectWorkspacePath(source.originalFilePath ?? '', legacyMode ? 'legacy-shared' : 'shared'));
    edited = editedAssetResults.filter((item): item is LegacyEdited => Boolean(item));

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

    if (legacyMode) await migrateLegacyDatasetExclusions(directory, async moves => {
      sources = sources.map(source => ({ ...source,
        originalFilePath: applyProjectRelativePathMoves(source.originalFilePath, moves),
        manifestPath: applyProjectRelativePathMoves(source.manifestPath, moves, true),
      }));
      edited = edited.map(item => ({ ...item,
        imageDataPath: applyProjectRelativePathMoves(item.imageDataPath, moves),
        psdDataPath: applyProjectRelativePathMoves(item.psdDataPath, moves),
        manifestPath: applyProjectRelativePathMoves(item.manifestPath, moves, true),
      }));
      await checkpointExclusionPaths(moves);
    });
  } else {
    // v3 with an asset registry: it says which files are tracked; the folder says what changed since the last session.
    const registry = await loadAssetRegistry(directory);
    const report = await reconcileProjectAssets(directory, registry);
    await Promise.all([...report.modified, ...report.removed].map((record) => removeRecordPreview(directory, record)));
    const registryRead = await readRegistryEntities(
      directory,
      Object.values(report.registry.assets),
      captionContext,
      new Set(report.modified.map((record) => record.id))
    );
    sources = registryRead.sources;
    edited = registryRead.edited;
    reconciled = { report, measured: registryRead.measured };
  }

  // Rebound files moved outside the app: every stored reference follows, like after an Explorer move.
  const explorerMoves: ExplorerPathMove[] = (reconciled?.report.pathMoves ?? []).map((move) => ({ from: `Project/${move.from}`, to: `Project/${move.to}` }));
  const moveStoredPath = (path: string): string => {
    const prefixed = path.startsWith('Project/');
    const moved = applyProjectRelativePathMoves(path, explorerMoves) ?? path;
    return prefixed ? `Project/${moved}` : moved;
  };

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
    characterTraits: normalizeCharacterTraits(manifest.project.characterTraits),
    id: manifest.project.id,
    name: manifest.project.name,
    currentTool,
    sourceImages: Object.fromEntries(sources.map(({ manifestPath: _manifest, ...source }) => [source.id, source as SourceImage])),
    datasetItems: Object.fromEntries(edited.map(({ manifestPath: _manifest, ...item }) => [item.id, item as EditedAsset])),
    dataset: {
      ...defaults.dataset,
      name: datasetSettings?.name || legacyDatasetManifest?.name || defaults.dataset.name,
      triggerWord: datasetSettings?.triggerWord ?? legacyDatasetManifest?.triggerWord ?? defaults.dataset.triggerWord,
      assetOrder: applyFileAssetOrderPathMoves(datasetSettings?.assetOrder ?? legacyDatasetManifest?.assetOrder ?? [], explorerMoves),
      createdAt: datasetSettings?.createdAt ? toDate(datasetSettings.createdAt, defaults.dataset.createdAt) : legacyDatasetManifest?.createdAt ? toDate(legacyDatasetManifest.createdAt, defaults.dataset.createdAt) : defaults.dataset.createdAt,
      updatedAt: datasetSettings?.updatedAt ? toDate(datasetSettings.updatedAt, defaults.dataset.updatedAt) : legacyDatasetManifest ? toDate(legacyDatasetManifest.updatedAt, defaults.dataset.updatedAt) : defaults.dataset.updatedAt,
    },
    taggingConfig: {
      ...defaults.taggingConfig,
      ...manifest.project.taggingConfig,
    },
    workspaceSettings: {
      ...defaults.workspaceSettings,
      ...manifest.project.workspaceSettings,
      ...(explorerMoves.length ? {
        excludedProjectCategories: (manifest.project.workspaceSettings?.excludedProjectCategories ?? defaults.workspaceSettings.excludedProjectCategories ?? []).map(moveStoredPath),
        includedProjectCategories: (manifest.project.workspaceSettings?.includedProjectCategories ?? defaults.workspaceSettings.includedProjectCategories ?? []).map(moveStoredPath),
      } : {}),
    },
    buildSession: applyBuildSessionPathMoves(normalizeBuildSession(manifest.project.buildSession), explorerMoves),
    captionMigration: manifest.project.captionMigration,
    datasetMigration,
    lastModified: toDate(manifest.project.lastModified, new Date()),
    createdAt: toDate(manifest.project.createdAt, new Date()),
  };
  if (legacyMode) {
    const manifests = getLegacyManifests(directory);
    manifests.clear();
    for (const entity of [...sources, ...edited]) if (entity.manifestPath) manifests.set(entity.id, entity.manifestPath);
  }
  if (manifest.version === 1 && datasetMigration?.status === 'complete') {
    await writeTextFile(directory, manifestName, JSON.stringify(getProjectManifest(loadedProject, {
      sourceImageManifests: Object.fromEntries(sources.flatMap((source) => source.manifestPath ? [[source.id, toProjectRelativePath(source.manifestPath)]] : [])),
      editedAssetManifests: Object.fromEntries(edited.flatMap((item) => item.manifestPath ? [[item.id, toProjectRelativePath(item.manifestPath)]] : [])),
    }), null, 2));
    await removeProjectFileAtPath(directory, DATASET_MANIFEST_FILE);
    if (datasetFilePath) await removeProjectFileAtPath(directory, datasetFilePath);
    await removeLegacyDatasetDocuments(directory);
  }
  if (reconciled) await finishRegistryReconcile(directory, loadedProject, reconciled, readOptions);
  const previousMigration = manifest.project.captionMigration;
  const legacyOverrides = previousMigration?.status === 'pending'
    ? Object.fromEntries(Object.entries(previousMigration.legacyOverrides).filter(([key]) => previousMigration.unresolved.includes(key)))
    : legacyDatasetManifest?.captionOverrides ?? {};
  const legacyOverwriteEnabled = previousMigration?.overwriteEnabled ?? legacyDatasetManifest?.overwriteCaptions === true;
  const migrationNeeded = manifest.project.captionMigration?.status !== 'complete' && (legacyOverwriteEnabled || Object.keys(legacyOverrides).length > 0);
  // A v3 project has no legacy caption data; a pending report blocks the layout upgrade instead.
  if (!legacyMode || !migrationNeeded) return loadedProject;
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
