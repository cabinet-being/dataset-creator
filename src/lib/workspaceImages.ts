import {
  createStandardImageFileName,
  type AspectRatio,
  type SourceImage,
  type EditedAsset,
  type WorkspaceImageKind,
} from '../types';
import type { ExplorerFileKind } from '../services/project/explorerFileService';

type CleanupWorkingEdit = {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
};

const withProjectRoot = (path: string | undefined): string | undefined => {
  if (!path) {
    return undefined;
  }
  return path.startsWith('Project/') ? path : `Project/${path}`;
};

export const normalizeWorkspaceAssetPath = (path: string): string =>
  path.startsWith('Project/') ? path : `Project/${path}`;

export const createWorkspaceFileAssetId = (path: string): string =>
  `asset:${normalizeWorkspaceAssetPath(path)}`;

const getProjectDataFileExtension = (fileName: string, mimeType: string): string => {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension && extension !== fileName.toLowerCase()) {
    return extension.replace(/[^a-z0-9]/g, '') || 'bin';
  }

  return mimeType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
};

export type WorkspaceImage = {
  id: string;
  sourceImageId: string;
  editedAssetId?: string;
  kind: WorkspaceImageKind;
  label: 'Image' | 'Edited' | 'Video' | 'PSD';
  displayIdentity: string;
  fileName: string;
  originalFileName?: string;
  assetPath?: string;
  imageData: Blob;
  psdData?: Blob;
  width: number;
  height: number;
  previewUrl?: string;
  previewStatus?: 'queued' | 'generating' | 'failed';
  allowObjectPreviewUrl?: boolean;
  tags?: string[];
  aspectRatio: AspectRatio;
  editedAssetType?: EditedAsset['type'];
  exportOrder?: number;
  deleted?: boolean;
  hidden?: boolean;
  byteSize?: number;
  modifiedAt?: number;
  dimensionsKnown?: boolean;
};

/** Human-readable UI name; storage and export names remain unchanged. */
export const getWorkspaceDisplayName = (item: Pick<WorkspaceImage, 'originalFileName' | 'fileName'>): string =>
  item.originalFileName?.trim() || item.fileName;

export type WorkspaceFileAsset = {
  id: string;
  path: string;
  fileName: string;
  kind: Extract<ExplorerFileKind, 'video' | 'psd'>;
  file: Blob;
  previewUrl?: string;
  previewStatus?: 'queued' | 'generating' | 'failed';
  width?: number;
  height?: number;
  tags?: string[];
  byteSize?: number;
  modifiedAt?: number;
};

export const WORKSPACE_KIND_STYLES: Record<
  WorkspaceImageKind,
  {
    label: 'Image' | 'Edited' | 'Video' | 'PSD';
    borderClass: string;
    selectedBorderClass: string;
    badgeClass: string;
    ringStyle: string;
  }
> = {
  image: {
    label: 'Image',
    borderClass: 'border-emerald-500/70',
    selectedBorderClass: 'border-emerald-400',
    badgeClass: 'bg-emerald-500/90 text-white',
    ringStyle: '0 0 0 2px rgba(16, 185, 129, 0.7) inset',
  },
  edited: {
    label: 'Edited',
    borderClass: 'border-sky-500/70',
    selectedBorderClass: 'border-sky-400',
    badgeClass: 'bg-sky-500/90 text-white',
    ringStyle: '0 0 0 2px rgba(14, 165, 233, 0.7) inset',
  },
  video: {
    label: 'Video',
    borderClass: 'border-violet-500/70',
    selectedBorderClass: 'border-violet-400',
    badgeClass: 'bg-violet-500/90 text-white',
    ringStyle: '0 0 0 2px rgba(139, 92, 246, 0.7) inset',
  },
  psd: {
    label: 'PSD',
    borderClass: 'border-cyan-500/70',
    selectedBorderClass: 'border-cyan-400',
    badgeClass: 'bg-cyan-500/90 text-white',
    ringStyle: '0 0 0 2px rgba(6, 182, 212, 0.7) inset',
  },
};

export const getWorkspaceKindFrameClass = (
  kind: WorkspaceImageKind,
  selected = false
): string => {
  const style = WORKSPACE_KIND_STYLES[kind];
  return `border ${selected ? style.selectedBorderClass : style.borderClass}`;
};

export const getWorkspaceKindFrameStyle = (
  kind: WorkspaceImageKind
): Record<string, string> => ({
  boxShadow: WORKSPACE_KIND_STYLES[kind].ringStyle,
});

export const getWorkspaceKindFrameOverlayStyle = (
  kind: WorkspaceImageKind
): Record<string, string> => ({
  boxShadow: WORKSPACE_KIND_STYLES[kind].ringStyle,
});

export const getWorkspaceKindFrameOverlayClass = (): string =>
  'workspace-frame-overlay pointer-events-none absolute inset-0 rounded-lg';

export const getWorkspaceKindBadgeClass = (kind: WorkspaceImageKind): string =>
  `inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium ${WORKSPACE_KIND_STYLES[kind].badgeClass}`;

