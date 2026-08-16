import { getExplorerFileKind, readExplorerFile } from '../services/project/explorerFileService';
import { appLog } from '../services/logging/applicationLog';
import {
  getOrCreateProjectPreviewUrl,
  readProjectPreviewUrl,
  type ProjectDirectoryHandle,
} from '../services/project/projectDirectoryService';
import { requestPhotopeaPsdPreview } from '../services/psd/photopeaPreviewQueue';
import { createPsdPreview } from '../services/psd/psdPreviewService';
import { filterLegacyProjectAssetPaths, LEGACY_PROJECT_ROOT_DIRECTORY_NAMES } from '../services/project/projectPathFilters';
import type { WorkspaceFileAsset } from './workspaceImages';

type WorkspaceFileAssetKind = WorkspaceFileAsset['kind'];

const REVIEW_FILE_KINDS = new Set<WorkspaceFileAssetKind>(['video', 'psd']);
const INTERNAL_DIRECTORY_NAMES = new Set(['.cache', '.dataset-creator-data']);
const PSD_PREVIEW_CONCURRENCY = 3;
type PsdPreviewUpdate = Pick<WorkspaceFileAsset, 'previewUrl' | 'previewStatus' | 'width' | 'height'>;
const pendingPsdPreviewByRoot = new WeakMap<ProjectDirectoryHandle, Map<string, Promise<PsdPreviewUpdate>>>();

const getFileName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

const readImageDimensions = (src: string): Promise<{ width: number; height: number } | undefined> =>
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : undefined
      );
    };
    image.onerror = () => resolve(undefined);
    image.src = src;
  });

