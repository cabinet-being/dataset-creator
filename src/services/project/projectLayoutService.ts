import type { ProjectDirectoryHandle } from './projectDirectoryService';
import type { ProjectState, ProjectType } from '../../types';
import { isSupportedProjectAsset } from './assetTypeService';

export const PROJECT_MANIFEST_FILE = 'manifest.json';
export const DATASET_MANIFEST_FILE = 'dataset.json';
export const PROJECT_DATASET_DIRECTORY = 'dataset';
export const PROJECT_SOURCE_DIRECTORY = 'src';
export const PROJECT_SHARED_DIRECTORY = 'src/shared';
export const PROJECT_ASSETS_DIRECTORY = 'src/assets';
export const PROJECT_CACHE_DIRECTORY = '.cache';
export const PROJECT_GIT_DIRECTORY = '.git';

export const REQUIRED_PROJECT_DIRECTORIES = [
  PROJECT_GIT_DIRECTORY,
  PROJECT_CACHE_DIRECTORY,
  PROJECT_DATASET_DIRECTORY,
  PROJECT_SOURCE_DIRECTORY,
  PROJECT_SHARED_DIRECTORY,
  PROJECT_ASSETS_DIRECTORY,
] as const;

export type DatasetTrainingSettings = {
  epochs?: number;
  repeats?: number;
  alpha?: number;
  dim?: number;
};

export type DatasetManifest = {
  format: 'dataset-creator-dataset';
  version: 2 | 3;
  name: string;
  projectType: ProjectType;
  description: string;
  triggerWord: string;
  imageCount: number;
  classCount: number;
  classRepeats: Record<string, number>;
  training?: DatasetTrainingSettings;
  updatedAt: string;
  assetIds?: string[];
  assetPaths?: string[];
  psdAssetPaths?: string[];
  assetOrder?: string[];
  overwriteCaptions?: boolean;
  captionOverrides?: Record<string, string[]>;
  createdAt?: string;
};

const pathParts = (path: string): string[] => path.split('/').filter(Boolean);

const joinPath = (...parts: string[]): string => parts.flatMap(pathParts).join('/');

const collectDatasetAssetPaths = async (
  directory: ProjectDirectoryHandle,
  relativePath = PROJECT_DATASET_DIRECTORY
): Promise<string[]> => {
  const assetPaths: string[] = [];

  for await (const [entryName, entry] of directory.entries()) {
    if ('entries' in entry) {
      assetPaths.push(...await collectDatasetAssetPaths(entry, joinPath(relativePath, entryName)));
      continue;
    }
    if (isSupportedProjectAsset(entryName)) {
      assetPaths.push(`Project/${joinPath(relativePath, entryName)}`);
    }
  }

  return assetPaths;
};

const writeTextFile = async (directory: ProjectDirectoryHandle, name: string, value: string) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
};

export const getDirectoryAtPath = async (
  root: ProjectDirectoryHandle,
  path: string,
  create = false
): Promise<ProjectDirectoryHandle> => {
  let directory = root;
  for (const part of pathParts(path)) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return directory;
};

export const createDatasetManifest = (project: Pick<ProjectState, 'name' | 'projectType' | 'taggingConfig' | 'dataset'>): DatasetManifest => ({
  format: 'dataset-creator-dataset',
  version: 3,
  name: project.dataset.name || project.name,
  projectType: project.projectType,
  description: '',
  triggerWord: project.dataset.triggerWord || project.taggingConfig.datasetKeyword,
  imageCount: project.dataset.assetIds.length + project.dataset.assetPaths.length,
  classCount: 0,
  classRepeats: {},
  assetIds: project.dataset.assetIds,
  assetPaths: project.dataset.assetPaths,
  psdAssetPaths: project.dataset.psdAssetPaths,
  assetOrder: project.dataset.assetOrder,
  createdAt: project.dataset.createdAt.toISOString(),
  updatedAt: new Date().toISOString(),
});

export const readDatasetManifest = async (root: ProjectDirectoryHandle): Promise<DatasetManifest | null> => {
  try {
    const file = await (await root.getFileHandle(DATASET_MANIFEST_FILE)).getFile();
    const manifest = JSON.parse(await file.text()) as DatasetManifest;
    return manifest.format === 'dataset-creator-dataset' && (manifest.version === 2 || manifest.version === 3) ? manifest : null;
  } catch {
    return null;
  }
};

export const writeDatasetManifest = async (
  root: ProjectDirectoryHandle,
  manifest: DatasetManifest
): Promise<void> => writeTextFile(root, DATASET_MANIFEST_FILE, JSON.stringify(manifest, null, 2));

export const ensureProjectLayout = async (
  root: ProjectDirectoryHandle,
  project: Pick<ProjectState, 'name' | 'projectType' | 'taggingConfig' | 'dataset'>
): Promise<DatasetManifest> => {
  await Promise.all(REQUIRED_PROJECT_DIRECTORIES.map((path) => getDirectoryAtPath(root, path, true)));
  const existing = await readDatasetManifest(root);
  const needsAssetIndex = Boolean(existing && existing.version === 2 && existing.assetPaths === undefined && existing.assetIds === undefined);
  const indexedAssetPaths = needsAssetIndex
    ? await collectDatasetAssetPaths(await getDirectoryAtPath(root, PROJECT_DATASET_DIRECTORY))
    : [];
  const indexedPsdAssetPaths = indexedAssetPaths.filter((path) => path.toLowerCase().endsWith('.psd'));
  const manifest: DatasetManifest = existing
    ? {
        ...existing,
        name: existing.name || project.name,
        projectType: existing.projectType || project.projectType,
        triggerWord: existing.triggerWord ?? project.taggingConfig.datasetKeyword,
        version: 3,
        assetIds: existing.assetIds ?? (needsAssetIndex ? [] : project.dataset.assetIds),
        assetPaths: existing.assetPaths ?? (needsAssetIndex ? indexedAssetPaths : project.dataset.assetPaths),
        psdAssetPaths: existing.psdAssetPaths ?? (needsAssetIndex ? indexedPsdAssetPaths : project.dataset.psdAssetPaths),
        assetOrder: existing.assetOrder ?? (needsAssetIndex ? indexedAssetPaths.map((path) => `file:${path}`) : project.dataset.assetOrder),
        createdAt: existing.createdAt ?? project.dataset.createdAt.toISOString(),
      }
    : createDatasetManifest(project);
  if (!existing || needsAssetIndex || existing.version !== 3) {
    await writeDatasetManifest(root, manifest);
  }
  return manifest;
};

export const isProjectWorkspacePath = (path: string, workspace: 'dataset' | 'shared' | 'assets'): boolean => {
  const normalizedPath = path.replace(/^Project\//, '');
  const root = workspace === 'dataset'
    ? PROJECT_DATASET_DIRECTORY
    : workspace === 'shared'
      ? PROJECT_SHARED_DIRECTORY
      : PROJECT_ASSETS_DIRECTORY;
  return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
};
