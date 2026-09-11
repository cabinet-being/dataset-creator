import JSZip from 'jszip';
import { TOOL_URL_SLUGS, URL_TOOL_ALIASES } from '../../lib/constants';
import type {
  BrickColumnCount,
  ProjectState,
  SourceImage,
  ToolName,
  EditedAsset,
  TaggingConfig,
  WorkspaceSettings,
} from '../../types';
import { getAssetManifestName, PROJECT_MANIFEST_NAME } from './assetManifestService';
import { isLegacyProjectRootPath } from './projectPathFilters';

export const PROJECT_FILE_EXTENSION = 'dcproj';
export const PROJECT_FILE_MIME_TYPE = 'application/vnd.dataset-creator.project';
export const PROJECT_FILE_DESCRIPTION = 'Dataset Creator Project';

type ProjectFileWritable = {
  write: (data: Blob) => Promise<void> | void;
  close: () => Promise<void> | void;
};

export type ProjectFileHandle = {
  name?: string;
  getFile?: () => Promise<File>;
  createWritable: () => Promise<ProjectFileWritable>;
};

type LegacySourceImageManifest = Omit<
  SourceImage,
  'originalFile' | 'previewUrl' | 'thumbnail' | 'embedding' | 'createdAt'
> & {
  originalFilePath: string;
  thumbnailPath?: string;
  embedding?: number[];
  createdAt: string;
};

type SourceImageManifest = {
  id: string;
  fileName: string;
  originalFileName?: string;
  width: number;
  height: number;
  mimeType: string;
  originalFilePath: string;
  tags?: string[];
  removedFromWorkspace?: boolean;
  excludedFromDataset?: boolean;
  createdAt: string;
};

type LegacyEditedAssetManifest = Omit<EditedAsset, 'imageData' | 'psdData' | 'createdAt' | 'deletedAt'> & {
  imageDataPath: string;
  psdDataPath?: string;
  createdAt: string;
  deletedAt?: string;
};

type EditedAssetManifest = {
  id: string;
  sourceImageId: string;
  fileName: string;
  imageDataPath: string;
  psdDataPath?: string;
  width: number;
  height: number;
  tags?: string[];
  aspectRatio: EditedAsset['aspectRatio'];
  excludedFromDataset?: boolean;
  createdAt: string;
};

type ProjectFileTaggingConfig = Omit<TaggingConfig, 'autoTaggingEndpoint'>;

type ProjectFileWorkspaceSettings = WorkspaceSettings;

type DatasetManifest = {
  id: string;
  name: string;
  parentPath?: string;
  triggerWord: string;
  assetIds: string[];
  assetPaths?: string[];
  assetOrder?: string[];
  createdAt: string;
  updatedAt: string;
};

type ProjectFileManifest = {
  format: 'dataset-creator-project';
  version: 1 | 2 | 3 | 4;
  project: {
    id: string;
    name: string;
    currentTool?: string;
    taggingConfig: ProjectFileTaggingConfig;
    workspaceSettings?: ProjectFileWorkspaceSettings;
    datasets?: Record<string, DatasetManifest>;
    sourceImages?: Record<string, LegacySourceImageManifest>;
    datasetItems?: Record<string, LegacyEditedAssetManifest>;
    sourceImageManifests?: Record<string, string>;
    editedAssetManifests?: Record<string, string>;
    datasetItemManifests?: Record<string, string>;
    cleanupOverlays?: {};
    toolState?: Record<string, unknown>;
    lastModified: string;
    createdAt: string;
  };
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const sanitizeFilename = (name: string) =>
  name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

const getPathParts = (path: string): string[] => path.split('/').filter(Boolean);

const getParentPath = (path: string): string => getPathParts(path).slice(0, -1).join('/');

const joinPath = (...parts: string[]): string => parts.flatMap(getPathParts).join('/');

const getProjectDataFileExtension = (fileName: string, mimeType: string): string => {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension && extension !== fileName.toLowerCase()) {
    return extension.replace(/[^a-z0-9]/g, '') || 'bin';
  }

  return mimeType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
};

