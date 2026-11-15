import { getCaptionFileName } from '../caption/captionFileService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { PROJECT_DATASET_DIRECTORY } from '../project/projectLayoutService';
import { isSupportedProjectAsset, resolveProjectAssetKind } from '../project/assetTypeService';

export type DatasetExportAsset = {
  file: File;
  sourcePath: string;
  /** Folder of the file inside dataset/ ('' for the root); exports keep the whole sub-folder structure. */
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
      targetDirectory: relativeDirectory,
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
