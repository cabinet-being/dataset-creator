import { createDataset, type Dataset } from '../../types';
import type { ProjectDirectoryHandle } from './projectDirectoryService';
import { normalizeDatasetAssetOrder } from '../../lib/datasetAssets';
import { filterLegacyProjectAssetPaths } from './projectPathFilters';

export const DATASET_FILE_SUFFIX = '.dataset.json';
export const DATASET_FILE_FORMAT = 'dataset-creator-dataset';

type DatasetFileManifest = {
  format: typeof DATASET_FILE_FORMAT;
  version: 1;
  id: string;
  name: string;
  triggerWord: string;
  assetIds: string[];
  assetPaths?: string[];
  psdAssetPaths?: string[];
  assetOrder?: string[];
  overwriteCaptions?: boolean;
  captionOverrides?: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
};

const getPathParts = (path: string): string[] => path.split('/').filter(Boolean).slice(1);
const getParentPath = (path: string): string => path.split('/').slice(0, -1).join('/') || 'Project';
const getFileName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;
const getPsdAssetPaths = (paths: string[] = []): string[] =>
  filterLegacyProjectAssetPaths(paths).filter((path) => path.toLowerCase().endsWith('.psd'));

export const isDatasetFileName = (name: string): boolean =>
  name.toLowerCase().endsWith(DATASET_FILE_SUFFIX);

export const getDatasetFileName = (name: string): string =>
  `${name.trim() || 'New Dataset'}${DATASET_FILE_SUFFIX}`;

export const getDatasetDisplayName = (fileName: string): string =>
  isDatasetFileName(fileName) ? fileName.slice(0, -DATASET_FILE_SUFFIX.length) : fileName;

export const getDirectoryAtDatasetPath = async (
  root: ProjectDirectoryHandle,
  path: string
): Promise<ProjectDirectoryHandle> => {
  let directory = root;
  const parts = getPathParts(getParentPath(path));
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory;
};

const writeTextFile = async (directory: ProjectDirectoryHandle, name: string, value: string) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
};

export const serializeDatasetFile = (dataset: Dataset): string => {
  const assetPaths = filterLegacyProjectAssetPaths([
    ...new Set([...(dataset.assetPaths ?? []), ...(dataset.psdAssetPaths ?? [])]),
  ]);
  const psdAssetPaths = filterLegacyProjectAssetPaths([
    ...new Set([...(dataset.psdAssetPaths ?? []), ...getPsdAssetPaths(assetPaths)]),
  ]);

  return JSON.stringify(
    {
      format: DATASET_FILE_FORMAT,
      version: 1,
      id: dataset.id,
      name: dataset.name,
      triggerWord: dataset.triggerWord,
      assetIds: dataset.assetIds,
      assetPaths,
      psdAssetPaths,
      assetOrder: normalizeDatasetAssetOrder(dataset.assetOrder, dataset.assetIds, assetPaths),
      createdAt: dataset.createdAt.toISOString(),
      updatedAt: dataset.updatedAt.toISOString(),
    } satisfies DatasetFileManifest,
    null,
    2
  );
};

export const readDatasetFile = async (
  root: ProjectDirectoryHandle,
  path: string
): Promise<Dataset> => {
  const directory = await getDirectoryAtDatasetPath(root, path);
  const file = await (await directory.getFileHandle(getFileName(path))).getFile();
  const manifest = JSON.parse(await file.text()) as DatasetFileManifest;
  if (manifest.format !== DATASET_FILE_FORMAT || manifest.version !== 1) {
    throw new Error('Unsupported Dataset file.');
  }

  const assetIds = manifest.assetIds ?? [];
  const assetPaths = filterLegacyProjectAssetPaths([...new Set([...(manifest.assetPaths ?? []), ...(manifest.psdAssetPaths ?? [])])]);
  const psdAssetPaths = filterLegacyProjectAssetPaths([
    ...new Set([...(manifest.psdAssetPaths ?? []), ...getPsdAssetPaths(assetPaths)]),
  ]);

  return {
    id: manifest.id,
    name: getDatasetDisplayName(file.name),
    parentPath: getParentPath(path),
    filePath: path,
    triggerWord: manifest.triggerWord ?? '',
    assetIds,
    assetPaths,
    psdAssetPaths,
    assetOrder: normalizeDatasetAssetOrder(manifest.assetOrder, assetIds, assetPaths),
    createdAt: new Date(manifest.createdAt),
    updatedAt: new Date(manifest.updatedAt),
  };
};

export const writeDatasetFile = async (
  root: ProjectDirectoryHandle,
  dataset: Dataset
) => {
  if (!dataset.filePath) {
    throw new Error('Dataset file path is missing.');
  }
  const directory = await getDirectoryAtDatasetPath(root, dataset.filePath);
  await writeTextFile(directory, getFileName(dataset.filePath), serializeDatasetFile(dataset));
};

export const createDatasetForFile = (name: string, filePath: string): Dataset => ({
  ...createDataset(name),
  name,
  parentPath: getParentPath(filePath),
  filePath,
});
