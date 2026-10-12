import type { ExplorerFileKind } from '../services/project/explorerFileService';
import { applyExplorerPathMoves, applyWorkspaceAssetIdMoves, type ExplorerPathMove } from './datasetAssets';

export type FileWorkspaceTab = {
  id: string;
  kind: 'file-view' | 'file-edit' | 'file-caption' | 'file-analysis' | 'file-video';
  path: string;
  name: string;
  fileKind: ExplorerFileKind;
  file: File | Blob;
  workspaceImageId?: string;
  pinned?: boolean;
  dirty?: boolean;
};

export const isFileBackedTab = (tab: { kind: string }): tab is FileWorkspaceTab =>
  ['file-view', 'file-edit', 'file-caption', 'file-analysis', 'file-video'].includes(tab.kind);

export const findFileTab = (tabs: readonly { kind: string }[], path: string, kind: FileWorkspaceTab['kind']) =>
  tabs.find((tab): tab is FileWorkspaceTab => isFileBackedTab(tab) && tab.path === path && tab.kind === kind);

/** A view owns its live editor. Its identity must not change with a filesystem path. */
export function moveFileTab<T extends { kind: string }>(tab: T, moves: ExplorerPathMove[]): T {
  if (!isFileBackedTab(tab)) return tab;
  const path = applyExplorerPathMoves(tab.path, moves);
  return path === tab.path ? tab : { ...tab, path, name: path.split('/').pop() ?? tab.name, workspaceImageId: applyWorkspaceAssetIdMoves(tab.workspaceImageId, moves) };
}
