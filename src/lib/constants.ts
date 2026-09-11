// Tools in recommended image preparation order.
export const WORKFLOW_TOOLS = [
  'import',
  'select',
  'clean',
  'analysis',
  'review',
  'tagging',
  'export',
] as const;

export const HUB_TOOL_CARDS = ['select', 'clean', 'analysis', 'review', 'tagging'] as const;

export const SIDEBAR_PRIMARY_TOOLS = [] as const;

export const SIDEBAR_SECONDARY_TOOLS = ['select', 'clean', 'analysis', 'review', 'tagging'] as const;

export const TOOLS = ['hub', ...WORKFLOW_TOOLS] as const;

export const TOOL_URL_SLUGS: Record<(typeof TOOLS)[number], string> = {
  hub: 'workspace',
  import: 'import',
  select: 'remove-duplicates',
  clean: 'photopea',
  analysis: 'analysis',
  review: 'review',
  tagging: 'caption',
  export: 'export',
};

export const URL_TOOL_ALIASES: Record<string, (typeof TOOLS)[number]> = {
  workspace: 'hub',
  hub: 'hub',
  import: 'import',
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

export const TOOL_LABELS: Record<string, string> = {
  hub: 'Project Workspace',
  import: 'Import',
  select: 'Remove Duplicates',
  clean: 'Photopea',
  analysis: 'Analysis',
  review: 'Review',
  tagging: 'Caption',
  export: 'Export',
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  import: 'Load source image files or folders into the project workspace.',
  select: 'Find duplicate and near-duplicate source images before editing.',
  clean: 'Open image and PSD assets in Photopea.',
  analysis: 'Analyze workspace images with relationship maps and similarity groups.',
  review: 'Preview workspace image, video, and PSD assets before captioning.',
  tagging: 'Edit captions manually, in bulk, or with a local ONNX tagger.',
  export: 'Save PNG and TXT training pairs as a folder or ZIP archive.',
};

export const TOOL_REQUIREMENTS: Record<string, 'none' | 'sourceImages' | 'workspaceImages'> = {
  import: 'none',
  select: 'sourceImages',
  clean: 'sourceImages',
  analysis: 'workspaceImages',
  review: 'workspaceImages',
  tagging: 'workspaceImages',
  export: 'workspaceImages',
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