const getDefaultSourceManifestPath = (source: SourceImage): string =>
  `.dataset-creator-data/source-images/${source.id}/${getAssetManifestName(
    `original.${getProjectDataFileExtension(source.fileName, source.mimeType)}`
  )}`;

const getDefaultEditedAssetManifestPath = (item: EditedAsset): string =>
  `.dataset-creator-data/generated-images/${item.id}/${getAssetManifestName('image.png')}`;

const getReusableProjectPath = (path: string | undefined): string | undefined => {
  if (!path) {
    return undefined;
  }

  const relativePath = path.replace(/^Project\//, '');
  return isLegacyProjectRootPath(relativePath) ? undefined : relativePath;
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
  return getPathParts(reusablePath).slice(-1)[0] === PROJECT_MANIFEST_NAME
    ? joinPath(getParentPath(reusablePath), getAssetManifestName(assetFileName))
    : reusablePath;
};

const toIsoString = (value: Date | string | number | undefined, fallback = new Date()): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
  }

  return fallback.toISOString();
};

const createEmptyToolState = (): ProjectState['toolState'] => ({
  hub: {},
  import: {},
  select: {},
  clean: {},
  analysis: {},
  review: {},
  tagging: {},
  export: {},
});

const getToolSlug = (tool: ToolName): string => TOOL_URL_SLUGS[tool] ?? tool;

const isToolName = (value: string): value is ToolName =>
  Object.prototype.hasOwnProperty.call(TOOL_URL_SLUGS, value);

const getToolFromSlug = (tool?: string, fallback: ToolName = 'hub'): ToolName =>
  ((tool ? URL_TOOL_ALIASES[tool] : undefined) ?? fallback) as ToolName;

const serializeTaggingConfig = (taggingConfig: TaggingConfig): ProjectFileTaggingConfig => {
  const { autoTaggingEndpoint: _autoTaggingEndpoint, ...serializableConfig } = taggingConfig;
  return serializableConfig;
};

const deserializeTaggingConfig = (
  taggingConfig: ProjectFileManifest['project']['taggingConfig']
): TaggingConfig => ({
  datasetKeyword: taggingConfig.datasetKeyword,
  threshold: taggingConfig.threshold,
  maxTags: taggingConfig.maxTags,
  insertMode: taggingConfig.insertMode,
  blacklist: taggingConfig.blacklist,
});

const isBrickColumnCount = (value: unknown): value is BrickColumnCount =>
  value === 'auto' || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;

const deserializeWorkspaceSettings = (
  workspaceSettings: ProjectFileManifest['project']['workspaceSettings']
): WorkspaceSettings => ({
  brickColumnCount: isBrickColumnCount(workspaceSettings?.brickColumnCount)
    ? workspaceSettings.brickColumnCount
    : 'auto',
  localTaggerModelPath:
    typeof workspaceSettings?.localTaggerModelPath === 'string'
      ? workspaceSettings.localTaggerModelPath
      : undefined,
  localTaggerTagsPath:
    typeof workspaceSettings?.localTaggerTagsPath === 'string'
      ? workspaceSettings.localTaggerTagsPath
      : undefined,
});

const readJsonFile = async <T>(zip: JSZip, path: string): Promise<T> => {
  const file = zip.file(path);
  if (!file) {
    throw new Error(`Project file is missing ${path}`);
  }

  return JSON.parse(await file.async('string')) as T;
};

