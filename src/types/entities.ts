import { PROJECT_TYPE_PROFILES } from '../lib/projectProfiles';
import { v4 as uuidv4 } from 'uuid';

// ============ ENUMS ============

export type AspectRatio = '2:3' | '3:2' | '1:1';

export type ImageType = 'cleaned' | 'crop' | 'augmented';

export type WorkspaceImageKind = 'image' | 'edited' | 'video' | 'psd';

export type AugmentationType = 'flip_h' | 'flip_v' | 'color' | 'rotate';

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
  /** Read for old projects only; the setting was removed from the UI. */
  brickColumnCount?: BrickColumnCount;
  localTaggerModelPath?: string;
  localTaggerTagsPath?: string;
  excludedProjectCategories?: string[];
  includedProjectCategories?: string[];
}

// ============ BUILD WORKFLOW ============

export type BuildReviewDecision = 'unreviewed' | 'accepted' | 'skipped' | 'deferred';
export type BuildApplicationStatus = 'idle' | 'pending' | 'failed' | 'applied';
export type BuildValidationStatus = 'pending' | 'valid' | 'stale' | 'error';

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
  captionRequired: boolean;
  transform?: BuildTransformRecipe;
  /** Legacy: read only to migrate to `ProjectState.targetModel`; no longer written. */
  minShortSide?: number;
  /** Auto-select without a target size: one image per group of similar ones. Absent means Target mode (older sessions). */
  sizeMode?: 'auto';
  /** Selected inbox folders (explorer paths; subfolders are included). Absent means the whole inbox; folders added later are not selected automatically. */
  sources?: string[];
  /** How alike two images must be to count as the same group when Assemble picks one of them. Absent means Balanced (the former fixed cutoff). */
  similarityStrictness?: 'strict' | 'balanced' | 'loose';
}

export interface BuildSession {
  /** 2 adds record overrides; version 1 sessions are migrated once on load. */
  version: 1 | 2;
  profile: BuildPreparationProfile;
  order: string[];
  records: Record<string, BuildReviewRecord>;
  lastExport?: { fingerprint: string; completedAt: string; entries: number };
  auto?: { assemblyKey?: string; assembledAt?: string; assemblyError?: string; assemblySummary?: BuildAssemblySummary };
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

/** A fresh Build session (version 2, Auto size). Lives next to `createProject` so the types module has no dependency on services. */
export const createBuildSession = (): BuildSession => ({
  version: 2,
  profile: { target: 60, captionRequired: true, sizeMode: 'auto' },
  order: [],
  records: {},
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
  taggingConfig: {
    threshold: 0.5,
    maxTags: 15,
    insertMode: 'append',
    blacklist: [],
  },
  workspaceSettings: {
    localTaggerModelPath: undefined,
    localTaggerTagsPath: undefined,
  },
  buildSession: createBuildSession(),
  lastModified: new Date(),
  createdAt: new Date(),
});
