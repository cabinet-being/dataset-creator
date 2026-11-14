import { PROJECT_TYPE_PROFILES } from '../lib/projectProfiles';
import { v4 as uuidv4 } from 'uuid';

// ============ ENUMS ============

export type AspectRatio = '2:3' | '3:2' | '1:1';

export type ImageType = 'cleaned' | 'crop' | 'augmented';

export type WorkspaceImageKind = 'image' | 'edited' | 'video' | 'psd';

export type AugmentationType = 'flip_h' | 'flip_v' | 'color' | 'rotate';

export type ToolName =
  | 'build'
  | 'import'
  | 'video'
  | 'select'
  | 'clean'
  | 'analysis'
  | 'review'
  | 'tagging'
  | 'export';

// ============ SOURCE IMAGE ============

export interface SourceImage {
  id: string;
  originalFile: Blob;
  fileName: string;
  originalFileName?: string;
  originalFilePath?: string;
  manifestPath?: string;
  width: number;
  height: number;
  mimeType: string;
  previewUrl?: string;
  thumbnail?: Blob;
  embedding?: Float32Array;
  hash?: string;
  tags?: string[];
  hidden?: boolean;
  createdAt: Date;
}

// ============ CROP & CLEANUP ============

export interface CropFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: AspectRatio;
}

export interface CanvasLayer {
  id: string;
  type: 'brush' | 'eraser';
  data: ImageData;
  opacity: number;
  timestamp: Date;
}

export interface CleanupOverlay {
  id: string;
  imageId: string;
  layers: CanvasLayer[];
  history: ImageData[];
  historyIndex: number;
}

// ============ AUGMENTATION ============

export interface AugmentationConfig {
  type: AugmentationType;
  flipH?: boolean;
  flipV?: boolean;
  colorGradient?: { from: string; to: string };
  rotationDegrees?: number;
  rotationVariants?: number;
  rotationSeed?: number;
}

// ============ EDITED ASSET ============

export interface EditedAsset {
  id: string;
  sourceImageId: string;
  imageData: Blob;
  psdData?: Blob;
  previewUrl?: string;
  imageDataPath?: string;
  psdDataPath?: string;
  manifestPath?: string;
  width: number;
  height: number;
  type: ImageType;
  cropFrame?: CropFrame;
  augmentationConfig?: AugmentationConfig;
  cleanupOverlayId?: string;
  tags?: string[];
  aspectRatio: AspectRatio;
  deleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  exportOrder?: number;
}

// ============ TAGGING ============

export interface TaggingConfig {
  datasetKeyword: string;
  autoTaggingEndpoint?: string;
  threshold: number;
  maxTags: number;
  insertMode: 'prepend' | 'append' | 'overwrite';
  blacklist: string[];
}

// ============ DATASETS ============

