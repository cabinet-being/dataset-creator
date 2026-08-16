import {
  createStandardImageFileName,
  type AspectRatio,
  type SourceImage,
  type SyntheticImage,
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
  syntheticImageId?: string;
  kind: WorkspaceImageKind;
  label: 'Image' | 'Generated' | 'Video' | 'PSD';
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
  allowGeneratedPreviewUrl?: boolean;
  tags?: string[];
  aspectRatio: AspectRatio;
  syntheticType?: SyntheticImage['type'];
  exportOrder?: number;
  excludedFromDataset?: boolean;
  deleted?: boolean;
  hidden?: boolean;
};

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
};

export const WORKSPACE_KIND_STYLES: Record<
  WorkspaceImageKind,
  {
    label: 'Image' | 'Generated' | 'Video' | 'PSD';
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
  synthetic: {
    label: 'Generated',
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
  syntheticImages: SyntheticImage[],
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
      excludedFromDataset: image.excludedFromDataset,
      aspectRatio: inferWorkspaceAspectRatio(workingEdit?.width ?? image.width, workingEdit?.height ?? image.height),
    };
  });

  const syntheticCountsBySource = new Map<string, number>();
  const synthetic: WorkspaceImage[] = syntheticImages
    .filter((image) => !image.deleted && sourceIds.has(image.sourceImageId))
    .map((image) => {
      const workspaceId = `synthetic:${image.id}`;
      const parentIndex = sourceOrder.get(image.sourceImageId) ?? 0;
      const nextSyntheticIndex = (syntheticCountsBySource.get(image.sourceImageId) ?? 0) + 1;
      syntheticCountsBySource.set(image.sourceImageId, nextSyntheticIndex);
      const workingEdit = workingEdits[workspaceId];

      return {
        id: workspaceId,
        sourceImageId: image.sourceImageId,
        syntheticImageId: image.id,
        kind: 'synthetic',
        label: 'Generated',
        displayIdentity: `${parentIndex || '?'}.${nextSyntheticIndex}`,
        fileName: `${image.id}.png`,
        assetPath: withProjectRoot(image.imageDataPath ?? `.dataset-creator-data/generated-images/${image.id}/image.png`),
        imageData: workingEdit?.blob ?? image.imageData,
        psdData: image.psdData,
        previewUrl: workingEdit?.previewUrl ?? image.previewUrl,
        width: workingEdit?.width ?? image.width,
        height: workingEdit?.height ?? image.height,
        tags: image.tags,
        aspectRatio: image.aspectRatio,
        syntheticType: image.type,
        exportOrder: image.exportOrder,
        excludedFromDataset: image.excludedFromDataset,
        deleted: image.deleted,
      };
    });

  return [...sources, ...synthetic];
};

export const getWorkspaceImageAspectRatio = (image: WorkspaceImage): AspectRatio =>
  inferWorkspaceAspectRatio(image.width, image.height);

export const toWorkspaceReviewAssets = (
  sourceImages: SourceImage[],
  fileAssets: WorkspaceFileAsset[],
  workingEdits: Record<string, CleanupWorkingEdit> = {}
): WorkspaceImage[] => {
  const imageItems = toWorkspaceImages(sourceImages, [], workingEdits).filter((item) => item.kind === 'image');
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
    allowGeneratedPreviewUrl: asset.kind !== 'psd',
    width: asset.width ?? 1,
    height: asset.height ?? 1,
    tags: asset.tags,
    aspectRatio: inferWorkspaceAspectRatio(asset.width ?? 1, asset.height ?? 1),
  }));

  return [...imageItems, ...fileItems];
};
