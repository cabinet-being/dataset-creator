import JSZip from 'jszip';
import { createSourceImage, type SourceImage } from '../../types';
import { createThumbnail, getImageDimensions } from '../image/imageProcessor';
import { generateEmbedding, generateImageHash } from '../image/embeddingService';
import { createOperationLogger, shouldLogProgress, type OperationLogger } from '../logging/applicationLog';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { snapshotFile } from '../project/fileSnapshotService';
import {
  getAssetManifestName,
  getAssetManifestPath,
} from '../project/assetManifestService';
import { getExplorerFileKind, getUniqueExplorerName } from '../project/explorerFileService';
import {
  SUPPORTED_PROJECT_ASSET_ACCEPT,
  getProjectAssetMimeType,
  isInternalProjectFileName,
  isSupportedProjectAsset,
  resolveProjectAssetKind,
} from '../project/assetTypeService';
import { isInternalProjectEntry } from '../project/projectLayoutService';
import { getCaptionPathForImage, parseCaptionText } from '../caption/captionFileService';

export const SUPPORTED_IMPORT_ARCHIVE_FORMATS = ['application/zip', 'application/x-zip-compressed'];
export const SUPPORTED_IMPORT_FILE_FORMATS = [
  ...SUPPORTED_PROJECT_ASSET_ACCEPT,
  ...SUPPORTED_IMPORT_ARCHIVE_FORMATS,
  '.zip',
];

export type ImportInputFile = File | {
  file: File;
  relativePath?: string;
} | {
  directoryPath: string;
};

type WebkitFileSystemFileEntry = {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
};

type WebkitFileSystemDirectoryReader = {
  readEntries: (
    success: (entries: WebkitFileSystemEntry[]) => void,
    error?: (error: DOMException) => void
  ) => void;
};

type WebkitFileSystemDirectoryEntry = {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => WebkitFileSystemDirectoryReader;
};

type WebkitFileSystemEntry = WebkitFileSystemFileEntry | WebkitFileSystemDirectoryEntry;

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => WebkitFileSystemEntry | null;
};

export type ImportedProjectAsset = {
  id: string;
  kind: ReturnType<typeof getExplorerFileKind>;
  fileName: string;
  assetPath: string;
  manifestPath: string;
  mimeType: string;
  size: number;
};

export type ImportDestination = {
  projectDirectory?: ProjectDirectoryHandle;
  explorerPath?: string;
};

export type ImportImagesOptions = {
  signal?: AbortSignal;
  logger?: OperationLogger;
  destination?: ImportDestination;
  onProgress?: (current: number, total: number) => void;
  onError?: (fileName: string, error: unknown) => void;
  onImageImported?: (image: SourceImage, asset?: ImportedProjectAsset) => void | Promise<void>;
  onAssetImported?: (asset: ImportedProjectAsset) => void | Promise<void>;
  onDirectoryImported?: (relativePath: string) => void | Promise<void>;
};

export type ImportImagesResult = {
  importedImages: SourceImage[];
  importedAssets: ImportedProjectAsset[];
  skippedCount: number;
  summary: ImportPairSummary;
};

export type ImportPairSummary = {
  pairedImages: number;
  imagesWithoutCaption: number;
  standaloneTextFiles: number;
  captionConflicts: number;
  errors: number;
};

const createImportPairSummary = (): ImportPairSummary => ({ pairedImages:0, imagesWithoutCaption:0, standaloneTextFiles:0, captionConflicts:0, errors:0 });
const mergeImportPairSummary = (target: ImportPairSummary, source: ImportPairSummary) => {
  target.pairedImages += source.pairedImages; target.imagesWithoutCaption += source.imagesWithoutCaption;
  target.standaloneTextFiles += source.standaloneTextFiles; target.captionConflicts += source.captionConflicts; target.errors += source.errors;
};

