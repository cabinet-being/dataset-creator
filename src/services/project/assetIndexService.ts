import { createSourceImage, type SourceImage } from '../../types';
import { createOperationLogger, shouldLogProgress, type OperationLogger } from '../logging/applicationLog';
import { getImageDimensions } from '../image/imageProcessor';
import { getAssetManifestName, getAssetManifestPath } from './assetManifestService';
import type { ProjectDirectoryFileHandle, ProjectDirectoryHandle } from './projectDirectoryService';
import { isInternalProjectFileName, isSupportedProjectAsset, resolveProjectAssetKind } from './assetTypeService';
import { snapshotFile } from './fileSnapshotService';

type IndexedAssetManifest = {
  id?: string;
  kind?: string;
  fileName?: string;
  originalFileName?: string;
  originalFilePath?: string;
  originalFileNameOnDisk?: string;
  assetPath?: string;
  sourceImageId?: string;
  imageDataPath?: string;
  psdDataPath?: string;
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

export type IndexProjectAssetsOptions = {
  logger?: OperationLogger;
  /** Project-relative files or directories. Undefined indexes the project; an empty array indexes nothing. */
  paths?: string[];
  existingSourceImages?: Record<string, SourceImage>;
  onAssetIndexed?: (update: ProjectAssetIndexUpdate) => void | Promise<void>;
  onProgress?: (current: number, total: number) => void;
};

const INTERNAL_DIRECTORY_NAMES = new Set(['.cache', '.dataset-creator-data', '.git']);

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
      if (!INTERNAL_DIRECTORY_NAMES.has(entryName)) {
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

const normalizeScopePath = (path: string): string => path
  .replace(/\\/g, '/')
  .replace(/^\/+|\/+$/g, '')
  .replace(/^Project(?:\/|$)/, '');

const normalizeScopePaths = (paths: string[]): string[] => {
  const normalized = [...new Set(paths.map(normalizeScopePath).filter(Boolean))].sort((a, b) => a.length - b.length);
  return normalized.filter((path, index) => !normalized.slice(0, index).some(parent => path === parent || path.startsWith(`${parent}/`)));
};

const collectScopedAssetFiles = async (
  root: ProjectDirectoryHandle,
  paths: string[]
): Promise<Array<{ directory: ProjectDirectoryHandle; handle: ProjectDirectoryFileHandle; assetPath: string }>> => {
  const assets = new Map<string, { directory: ProjectDirectoryHandle; handle: ProjectDirectoryFileHandle; assetPath: string }>();
  for (const assetPath of normalizeScopePaths(paths)) {
    const parts = assetPath.split('/');
    const name = parts.pop();
    if (!name) continue;
    let parent = root;
    try {
      for (const part of parts) parent = await parent.getDirectoryHandle(part);
      try {
        const handle = await parent.getFileHandle(name);
        if (isSupportedProjectAsset(name)) assets.set(assetPath, { directory: parent, handle, assetPath });
      } catch {
        const directory = await parent.getDirectoryHandle(name);
        for (const entry of await collectAssetFiles(directory, assetPath)) assets.set(entry.assetPath, entry);
      }
    } catch {
      // A scoped path may disappear between a completed filesystem operation and indexing.
    }
  }
  return [...assets.values()];
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
  const assetFiles = options.paths === undefined
    ? await collectAssetFiles(root)
    : await collectScopedAssetFiles(root, options.paths);
  logger.info(`Discovered ${assetFiles.length} supported file${assetFiles.length !== 1 ? 's' : ''}`);

  for (let index = 0; index < assetFiles.length; index += 1) {
    const { directory, handle, assetPath } = assetFiles[index];
    const existingSource = existingByPath.get(assetPath);
    const manifestName = getAssetManifestName(handle.name);
    const existingManifest = await readOptionalManifest(directory, manifestName);
    const kind = resolveProjectAssetKind(handle.name, existingManifest?.mimeType ?? '');
    const isRegisteredEditedAsset =
      typeof existingManifest?.sourceImageId === 'string' &&
      (existingManifest.imageDataPath === assetPath || existingManifest.psdDataPath === assetPath);
    const manifestIdOwner = typeof existingManifest?.id === 'string'
      ? existingById.get(existingManifest.id)
      : undefined;
    const manifestIdentityConflict =
      kind === 'image' &&
      Boolean(manifestIdOwner) &&
      manifestIdOwner?.originalFilePath !== assetPath;
    let sourceImage: SourceImage | undefined;
    let file: File | undefined;

    if (kind === 'image' && !existingSource && !isRegisteredEditedAsset) {
      file = await snapshotFile(await handle.getFile());
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
      (existingManifest?.assetPath === assetPath || existingManifest?.originalFilePath === assetPath || isRegisteredEditedAsset) &&
      !manifestIdentityConflict;
    if (!manifestValid) {
      file ??= await handle.getFile();
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
