import { getExplorerFileKind, readExplorerFile } from '../services/project/explorerFileService';
import { appLog } from '../services/logging/applicationLog';
import {
  getOrCreateProjectPreviewUrl,
  readProjectPreviewUrl,
  type ProjectDirectoryHandle,
} from '../services/project/projectDirectoryService';
import { requestPhotopeaPsdPreview } from '../services/psd/photopeaPreviewQueue';
import { createPsdPreview } from '../services/psd/psdPreviewService';
import { createWorkspaceFileAssetId, type WorkspaceFileAsset } from './workspaceImages';
import { getAssetManifestPath } from '../services/project/assetManifestService';

type WorkspaceFileAssetKind = WorkspaceFileAsset['kind'];

const REVIEW_FILE_KINDS = new Set<WorkspaceFileAssetKind>(['video', 'psd']);
const INTERNAL_DIRECTORY_NAMES = new Set(['.cache', '.dataset-creator-data', '.git']);
const PSD_PREVIEW_CONCURRENCY = 3;
type PsdPreviewUpdate = Pick<WorkspaceFileAsset, 'previewUrl' | 'previewStatus' | 'width' | 'height'>;
const pendingPsdPreviewByRoot = new WeakMap<ProjectDirectoryHandle, Map<string, Promise<PsdPreviewUpdate>>>();
const workspaceAssetScanByRoot = new WeakMap<ProjectDirectoryHandle, Promise<WorkspaceFileAsset[]>>();
const workspaceAssetIssuesByRoot = new WeakMap<ProjectDirectoryHandle, string[]>();

export const getWorkspaceFileAssetIssues = (root: ProjectDirectoryHandle): string[] => [...(workspaceAssetIssuesByRoot.get(root) ?? [])];

export const invalidateWorkspaceFileAssetCache = (root: ProjectDirectoryHandle) => {
  workspaceAssetScanByRoot.delete(root);
  workspaceAssetIssuesByRoot.delete(root);
};

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
  parentPath = 'Project',
  issues: string[] = []
): Promise<string[]> => {
  const paths: string[] = [];

  for await (const [entryName, entry] of directory.entries()) {
    if (INTERNAL_DIRECTORY_NAMES.has(entryName)) {
      continue;
    }

    const path = `${parentPath}/${entryName}`;
    if ('entries' in entry) {
      try { paths.push(...await collectAssetPaths(entry, path, issues)); }
      catch { issues.push(`${path}: folder could not be read`); }
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
  let scan = workspaceAssetScanByRoot.get(root);
  if (!scan) {
    scan = (async () => {
      const issues: string[] = [];
      const assetPaths = await collectAssetPaths(root, 'Project', issues);
      const assets: WorkspaceFileAsset[] = [];

      for (const path of assetPaths) {
        try {
          const fileName = getFileName(path);
          const file = await readExplorerFile(root, path);
          const kind = getExplorerFileKind(fileName, 'type' in file ? file.type : undefined);
          if (!REVIEW_FILE_KINDS.has(kind as WorkspaceFileAssetKind)) continue;
          const previewUrl = kind === 'psd' ? await readProjectPreviewUrl(root, 'psd', path) : undefined;
          const previewDimensions = previewUrl ? await readImageDimensions(previewUrl) : undefined;
          let metadata: {tags?:unknown;caption?:unknown;excludedFromDataset?:unknown;createdAt?:unknown} = {};
          try { metadata = JSON.parse(await (await readExplorerFile(root, getAssetManifestPath(path))).text()); } catch { /* metadata is optional */ }
          const tags = Array.isArray(metadata.tags)
            ? metadata.tags.filter((tag): tag is string => typeof tag === 'string')
            : typeof metadata.caption === 'string' ? metadata.caption.split(',').map((tag) => tag.trim()).filter(Boolean) : undefined;
          assets.push({ id:createWorkspaceFileAssetId(path), path, fileName, kind:kind as WorkspaceFileAssetKind, file,
            previewUrl, width:previewDimensions?.width, height:previewDimensions?.height, byteSize:file.size,
            modifiedAt:'lastModified' in file ? file.lastModified : typeof metadata.createdAt === 'string' ? Date.parse(metadata.createdAt) : undefined,
            tags, excludedFromDataset:metadata.excludedFromDataset === true });
        } catch (error) {
          issues.push(`${path}: file could not be read`);
          appLog.warning(`Assets: unable to read ${path}`);
          if (import.meta.env.DEV) console.warn(`[workspace-assets] unable to read ${path}`, error);
        }
      }
      workspaceAssetIssuesByRoot.set(root, issues);
      return assets;
    })();
    workspaceAssetScanByRoot.set(root, scan);
    void scan.catch(() => workspaceAssetScanByRoot.delete(root));
  }
  const scannedAssets = await scan;
  if (!paths) return scannedAssets.map((asset) => ({ ...asset }));
  const requested = new Set(paths.map((path) => path.startsWith('Project/') ? path : `Project/${path}`));
  return scannedAssets.filter((asset) => requested.has(asset.path)).map((asset) => ({ ...asset }));
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
