// Tools in recommended image preparation order.
export const WORKFLOW_TOOLS = [
  'import',
  'select',
  'clean',
  'review',
  'tagging',
  'export',
] as const;

export const HUB_TOOL_CARDS = ['select', 'clean', 'review', 'tagging'] as const;

export const SIDEBAR_PRIMARY_TOOLS = [] as const;

export const SIDEBAR_SECONDARY_TOOLS = ['select', 'clean', 'review', 'tagging'] as const;

export const STAGES = ['hub', ...WORKFLOW_TOOLS] as const;

export const STAGE_LABELS: Record<string, string> = {
  hub: 'Image Workspace',
  import: 'Import',
  select: 'Remove Duplicates',
  clean: 'Edit',
  review: 'Review',
  tagging: 'Caption',
  export: 'Export',
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  import: 'Load Source image files or folders into the shared workspace.',
  select: 'Find duplicate and near-duplicate source images before editing.',
  clean: 'Edit Source and Synthetic images in Photopea from the browser workspace.',
  review: 'Inspect Source and Synthetic images with relationship maps before captioning.',
  tagging: 'Edit captions manually, in bulk, or with a local ONNX tagger.',
  export: 'Save PNG and TXT training pairs as a folder or ZIP archive.',
};

export const TOOL_REQUIREMENTS: Record<string, 'none' | 'sourceImages' | 'workspaceImages'> = {
  import: 'none',
  select: 'sourceImages',
  clean: 'sourceImages',
  review: 'workspaceImages',
  tagging: 'workspaceImages',
  export: 'workspaceImages',
};

// Aspect ratios
export const ASPECT_RATIOS = ['2:3', '3:2', '1:1'] as const;

export const ASPECT_RATIO_LABELS: Record<string, string> = {
  '2:3': 'Portrait (2:3)',
  '3:2': 'Landscape (3:2)',
  '1:1': 'Square (1:1)',
};

// Storage keys
export const DB_NAME = 'DatasetCreator';
export const DB_VERSION = 1;

export const OBJECT_STORES = {
  PROJECTS: 'projects',
  SOURCE_IMAGES: 'sourceImages',
  DATASET_ITEMS: 'datasetItems',
  CLEANUP_OVERLAYS: 'cleanupOverlays',
  EMBEDDINGS: 'embeddings',
  SIMILARITY_CACHE: 'similarityCache',
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
