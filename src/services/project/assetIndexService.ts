import { createSourceImage, type SourceImage } from '../../types';
import { createOperationLogger, shouldLogProgress, type OperationLogger } from '../logging/applicationLog';
import { getImageDimensions } from '../image/imageProcessor';
import { getAssetManifestName, getAssetManifestPath } from './assetManifestService';
import type { ProjectDirectoryFileHandle, ProjectDirectoryHandle } from './projectDirectoryService';
import { isInternalProjectFileName, isSupportedProjectAsset, resolveProjectAssetKind } from './assetTypeService';
import { snapshotFile } from './fileSnapshotService';
import { LEGACY_PROJECT_ROOT_DIRECTORY_NAMES } from './projectPathFilters';
import { PROJECT_SHARED_DIRECTORY } from './projectLayoutService';

type IndexedAssetManifest = {
  id?: string;
  kind?: string;
  fileName?: string;
  originalFileName?: string;
  originalFilePath?: string;
  originalFileNameOnDisk?: string;
  assetPath?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  tags?: string[];
  createdAt?: string;
};

export type ProjectAssetIndexUpdate = {
  sourceImage?: SourceImage;
  assetPath: string;
  manifestCreated: boolean;
};

export type ProjectAssetIndexResult = {
  discoveredCount: number;
  indexedCount: number;
  createdManifestCount: number;
};

type IndexProjectAssetsOptions = {
  logger?: OperationLogger;
  existingSourceImages?: Record<string, SourceImage>;
  onAssetIndexed?: (update: ProjectAssetIndexUpdate) => void | Promise<void>;
  onProgress?: (current: number, total: number) => void;
};

const INTERNAL_DIRECTORY_NAMES = new Set(['.cache', '.dataset-creator-data']);

const yieldToUi = async () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const joinPath = (...parts: string[]): string => parts.filter(Boolean).join('/');

const writeTextFile = async (directory: ProjectDirectoryHandle, name: string, value: string) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
};

const readOptionalManifest = async (
  directory: ProjectDirectoryHandle,
  manifestName: string
): Promise<IndexedAssetManifest | null> => {
  try {
    const text = await (await directory.getFileHandle(manifestName)).getFile().then((file) => file.text());
    return JSON.parse(text) as IndexedAssetManifest;
  } catch {
    return null;
  }
};

const writeGenericAssetManifest = async (
  directory: ProjectDirectoryHandle,
  file: File,
  assetPath: string,
  sourceImage?: SourceImage
) => {
  const manifest = {
    id: sourceImage?.id ?? crypto.randomUUID(),
    kind: resolveProjectAssetKind(file.name, file.type),
    fileName: sourceImage?.fileName ?? file.name,
    originalFileName: file.name,
    originalFilePath: sourceImage?.originalFilePath,
    originalFileNameOnDisk: sourceImage ? file.name : undefined,
    assetPath,
    mimeType: file.type,
    size: file.size,
    width: sourceImage?.width,
    height: sourceImage?.height,
    tags: sourceImage?.tags,
    createdAt: sourceImage?.createdAt.toISOString() ?? new Date().toISOString(),
  };
  await writeTextFile(directory, getAssetManifestName(file.name), JSON.stringify(manifest, null, 2));
};

const collectAssetFiles = async (
  directory: ProjectDirectoryHandle,
  relativeDirectory = ''
): Promise<Array<{ directory: ProjectDirectoryHandle; handle: ProjectDirectoryFileHandle; assetPath: string }>> => {
  const assets: Array<{ directory: ProjectDirectoryHandle; handle: ProjectDirectoryFileHandle; assetPath: string }> = [];

  for await (const [entryName, entry] of directory.entries()) {
    if (isInternalProjectFileName(entryName)) {
      continue;
    }
    if ('entries' in entry) {
      if (!INTERNAL_DIRECTORY_NAMES.has(entryName) && !(relativeDirectory === '' && LEGACY_PROJECT_ROOT_DIRECTORY_NAMES.has(entryName.toLowerCase()))) {
        assets.push(...await collectAssetFiles(entry, joinPath(relativeDirectory, entryName)));
      }
      continue;
    }
    if (isSupportedProjectAsset(entryName)) {
      assets.push({ directory, handle: entry, assetPath: joinPath(relativeDirectory, entryName) });
    }
  }

  return assets;
};

