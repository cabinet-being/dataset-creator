import type { AspectRatio, SourceImage, SyntheticImage, WorkspaceImageKind } from '../types';

type CleanupWorkingEdit = {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
};

export type WorkspaceImage = {
  id: string;
  sourceImageId: string;
  syntheticImageId?: string;
  kind: WorkspaceImageKind;
  label: 'Source' | 'Synthetic';
  displayIdentity: string;
  imageData: Blob;
  width: number;
  height: number;
  previewUrl?: string;
  tags?: string[];
  aspectRatio: AspectRatio;
  syntheticType?: SyntheticImage['type'];
  exportOrder?: number;
  deleted?: boolean;
  hidden?: boolean;
};

export const WORKSPACE_KIND_STYLES: Record<
  WorkspaceImageKind,
  {
    label: 'Source' | 'Synthetic';
    borderClass: string;
    selectedBorderClass: string;
    badgeClass: string;
    ringStyle: string;
  }
> = {
  source: {
    label: 'Source',
    borderClass: 'border-emerald-500/70',
    selectedBorderClass: 'border-emerald-400',
    badgeClass: 'bg-emerald-500/90 text-white',
    ringStyle: '0 0 0 2px rgba(16, 185, 129, 0.7) inset',
  },
  synthetic: {
    label: 'Synthetic',
    borderClass: 'border-sky-500/70',
    selectedBorderClass: 'border-sky-400',
    badgeClass: 'bg-sky-500/90 text-white',
    ringStyle: '0 0 0 2px rgba(14, 165, 233, 0.7) inset',
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

export const getWorkspaceKindBadgeClass = (kind: WorkspaceImageKind): string =>
  `inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium ${WORKSPACE_KIND_STYLES[kind].badgeClass}`;

const inferAspectRatio = (width: number, height: number): AspectRatio => {
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
      kind: 'source',
      label: 'Source',
      displayIdentity: `${index + 1}`,
      imageData: workingEdit?.blob ?? image.originalFile,
      previewUrl: workingEdit?.previewUrl ?? image.previewUrl,
      width: workingEdit?.width ?? image.width,
      height: workingEdit?.height ?? image.height,
      tags: image.tags,
      hidden: image.hidden,
      aspectRatio: inferAspectRatio(workingEdit?.width ?? image.width, workingEdit?.height ?? image.height),
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
        label: 'Synthetic',
        displayIdentity: `${parentIndex || '?'}.${nextSyntheticIndex}`,
        imageData: workingEdit?.blob ?? image.imageData,
        previewUrl: workingEdit?.previewUrl,
        width: workingEdit?.width ?? image.width,
        height: workingEdit?.height ?? image.height,
        tags: image.tags,
        aspectRatio: image.aspectRatio,
        syntheticType: image.type,
        exportOrder: image.exportOrder,
        deleted: image.deleted,
      };
    });

  return [...sources, ...synthetic];
};

export const getWorkspaceImageAspectRatio = (image: WorkspaceImage): AspectRatio =>
  inferAspectRatio(image.width, image.height);
