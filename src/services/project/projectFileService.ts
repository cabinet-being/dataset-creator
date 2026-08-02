import JSZip from 'jszip';
import type { ProjectState, SourceImage, SyntheticImage } from '../../types';

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

type SourceImageManifest = Omit<
  SourceImage,
  'originalFile' | 'previewUrl' | 'thumbnail' | 'embedding' | 'createdAt'
> & {
  originalFilePath: string;
  thumbnailPath?: string;
  embedding?: number[];
  createdAt: string;
};

type SyntheticImageManifest = Omit<SyntheticImage, 'imageData' | 'psdData' | 'createdAt' | 'deletedAt'> & {
  imageDataPath: string;
  psdDataPath?: string;
  createdAt: string;
  deletedAt?: string;
};

type ProjectFileManifest = {
  format: 'dataset-creator-project';
  version: 1 | 2;
  project: Omit<ProjectState, 'sourceImages' | 'datasetItems' | 'cleanupOverlays' | 'lastModified' | 'createdAt'> & {
    sourceImages?: Record<string, SourceImageManifest>;
    datasetItems?: Record<string, SyntheticImageManifest>;
    sourceImageManifests?: Record<string, string>;
    datasetItemManifests?: Record<string, string>;
    cleanupOverlays: {};
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
  const datasetItemManifests: Record<string, string> = {};
  const exportedAt = new Date();

  for (const source of Object.values(project.sourceImages)) {
    const originalFilePath = `sources/${source.id}/original`;
    const thumbnailPath = source.thumbnail ? `sources/${source.id}/thumbnail` : undefined;
    const manifestPath = `sources/${source.id}/manifest.json`;
    zip.file(originalFilePath, source.originalFile);
    if (source.thumbnail && thumbnailPath) {
      zip.file(thumbnailPath, source.thumbnail);
    }

    const { originalFile: _originalFile, previewUrl: _previewUrl, thumbnail: _thumbnail, embedding, ...metadata } = source;
    const sourceManifest: SourceImageManifest = {
      ...metadata,
      originalFilePath,
      thumbnailPath,
      embedding: embedding ? Array.from(embedding) : undefined,
      createdAt: toIsoString(source.createdAt, exportedAt),
    };
    sourceImageManifests[source.id] = manifestPath;
    zip.file(manifestPath, JSON.stringify(sourceManifest, null, 2));
  }

  for (const item of Object.values(project.datasetItems)) {
    const imageDataPath = `synthetic/${item.id}/image.png`;
    const psdDataPath = item.psdData ? `synthetic/${item.id}/image.psd` : undefined;
    const manifestPath = `synthetic/${item.id}/manifest.json`;
    zip.file(imageDataPath, item.imageData);
    if (item.psdData && psdDataPath) {
      zip.file(psdDataPath, item.psdData);
    }

    const { imageData: _imageData, psdData: _psdData, createdAt, deletedAt, ...metadata } = item;
    const itemManifest: SyntheticImageManifest = {
      ...metadata,
      imageDataPath,
      psdDataPath,
      createdAt: toIsoString(createdAt, exportedAt),
      deletedAt: deletedAt ? toIsoString(deletedAt, exportedAt) : undefined,
    };
    datasetItemManifests[item.id] = manifestPath;
    zip.file(manifestPath, JSON.stringify(itemManifest, null, 2));
  }

  const manifest: ProjectFileManifest = {
    format: 'dataset-creator-project',
    version: 2,
    project: {
      id: project.id,
      name: project.name,
      sourceImageManifests,
      datasetItemManifests,
      cleanupOverlays: {},
      currentStage: project.currentStage,
      stageState: project.stageState,
      taggingConfig: project.taggingConfig,
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
  if (manifest.format !== 'dataset-creator-project' || ![1, 2].includes(manifest.version)) {
    throw new Error('Unsupported project file');
  }

  const sourceManifests = manifest.project.sourceImageManifests
    ? await Promise.all(
        Object.values(manifest.project.sourceImageManifests).map((path) =>
          readJsonFile<SourceImageManifest>(zip, path)
        )
      )
    : Object.values(manifest.project.sourceImages ?? {});
  const syntheticManifests = manifest.project.datasetItemManifests
    ? await Promise.all(
        Object.values(manifest.project.datasetItemManifests).map((path) =>
          readJsonFile<SyntheticImageManifest>(zip, path)
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
    const thumbnailBuffer = source.thumbnailPath
      ? await zip.file(source.thumbnailPath)?.async('arraybuffer')
      : undefined;
    const thumbnail = thumbnailBuffer ? new Blob([thumbnailBuffer], { type: 'image/jpeg' }) : undefined;
    const {
      originalFilePath: _originalFilePath,
      thumbnailPath: _thumbnailPath,
      embedding,
      createdAt,
      ...metadata
    } = source;

    sourceImages[source.id] = {
      ...metadata,
      originalFile,
      thumbnail,
      embedding: embedding ? new Float32Array(embedding) : undefined,
      previewUrl: URL.createObjectURL(originalFile),
      createdAt: new Date(createdAt),
    };
  }

  const datasetItems: Record<string, SyntheticImage> = {};
  for (const item of syntheticManifests) {
    const imageDataBuffer = await zip.file(item.imageDataPath)?.async('arraybuffer');
    if (!imageDataBuffer) {
      throw new Error(`Project file is missing Synthetic data for ${item.id}`);
    }

    const imageData = new Blob([imageDataBuffer], { type: 'image/png' });
    const psdDataBuffer = item.psdDataPath ? await zip.file(item.psdDataPath)?.async('arraybuffer') : undefined;
    const psdData = psdDataBuffer
      ? new Blob([psdDataBuffer], { type: 'image/vnd.adobe.photoshop' })
      : undefined;
    const {
      imageDataPath: _imageDataPath,
      psdDataPath: _psdDataPath,
      createdAt,
      deletedAt,
      ...metadata
    } = item;

    datasetItems[item.id] = {
      ...metadata,
      imageData,
      psdData,
      createdAt: new Date(createdAt),
      deletedAt: deletedAt ? new Date(deletedAt) : undefined,
    };
  }

  const {
    sourceImages: _sourceImageManifests,
    datasetItems: _datasetItemManifests,
    sourceImageManifests: _sourceImageManifestPaths,
    datasetItemManifests: _datasetItemManifestPaths,
    cleanupOverlays: _cleanupOverlays,
    lastModified,
    createdAt,
    stageState,
    ...projectMetadata
  } = manifest.project;
  const loadedStageState = stageState as Partial<Record<string, unknown>>;

  return {
    ...projectMetadata,
    sourceImages,
    datasetItems,
    cleanupOverlays: {},
    stageState: {
      hub: loadedStageState.hub ?? {},
      import: loadedStageState.import ?? {},
      select: loadedStageState.select ?? {},
      clean: loadedStageState.clean ?? {},
      analysis: loadedStageState.analysis ?? {},
      review: loadedStageState.review ?? {},
      tagging: loadedStageState.tagging ?? {},
      export: loadedStageState.export ?? {},
    },
    lastModified: new Date(lastModified),
    createdAt: new Date(createdAt),
  };
};