export const summarizeImportPairPaths = (paths: readonly string[]): ImportPairSummary => {
  const summary = createImportPairSummary();
  const imagesByKey = new Map<string, number>();
  const textsByKey = new Map<string, number>();
  for (const path of paths) {
    const kind = resolveProjectAssetKind(path);
    const target = kind === 'image' ? imagesByKey : kind === 'text' && getArchiveExtension(path) === '.txt' ? textsByKey : null;
    if (!target) continue;
    const key = getImportPairKey(path);
    target.set(key, (target.get(key) ?? 0) + 1);
  }
  for (const [key, imageCount] of imagesByKey) {
    const textCount = textsByKey.get(key) ?? 0;
    if (textCount === 1) summary.pairedImages += imageCount;
    else if (textCount === 0) summary.imagesWithoutCaption += imageCount;
  }
  for (const [key, textCount] of textsByKey) {
    if (!imagesByKey.has(key)) summary.standaloneTextFiles += textCount;
    if (textCount > 1) summary.captionConflicts += 1;
  }
  return summary;
};

const getArchivePathStem = (path: string): string => path.replace(/\.[^/.]+$/, '');
const getArchiveFileName = (path: string): string => path.split('/').pop() ?? path;
const getArchiveExtension = (path: string): string => path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
const isUnsafeArchivePath = (path: string): boolean => {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalized.split('/').includes('..');
};
const isInternalImportPath = (path: string): boolean =>
  path.split('/').some((part) => isInternalProjectEntry(part));

export const isImportArchiveFile = (file: File): boolean =>
  SUPPORTED_IMPORT_ARCHIVE_FORMATS.includes(file.type) || file.name.toLowerCase().endsWith('.zip');

export const isInternalImportFileName = (fileName: string): boolean =>
  isInternalProjectFileName(fileName);

export const isSupportedImportAssetFile = (file: File): boolean =>
  isSupportedProjectAsset(file.name, file.type);

const readFileEntry = async (
  entry: WebkitFileSystemFileEntry,
  relativePath: string
): Promise<ImportInputFile[]> =>
  new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve([{ file, relativePath }]),
      (error) => reject(error)
    );
  });

const readDirectoryEntries = async (
  reader: WebkitFileSystemDirectoryReader
): Promise<WebkitFileSystemEntry[]> => {
  const entries: WebkitFileSystemEntry[] = [];

  while (true) {
    const batch = await new Promise<WebkitFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) {
      return entries;
    }
    entries.push(...batch);
  }
};

const readEntryFiles = async (
  entry: WebkitFileSystemEntry,
  parentPath = ''
): Promise<ImportInputFile[]> => {
  const relativePath = joinPath(parentPath, entry.name);
  if (isInternalImportPath(relativePath)) {
    return [];
  }
  if (entry.isFile) {
    return readFileEntry(entry, relativePath);
  }

  const childEntries = await readDirectoryEntries(entry.createReader());
  const nestedFiles = await Promise.all(childEntries.map((child) => readEntryFiles(child, relativePath)));
  return [{ directoryPath: relativePath }, ...nestedFiles.flat()];
};

export const getImportFilesFromDataTransfer = async (
  dataTransfer: DataTransfer
): Promise<ImportInputFile[]> => {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => (item as DataTransferItemWithEntry).webkitGetAsEntry?.() as WebkitFileSystemEntry | null | undefined)
    .filter((entry): entry is WebkitFileSystemEntry => Boolean(entry));

  if (entries.length === 0) {
    return Array.from(dataTransfer.files ?? []);
  }

  const files = await Promise.all(entries.map((entry) => readEntryFiles(entry)));
  return files.flat();
};

export const getImportPairKey = (path: string): string =>
  getArchivePathStem(path.replace(/\\/g, '/')).toLocaleLowerCase();

