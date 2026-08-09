import { STAGE_URL_SLUGS, URL_STAGE_ALIASES } from '../../lib/constants';
import {
  createProject,
  type ProjectState,
  type SourceImage,
  type StageName,
  type SyntheticImage,
  type TaggingConfig,
  type WorkspaceSettings,
} from '../../types';

export const PROJECT_DIRECTORY_MANIFEST = 'manifest.json';
export const PROJECT_DIRECTORY_FORMAT = 'dataset-creator-directory';
export const PROJECT_DIRECTORY_DESCRIPTION = 'Dataset Creator project directory';

export type ProjectDirectoryWritable = {
  write: (data: Blob | string) => Promise<void> | void;
  close: () => Promise<void> | void;
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
  version: 1;
  project: {
    id: string;
    name: string;
    currentStage: StageName;
    taggingConfig: Omit<TaggingConfig, 'autoTaggingEndpoint'>;
    workspaceSettings: WorkspaceSettings;
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
  originalFileNameOnDisk: string;
  tags?: string[];
  hidden?: boolean;
  excludedFromDataset?: boolean;
  createdAt: string;
};

type SyntheticManifest = {
  id: string;
  sourceImageId: string;
  imageFileName: string;
  psdFileName?: string;
  width: number;
  height: number;
  type: SyntheticImage['type'];
  cropFrame?: SyntheticImage['cropFrame'];
  augmentationConfig?: SyntheticImage['augmentationConfig'];
  cleanupOverlayId?: string;
  tags?: string[];
  aspectRatio: SyntheticImage['aspectRatio'];
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

const getExistingManifestName = async (directory: ProjectDirectoryHandle): Promise<string> => {
  try {
    await getProjectFile(directory, PROJECT_DIRECTORY_MANIFEST);
    return PROJECT_DIRECTORY_MANIFEST;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new Error(`Unable to access the project manifest: ${getErrorMessage(error)}`);
    }
    throw new Error(
      'The selected directory does not contain a supported Dataset Creator project.'
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

const readTextFile = async (directory: ProjectDirectoryHandle, name: string): Promise<string> =>
  (await (await getProjectFile(directory, name)).getFile()).text();

const readBlobFile = async (directory: ProjectDirectoryHandle, name: string): Promise<Blob> =>
  (await getProjectFile(directory, name)).getFile();

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

const getStageFromSlug = (value: string | undefined): StageName =>
  ((value ? URL_STAGE_ALIASES[value] : undefined) ?? 'hub') as StageName;

const serializeSourceManifest = (source: SourceImage, originalFileNameOnDisk: string): SourceManifest => ({
  id: source.id,
  fileName: source.fileName,
  originalFileName: source.originalFileName,
  width: source.width,
  height: source.height,
  mimeType: source.mimeType,
  originalFileNameOnDisk,
  tags: source.tags,
  hidden: source.hidden,
  excludedFromDataset: source.excludedFromDataset,
  createdAt: toIsoString(source.createdAt),
});

const serializeSyntheticManifest = (item: SyntheticImage, imageFileName: string, psdFileName?: string): SyntheticManifest => ({
  id: item.id,
  sourceImageId: item.sourceImageId,
  imageFileName,
  psdFileName,
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

const getProjectManifest = (project: ProjectState): DirectoryProjectManifest => ({
  format: PROJECT_DIRECTORY_FORMAT,
  version: 1,
  project: {
    id: project.id,
    name: project.name,
    currentStage: getStageFromSlug(STAGE_URL_SLUGS[project.currentStage]),
    taggingConfig: {
      datasetKeyword: project.taggingConfig.datasetKeyword,
      threshold: project.taggingConfig.threshold,
      maxTags: project.taggingConfig.maxTags,
      insertMode: project.taggingConfig.insertMode,
      blacklist: project.taggingConfig.blacklist,
    },
    workspaceSettings: project.workspaceSettings,
    lastModified: toIsoString(project.lastModified),
    createdAt: toIsoString(project.createdAt),
  },
});

const writeSource = async (sourcesDirectory: ProjectDirectoryHandle, source: SourceImage) => {
  const sourceDirectory = await getChildDirectory(sourcesDirectory, source.id, true);
  const originalFileNameOnDisk = `original.${getFileExtension(source.fileName, source.mimeType)}`;
  await writeBlobFile(sourceDirectory, originalFileNameOnDisk, source.originalFile);
  await writeTextFile(
    sourceDirectory,
    'manifest.json',
    JSON.stringify(serializeSourceManifest(source, originalFileNameOnDisk), null, 2)
  );
};

const writeSourceChanges = async (
  sourcesDirectory: ProjectDirectoryHandle,
  source: SourceImage,
  previousSource?: SourceImage
) => {
  const sourceDirectory = await getChildDirectory(sourcesDirectory, source.id, true);
  const originalFileNameOnDisk = `original.${getFileExtension(source.fileName, source.mimeType)}`;
  if (!previousSource || source.originalFile !== previousSource.originalFile) {
    await writeBlobFile(sourceDirectory, originalFileNameOnDisk, source.originalFile);
  }
  await writeTextFile(
    sourceDirectory,
    'manifest.json',
    JSON.stringify(serializeSourceManifest(source, originalFileNameOnDisk), null, 2)
  );
};

const writeSynthetic = async (syntheticDirectory: ProjectDirectoryHandle, item: SyntheticImage) => {
  const itemDirectory = await getChildDirectory(syntheticDirectory, item.id, true);
  const imageFileName = 'image.png';
  const psdFileName = item.psdData ? 'image.psd' : undefined;
  await writeBlobFile(itemDirectory, imageFileName, item.imageData);
  if (item.psdData && psdFileName) {
    await writeBlobFile(itemDirectory, psdFileName, item.psdData);
  } else {
    try {
      await itemDirectory.removeEntry('image.psd');
    } catch {
      // The PSD is optional and may not exist yet.
    }
  }
  await writeTextFile(
    itemDirectory,
    'manifest.json',
    JSON.stringify(serializeSyntheticManifest(item, imageFileName, psdFileName), null, 2)
  );
};

const writeSyntheticChanges = async (
  syntheticDirectory: ProjectDirectoryHandle,
  item: SyntheticImage,
  previousItem?: SyntheticImage
) => {
  const itemDirectory = await getChildDirectory(syntheticDirectory, item.id, true);
  const imageFileName = 'image.png';
  const psdFileName = item.psdData ? 'image.psd' : undefined;
  if (!previousItem || item.imageData !== previousItem.imageData) {
    await writeBlobFile(itemDirectory, imageFileName, item.imageData);
  }
  if (item.psdData && (!previousItem || item.psdData !== previousItem.psdData)) {
    await writeBlobFile(itemDirectory, 'image.psd', item.psdData);
  } else if (!item.psdData && previousItem?.psdData) {
    try {
      await itemDirectory.removeEntry('image.psd');
    } catch {
      // The PSD may already be absent.
    }
  }
  await writeTextFile(
    itemDirectory,
    'manifest.json',
    JSON.stringify(serializeSyntheticManifest(item, imageFileName, psdFileName), null, 2)
  );
};

const removeProjectEntry = async (directory: ProjectDirectoryHandle, id: string) => {
  try {
    await directory.removeEntry(id, { recursive: true });
  } catch {
    // The entry may already be absent after a partial save.
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
  await writeTextFile(directory, PROJECT_DIRECTORY_MANIFEST, JSON.stringify(getProjectManifest(project), null, 2));
  const sourcesDirectory = await getChildDirectory(directory, 'sources', true);
  const syntheticDirectory = await getChildDirectory(directory, 'synthetic', true);

  await Promise.all([
    ...Object.values(project.sourceImages).map((source) => writeSource(sourcesDirectory, source)),
    ...Object.values(project.datasetItems).map((item) => writeSynthetic(syntheticDirectory, item)),
  ]);
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
    ['sources', 'synthetic', PROJECT_DIRECTORY_MANIFEST].map(async (entry) => {
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
  const metadataChanged =
    !previousProject ||
    project.id !== previousProject.id ||
    project.name !== previousProject.name ||
    project.currentStage !== previousProject.currentStage ||
    project.taggingConfig !== previousProject.taggingConfig ||
    project.workspaceSettings !== previousProject.workspaceSettings ||
    project.lastModified !== previousProject.lastModified;

  if (metadataChanged) {
    await writeTextFile(directory, PROJECT_DIRECTORY_MANIFEST, JSON.stringify(getProjectManifest(project), null, 2));
  }

  const sourcesDirectory = await getChildDirectory(directory, 'sources', true);
  const syntheticDirectory = await getChildDirectory(directory, 'synthetic', true);
  const previousSources = previousProject?.sourceImages ?? {};
  const previousSynthetic = previousProject?.datasetItems ?? {};

  await Promise.all([
    ...Object.entries(project.sourceImages)
      .filter(([id, source]) => source !== previousSources[id])
      .map(([id, source]) => writeSourceChanges(sourcesDirectory, source, previousSources[id])),
    ...Object.keys(previousSources)
      .filter((id) => !project.sourceImages[id])
      .map((id) => removeProjectEntry(sourcesDirectory, id)),
    ...Object.entries(project.datasetItems)
      .filter(([id, item]) => item !== previousSynthetic[id])
      .map(([id, item]) => writeSyntheticChanges(syntheticDirectory, item, previousSynthetic[id])),
    ...Object.keys(previousSynthetic)
      .filter((id) => !project.datasetItems[id])
      .map((id) => removeProjectEntry(syntheticDirectory, id)),
  ]);
};

const readSource = async (directory: ProjectDirectoryHandle): Promise<SourceImage> => {
  const manifest = await readJsonFile<SourceManifest>(
    directory,
    'manifest.json',
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
  try {
    originalFile = await readBlobFile(directory, manifest.originalFileNameOnDisk);
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
    tags: manifest.tags,
    hidden: manifest.hidden,
    excludedFromDataset: manifest.excludedFromDataset,
    createdAt: toDate(manifest.createdAt, new Date()),
  };
};

const readSynthetic = async (directory: ProjectDirectoryHandle): Promise<SyntheticImage> => {
  const manifest = await readJsonFile<SyntheticManifest>(
    directory,
    'manifest.json',
    `synthetic manifest in "${directory.name}"`
  );
  if (!manifest.id || !manifest.sourceImageId || !manifest.imageFileName) {
    throw new Error(`Synthetic manifest in "${directory.name}" is missing required fields.`);
  }

  let imageData: Blob;
  try {
    imageData = await readBlobFile(directory, manifest.imageFileName);
  } catch (error) {
    throw new Error(
      `Unable to read synthetic image "${manifest.imageFileName}": ${getErrorMessage(error)}`
    );
  }

  let psdData: Blob | undefined;
  if (manifest.psdFileName) {
    try {
      psdData = await readBlobFile(directory, manifest.psdFileName);
    } catch (error) {
      throw new Error(
        `Unable to read synthetic PSD "${manifest.psdFileName}": ${getErrorMessage(error)}`
      );
    }
  }

  return {
    id: manifest.id,
    sourceImageId: manifest.sourceImageId,
    imageData,
    psdData,
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

export const readProjectDirectory = async (
  directory: ProjectDirectoryHandle
): Promise<ProjectState> => {
  const manifestName = await getExistingManifestName(directory);
  const manifest = await readJsonFile<DirectoryProjectManifest>(
    directory,
    manifestName,
    'the project manifest'
  );
  if (manifest.format !== PROJECT_DIRECTORY_FORMAT || manifest.version !== 1) {
    throw new Error('The selected directory is not a supported Dataset Creator project.');
  }
  if (!manifest.project || !manifest.project.id || !manifest.project.name) {
    throw new Error('The project manifest is missing required project fields.');
  }

  const defaults = createProject(manifest.project.name);
  const [sources, synthetic] = await Promise.all([
    readOptionalProjectChildren(directory, 'sources', readSource),
    readOptionalProjectChildren(directory, 'synthetic', readSynthetic),
  ]);

  const sourceIds = new Set(sources.map((source) => source.id));
  const orphanSynthetic = synthetic.find((item) => !sourceIds.has(item.sourceImageId));
  if (orphanSynthetic) {
    throw new Error(
      `Synthetic image "${orphanSynthetic.id}" references a source image that is missing from the project.`
    );
  }

  return {
    ...defaults,
    id: manifest.project.id,
    name: manifest.project.name,
    currentStage: manifest.project.currentStage,
    sourceImages: Object.fromEntries(sources.map((source) => [source.id, source])),
    datasetItems: Object.fromEntries(synthetic.map((item) => [item.id, item])),
    taggingConfig: {
      ...defaults.taggingConfig,
      ...manifest.project.taggingConfig,
    },
    workspaceSettings: {
      ...defaults.workspaceSettings,
      ...manifest.project.workspaceSettings,
    },
    lastModified: toDate(manifest.project.lastModified, new Date()),
    createdAt: toDate(manifest.project.createdAt, new Date()),
  };
};
