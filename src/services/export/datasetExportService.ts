import JSZip from 'jszip';
import { getCaptionFileName } from '../caption/captionFileService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { PROJECT_DATASET_DIRECTORY } from '../project/projectLayoutService';
import { getProjectAssetExtension, isSupportedProjectAsset, resolveProjectAssetKind } from '../project/assetTypeService';
import type { OperationLogger } from '../logging/applicationLog';

export type DatasetExportAsset = {
  file: File;
  sourcePath: string;
  targetDirectory: string;
  /** Exact content of the caption TXT next to the image (trigger word already in it); null when there is none. */
  captionRaw: string | null;
};

const getPathParts = (path: string) => path.split('/').filter(Boolean);
const joinPath = (...parts: string[]) => parts.flatMap(getPathParts).join('/');

const readCaptionRawNextTo = async (directory: ProjectDirectoryHandle, imageName: string): Promise<string | null> => {
  const captionName = getCaptionFileName(imageName);
  if (!captionName) return null;
  try { return await (await directory.getFileHandle(captionName)).getFile().then((file) => file.text()); }
  catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return null;
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
    assets.push({
      file,
      sourcePath: joinPath(relativeDirectory, name),
      targetDirectory: getExportDirectory(relativeDirectory),
      captionRaw: await readCaptionRawNextTo(directory, name),
    });
  }
  return assets;
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
  logger?: OperationLogger
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
    // The dataset TXT is the caption as the trainer reads it: trigger word included, blacklist not applied.
    if (asset.captionRaw !== null) zip.file(`${relativePath}.txt`, asset.captionRaw);
    logger?.progress({ current: index + 1, total: assets.length, label: 'prepared dataset files' });
  }
  logger?.info('compressing dataset ZIP');
  return { blob: await zip.generateAsync({ type: 'blob' }), count: assets.length };
};