const toProjectRelativePath = (explorerPath: string): string =>
  explorerPath === 'Project' ? '' : explorerPath.replace(/^Project\//, '');

const joinPath = (...parts: string[]): string => parts.filter(Boolean).join('/');
const getParentPath = (path: string): string => path.split('/').filter(Boolean).slice(0, -1).join('/');
const yieldToUi = async () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const normalizeImportInput = (input: ImportInputFile): { file?: File; relativePath?: string; directoryPath?: string } => {
  if ('directoryPath' in input) {
    return input;
  }
  if ('file' in input) {
    return input;
  }

  const relativePath = (input as File & { webkitRelativePath?: string }).webkitRelativePath;
  return {
    file: input,
    relativePath: relativePath || undefined,
  };
};

const splitExtension = (name: string): { stem: string; extension: string } => {
  const index = name.lastIndexOf('.');
  if (index <= 0) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, index), extension: name.slice(index) };
};

const getUniqueReservedName = (name: string, reservedNames: Set<string>): string => {
  if (!reservedNames.has(name)) {
    return name;
  }
  const { stem, extension } = splitExtension(name);
  const baseStem = stem.replace(/\s+\d+$/, '') || stem;
  let index = 2;
  while (reservedNames.has(`${baseStem} ${index}${extension}`)) {
    index += 1;
  }
  return `${baseStem} ${index}${extension}`;
};

const importEntryExists = async (directory: ProjectDirectoryHandle, name: string): Promise<boolean> => {
  try { await directory.getFileHandle(name); return true; }
  catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return false; throw error; }
};

const resolveImportFileName = async (
  fileName: string,
  destination: ImportDestination | undefined,
  reservedNames: Set<string>,
  explorerDirectoryPath?: string,
  options: { reserveCaptionSidecar?: boolean; useReservedTarget?: boolean } = {}
): Promise<string> => {
  if (options.useReservedTarget) return fileName;
  if (destination?.projectDirectory && explorerDirectoryPath) {
    const directory = await getOrCreateDirectoryAtExplorerPath(destination.projectDirectory, explorerDirectoryPath);
    let targetName = getUniqueReservedName(await getUniqueExplorerName(directory, fileName), reservedNames);
    if (options.reserveCaptionSidecar) {
      while (reservedNames.has(getCaptionPathForImage(targetName)) || reservedNames.has(getAssetManifestName(getCaptionPathForImage(targetName))) ||
        await importEntryExists(directory, getCaptionPathForImage(targetName)) || await importEntryExists(directory, getAssetManifestName(getCaptionPathForImage(targetName)))) {
        reservedNames.add(targetName);
        targetName = getUniqueReservedName(await getUniqueExplorerName(directory, fileName), reservedNames);
      }
      reservedNames.add(getCaptionPathForImage(targetName));
      reservedNames.add(getAssetManifestName(getCaptionPathForImage(targetName)));
    }
    reservedNames.add(targetName);
    reservedNames.add(getAssetManifestName(targetName));
    return targetName;
  }
  const targetName = getUniqueReservedName(fileName, reservedNames);
  if (options.reserveCaptionSidecar) {
    reservedNames.add(getCaptionPathForImage(targetName));
    reservedNames.add(getAssetManifestName(getCaptionPathForImage(targetName)));
  }
  reservedNames.add(targetName);
  reservedNames.add(getAssetManifestName(targetName));
  return targetName;
};

const getImportTarget = async (
  fileName: string,
  relativePath: string | undefined,
  destination: ImportDestination | undefined,
  reservedNamesByDirectory: Map<string, Set<string>>,
  options: { reserveCaptionSidecar?: boolean; useReservedTarget?: boolean } = {}
): Promise<{ explorerDirectoryPath?: string; fileName: string; assetPath?: string; manifestPath?: string }> => {
  const relativeDirectory = relativePath ? getParentPath(relativePath) : '';
  const explorerDirectoryPath = destination?.explorerPath
    ? joinPath(destination.explorerPath, relativeDirectory)
    : undefined;
  const reservedKey = explorerDirectoryPath ?? '';
  const reservedNames = reservedNamesByDirectory.get(reservedKey) ?? new Set<string>();
  reservedNamesByDirectory.set(reservedKey, reservedNames);
  const targetFileName = await resolveImportFileName(fileName, destination, reservedNames, explorerDirectoryPath, options);

  if (!explorerDirectoryPath) {
    return { fileName: targetFileName };
  }

  const directoryPath = toProjectRelativePath(explorerDirectoryPath);
  const assetPath = joinPath(directoryPath, targetFileName);
  return {
    explorerDirectoryPath,
    fileName: targetFileName,
    assetPath,
    manifestPath: getAssetManifestPath(assetPath),
  };
};

