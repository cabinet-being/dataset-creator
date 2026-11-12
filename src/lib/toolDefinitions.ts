import { BarChart3, Brush, Download, Layers3, Plus, ScanSearch, Sparkles, Tags, Upload, Video, type LucideIcon } from 'lucide-react';
import type { ToolName } from '../types';
export type ToolScope = 'project' | 'dataset' | 'file' | 'selection';
/** `primary` tools form the main path; `advanced` tools stay reachable from the Advanced group. */
export type ToolTier = 'primary' | 'advanced';
export type ToolDefinition = {
  label: string; description: string; slug: string; icon: LucideIcon;
  requirement: 'none' | 'sourceImages' | 'workspaceImages'; scopes: readonly ToolScope[]; tier: ToolTier;
};
export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  build: { label: 'Build Dataset', description: 'Import, review, caption and export in one workspace.', slug: 'build-dataset', icon: Sparkles, requirement: 'none', scopes: ['project'], tier: 'primary' },
  import: { label: 'Import', description: 'Load source files or folders.', slug: 'import', icon: Upload, requirement: 'none', scopes: ['project'], tier: 'advanced' },
  video: { label: 'Video Frames', description: 'Save video frames manually or with local visual analysis.', slug: 'video-frames', icon: Video, requirement: 'none', scopes: ['project', 'file'], tier: 'advanced' },
  select: { label: 'Remove Duplicates', description: 'Find duplicate and similar source images.', slug: 'remove-duplicates', icon: ScanSearch, requirement: 'sourceImages', scopes: ['project'], tier: 'advanced' },
  clean: { label: 'Photopea', description: 'Edit image and PSD assets in Photopea.', slug: 'photopea', icon: Brush, requirement: 'sourceImages', scopes: ['project', 'file'], tier: 'advanced' },
  analysis: { label: 'Analysis', description: 'Explore image similarities and groups.', slug: 'analysis', icon: BarChart3, requirement: 'workspaceImages', scopes: ['project', 'dataset', 'file', 'selection'], tier: 'advanced' },
  review: { label: 'Review', description: 'Review images, videos and PSDs.', slug: 'review', icon: Layers3, requirement: 'workspaceImages', scopes: ['project', 'dataset', 'selection'], tier: 'advanced' },
  tagging: { label: 'Caption', description: 'Edit captions manually, in bulk or with a local model.', slug: 'caption', icon: Tags, requirement: 'workspaceImages', scopes: ['project', 'dataset', 'file', 'selection'], tier: 'advanced' },
  export: { label: 'Export', description: 'Review and export matching image and TXT pairs.', slug: 'export', icon: Download, requirement: 'workspaceImages', scopes: ['project', 'dataset'], tier: 'advanced' },
};
export const ADVANCED_TOOL_GROUP_LABEL = 'Advanced';

// Dataset-scoped tools have their own ids: `add-files` is FinalReviewTool in
// select mode and must not share an id with the project-level Remove Duplicates
// tool (`select`). `baseTool` is the project tool whose inspector and enablement
// rules the dataset tool follows.
export type DatasetToolName = 'add-files' | 'review' | 'analysis' | 'tagging';
export type DatasetToolDefinition = { label: string; icon: LucideIcon; baseTool: ToolName };
export const DATASET_TOOL_DEFINITIONS: Record<DatasetToolName, DatasetToolDefinition> = {
  'add-files': { label: 'Add files', icon: Plus, baseTool: 'review' },
  review: { label: TOOL_DEFINITIONS.review.label, icon: Layers3, baseTool: 'review' },
  analysis: { label: TOOL_DEFINITIONS.analysis.label, icon: BarChart3, baseTool: 'analysis' },
  tagging: { label: TOOL_DEFINITIONS.tagging.label, icon: Tags, baseTool: 'tagging' },
};
/** Dataset tool ids written by older builds. */
export const LEGACY_DATASET_TOOL_ALIASES: Readonly<Record<string, DatasetToolName>> = { select: 'add-files' };

export const TOOL_ICONS = Object.fromEntries(Object.entries(TOOL_DEFINITIONS).map(([id, definition]) => [id, definition.icon])) as Record<ToolName, LucideIcon>;
