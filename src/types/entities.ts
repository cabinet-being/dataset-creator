import { PROJECT_TYPE_PROFILES } from '../lib/projectProfiles';
import { v4 as uuidv4 } from 'uuid';

// ============ ENUMS ============

export type AspectRatio = '2:3' | '3:2' | '1:1';

export type ImageType = 'cleaned' | 'crop' | 'augmented';

export type WorkspaceImageKind = 'image' | 'edited' | 'video' | 'psd';

export type AugmentationType = 'flip_h' | 'flip_v' | 'color' | 'rotate';

export type ToolName =
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

export type ProjectType = 'character' | 'style' | 'concept';

export interface ProjectState {
  projectType: ProjectType;
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

export const createProject = (name: string, projectType: ProjectType): ProjectState => ({
  projectType,
  id: uuidv4(),
  name,
  sourceImages: {},
  datasetItems: {},
  dataset: {
    ...createDataset(PROJECT_TYPE_PROFILES[projectType].defaults.datasetName),
    triggerWord: PROJECT_TYPE_PROFILES[projectType].defaults.triggerWord,
  },
  cleanupOverlays: {},
  currentTool: 'import',
  toolState: {
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
  lastModified: new Date(),
  createdAt: new Date(),
});
