import JSZip from 'jszip';
import { createSourceImage, type SourceImage } from '../../types';
import { createThumbnail, getImageDimensions } from '../image/imageProcessor';
import { generateEmbedding, generateImageHash } from '../image/embeddingService';
import { createOperationLogger, shouldLogProgress, type OperationLogger } from '../logging/applicationLog';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { getAssetManifestPath } from '../project/assetManifestService';
import { getDirectoryAtExplorerPath, getUniqueExplorerName } from '../project/explorerFileService';

export const SUPPORTED_IMPORT_IMAGE_FORMATS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const SUPPORTED_IMPORT_ARCHIVE_FORMATS = ['application/zip', 'application/x-zip-compressed'];
export const SUPPORTED_IMPORT_FILE_FORMATS = [
  ...SUPPORTED_IMPORT_IMAGE_FORMATS,
  ...SUPPORTED_IMPORT_ARCHIVE_FORMATS,
  '.zip',
];

const IMAGE_EXTENSION_TYPES = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

export type ImportDestination = {
  projectDirectory?: ProjectDirectoryHandle;
  explorerPath?: string;
};

export type ImportImagesOptions = {
  logger?: OperationLogger;
  destination?: ImportDestination;
  onProgress?: (current: number, total: number) => void;
  onError?: (fileName: string, error: unknown) => void;
};

export type ImportImagesResult = {
  importedImages: SourceImage[];
  skippedCount: number;
};

const getArchivePathStem = (path: string): string => path.replace(/\.[^/.]+$/, '');
const getArchiveFileName = (path: string): string => path.split('/').pop() ?? path;
const getArchiveFileStem = (path: string): string => getArchiveFileName(path).replace(/\.[^.]+$/, '');
const getArchiveExtension = (path: string): string => path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';

export const isImportArchiveFile = (file: File): boolean =>
  SUPPORTED_IMPORT_ARCHIVE_FORMATS.includes(file.type) || file.name.toLowerCase().endsWith('.zip');

const parseCaptionTags = (caption: string): string[] =>
  caption
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

const toProjectRelativePath = (explorerPath: string): string =>
  explorerPath === 'Project' ? '' : explorerPath.replace(/^Project\//, '');

const joinPath = (...parts: string[]): string => parts.filter(Boolean).join('/');

const resolveImportFileName = async (
  fileName: string,
  destination?: ImportDestination
): Promise<string> => {
  if (!destination?.projectDirectory || !destination.explorerPath) {
    return fileName;
  }
  const directory = await getDirectoryAtExplorerPath(destination.projectDirectory, destination.explorerPath);
  return getUniqueExplorerName(directory, fileName);
};

const applyImportDestination = (sourceImage: SourceImage, fileName: string, destination?: ImportDestination) => {
  if (!destination?.explorerPath) {
    return;
  }
  const directoryPath = toProjectRelativePath(destination.explorerPath);
  const originalFilePath = joinPath(directoryPath, fileName);
  sourceImage.fileName = fileName;
  sourceImage.originalFilePath = originalFilePath;
  sourceImage.manifestPath = getAssetManifestPath(originalFilePath);
};

const processImportedFile = async (
  file: File,
  tags: string[],
  destination: ImportDestination | undefined,
  logger: OperationLogger
): Promise<SourceImage | null> => {
  if (!SUPPORTED_IMPORT_IMAGE_FORMATS.includes(file.type)) {
    logger.warning(`skipped unsupported file ${file.name}`);
    return null;
  }

  const targetFileName = await resolveImportFileName(file.name, destination);
  const { width, height } = await getImageDimensions(file);
  const thumbnail = await createThumbnail(file);
  const embedding = await generateEmbedding(file);
  const hash = await generateImageHash(file);
  const previewUrl = URL.createObjectURL(file);

  const sourceImage = createSourceImage(file, file.name, width, height, previewUrl);
  sourceImage.thumbnail = thumbnail;
  sourceImage.embedding = embedding;
  sourceImage.hash = hash;
  sourceImage.tags = tags;
  applyImportDestination(sourceImage, targetFileName, destination);

  return sourceImage;
};

const processArchiveFile = async (
  file: File,
  destination: ImportDestination | undefined,
  logger: OperationLogger
): Promise<SourceImage[]> => {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const captionsByPathStem = new Map<string, JSZip.JSZipObject>();
  const captionsByFileStem = new Map<string, JSZip.JSZipObject>();

  for (const entry of entries) {
    if (getArchiveExtension(entry.name) !== '.txt') {
      continue;
    }
    captionsByPathStem.set(getArchivePathStem(entry.name), entry);
    captionsByFileStem.set(getArchiveFileStem(entry.name), entry);
  }

  const importedImages: SourceImage[] = [];
  const imageEntries = entries.filter((entry) => IMAGE_EXTENSION_TYPES.has(getArchiveExtension(entry.name)));
  logger.info(`archive ${file.name} contains ${imageEntries.length} image files`);

  for (let i = 0; i < imageEntries.length; i++) {
    const entry = imageEntries[i];
    const extension = getArchiveExtension(entry.name);
    const mimeType = IMAGE_EXTENSION_TYPES.get(extension);
    if (!mimeType) {
      continue;
    }

    const imageBlob = await entry.async('blob');
    const imageFile = new File([imageBlob], getArchiveFileName(entry.name), { type: mimeType });
    const captionEntry =
      captionsByPathStem.get(getArchivePathStem(entry.name)) ??
      captionsByFileStem.get(getArchiveFileStem(entry.name));
    const tags = captionEntry ? parseCaptionTags(await captionEntry.async('string')) : [];
    const sourceImage = await processImportedFile(imageFile, tags, destination, logger);
    if (sourceImage) {
      importedImages.push(sourceImage);
    }

    const current = i + 1;
    if (shouldLogProgress(current, imageEntries.length)) {
      logger.progress({ current, total: imageEntries.length, label: `processing ${file.name}` });
    }
  }

  return importedImages;
};

export const importImageFiles = async (
  files: File[],
  options: ImportImagesOptions = {}
): Promise<ImportImagesResult> => {
  const logger = options.logger ?? createOperationLogger('Import');
  const importedImages: SourceImage[] = [];
  let skippedCount = 0;

  if (files.length === 0) {
    return { importedImages, skippedCount };
  }

  const destinationLabel = options.destination?.explorerPath
    ? ` into /${toProjectRelativePath(options.destination.explorerPath) || ''}`
    : '';
  logger.info(`starting image import from ${files.length} selected file${files.length !== 1 ? 's' : ''}${destinationLabel}`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      if (isImportArchiveFile(file)) {
        importedImages.push(...await processArchiveFile(file, options.destination, logger));
      } else {
        const sourceImage = await processImportedFile(file, [], options.destination, logger);
        if (sourceImage) {
          importedImages.push(sourceImage);
        } else {
          skippedCount += 1;
        }
      }
    } catch (error) {
      logger.error(`failed to process ${file.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
      options.onError?.(file.name, error);
    }

    const current = i + 1;
    options.onProgress?.(current, files.length);
    if (shouldLogProgress(current, files.length)) {
      logger.progress({ current, total: files.length, label: 'processed selections' });
    }
  }

  if (skippedCount > 0) {
    logger.warning(`${skippedCount} unsupported file${skippedCount !== 1 ? 's' : ''} skipped`);
  }

  if (importedImages.length > 0) {
    logger.success(`completed: imported ${importedImages.length} image${importedImages.length !== 1 ? 's' : ''}`);
  } else {
    logger.warning('completed with no images imported');
  }

  return { importedImages, skippedCount };
};