const readImageBlobDimensions = async (blob: Blob): Promise<{ width: number; height: number } | undefined> => {
  const url = URL.createObjectURL(blob);
  try {
    return await readImageDimensions(url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

const getPendingPsdPreviewMap = (root: ProjectDirectoryHandle): Map<string, Promise<PsdPreviewUpdate>> => {
  const existing = pendingPsdPreviewByRoot.get(root);
  if (existing) {
    return existing;
  }

  const next = new Map<string, Promise<PsdPreviewUpdate>>();
  pendingPsdPreviewByRoot.set(root, next);
  return next;
};

const createWorkspacePsdPreview = async (
  root: ProjectDirectoryHandle,
  asset: WorkspaceFileAsset
): Promise<PsdPreviewUpdate> => {
  const psdPreview = await createPsdPreview(asset.file) ?? await requestPhotopeaPsdPreview(asset.file, asset.path);
  if (!psdPreview) {
    appLog.warning(`PSD preview: unavailable for ${asset.path}`);
    return { previewStatus: 'failed', previewUrl: undefined, width: undefined, height: undefined };
  }

  const previewDimensions = await readImageBlobDimensions(psdPreview);
  const previewUrl = await getOrCreateProjectPreviewUrl(root, 'psd', asset.path, psdPreview);
  if (!previewUrl) {
    appLog.warning(`PSD preview: cache write failed for ${asset.path}`);
    return { previewStatus: 'failed', previewUrl: undefined, width: undefined, height: undefined };
  }

  appLog.success(`PSD preview: ready for ${asset.path}`);
  return {
    previewUrl,
    previewStatus: undefined,
    width: previewDimensions?.width,
    height: previewDimensions?.height,
  };
};

const getOrCreateWorkspacePsdPreview = (
  root: ProjectDirectoryHandle,
  asset: WorkspaceFileAsset
): Promise<PsdPreviewUpdate> => {
  const pendingByPath = getPendingPsdPreviewMap(root);
  const pending = pendingByPath.get(asset.path);
  if (pending) {
    return pending;
  }

  const promise = createWorkspacePsdPreview(root, asset).finally(() => {
    pendingByPath.delete(asset.path);
  });
  pendingByPath.set(asset.path, promise);
  return promise;
};

const collectAssetPaths = async (
  directory: ProjectDirectoryHandle,
  parentPath = 'Project'
): Promise<string[]> => {
  const paths: string[] = [];

  for await (const [entryName, entry] of directory.entries()) {
    if (INTERNAL_DIRECTORY_NAMES.has(entryName) || (parentPath === 'Project' && LEGACY_PROJECT_ROOT_DIRECTORY_NAMES.has(entryName.toLowerCase()))) {
      continue;
    }

    const path = `${parentPath}/${entryName}`;
    if ('entries' in entry) {
      paths.push(...await collectAssetPaths(entry, path));
      continue;
    }

    const kind = getExplorerFileKind(entryName);
    if (REVIEW_FILE_KINDS.has(kind as WorkspaceFileAssetKind)) {
      paths.push(path);
    }
  }

  return paths;
};

export const collectWorkspaceFileAssets = async (
  root: ProjectDirectoryHandle,
  paths?: string[]
): Promise<WorkspaceFileAsset[]> => {
  const requestedAssetPaths = paths ? [...new Set(paths)] : await collectAssetPaths(root);
  const assetPaths = paths ? filterLegacyProjectAssetPaths(requestedAssetPaths) : requestedAssetPaths;
  const filteredCount = requestedAssetPaths.length - assetPaths.length;
  if (filteredCount > 0) {
    appLog.info(`Assets: skipped ${filteredCount} legacy asset path${filteredCount !== 1 ? 's' : ''}`);
  }
  const assets: WorkspaceFileAsset[] = [];

  for (const path of assetPaths) {
    try {
      const fileName = getFileName(path);
      const file = await readExplorerFile(root, path);
      const kind = getExplorerFileKind(fileName, 'type' in file ? file.type : undefined);
      if (!REVIEW_FILE_KINDS.has(kind as WorkspaceFileAssetKind)) {
        continue;
      }

      let previewUrl = kind === 'psd' ? await readProjectPreviewUrl(root, 'psd', path) : undefined;
      const previewDimensions = previewUrl ? await readImageDimensions(previewUrl) : undefined;

      assets.push({
        id: `asset:${path}`,
        path,
        fileName,
        kind: kind as WorkspaceFileAssetKind,
        file,
        previewUrl,
        width: previewDimensions?.width,
        height: previewDimensions?.height,
      });
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn(`[workspace-assets] unable to read ${path}`, error);
      }
    }
  }

  return assets;
};

export const generateMissingWorkspacePsdPreviews = async (
  root: ProjectDirectoryHandle,
  assets: WorkspaceFileAsset[],
  onUpdate: (
    path: string,
    update: Pick<WorkspaceFileAsset, 'previewUrl' | 'previewStatus' | 'width' | 'height'>
  ) => void,
  isCanceled: () => boolean = () => false
): Promise<void> => {
  const pendingAssets = assets.filter((asset) => asset.kind === 'psd' && !asset.previewUrl);
  if (pendingAssets.length === 0) {
    return;
  }

  appLog.info(`PSD preview: generating ${pendingAssets.length} missing preview${pendingAssets.length !== 1 ? 's' : ''}`);

  const generatePreview = async (asset: WorkspaceFileAsset) => {
    if (isCanceled()) {
      return;
    }

    try {
      onUpdate(asset.path, { previewStatus: 'generating' });
      const update = await getOrCreateWorkspacePsdPreview(root, asset);
      if (isCanceled()) {
        return;
      }

      onUpdate(asset.path, update);
    } catch (error) {
      onUpdate(asset.path, { previewStatus: 'failed', previewUrl: undefined, width: undefined, height: undefined });
      appLog.warning(`PSD preview: failed for ${asset.path}`);
      if (import.meta.env.DEV) {
        console.warn(`[psd-preview] unable to create preview for ${asset.path}`, error);
      }
    }
  };

  let nextIndex = 0;
  const runWorker = async () => {
    while (!isCanceled()) {
      const asset = pendingAssets[nextIndex];
      nextIndex += 1;
      if (!asset) {
        return;
      }
      await generatePreview(asset);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PSD_PREVIEW_CONCURRENCY, pendingAssets.length) }, () => runWorker())
  );
};
