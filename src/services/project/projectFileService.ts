import JSZip from 'jszip';
import { STAGE_URL_SLUGS, URL_STAGE_ALIASES } from '../../lib/constants';
import type {
  BrickColumnCount,
  ProjectState,
  SourceImage,
  StageName,
  SyntheticImage,
  TaggingConfig,
  WorkspaceSettings,
} from '../../types';

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

type LegacySyntheticImageManifest = Omit<SyntheticImage, 'imageData' | 'psdData' | 'createdAt' | 'deletedAt'> & {
  imageDataPath: string;
  psdDataPath?: string;
  createdAt: string;
  deletedAt?: string;
};

type SyntheticImageManifest = {
  id: string;
  sourceImageId: string;
  fileName: string;
  imageDataPath: string;
  psdDataPath?: string;
  width: number;
  height: number;
  tags?: string[];
  aspectRatio: SyntheticImage['aspectRatio'];
  excludedFromDataset?: boolean;
  createdAt: string;
};

type ProjectFileTaggingConfig = Omit<TaggingConfig, 'autoTaggingEndpoint'>;

type ProjectFileWorkspaceSettings = WorkspaceSettings;

type ProjectFileManifest = {
  format: 'dataset-creator-project';
  version: 1 | 2 | 3 | 4;
  project: {
    id: string;
    name: string;
    currentTool?: string;
    currentStage?: StageName;
    taggingConfig: ProjectFileTaggingConfig;
    workspaceSettings?: ProjectFileWorkspaceSettings;
    sourceImages?: Record<string, LegacySourceImageManifest>;
    datasetItems?: Record<string, LegacySyntheticImageManifest>;
    sourceImageManifests?: Record<string, string>;
    syntheticImageManifests?: Record<string, string>;
    datasetItemManifests?: Record<string, string>;
    cleanupOverlays?: {};
    stageState?: Record<string, unknown>;
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

const createEmptyStageState = (): ProjectState['stageState'] => ({
  hub: {},
  import: {},
  select: {},
  clean: {},
  analysis: {},
  review: {},
  tagging: {},
  export: {},
});

const getToolSlug = (stage: StageName): string => STAGE_URL_SLUGS[stage] ?? stage;

const getStageFromToolSlug = (tool?: string, fallback: StageName = 'hub'): StageName =>
  ((tool ? URL_STAGE_ALIASES[tool] : undefined) ?? fallback) as StageName;

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
  const syntheticImageManifests: Record<string, string> = {};
  const exportedAt = new Date();

  for (const source of Object.values(project.sourceImages)) {
    const originalFilePath = `sources/${source.id}/original`;
    const manifestPath = `sources/${source.id}/manifest.json`;
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
    const imageDataPath = `synthetic/${item.id}/image.png`;
    const psdDataPath = item.psdData ? `synthetic/${item.id}/image.psd` : undefined;
    const manifestPath = `synthetic/${item.id}/manifest.json`;
    zip.file(imageDataPath, item.imageData);
    if (item.psdData && psdDataPath) {
      zip.file(psdDataPath, item.psdData);
    }

    const itemManifest: SyntheticImageManifest = {
      id: item.id,
      sourceImageId: item.sourceImageId,
      fileName: `${item.id}.png`,
      imageDataPath,
      psdDataPath,
      width: item.width,
      height: item.height,
      tags: item.tags,
      aspectRatio: item.aspectRatio,
      excludedFromDataset: item.excludedFromDataset,
      createdAt: toIsoString(item.createdAt, exportedAt),
    };
    syntheticImageManifests[item.id] = manifestPath;
    zip.file(manifestPath, JSON.stringify(itemManifest, null, 2));
  }

  const manifest: ProjectFileManifest = {
    format: 'dataset-creator-project',
    version: 4,
    project: {
      id: project.id,
      name: project.name,
      currentTool: getToolSlug(project.currentStage),
      sourceImageManifests,
      syntheticImageManifests,
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

  const sourceManifests = manifest.project.sourceImageManifests
    ? await Promise.all(
        Object.values(manifest.project.sourceImageManifests).map((path) =>
          readJsonFile<SourceImageManifest | LegacySourceImageManifest>(zip, path)
        )
      )
    : Object.values(manifest.project.sourceImages ?? {});
  const syntheticManifestPaths = manifest.project.syntheticImageManifests ?? manifest.project.datasetItemManifests;
  const syntheticManifests = syntheticManifestPaths
    ? await Promise.all(
        Object.values(syntheticManifestPaths).map((path) =>
          readJsonFile<SyntheticImageManifest | LegacySyntheticImageManifest>(zip, path)
        )
      )
    : Object.values(manifest.project.datasetItems ?? {});

  const sourceImages: Record<string, SourceImage> = {};
  for (const source of sourceManifests) {
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

  const datasetItems: Record<string, SyntheticImage> = {};
  for (const item of syntheticManifests) {
    if ('deleted' in item && item.deleted) {
      continue;
    }

    const imageDataBuffer = await zip.file(item.imageDataPath)?.async('arraybuffer');
    if (!imageDataBuffer) {
      throw new Error(`Project file is missing Synthetic data for ${item.id}`);
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
      createdAt: new Date(item.createdAt),
      deletedAt: deletedAt ? new Date(deletedAt) : undefined,
    };
  }

  const {
    sourceImages: _sourceImageManifests,
    datasetItems: _datasetItemManifests,
    sourceImageManifests: _sourceImageManifestPaths,
    syntheticImageManifests: _syntheticImageManifestPaths,
    datasetItemManifests: _datasetItemManifestPaths,
    cleanupOverlays: _cleanupOverlays,
    lastModified,
    createdAt,
    stageState,
    currentTool,
    currentStage,
    taggingConfig,
    workspaceSettings,
    ...projectMetadata
  } = manifest.project;
  const loadedStageState = stageState as Partial<Record<string, unknown>>;
  const restoredCurrentStage = getStageFromToolSlug(currentTool, currentStage ?? 'hub');

  return {
    ...projectMetadata,
    sourceImages,
    datasetItems,
    cleanupOverlays: {},
    currentStage: restoredCurrentStage,
    stageState: {
      ...createEmptyStageState(),
      hub: loadedStageState?.hub ?? {},
      import: loadedStageState?.import ?? {},
      select: loadedStageState?.select ?? {},
      clean: loadedStageState?.clean ?? {},
      analysis: loadedStageState?.analysis ?? {},
      review: loadedStageState?.review ?? {},
      tagging: loadedStageState?.tagging ?? {},
      export: loadedStageState?.export ?? {},
    },
    taggingConfig: deserializeTaggingConfig(taggingConfig),
    workspaceSettings: deserializeWorkspaceSettings(workspaceSettings),
    lastModified: new Date(lastModified),
    createdAt: new Date(createdAt),
  };
};