const applyImportDestination = (
  sourceImage: SourceImage,
  target: { fileName: string; assetPath?: string; manifestPath?: string }
) => {
  if (!target.assetPath || !target.manifestPath) {
    return;
  }

  sourceImage.fileName = target.fileName;
  sourceImage.originalFilePath = target.assetPath;
  sourceImage.manifestPath = target.manifestPath;
};

const getOrCreateDirectoryAtExplorerPath = async (
  root: ProjectDirectoryHandle,
  explorerPath: string
): Promise<ProjectDirectoryHandle> => {
  let directory = root;
  for (const part of explorerPath.replace(/^Project\/?/, '').split('/').filter(Boolean)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  return directory;
};

const createImportDirectory = async (
  destination: ImportDestination | undefined,
  relativePath: string
) => {
  if (!destination?.projectDirectory || !destination.explorerPath) {
    return;
  }
  await getOrCreateDirectoryAtExplorerPath(
    destination.projectDirectory,
    joinPath(destination.explorerPath, relativePath)
  );
};

const writeBlobFile = async (directory: ProjectDirectoryHandle, name: string, value: Blob) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
};

const writeProjectAsset = async (
  file: File,
  target: { explorerDirectoryPath?: string; fileName: string; assetPath?: string; manifestPath?: string },
  destination: ImportDestination | undefined
): Promise<ImportedProjectAsset | null> => {
  if (!destination?.projectDirectory || !target.explorerDirectoryPath || !target.assetPath || !target.manifestPath) {
    return null;
  }

  const directory = await getOrCreateDirectoryAtExplorerPath(destination.projectDirectory, target.explorerDirectoryPath);
  await writeBlobFile(directory, target.fileName, file);

  const asset: ImportedProjectAsset = {
    id: crypto.randomUUID(),
    kind: getExplorerFileKind(target.fileName, file.type),
    fileName: target.fileName,
    assetPath: target.assetPath,
    manifestPath: target.manifestPath,
    mimeType: file.type,
    size: file.size,
  };

  await writeBlobFile(
    directory,
    getAssetManifestName(target.fileName),
    new Blob([
      JSON.stringify(
        {
          id: asset.id,
          kind: asset.kind,
          fileName: asset.fileName,
          originalFileName: file.name,
          assetPath: asset.assetPath,
          mimeType: asset.mimeType,
          size: asset.size,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ),
    ], { type: 'application/json' })
  );

  return asset;
};

const processImportedFile = async (
  inputFile: File,
  relativePath: string | undefined,
  tags: string[] | undefined,
  destination: ImportDestination | undefined,
  logger: OperationLogger,
  reservedNamesByDirectory: Map<string, Set<string>>,
  targetOptions: { reserveCaptionSidecar?: boolean; useReservedTarget?: boolean } = {}
): Promise<{ sourceImage: SourceImage | null; asset: ImportedProjectAsset | null }> => {
  const file = await snapshotFile(inputFile);

  if (isInternalImportFileName(file.name)) {
    logger.warning(`skipped internal project metadata file ${file.name}`);
    return { sourceImage: null, asset: null };
  }

  if (!isSupportedImportAssetFile(file)) {
    logger.warning(`skipped unsupported file ${file.name}`);
    return { sourceImage: null, asset: null };
  }

  const target = await getImportTarget(file.name, relativePath, destination, reservedNamesByDirectory, targetOptions);
  const asset = await writeProjectAsset(file, target, destination);

  if (resolveProjectAssetKind(file.name, file.type) !== 'image') {
    return { sourceImage: null, asset };
  }

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
  applyImportDestination(sourceImage, target);

  return { sourceImage, asset };
};

const processArchiveFile = async (
  file: File,
  destination: ImportDestination | undefined,
  logger: OperationLogger,
  reservedNamesByDirectory: Map<string, Set<string>>,
  onImageImported?: ImportImagesOptions['onImageImported'],
  onAssetImported?: ImportImagesOptions['onAssetImported'],
  signal?: AbortSignal
): Promise<{ importedImages: SourceImage[]; importedAssets: ImportedProjectAsset[]; summary: ImportPairSummary }> => {
  signal?.throwIfAborted();
  const zip = await JSZip.loadAsync(file);
  const archiveEntries = Object.values(zip.files);
  const unsafeEntries = archiveEntries.filter((entry) =>
    isUnsafeArchivePath((entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name)
  );
  if (unsafeEntries.length > 0) {
    logger.warning(`archive ${file.name} contains ${unsafeEntries.length} unsafe path${unsafeEntries.length !== 1 ? 's' : ''}; skipped`);
  }
  const entries = archiveEntries.filter((entry) => {
    const originalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    return !entry.dir && !isUnsafeArchivePath(originalName) && !isInternalImportPath(entry.name) && !isInternalImportFileName(getArchiveFileName(entry.name));
  });
  const captionsByPathStem = new Map<string, JSZip.JSZipObject[]>();

  for (const entry of entries) {
    if (getArchiveExtension(entry.name) !== '.txt') {
      continue;
    }
    const key = getImportPairKey(entry.name);
    captionsByPathStem.set(key, [...(captionsByPathStem.get(key) ?? []), entry]);
  }

  const importedImages: SourceImage[] = [];
  const importedAssets: ImportedProjectAsset[] = [];
  const summary = createImportPairSummary();
  const captionTargetByPairKey = new Map<string, string>();
  const imageEntries = entries.filter((entry) => resolveProjectAssetKind(entry.name) === 'image');
  const textEntries = entries.filter((entry) => getArchiveExtension(entry.name) === '.txt');
  Object.assign(summary, summarizeImportPairPaths(entries.map((entry) => entry.name)));
  const importEntries = [...imageEntries, ...textEntries];
  logger.info(`archive ${file.name} contains ${imageEntries.length} image files and ${textEntries.length} text files`);

  for (let i = 0; i < importEntries.length; i++) {
    signal?.throwIfAborted();
    const entry = importEntries[i];
    const kind = resolveProjectAssetKind(entry.name);
    if (kind === 'text') {
      const textBlob = await entry.async('blob');
      const targetPath = captionTargetByPairKey.get(getImportPairKey(entry.name)) ?? entry.name;
      const textFile = new File([textBlob], getArchiveFileName(targetPath), { type: 'text/plain' });
      const { asset } = await processImportedFile(
        textFile,
        targetPath,
        [],
        destination,
        logger,
        reservedNamesByDirectory,
        { useReservedTarget: captionTargetByPairKey.has(getImportPairKey(entry.name)) }
      );
      if (asset) {
        importedAssets.push(asset);
        await onAssetImported?.(asset);
      }
      const current = i + 1;
      if (shouldLogProgress(current, importEntries.length)) {
        logger.progress({ current, total: importEntries.length, label: `processing ${file.name}` });
      }
      continue;
    }
    const mimeType = getProjectAssetMimeType(entry.name, 'image/png');

    const imageBlob = await entry.async('blob');
    const imageFile = new File([imageBlob], getArchiveFileName(entry.name), { type: mimeType });
    const captionEntries = captionsByPathStem.get(getImportPairKey(entry.name)) ?? [];
    if (captionEntries.length > 1) logger.warning(`archive ${file.name} has conflicting captions for ${entry.name}; caption was not attached`);
    const tags = captionEntries.length === 1 ? parseCaptionText(await captionEntries[0].async('string')).tags : undefined;
    const { sourceImage, asset } = await processImportedFile(
      imageFile,
      entry.name,
      tags,
      destination,
      logger,
      reservedNamesByDirectory,
      { reserveCaptionSidecar: captionEntries.length === 1 }
    );
    if (asset) {
      importedAssets.push(asset);
      captionTargetByPairKey.set(
        getImportPairKey(entry.name),
        getCaptionPathForImage(joinPath(getParentPath(entry.name), asset.fileName))
      );
      await onAssetImported?.(asset);
    }
    if (sourceImage) {
      importedImages.push(sourceImage);
      await onImageImported?.(sourceImage, asset ?? undefined);
    }

    const current = i + 1;
    if (shouldLogProgress(current, importEntries.length)) {
      logger.progress({ current, total: importEntries.length, label: `processing ${file.name}` });
    }
  }

  return { importedImages, importedAssets, summary };
};

export const importImageFiles = async (
  files: ImportInputFile[],
  options: ImportImagesOptions = {}
): Promise<ImportImagesResult> => {
  const logger = options.logger ?? createOperationLogger('Import');
  const importedImages: SourceImage[] = [];
  const importedAssets: ImportedProjectAsset[] = [];
  const summary = createImportPairSummary();
  const reservedNamesByDirectory = new Map<string, Set<string>>();
  const normalizedInputs = files.map(normalizeImportInput);
  const orderedInputs = [...normalizedInputs].sort((left, right) => {
    const priority = (input: ReturnType<typeof normalizeImportInput>) => {
      if (input.directoryPath || !input.file || isImportArchiveFile(input.file)) return 0;
      const kind = resolveProjectAssetKind(input.file.name, input.file.type);
      return kind === 'image' ? 1 : kind === 'text' ? 2 : 3;
    };
    return priority(left) - priority(right);
  });
  const directCaptions = new Map<string, File[]>();
  const directCaptionTargetByPairKey = new Map<string, string>();
  for (const input of normalizedInputs) {
    if (!input.file || isImportArchiveFile(input.file) || resolveProjectAssetKind(input.file.name, input.file.type) !== 'text') continue;
    const path = input.relativePath || input.file.name;
    if (getArchiveExtension(path) !== '.txt') continue;
    const key = getImportPairKey(path);
    directCaptions.set(key, [...(directCaptions.get(key) ?? []), input.file]);
  }
  Object.assign(summary, summarizeImportPairPaths(normalizedInputs.filter((input) => input.file && !isImportArchiveFile(input.file))
    .map((input) => input.relativePath || input.file!.name)));
  let skippedCount = 0;

  if (files.length === 0) {
    return { importedImages, importedAssets, skippedCount, summary };
  }

  const destinationLabel = options.destination?.explorerPath
    ? ` into /${toProjectRelativePath(options.destination.explorerPath) || ''}`
    : '';
  logger.info(`starting asset import from ${files.length} selected file${files.length !== 1 ? 's' : ''}${destinationLabel}`);

  for (let i = 0; i < orderedInputs.length; i++) {
    options.signal?.throwIfAborted();
    const input = orderedInputs[i];
    if (input.directoryPath) {
      await createImportDirectory(options.destination, input.directoryPath);
      await options.onDirectoryImported?.(input.directoryPath);
      await options.onProgress?.(i + 1, files.length);
      await yieldToUi();
      continue;
    }
    if (!input.file) {
      continue;
    }
    const file = input.file;
    try {
      if (isImportArchiveFile(file)) {
        const archiveResult = await processArchiveFile(
          file,
          options.destination,
          logger,
          reservedNamesByDirectory,
          options.onImageImported,
          options.onAssetImported,
          options.signal
        );
        importedImages.push(...archiveResult.importedImages);
        importedAssets.push(...archiveResult.importedAssets);
        mergeImportPairSummary(summary, archiveResult.summary);
      } else {
        const kind = resolveProjectAssetKind(file.name, file.type);
        const originalPath = input.relativePath || file.name;
        const captionEntries = kind === 'image' ? directCaptions.get(getImportPairKey(input.relativePath || file.name)) ?? [] : [];
        if (captionEntries.length > 1) logger.warning(`conflicting captions for ${input.relativePath || file.name}; caption was not attached`);
        const tags = captionEntries.length === 1 ? parseCaptionText(await captionEntries[0].text()).tags : undefined;
        const pairedTargetPath = kind === 'text' ? directCaptionTargetByPairKey.get(getImportPairKey(originalPath)) : undefined;
        const importFile = pairedTargetPath
          ? new File([file], getArchiveFileName(pairedTargetPath), { type: file.type || 'text/plain', lastModified: file.lastModified })
          : file;
        const { sourceImage, asset } = await processImportedFile(
          importFile,
          pairedTargetPath ?? input.relativePath,
          tags,
          options.destination,
          logger,
          reservedNamesByDirectory,
          { reserveCaptionSidecar: kind === 'image' && captionEntries.length === 1, useReservedTarget: Boolean(pairedTargetPath) }
        );
        if (asset) {
          importedAssets.push(asset);
          if (kind === 'image') {
            directCaptionTargetByPairKey.set(
              getImportPairKey(originalPath),
              getCaptionPathForImage(joinPath(getParentPath(originalPath), asset.fileName))
            );
          }
          await options.onAssetImported?.(asset);
        }
        if (sourceImage) {
          importedImages.push(sourceImage);
          await options.onImageImported?.(sourceImage, asset ?? undefined);
        } else if (!asset) {
          skippedCount += 1;
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      logger.error(`failed to process ${file.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
      summary.errors += 1;
      options.onError?.(file.name, error);
    }

    const current = i + 1;
    options.onProgress?.(current, files.length);
    if (shouldLogProgress(current, files.length)) {
      logger.progress({ current, total: files.length, label: 'processed selections' });
    }
    await yieldToUi();
  }

  options.signal?.throwIfAborted();
  if (skippedCount > 0) {
    logger.warning(`${skippedCount} unsupported file${skippedCount !== 1 ? 's' : ''} skipped`);
  }

  if (importedImages.length > 0) {
    logger.success(`completed: imported ${importedAssets.length || importedImages.length} asset${(importedAssets.length || importedImages.length) !== 1 ? 's' : ''}`);
  } else {
    logger.warning('completed with no assets imported');
  }

  return { importedImages, importedAssets, skippedCount, summary };
};

type FilePickerWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      excludeAcceptAllOption?: boolean;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };

type ImportDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
};

const joinImportPath = (...parts: string[]): string => parts.filter(Boolean).join('/');

const readImportDirectoryFiles = async (
  directory: ImportDirectoryHandle,
  parentPath = ''
): Promise<ImportInputFile[]> => {
  const directoryPath = joinImportPath(parentPath, directory.name);
  const inputs: ImportInputFile[] = [{ directoryPath }];

  for await (const [entryName, entry] of directory.entries()) {
    if ('entries' in entry) {
      inputs.push(...await readImportDirectoryFiles(entry as ImportDirectoryHandle, directoryPath));
    } else {
      const file = await (entry as FileSystemFileHandle).getFile();
      inputs.push({ file, relativePath: joinImportPath(directoryPath, entryName) });
    }
  }

  return inputs;
};

export const pickImportFiles = async (): Promise<ImportInputFile[]> => {
  const pickerWindow = window as FilePickerWindow;
  if (!pickerWindow.showOpenFilePicker) {
    throw new Error('File picker is not available in this browser.');
  }

  const handles = await pickerWindow.showOpenFilePicker({
    multiple: true,
    excludeAcceptAllOption: false,
    types: [
      {
        description: 'Project assets',
        accept: {
          'image/*': ['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp'],
          'text/plain': ['.txt'],
          'application/json': ['.json'],
          'image/vnd.adobe.photoshop': ['.psd'],
          'video/*': ['.mp4', '.webm'],
        },
      },
    ],
  });
  return Promise.all(handles.map((handle) => handle.getFile()));
};

export const pickImportDirectory = async (): Promise<ImportInputFile[]> => {
  const pickerWindow = window as FilePickerWindow;
  if (!pickerWindow.showDirectoryPicker) {
    throw new Error('Folder picker is not available in this browser.');
  }

  const directory = await pickerWindow.showDirectoryPicker({ mode: 'read' });
  return readImportDirectoryFiles(directory as ImportDirectoryHandle);
};
