import { BarChart3, Brush, Download, Layers3, ScanSearch, Tags, Upload, Video, type LucideIcon } from 'lucide-react';
import type { ToolName } from '../types';
export type ToolScope = 'project' | 'dataset' | 'file' | 'selection';
export type ToolDefinition = {
  label: string; description: string; slug: string; icon: LucideIcon;
  requirement: 'none' | 'sourceImages' | 'workspaceImages'; scopes: readonly ToolScope[];
};
export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  import: { label: 'Import', description: 'Load source files or folders.', slug: 'import', icon: Upload, requirement: 'none', scopes: ['project'] },
  video: { label: 'Video Frames', description: 'Save video frames manually or with local visual analysis.', slug: 'video-frames', icon: Video, requirement: 'none', scopes: ['project', 'file'] },
  select: { label: 'Remove Duplicates', description: 'Find duplicate and similar source images.', slug: 'remove-duplicates', icon: ScanSearch, requirement: 'sourceImages', scopes: ['project'] },
  clean: { label: 'Photopea', description: 'Edit image and PSD assets in Photopea.', slug: 'photopea', icon: Brush, requirement: 'sourceImages', scopes: ['project', 'file'] },
  analysis: { label: 'Analysis', description: 'Explore image similarities and groups.', slug: 'analysis', icon: BarChart3, requirement: 'workspaceImages', scopes: ['project', 'dataset', 'file', 'selection'] },
  review: { label: 'Review', description: 'Review images, videos and PSDs.', slug: 'review', icon: Layers3, requirement: 'workspaceImages', scopes: ['project', 'dataset', 'selection'] },
  tagging: { label: 'Caption', description: 'Edit captions manually, in bulk or with a local model.', slug: 'caption', icon: Tags, requirement: 'workspaceImages', scopes: ['project', 'dataset', 'file', 'selection'] },
  export: { label: 'Export', description: 'Review and export matching image and TXT pairs.', slug: 'export', icon: Download, requirement: 'workspaceImages', scopes: ['project', 'dataset'] },
};
export const TOOL_ICONS = Object.fromEntries(Object.entries(TOOL_DEFINITIONS).map(([id, definition]) => [id, definition.icon])) as Record<ToolName, LucideIcon>;