export const inferWorkspaceAspectRatio = (width: number, height: number): AspectRatio => {
  const ratio = width / height;
  const targets: Array<{ value: AspectRatio; ratio: number }> = [
    { value: '2:3', ratio: 2 / 3 },
    { value: '3:2', ratio: 3 / 2 },
    { value: '1:1', ratio: 1 },
  ];

  return targets.reduce((best, current) =>
    Math.abs(current.ratio - ratio) < Math.abs(best.ratio - ratio) ? current : best
  ).value;
};

export const toWorkspaceImages = (
  sourceImages: SourceImage[],
  editedAssets: EditedAsset[],
  workingEdits: Record<string, CleanupWorkingEdit> = {}
): WorkspaceImage[] => {
  const sourceOrder = new Map(sourceImages.map((image, index) => [image.id, index + 1]));
  const sourceIds = new Set(sourceImages.map((image) => image.id));

  const sources: WorkspaceImage[] = sourceImages.filter((image) => !image.hidden).map((image, index) => {
    const workspaceId = `source:${image.id}`;
    const workingEdit = workingEdits[workspaceId] ?? workingEdits[image.id];
    return {
      id: workspaceId,
      sourceImageId: image.id,
      kind: 'image',
      label: 'Image',
      displayIdentity: `${index + 1}`,
      fileName: createStandardImageFileName(image.id, image.fileName, image.mimeType),
      originalFileName: image.originalFileName,
      assetPath: withProjectRoot(
        image.originalFilePath ??
          `.dataset-creator-data/source-images/${image.id}/original.${getProjectDataFileExtension(image.fileName, image.mimeType)}`
      ),
      imageData: workingEdit?.blob ?? image.originalFile,
      previewUrl: workingEdit?.previewUrl ?? image.previewUrl,
      width: workingEdit?.width ?? image.width,
      height: workingEdit?.height ?? image.height,
      tags: image.tags,
      hidden: image.hidden,
      byteSize: image.originalFile.size,
      modifiedAt: image.createdAt.getTime(),
      dimensionsKnown: true,
      aspectRatio: inferWorkspaceAspectRatio(workingEdit?.width ?? image.width, workingEdit?.height ?? image.height),
    };
  });

  const editedCountsBySource = new Map<string, number>();
  const edited: WorkspaceImage[] = editedAssets
    .filter((image) => !image.deleted && sourceIds.has(image.sourceImageId))
    .map((image) => {
      const workspaceId = `edited:${image.id}`;
      const parentIndex = sourceOrder.get(image.sourceImageId) ?? 0;
      const nextEditedIndex = (editedCountsBySource.get(image.sourceImageId) ?? 0) + 1;
      editedCountsBySource.set(image.sourceImageId, nextEditedIndex);
      const workingEdit = workingEdits[workspaceId];

      return {
        id: workspaceId,
        sourceImageId: image.sourceImageId,
        editedAssetId: image.id,
        kind: 'edited',
        label: 'Edited',
        displayIdentity: `${parentIndex || '?'}.${nextEditedIndex}`,
        fileName: `${image.id}.png`,
        assetPath: withProjectRoot(image.imageDataPath ?? `.dataset-creator-data/generated-images/${image.id}/image.png`),
        imageData: workingEdit?.blob ?? image.imageData,
        psdData: image.psdData,
        previewUrl: workingEdit?.previewUrl ?? image.previewUrl,
        width: workingEdit?.width ?? image.width,
        height: workingEdit?.height ?? image.height,
        tags: image.tags,
        aspectRatio: image.aspectRatio,
        editedAssetType: image.type,
        exportOrder: image.exportOrder,
        deleted: image.deleted,
        byteSize: image.imageData.size,
        modifiedAt: image.createdAt.getTime(),
        dimensionsKnown: true,
      };
    });

  return [...sources, ...edited];
};

export const getWorkspaceImageAspectRatio = (image: WorkspaceImage): AspectRatio =>
  inferWorkspaceAspectRatio(image.width, image.height);

export const toWorkspaceReviewAssets = (
  sourceImages: SourceImage[],
  fileAssets: WorkspaceFileAsset[],
  workingEdits: Record<string, CleanupWorkingEdit> = {},
  editedAssets: EditedAsset[] = []
): WorkspaceImage[] => {
  const imageItems = toWorkspaceImages(sourceImages, editedAssets, workingEdits).filter(
    (item) => item.kind === 'image' || item.kind === 'edited'
  );
  const fileItems: WorkspaceImage[] = fileAssets.map((asset, index) => ({
    id: asset.id,
    sourceImageId: '',
    kind: asset.kind,
    label: WORKSPACE_KIND_STYLES[asset.kind].label,
    displayIdentity: `${imageItems.length + index + 1}`,
    fileName: asset.fileName,
    assetPath: asset.path,
    imageData: asset.file,
    previewUrl: asset.previewUrl,
    previewStatus: asset.previewStatus,
    allowObjectPreviewUrl: asset.kind !== 'psd',
    width: asset.width ?? 1,
    height: asset.height ?? 1,
    tags: asset.tags,
    byteSize: asset.byteSize ?? asset.file.size,
    modifiedAt: asset.modifiedAt,
    dimensionsKnown: asset.width !== undefined && asset.height !== undefined,
    aspectRatio: inferWorkspaceAspectRatio(asset.width ?? 1, asset.height ?? 1),
  }));

  return [...imageItems, ...fileItems];
};
