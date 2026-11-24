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
  width: number;
  height: number;
  mimeType: string;
  previewUrl?: string;
  thumbnail?: Blob;
  embedding?: Float32Array;
  hash?: string;
  tags?: string[];
  /** True when the TXT exists but does not start with the dataset trigger word (never written on read). */
  captionTriggerMissing?: boolean;
  hidden?: boolean;
  /** Set when the file changed outside the app; replaces createdAt as the content timestamp of the Build revision. */
  modifiedAt?: number;
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
  width: number;
  height: number;
  type: ImageType;
  cropFrame?: CropFrame;
  augmentationConfig?: AugmentationConfig;
  cleanupOverlayId?: string;
  tags?: string[];
  /** True when the TXT exists but does not start with the dataset trigger word (never written on read). */
  captionTriggerMissing?: boolean;
  aspectRatio: AspectRatio;
  deleted: boolean;
  deletedAt?: Date;
  modifiedAt?: number;
  createdAt: Date;
  exportOrder?: number;
}

// ============ TAGGING ============

export interface TaggingConfig {
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
  /** The only user-set image status: Pin keeps the image in the Dataset baseline, Ban keeps it out of everything. */
  override?: BuildImageOverride;
  /** Explanation of the last Assemble for an image it left out. A cache, not membership; dropped when the image changes. */
  assembly?: BuildAssemblyOutcome;
  /** Inbox folder (explorer path) the image came from, so removing it from the Dataset returns it there. */
  origin?: string;
  updatedAt: string;
}

export type BuildImageOverride = 'pin' | 'ban';
export interface BuildAssemblyOutcome {
  outcome: 'duplicate' | 'not-selected';
  /** Asset id of the kept image for a duplicate. */
  of?: string;
  similarity?: number;
  /** Content revision the outcome was computed for. */
  revision: string;
}

export interface BuildPreparationProfile {
  target: number;
  reviewMode: BuildReviewMode;
  captionRequired: boolean;
  transform?: BuildTransformRecipe;
  /** Legacy: read only to migrate to `ProjectState.targetModel`; no longer written. */
  minShortSide?: number;
  autoPipeline?: boolean;
  /** Auto-select without a target size: one image per group of similar ones. Absent means Target mode (older sessions). */
  sizeMode?: 'auto';
  /** Selected inbox folders (explorer paths; subfolders are included). Absent means the whole inbox; folders added later are not selected automatically. */
  sources?: string[];
  /** How alike two images must be to count as the same group when Assemble picks one of them. Absent means Balanced (the former fixed cutoff). */
  similarityStrictness?: 'strict' | 'balanced' | 'loose';
}

export type BuildReviewView = 'list' | 'grid' | 'clusters';
export type BuildStage = 'add' | 'select' | 'caption' | 'check' | 'export';

export interface BuildSession {
  /** 2 adds record overrides; version 1 sessions are migrated once on load. */
  version: 1 | 2;
  /** Current Build stage; absent in sessions saved before stages existed (normalized on load). */
  stage?: BuildStage;
  /** Select-stage view mode; absent means list. */
  view?: BuildReviewView;
  profile: BuildPreparationProfile;
  cursor: number;
  filter: 'all' | 'unresolved' | 'errors' | 'needs-decision' | 'accepted' | 'rejected' | 'shortlisted' | 'picked'
    | 'status-inbox' | 'status-out' | 'status-in-dataset' | 'status-pinned' | 'status-banned';
  order: string[];
  records: Record<string, BuildReviewRecord>;
  lastExport?: { fingerprint: string; completedAt: string; entries: number };
  auto?: { assemblyKey?: string; assembledAt?: string; assemblyError?: string; shortlist?: BuildShortlist; assemblySummary?: BuildAssemblySummary };
}

/** Numbers of the last Assemble, written in the same Undo step as its result. */
export interface BuildAssemblySummary {
  /** Images that took part: the compared pool plus the ones the quality check left out. */
  images: number;
  /** Groups of similar images, one representative each (Auto size only). */
  groups?: number;
  /** Images this Assemble moved into the Dataset. */
  added: number;
  /** Images left out by the quality check. */
  outOnQuality: number;
  /** Images left out as duplicates of a kept image. */
  duplicates: number;
}

/** Pass-1 result of Auto-select: marks candidates only; nothing moves into the Dataset until pass 2 is applied. */
export interface BuildShortlistEntry {
  /** Build asset id. */
  id: string;
  /** Content revision when the entry was created; a changed image drops the entry. */
  revision: string;
  cluster: string;
  gain: number;
  rank: number;
}
export interface BuildShortlist {
  createdAt: string;
  /** Images the Dataset still needed when the shortlist was made. */
  needed: number;
  /** Wanted shortlist size (the entries may be fewer when the pool is small). */
  size: number;
  duplicatesRejected: number;
  /** `auto`: made without a target size. */
  mode?: 'auto';
  /** Images that were compared (the Find pool), used to explain Auto results. */
  poolCount?: number;
  entries: BuildShortlistEntry[];
  /** Pass-2 result: Build asset ids to add, in rank order. */
  narrowed?: { createdAt: string; target: number; ids: string[] };
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

/** `include`: always written to captions; `omit`: left for the trigger word to learn. Both drop contradicting tags of the same group. */
export interface CharacterTrait { tag: string; mode: 'include' | 'omit' }

export interface ProjectState {
  projectType: ProjectType;
  /** Project-level target model; the single source of the minimum short side. */
  targetModel: TargetModelId;
  /** Typical traits of a `character` project; a missing value means none. */
  characterTraits?: CharacterTrait[];
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
    stage: 'add',
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