export const indexProjectAssets = async (
  root: ProjectDirectoryHandle,
  options: IndexProjectAssetsOptions = {}
): Promise<ProjectAssetIndexResult> => {
  const logger = options.logger ?? createOperationLogger('Index');
  const existingByPath = new Map(
    Object.values(options.existingSourceImages ?? {})
      .filter((source) => source.originalFilePath)
      .map((source) => [source.originalFilePath as string, source])
  );
  const existingById = new Map(
    Object.values(options.existingSourceImages ?? {}).map((source) => [source.id, source])
  );
  let indexedCount = 0;
  let createdManifestCount = 0;

  logger.info('Indexing project...');
  let sharedDirectory: ProjectDirectoryHandle;
  try {
    sharedDirectory = await PROJECT_SHARED_DIRECTORY
      .split('/')
      .filter(Boolean)
      .reduce<Promise<ProjectDirectoryHandle>>(
        async (currentDirectory, part) => (await currentDirectory).getDirectoryHandle(part),
        Promise.resolve(root)
      );
  } catch {
    logger.warning('Shared workspace is unavailable; no global assets were indexed.');
    return { discoveredCount: 0, indexedCount: 0, createdManifestCount: 0 };
  }
  const assetFiles = await collectAssetFiles(sharedDirectory, PROJECT_SHARED_DIRECTORY);
  logger.info(`Discovered ${assetFiles.length} supported file${assetFiles.length !== 1 ? 's' : ''}`);

  for (let index = 0; index < assetFiles.length; index += 1) {
    const { directory, handle, assetPath } = assetFiles[index];
    const file = await snapshotFile(await handle.getFile());
    const existingSource = existingByPath.get(assetPath);
    const manifestName = getAssetManifestName(file.name);
    const existingManifest = await readOptionalManifest(directory, manifestName);
    const kind = resolveProjectAssetKind(file.name, file.type);
    const manifestIdOwner = typeof existingManifest?.id === 'string'
      ? existingById.get(existingManifest.id)
      : undefined;
    const manifestIdentityConflict =
      kind === 'image' &&
      Boolean(manifestIdOwner) &&
      manifestIdOwner?.originalFilePath !== assetPath;
    let sourceImage: SourceImage | undefined;

    if (kind === 'image' && !existingSource) {
      const { width, height } = await getImageDimensions(file);
      const id = manifestIdentityConflict ? undefined : existingManifest?.id;
      sourceImage = createSourceImage(file, file.name, width, height, URL.createObjectURL(file));
      if (id) {
        sourceImage.id = id;
        sourceImage.fileName = existingManifest?.fileName ?? sourceImage.fileName;
      }
      sourceImage.originalFileName = existingManifest?.originalFileName ?? file.name;
      sourceImage.originalFilePath = assetPath;
      sourceImage.manifestPath = getAssetManifestPath(assetPath);
      sourceImage.tags = existingManifest?.tags;
      sourceImage.createdAt = existingManifest?.createdAt ? new Date(existingManifest.createdAt) : sourceImage.createdAt;
    }

    const manifestValid =
      Boolean(existingManifest?.id) &&
      (existingManifest?.assetPath === assetPath || existingManifest?.originalFilePath === assetPath) &&
      !manifestIdentityConflict;
    if (!manifestValid) {
      await writeGenericAssetManifest(directory, file, assetPath, sourceImage ?? existingSource);
      createdManifestCount += 1;
    }

    if (sourceImage || !manifestValid) {
      await options.onAssetIndexed?.({
        sourceImage,
        assetPath,
        manifestCreated: !manifestValid,
      });
    }

    if (sourceImage) {
      existingByPath.set(assetPath, sourceImage);
      existingById.set(sourceImage.id, sourceImage);
    }

    indexedCount += 1;
    const current = index + 1;
    options.onProgress?.(current, assetFiles.length);
    if (shouldLogProgress(current, assetFiles.length)) {
      logger.progress({ current, total: assetFiles.length, label: 'indexed assets' });
    }
    if (current % 10 === 0) {
      await yieldToUi();
    }
  }

  logger.success(`Project index ready: ${indexedCount} asset${indexedCount !== 1 ? 's' : ''}`);
  return {
    discoveredCount: assetFiles.length,
    indexedCount,
    createdManifestCount,
  };
};
