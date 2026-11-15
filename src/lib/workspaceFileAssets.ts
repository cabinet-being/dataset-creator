import { getExplorerFileKind, getDirectoryAtExplorerPath, getExplorerParentDirectory, readExplorerFile } from '../services/project/explorerFileService';
import { appLog } from '../services/logging/applicationLog';
import {
  getOrCreateProjectPreviewUrl,
  readProjectPreviewUrl,
  type ProjectDirectoryHandle,
} from '../services/project/projectDirectoryService';
import { requestPhotopeaPsdPreview } from '../services/psd/photopeaPreviewQueue';
import { createPsdPreview } from '../services/psd/psdPreviewService';
import { createWorkspaceFileAssetId, type WorkspaceFileAsset } from './workspaceImages';
import { getActiveAssetRegistry, getAssetPathIndex, normalizeRegistryPath } from '../services/project/assetRegistryService';

import type { ExplorerChanges } from './explorerTreeUpdates';
import { PROJECT_EXPORTS_DIRECTORY, isInternalProjectEntry } from '../services/project/projectLayoutService';
import { isCaptionCarrierName, isTriggerMissing, readCaptionFile } from '../services/caption/captionFileService';
import { useProjectStore } from '../stores/useProjectStore';

type WorkspaceFileAssetKind = WorkspaceFileAsset['kind'];

const REVIEW_FILE_KINDS = new Set<WorkspaceFileAssetKind>(['video', 'psd']);
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
    if (isInternalProjectEntry(entryName) || (parentPath === 'Project' && entryName === PROJECT_EXPORTS_DIRECTORY)) {
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

const readWorkspaceAssets = async (root: ProjectDirectoryHandle, assetPaths: string[], issues: string[]): Promise<WorkspaceFileAsset[]> => {
const assets: WorkspaceFileAsset[] = [];

for (const path of assetPaths) {
  try {
    const fileName = getFileName(path);
    const file = await readExplorerFile(root, path);
    const kind = getExplorerFileKind(fileName, 'type' in file ? file.type : undefined);
    if (!REVIEW_FILE_KINDS.has(kind as WorkspaceFileAssetKind)) continue;
    const previewUrl = kind === 'psd' ? await readProjectPreviewUrl(root, 'psd', path) : undefined;
    const previewDimensions = previewUrl ? await readImageDimensions(previewUrl) : undefined;
    // The stable id and creation time come from the asset registry; a file it does not know yet has none.
    const registry = getActiveAssetRegistry(root);
    const metadata = registry ? getAssetPathIndex(registry).get(normalizeRegistryPath(path)) : undefined;
    // The caption lives only in the TXT next to the file; videos cannot carry one.
    const caption = isCaptionCarrierName(fileName) ? await readCaptionFile(root, path, useProjectStore.getState().dataset.triggerWord) : undefined;
    const tags = caption?.tags;
    assets.push({ id:createWorkspaceFileAssetId(path), stableId:metadata?.id, path, fileName, kind:kind as WorkspaceFileAssetKind, file,
      previewUrl, width:previewDimensions?.width, height:previewDimensions?.height, byteSize:file.size,
      modifiedAt:'lastModified' in file ? file.lastModified : metadata?.createdAt ? Date.parse(metadata.createdAt) : undefined,
      tags, captionTriggerMissing: caption ? isTriggerMissing(caption) : undefined });
  } catch (error) {
    issues.push(`${path}: file could not be read`);
    appLog.warning(`Assets: unable to read ${path}`);
    if (import.meta.env.DEV) console.warn(`[workspace-assets] unable to read ${path}`, error);
  }
}
  return assets;
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
      const assets = await readWorkspaceAssets(root, assetPaths, issues);
      workspaceAssetIssuesByRoot.set(root, issues);
      return assets;
    })();
    workspaceAssetScanByRoot.set(root, scan);
    void scan.catch(() => { if (workspaceAssetScanByRoot.get(root) === scan) workspaceAssetScanByRoot.delete(root); });
  }
  const scannedAssets = await scan;
  if (!paths) return scannedAssets.map((asset) => ({ ...asset }));
  const requested = new Set(paths.map((path) => path.startsWith('Project/') ? path : `Project/${path}`));
  return scannedAssets.filter((asset) => requested.has(asset.path)).map((asset) => ({ ...asset }));
};

// Keep snapshots and preview URLs for known moves. Only newly created/changed
// paths need filesystem reads; a move must not evict every PSD/video preview.
export const updateWorkspaceFileAssetCache = async (root: ProjectDirectoryHandle, changes: ExplorerChanges): Promise<void> => {
  const previous = workspaceAssetScanByRoot.get(root);
  if (!previous) return;
  let next!: Promise<WorkspaceFileAsset[]>;
  // Self-referencing: the async body compares against `next`, so declaration and assignment must be separate.
  // eslint-disable-next-line prefer-const
  next = (async () => {
    let assets = await previous;
    const changedPaths = new Set(changes.paths);
    for (const { from, to } of changes.moves) {
      if (from === to) continue;
      let found = false;
      assets = assets.flatMap(asset => {
        if (asset.path !== from && !asset.path.startsWith(`${from}/`)) return [asset];
        found = true;
        const path = to + asset.path.slice(from.length);
        const fileName = getFileName(path);
        const kind = getExplorerFileKind(fileName);
        if (!REVIEW_FILE_KINDS.has(kind as WorkspaceFileAssetKind)) return [];
        return [{ ...asset, path, id: createWorkspaceFileAssetId(path), fileName, kind: kind as WorkspaceFileAssetKind }];
      });
      if (!found && REVIEW_FILE_KINDS.has(getExplorerFileKind(getFileName(to)) as WorkspaceFileAssetKind)) changedPaths.add(to);
    }
    const issues: string[] = [];
    for (const path of changedPaths) {
      assets = assets.filter(asset => asset.path !== path && !asset.path.startsWith(`${path}/`));
      try {
        const { directory, name } = await getExplorerParentDirectory(root, path);
        let paths: string[];
        try {
          const folder = await getDirectoryAtExplorerPath(root, path);
          paths = await collectAssetPaths(folder, path, issues);
        } catch (error) {
          if (!(error instanceof Error) || !['NotFoundError', 'TypeMismatchError'].includes(error.name)) throw error;
          await directory.getFileHandle(name);
          paths = REVIEW_FILE_KINDS.has(getExplorerFileKind(name) as WorkspaceFileAssetKind) ? [path] : [];
        }
        assets.push(...await readWorkspaceAssets(root, paths, issues));
      } catch (error) {
        if (!(error instanceof Error && error.name === 'NotFoundError')) issues.push(`${path}: entry could not be read`);
      }
    }
    if (workspaceAssetScanByRoot.get(root) === next) workspaceAssetIssuesByRoot.set(root, issues);
    return assets;
  })();
  workspaceAssetScanByRoot.set(root, next);
  try { await next; }
  catch (error) {
    if (workspaceAssetScanByRoot.get(root) === next) workspaceAssetScanByRoot.delete(root);
    throw error;
  }
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
