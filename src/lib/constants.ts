// Tools in recommended image preparation order.
export const WORKFLOW_TOOLS = [
  'build',
  'import',
  'video',
  'select',
  'clean',
  'analysis',
  'review',
  'tagging',
  'export',
] as const;

export const TOOLS = [...WORKFLOW_TOOLS] as const;

export const URL_TOOL_ALIASES: Record<string, (typeof TOOLS)[number]> = {
  'build-dataset': 'build',
  build: 'build',
  import: 'import',
  'video-frames': 'video',
  video: 'video',
  'remove-duplicates': 'select',
  select: 'select',
  photopea: 'clean',
  edit: 'clean',
  clean: 'clean',
  clear: 'clean',
  analysis: 'analysis',
  review: 'review',
  caption: 'tagging',
  tagging: 'tagging',
  export: 'export',
};

// Aspect ratios
export const ASPECT_RATIOS = ['2:3', '3:2', '1:1'] as const;

export const ASPECT_RATIO_LABELS: Record<string, string> = {
  '2:3': 'Portrait',
  '3:2': 'Landscape',
  '1:1': 'Square',
};

// Storage keys
export const DB_NAME = 'DatasetCreator';
export const DB_VERSION = 3;

export const OBJECT_STORES = {
  PROJECTS: 'projects',
  SOURCE_IMAGES: 'sourceImages',
  DATASET_ITEMS: 'datasetItems',
  CLEANUP_OVERLAYS: 'cleanupOverlays',
  EMBEDDINGS: 'embeddings',
  SIMILARITY_CACHE: 'similarityCache',
  TAGGER_FILE_HANDLES: 'taggerFileHandles',
};

// UI defaults
export const DEFAULT_BRUSH_SIZE = 20;
export const DEFAULT_BRUSH_OPACITY = 1;
export const DEFAULT_BRUSH_HARDNESS = 0.8;

export const DEFAULT_ROTATION_AMPLITUDE = 15;
export const DEFAULT_ROTATION_VARIANTS = 3;

// Performance
export const CHUNK_SIZE = 10; // Process images in chunks
export const DEBOUNCE_DELAY = 500; // Auto-save debounce
export const WORKER_TIMEOUT = 30000; // 30s worker timeout

// Similarity thresholds
export const SIMILARITY_HIGH_THRESHOLD = 0.85;
export const SIMILARITY_MEDIUM_THRESHOLD = 0.65;
export const SIMILARITY_LOW_THRESHOLD = 0.45;