export const createProjectFileBlob = async (project: ProjectState): Promise<Blob> => {
  const zip = new JSZip();
  const sourceImageManifests: Record<string, string> = {};
  const editedAssetManifests: Record<string, string> = {};
  const exportedAt = new Date();

  for (const source of Object.values(project.sourceImages)) {
    const originalFileNameOnDisk = `original.${getProjectDataFileExtension(source.fileName, source.mimeType)}`;
    const manifestPath = getNormalizedAssetManifestPath(
      source.manifestPath,
      originalFileNameOnDisk,
      getDefaultSourceManifestPath(source)
    );
    const originalFilePath =
      source.originalFilePath ??
      joinPath(getParentPath(manifestPath), originalFileNameOnDisk);
    zip.file(originalFilePath, source.originalFile);

    const sourceManifest: SourceImageManifest = {
      id: source.id,
      fileName: source.fileName,
      originalFileName: source.originalFileName,
      width: source.width,
      height: source.height,
      mimeType: source.mimeType,
      originalFilePath,
      tags: source.tags,
      removedFromWorkspace: source.hidden,
      excludedFromDataset: source.excludedFromDataset,
      createdAt: toIsoString(source.createdAt, exportedAt),
    };
    sourceImageManifests[source.id] = manifestPath;
    zip.file(manifestPath, JSON.stringify(sourceManifest, null, 2));
  }

  for (const item of Object.values(project.datasetItems).filter((entry) => !entry.deleted)) {
    const manifestPath = getNormalizedAssetManifestPath(item.manifestPath, 'image.png', getDefaultEditedAssetManifestPath(item));
    const imageDataPath = getReusableProjectPath(item.imageDataPath) ?? joinPath(getParentPath(manifestPath), 'image.png');
    const psdDataPath = item.psdData
      ? getReusableProjectPath(item.psdDataPath) ?? joinPath(getParentPath(manifestPath), 'image.psd')
      : undefined;
    zip.file(imageDataPath, item.imageData);
    if (item.psdData && psdDataPath) {
      zip.file(psdDataPath, item.psdData);
    }

    const itemManifest: EditedAssetManifest = {
      id: item.id,
      sourceImageId: item.sourceImageId,
      fileName: imageDataPath.split('/').pop() ?? `${item.id}.png`,
      imageDataPath,
      psdDataPath,
      width: item.width,
      height: item.height,
      tags: item.tags,
      aspectRatio: item.aspectRatio,
      excludedFromDataset: item.excludedFromDataset,
      createdAt: toIsoString(item.createdAt, exportedAt),
    };
    editedAssetManifests[item.id] = manifestPath;
    zip.file(manifestPath, JSON.stringify(itemManifest, null, 2));
  }

  const manifest: ProjectFileManifest = {
    format: 'dataset-creator-project',
    version: 4,
    project: {
      id: project.id,
      name: project.name,
      currentTool: getToolSlug(project.currentTool),
      sourceImageManifests,
      editedAssetManifests,
      taggingConfig: serializeTaggingConfig(project.taggingConfig),
      workspaceSettings: project.workspaceSettings,
      lastModified: toIsoString(project.lastModified, exportedAt),
      createdAt: toIsoString(project.createdAt, exportedAt),
    },
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: 'blob', mimeType: PROJECT_FILE_MIME_TYPE });
};

export const downloadProjectFile = async (project: ProjectState) => {
  const blob = await createProjectFileBlob(project);
  downloadBlob(blob, `${sanitizeFilename(project.name)}.${PROJECT_FILE_EXTENSION}`);
};

export const writeProjectFileToHandle = async (
  project: ProjectState,
  handle: ProjectFileHandle
): Promise<void> => {
  const blob = await createProjectFileBlob(project);
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
};

export const pickProjectFileForOpen = async (): Promise<{
  file: File;
  handle?: ProjectFileHandle;
} | null> => {
  if (!('showOpenFilePicker' in window)) {
    return null;
  }

  const [handle] = await (window as any).showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: PROJECT_FILE_DESCRIPTION,
        accept: {
          [PROJECT_FILE_MIME_TYPE]: [`.${PROJECT_FILE_EXTENSION}`],
        },
      },
    ],
  });

  if (!handle) {
    return null;
  }

  return {
    file: await handle.getFile(),
    handle: handle as ProjectFileHandle,
  };
};

