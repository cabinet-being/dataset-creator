import JSZip from 'jszip';
import type { ProjectState, SourceImage, SyntheticImage } from '../../types';

export const PROJECT_FILE_EXTENSION = 'dcproj';
export const PROJECT_FILE_MIME_TYPE = 'application/vnd.dataset-creator.project';

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
  version: 1;
  project: Omit<ProjectState, 'sourceImages' | 'datasetItems' | 'cleanupOverlays' | 'lastModified' | 'createdAt'> & {
    sourceImages: Record<string, SourceImageManifest>;
    datasetItems: Record<string, SyntheticImageManifest>;
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

export const createProjectFileBlob = async (project: ProjectState): Promise<Blob> => {
  const zip = new JSZip();
  const sourceImages: Record<string, SourceImageManifest> = {};
  const datasetItems: Record<string, SyntheticImageManifest> = {};
  const exportedAt = new Date();

  for (const source of Object.values(project.sourceImages)) {
    const originalFilePath = `sources/${source.id}/original`;
    const thumbnailPath = source.thumbnail ? `sources/${source.id}/thumbnail` : undefined;
    zip.file(originalFilePath, source.originalFile);
    if (source.thumbnail && thumbnailPath) {
      zip.file(thumbnailPath, source.thumbnail);
    }

    const { originalFile: _originalFile, previewUrl: _previewUrl, thumbnail: _thumbnail, embedding, ...metadata } = source;
    sourceImages[source.id] = {
      ...metadata,
      originalFilePath,
      thumbnailPath,
      embedding: embedding ? Array.from(embedding) : undefined,
      createdAt: toIsoString(source.createdAt, exportedAt),
    };
  }

  for (const item of Object.values(project.datasetItems)) {
    const imageDataPath = `synthetic/${item.id}/image.png`;
    const psdDataPath = item.psdData ? `synthetic/${item.id}/image.psd` : undefined;
    zip.file(imageDataPath, item.imageData);
    if (item.psdData && psdDataPath) {
      zip.file(psdDataPath, item.psdData);
    }

    const { imageData: _imageData, psdData: _psdData, createdAt, deletedAt, ...metadata } = item;
    datasetItems[item.id] = {
      ...metadata,
      imageDataPath,
      psdDataPath,
      createdAt: toIsoString(createdAt, exportedAt),
      deletedAt: deletedAt ? toIsoString(deletedAt, exportedAt) : undefined,
    };
  }

  const manifest: ProjectFileManifest = {
    format: 'dataset-creator-project',
    version: 1,
    project: {
      id: project.id,
      name: project.name,
      sourceImages,
      datasetItems,
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

export const readProjectFile = async (file: File): Promise<ProjectState> => {
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid project file: missing manifest');
  }

  const manifest = JSON.parse(await manifestFile.async('string')) as ProjectFileManifest;
  if (manifest.format !== 'dataset-creator-project' || manifest.version !== 1) {
    throw new Error('Unsupported project file');
  }

  const sourceImages: Record<string, SourceImage> = {};
  for (const source of Object.values(manifest.project.sourceImages)) {
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
  for (const item of Object.values(manifest.project.datasetItems)) {
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

  return {
    ...manifest.project,
    sourceImages,
    datasetItems,
    cleanupOverlays: {},
    lastModified: new Date(manifest.project.lastModified),
    createdAt: new Date(manifest.project.createdAt),
  };
};