export interface Dataset {
  id: string;
  name: string;
  triggerWord: string;
  assetOrder: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ============ WORKSPACE SETTINGS ============

export type BrickColumnCount = 'auto' | 1 | 2 | 3 | 4 | 5;

export interface WorkspaceSettings {
  brickColumnCount: BrickColumnCount;
  localTaggerModelPath?: string;
  localTaggerTagsPath?: string;
  excludedProjectCategories?: string[];
  includedProjectCategories?: string[];
}

// ============ BUILD WORKFLOW ============

export type BuildReviewDecision = 'unreviewed' | 'accepted' | 'skipped' | 'deferred';
export type BuildApplicationStatus = 'idle' | 'pending' | 'failed' | 'applied';
export type BuildValidationStatus = 'pending' | 'valid' | 'stale' | 'error';
export type BuildReviewMode = 'every-item' | 'uncertain-only';

export type BuildTransformRecipe = {
  mode: 'fit' | 'crop';
  width: number;
  height: number;
  allowUpscale: boolean;
  crop?: { x: number; y: number; width: number; height: number };
};

export type BuildTriageGroup = 'accepted' | 'rejected' | 'needs-decision';
export type BuildTriageReasonCode =
  | 'exact-duplicate' | 'near-duplicate' | 'too-small' | 'below-target-resolution'
  | 'blurry' | 'soft' | 'dark' | 'underexposed' | 'overexposed'
  | 'not-selected' | 'video' | 'unmeasured' | 'quality-ok' | 'selected';
export interface BuildTriageReason { code: BuildTriageReasonCode; message: string }
/** Numbers-only image quality measurements persisted with a triage proposal. */
export interface ImageQualitySummary {
  version: number;
  width: number;
  height: number;
  shortSide: number;
  sharpness: number;
  brightness: number;
  darkShare: number;
  brightShare: number;
  minShortSide: number;
  /** Almost entirely black frame; absent in summaries saved before it was recorded. */
  dark?: boolean;
}
export interface BuildTriageProposal {
  group: BuildTriageGroup;
  reasons: BuildTriageReason[];
  stage: 'quality' | 'assembly';
  revision: string;
  duplicateOf?: string;
  similarity?: number;
  quality?: ImageQualitySummary;
  digest?: string;
  createdAt: string;
}

export interface BuildReviewRecord {
  assetId: string;
  locator?: string;
  decision: BuildReviewDecision;
  application: BuildApplicationStatus;
  validation: BuildValidationStatus;
  revision?: string;
  acceptedRevision?: string;
  provenance?: 'manual' | 'auto';
  error?: string;
  transform?: BuildTransformRecipe;
  outputAssetId?: string;
  outputRevision?: string;
  proposal?: { tags: string[]; revision: string };
  draft?: string;
  triage?: BuildTriageProposal;
  updatedAt: string;
}

export interface BuildPreparationProfile {
  target: number;
  reviewMode: BuildReviewMode;
  captionRequired: boolean;
  transform?: BuildTransformRecipe;
  /** Legacy: read only to migrate to `ProjectState.targetModel`; no longer written. */
  minShortSide?: number;
  autoPipeline?: boolean;
}

export interface BuildSession {
  version: 1;
  profile: BuildPreparationProfile;
  cursor: number;
  filter: 'all' | 'unresolved' | 'errors' | 'needs-decision' | 'accepted' | 'rejected';
  order: string[];
  records: Record<string, BuildReviewRecord>;
  lastExport?: { fingerprint: string; completedAt: string; entries: number };
  auto?: { assemblyKey?: string; assembledAt?: string; assemblyError?: string };
}

// ============ SIMILARITY ============

export interface SimilarityResult {
  imageId1: string;
  imageId2: string;
  distance: number;
  similarity: number; // 0-1
}

export interface SimilarityCluster {
  id: string;
  imageIds: string[];
  avgSimilarity: number;
}

// ============ PROJECT ============

export type ProjectType = 'general' | 'character' | 'style' | 'concept';
export type TargetModelId = 'sd15' | 'sdxl' | 'flux';

export interface ProjectState {
  projectType: ProjectType;
  /** Project-level target model; the single source of the minimum short side. */
  targetModel: TargetModelId;
  id: string;
  name: string;
  sourceImages: Record<string, SourceImage>;
  datasetItems: Record<string, EditedAsset>;
  dataset: Dataset;
  cleanupOverlays: Record<string, CleanupOverlay>;
  currentTool: ToolName;
  toolState: Record<ToolName, unknown>;
  taggingConfig: TaggingConfig;
  workspaceSettings: WorkspaceSettings;
  buildSession: BuildSession;
  captionMigration?: import('../services/caption/captionMigrationService').CaptionMigrationReport;
  datasetMigration?: import('../services/project/legacyDatasetMigrationService').LegacyDatasetMigrationReport;
  lastModified: Date;
  createdAt: Date;
}

// ============ FACTORY FUNCTIONS ============

export const createSourceImage = (
  file: Blob,
  fileName: string,
  width: number,
  height: number,
  previewUrl?: string
): SourceImage => {
  const id = uuidv4();

  return {
    id,
    originalFile: file,
    fileName: createStandardImageFileName(id, fileName, file.type),
    originalFileName: fileName,
    width,
    height,
    mimeType: file.type,
    previewUrl,
    createdAt: new Date(),
  };
};

export const createStandardImageFileName = (
  id: string,
  fileName = '',
  mimeType = ''
): string => `${id}${getImageFileExtension(fileName, mimeType)}`;

export const getImageFileExtension = (fileName: string, mimeType: string): string => {
  const extension = fileName.match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase();
  if (extension) {
    return extension;
  }

  const extensionByMimeType: Record<string, string> = {
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };

  return extensionByMimeType[mimeType] ?? '.png';
};

export const createEditedAsset = (
  sourceImageId: string,
  imageData: Blob,
  width: number,
  height: number,
  type: ImageType = 'cleaned',
  aspectRatio: AspectRatio = '1:1'
): EditedAsset => ({
  id: uuidv4(),
  sourceImageId,
  imageData,
  width,
  height,
  type,
  aspectRatio,
  deleted: false,
  createdAt: new Date(),
});

export const createCropFrame = (
  x: number,
  y: number,
  width: number,
  height: number,
  aspectRatio: AspectRatio
): CropFrame => ({
  id: uuidv4(),
  x,
  y,
  width,
  height,
  aspectRatio,
});

export const createCleanupOverlay = (imageId: string): CleanupOverlay => ({
  id: uuidv4(),
  imageId,
  layers: [],
  history: [],
  historyIndex: -1,
});

export const createDataset = (name = 'New Dataset'): Dataset => ({
  id: 'global',
  name,
  triggerWord: '',
  assetOrder: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const createProject = (name: string, projectType: ProjectType = 'general', targetModel: TargetModelId = 'sdxl'): ProjectState => ({
  projectType,
  targetModel,
  id: uuidv4(),
  name,
  sourceImages: {},
  datasetItems: {},
  dataset: {
    ...createDataset(PROJECT_TYPE_PROFILES[projectType].defaults.datasetName),
    triggerWord: PROJECT_TYPE_PROFILES[projectType].defaults.triggerWord,
  },
  cleanupOverlays: {},
  currentTool: 'build',
  toolState: {
    build: {},
    import: {},
    video: {},
    select: {},
    clean: {},
    analysis: {},
    review: {},
    tagging: {},
    export: {},
  },
  taggingConfig: {
    datasetKeyword: PROJECT_TYPE_PROFILES[projectType].defaults.datasetKeyword,
    threshold: 0.5,
    maxTags: 15,
    insertMode: 'append',
    blacklist: [],
  },
  workspaceSettings: {
    brickColumnCount: 'auto',
    localTaggerModelPath: undefined,
    localTaggerTagsPath: undefined,
  },
  buildSession: {
    version: 1,
    profile: {
      target: 60,
      reviewMode: 'every-item',
      captionRequired: true,
    },
    cursor: 0,
    filter: 'all',
    order: [],
    records: {},
  },
  lastModified: new Date(),
  createdAt: new Date(),
});