export const pickProjectFileForSave = async (
  projectName: string
): Promise<ProjectFileHandle | null> => {
  if (!('showSaveFilePicker' in window)) {
    return null;
  }

  return (window as any).showSaveFilePicker({
    suggestedName: `${sanitizeFilename(projectName)}.${PROJECT_FILE_EXTENSION}`,
    types: [
      {
        description: PROJECT_FILE_DESCRIPTION,
        accept: {
          [PROJECT_FILE_MIME_TYPE]: [`.${PROJECT_FILE_EXTENSION}`],
        },
      },
    ],
  }) as Promise<ProjectFileHandle>;
};

export const readProjectFile = async (file: File): Promise<ProjectState> => {
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid project file: missing manifest');
  }

  const manifest = JSON.parse(await manifestFile.async('string')) as ProjectFileManifest;
  if (manifest.format !== 'dataset-creator-project' || ![1, 2, 3, 4].includes(manifest.version)) {
    throw new Error('Unsupported project file');
  }

  const sourceManifestEntries: Array<{
    manifestPath?: string;
    manifest: SourceImageManifest | LegacySourceImageManifest;
  }> = manifest.project.sourceImageManifests
    ? await Promise.all(
        Object.values(manifest.project.sourceImageManifests).map(
          async (path) => ({
            manifestPath: path,
            manifest: await readJsonFile<SourceImageManifest | LegacySourceImageManifest>(zip, path),
          })
        )
      )
    : Object.values(manifest.project.sourceImages ?? {}).map((source) => ({ manifest: source }));
  const legacyEditedAssetManifestPaths = (manifest.project as Record<string, unknown>)[
    `syn${'thetic'}ImageManifests`
  ] as Record<string, string> | undefined;
  const editedAssetManifestPaths =
    manifest.project.editedAssetManifests ?? legacyEditedAssetManifestPaths ?? manifest.project.datasetItemManifests;
  const supportedEditedAssetManifestPaths = editedAssetManifestPaths
    ? Object.values(editedAssetManifestPaths).filter((manifestPath) => !isLegacyProjectRootPath(manifestPath))
    : undefined;
  const editedAssetManifestEntries: Array<{
    manifestPath?: string;
    manifest: EditedAssetManifest | LegacyEditedAssetManifest;
  }> = supportedEditedAssetManifestPaths
    ? await Promise.all(
        supportedEditedAssetManifestPaths.map(
          async (path) => ({
            manifestPath: path,
            manifest: await readJsonFile<EditedAssetManifest | LegacyEditedAssetManifest>(zip, path),
          })
        )
      )
    : Object.values(manifest.project.datasetItems ?? {}).map((item) => ({ manifest: item }));

  const sourceImages: Record<string, SourceImage> = {};
  for (const { manifestPath, manifest: source } of sourceManifestEntries) {
    const originalFileBuffer = await zip.file(source.originalFilePath)?.async('arraybuffer');
    if (!originalFileBuffer) {
      throw new Error(`Project file is missing Source data for ${source.id}`);
    }

    const originalFile = new Blob([originalFileBuffer], { type: source.mimeType });
    const thumbnailPath = 'thumbnailPath' in source ? source.thumbnailPath : undefined;
    const sourceEmbedding = 'embedding' in source ? source.embedding : undefined;
    const sourceHidden =
      'removedFromWorkspace' in source
        ? source.removedFromWorkspace
        : 'hidden' in source
          ? source.hidden
          : undefined;
    const thumbnailBuffer = thumbnailPath
      ? await zip.file(thumbnailPath)?.async('arraybuffer')
      : undefined;
    const thumbnail = thumbnailBuffer ? new Blob([thumbnailBuffer], { type: 'image/jpeg' }) : undefined;

    sourceImages[source.id] = {
      id: source.id,
      fileName: source.fileName,
      originalFileName: source.originalFileName,
      width: source.width,
      height: source.height,
      mimeType: source.mimeType,
      originalFilePath: source.originalFilePath,
      manifestPath,
      tags: source.tags,
      hidden: sourceHidden,
      excludedFromDataset: source.excludedFromDataset,
      originalFile,
      thumbnail,
      embedding: sourceEmbedding ? new Float32Array(sourceEmbedding) : undefined,
      previewUrl: URL.createObjectURL(originalFile),
      createdAt: new Date(source.createdAt),
    };
  }

  const datasetItems: Record<string, EditedAsset> = {};
  for (const { manifestPath, manifest: item } of editedAssetManifestEntries) {
    if ('deleted' in item && item.deleted) {
      continue;
    }

    const imageDataBuffer = await zip.file(item.imageDataPath)?.async('arraybuffer');
    if (!imageDataBuffer) {
      throw new Error(`Project file is missing edited asset data for ${item.id}`);
    }

    const imageData = new Blob([imageDataBuffer], { type: 'image/png' });
    const psdDataBuffer = item.psdDataPath ? await zip.file(item.psdDataPath)?.async('arraybuffer') : undefined;
    const psdData = psdDataBuffer
      ? new Blob([psdDataBuffer], { type: 'image/vnd.adobe.photoshop' })
      : undefined;
    const deletedAt = 'deletedAt' in item ? item.deletedAt : undefined;

    datasetItems[item.id] = {
      id: item.id,
      sourceImageId: item.sourceImageId,
      width: item.width,
      height: item.height,
      type: 'type' in item ? item.type : 'cleaned',
      cropFrame: 'cropFrame' in item ? item.cropFrame : undefined,
      augmentationConfig: 'augmentationConfig' in item ? item.augmentationConfig : undefined,
      cleanupOverlayId: 'cleanupOverlayId' in item ? item.cleanupOverlayId : undefined,
      tags: item.tags,
      aspectRatio: item.aspectRatio,
      deleted: false,
      excludedFromDataset: item.excludedFromDataset,
      exportOrder: 'exportOrder' in item ? item.exportOrder : undefined,
      imageData,
      psdData,
      imageDataPath: item.imageDataPath,
      psdDataPath: item.psdDataPath,
      manifestPath,
      createdAt: new Date(item.createdAt),
      deletedAt: deletedAt ? new Date(deletedAt) : undefined,
    };
  }

  const {
    sourceImages: _sourceImageManifests,
    datasetItems: _datasetItemManifests,
    sourceImageManifests: _sourceImageManifestPaths,
    editedAssetManifests: _editedAssetManifestPaths,
    datasetItemManifests: _datasetItemManifestPaths,
    datasets,
    cleanupOverlays: _cleanupOverlays,
    lastModified,
    createdAt,
    currentTool,
    taggingConfig,
    workspaceSettings,
    ...projectMetadata
  } = manifest.project;
  const projectRecord = manifest.project as Record<string, unknown>;
  const legacyToolState = projectRecord[`sta${'ge'}State`];
  const legacyCurrentTool = projectRecord[`currentSta${'ge'}`];
  const loadedToolState = (manifest.project.toolState ?? legacyToolState) as Partial<Record<string, unknown>>;
  const restoredCurrentTool = getToolFromSlug(
    currentTool,
    typeof legacyCurrentTool === 'string' && isToolName(legacyCurrentTool) ? legacyCurrentTool : 'hub'
  );

  return {
    ...projectMetadata,
    sourceImages,
    datasetItems,
    datasets: {},
    cleanupOverlays: {},
    currentTool: restoredCurrentTool,
    toolState: {
      ...createEmptyToolState(),
      hub: loadedToolState?.hub ?? {},
      import: loadedToolState?.import ?? {},
      select: loadedToolState?.select ?? {},
      clean: loadedToolState?.clean ?? {},
      analysis: loadedToolState?.analysis ?? {},
      review: loadedToolState?.review ?? {},
      tagging: loadedToolState?.tagging ?? {},
      export: loadedToolState?.export ?? {},
    },
    taggingConfig: deserializeTaggingConfig(taggingConfig),
    workspaceSettings: deserializeWorkspaceSettings(workspaceSettings),
    lastModified: new Date(lastModified),
    createdAt: new Date(createdAt),
  };
};
