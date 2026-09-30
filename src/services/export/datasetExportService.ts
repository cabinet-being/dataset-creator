import JSZip from 'jszip';
import { getAssetManifestName } from '../project/assetManifestService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { DATASET_MANIFEST_FILE, PROJECT_DATASET_DIRECTORY, readDatasetManifest, writeDatasetManifest } from '../project/projectLayoutService';
import { getProjectAssetExtension, isSupportedProjectAsset, resolveProjectAssetKind } from '../project/assetTypeService';
import type { OperationLogger } from '../logging/applicationLog';

type DatasetAssetMetadata = {
  tags?: string[];
  caption?: string;
};

export type DatasetExportAsset = {
  file: File;
  sourcePath: string;
  targetDirectory: string;
  tags: string[];
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
  } catch {
    return {};
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
    if (!isSupportedProjectAsset(name) || resolveProjectAssetKind(name) !== 'image') {
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
  try {
    return await collectDatasetAssets(await root.getDirectoryHandle(PROJECT_DATASET_DIRECTORY));
  } catch {
    return [];
  }
};

export const syncProjectDatasetManifest = async (root: ProjectDirectoryHandle): Promise<DatasetExportAsset[]> => {
  const manifest = await readDatasetManifest(root);
  if (!manifest) {
    throw new Error(`${DATASET_MANIFEST_FILE} is missing or invalid.`);
  }
  const assets = await getProjectDatasetAssets(root);
  const classRepeats: Record<string, number> = {};
  for (const asset of assets) {
    if (!asset.targetDirectory) continue;
    const match = asset.targetDirectory.match(/^(\d+)_/);
    if (match) classRepeats[asset.targetDirectory] = Number(match[1]);
  }
  await writeDatasetManifest(root, {
    ...manifest,
    imageCount: assets.length,
    classCount: Object.keys(classRepeats).length,
    classRepeats,
    updatedAt: new Date().toISOString(),
  });
  return assets;
};

export const exportProjectDatasetAsZip = async (
  root: ProjectDirectoryHandle,
  blacklist: string[] = [],
  logger?: OperationLogger
): Promise<{ blob: Blob; count: number }> => {
  const manifest = await readDatasetManifest(root);
  if (!manifest) throw new Error(`${DATASET_MANIFEST_FILE} is missing or invalid.`);
  const assets = await syncProjectDatasetManifest(root);
  if (assets.length === 0) {
    throw new Error('The dataset directory contains no images to export.');
  }
  const zip = new JSZip();
  for (const [index, asset] of assets.entries()) {
    const order = String(index + 1);
    const extension = getProjectAssetExtension(asset.file.name) || 'png';
    const relativePath = asset.targetDirectory ? `${asset.targetDirectory}/${order}` : order;
    zip.file(`${relativePath}.${extension}`, await asset.file.arrayBuffer());
    zip.file(`${relativePath}.txt`, getCaption(asset.tags, manifest.triggerWord, blacklist));
    logger?.progress({ current: index + 1, total: assets.length, label: 'prepared dataset files' });
  }
  logger?.info('compressing dataset ZIP');
  return { blob: await zip.generateAsync({ type: 'blob' }), count: assets.length };
};
