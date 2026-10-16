import JSZip from 'jszip';
import { getAssetManifestName } from '../project/assetManifestService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { PROJECT_DATASET_DIRECTORY } from '../project/projectLayoutService';
import { getProjectAssetExtension, isSupportedProjectAsset, resolveProjectAssetKind } from '../project/assetTypeService';
import type { OperationLogger } from '../logging/applicationLog';

type DatasetAssetMetadata = {
  tags?: string[];
  caption?: string;
  excludedFromDataset?: boolean;
};

export type DatasetExportAsset = {
  file: File;
  sourcePath: string;
  targetDirectory: string;
  tags: string[];
  excludedFromDataset?: boolean;
};

const getPathParts = (path: string) => path.split('/').filter(Boolean);
const joinPath = (...parts: string[]) => parts.flatMap(getPathParts).join('/');

const readOptionalMetadata = async (
  directory: ProjectDirectoryHandle,
  fileName: string
): Promise<DatasetAssetMetadata> => {
  try {
    const metadataFile = await (await directory.getFileHandle(getAssetManifestName(fileName))).getFile();
    const metadata = JSON.parse(await metadataFile.text()) as DatasetAssetMetadata;
    return metadata;
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return {};
    throw error;
  }
};

const getExportDirectory = (relativeDirectory: string): string => {
  const [firstDirectory] = getPathParts(relativeDirectory);
  return firstDirectory && /^\d+_/.test(firstDirectory) ? firstDirectory : '';
};

const collectDatasetAssets = async (
  directory: ProjectDirectoryHandle,
  relativeDirectory = ''
): Promise<DatasetExportAsset[]> => {
  const assets: DatasetExportAsset[] = [];
  for await (const [name, entry] of directory.entries()) {
    if ('entries' in entry) {
      assets.push(...await collectDatasetAssets(entry, joinPath(relativeDirectory, name)));
      continue;
    }
    if (!isSupportedProjectAsset(name) || !['image', 'psd'].includes(resolveProjectAssetKind(name))) {
      continue;
    }
    const file = await entry.getFile();
    const metadata = await readOptionalMetadata(directory, name);
    const tags = metadata.caption
      ? metadata.caption.split(',').map((tag) => tag.trim()).filter(Boolean)
      : metadata.tags ?? [];
    assets.push({
      file,
      sourcePath: joinPath(relativeDirectory, name),
      targetDirectory: getExportDirectory(relativeDirectory),
      tags,
      excludedFromDataset: metadata.excludedFromDataset,
    });
  }
  return assets;
};

const getCaption = (tags: string[], triggerWord: string, blacklist: string[]) => {
  const blocked = new Set(blacklist.map((tag) => tag.trim().toLowerCase()));
  const seen = new Set<string>();
  const values = [triggerWord, ...tags]
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => !blocked.has(tag.toLowerCase()))
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return values.join(', ') + '\n';
};

export const getProjectDatasetAssets = async (root: ProjectDirectoryHandle): Promise<DatasetExportAsset[]> => {
  let directory: ProjectDirectoryHandle;
  try { directory = await root.getDirectoryHandle(PROJECT_DATASET_DIRECTORY); }
  catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return [];
    throw error;
  }
  return (await collectDatasetAssets(directory)).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, undefined, { numeric:true, sensitivity:'base' }));
};

export const syncProjectDatasetManifest = async (root: ProjectDirectoryHandle): Promise<DatasetExportAsset[]> => {
  return getProjectDatasetAssets(root);
};

export const exportProjectDatasetAsZip = async (
  root: ProjectDirectoryHandle,
  blacklist: string[] = [],
  logger?: OperationLogger,
  triggerWord = ''
): Promise<{ blob: Blob; count: number }> => {
  const assets = await getProjectDatasetAssets(root);
  if (assets.length === 0) {
    throw new Error('The dataset directory contains no images to export.');
  }
  const zip = new JSZip();
  for (const [index, asset] of assets.entries()) {
    const order = String(index + 1);
    const extension = getProjectAssetExtension(asset.file.name) || 'png';
    const relativePath = asset.targetDirectory ? `${asset.targetDirectory}/${order}` : order;
    zip.file(`${relativePath}.${extension}`, await asset.file.arrayBuffer());
    zip.file(`${relativePath}.txt`, getCaption(asset.tags, triggerWord, blacklist));
    logger?.progress({ current: index + 1, total: assets.length, label: 'prepared dataset files' });
  }
  logger?.info('compressing dataset ZIP');
  return { blob: await zip.generateAsync({ type: 'blob' }), count: assets.length };
};
