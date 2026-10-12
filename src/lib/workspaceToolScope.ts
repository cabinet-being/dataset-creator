import type { ToolName } from '../types';
import type { ExplorerFileKind } from '../services/project/explorerFileService';
import { applyExplorerPathMoves, applyWorkspaceAssetIdMoves } from './datasetAssets';

export type AnalysisScopeTarget = {
  path: string;
  name: string;
  fileKind: ExplorerFileKind;
  file: File | Blob;
  workspaceImageId?: string;
};

export type ToolSelectionScope = {
  analysisFiles?: AnalysisScopeTarget[];
  taggingItemIds?: string[];
};

/** Gallery callbacks can outlive their rendered items during a scope change. */
export function resolveCurrentScope<T extends {id: string}>(items: T[], selection: readonly {id: string}[] | null): T[] {
  if (selection === null) return items;
  const current = new Map(items.map(item => [item.id, item]));
  return selection.map(item => current.get(item.id)).filter((item): item is T => item !== undefined);
}

export type ToolViewContext =
  | { tool: Exclude<ToolName, 'video'>; context: {kind: 'project'; selectedItemId?: string} }
  | { tool: 'analysis'; context: {kind: 'selection'; files: AnalysisScopeTarget[]} }
  | { tool: 'tagging'; context: {kind: 'selection'; itemIds: string[]; selectedItemId?: string} };

export function getToolViewContext(tool: Exclude<ToolName, 'video'>, scope?: ToolSelectionScope, selectedItemId?: string): ToolViewContext {
  if (tool === 'analysis' && scope?.analysisFiles !== undefined) {
    return {tool, context:{kind:'selection', files:scope.analysisFiles}};
  }
  if (tool === 'tagging' && scope?.taggingItemIds !== undefined) {
    return {tool, context:{kind:'selection', itemIds:scope.taggingItemIds, selectedItemId}};
  }
  return {tool, context:{kind:'project', selectedItemId}};
}

type ScopedTab = { id: string; kind: string; tool?: ToolName; scope?: ToolSelectionScope; nested?: {itemId: string} };

/** Explicitly reopening a tool changes only that view's scope. */
export function setToolViewScope<T extends ScopedTab>(tabs: T[], id: string, scope?: ToolSelectionScope): T[] {
  return tabs.map(tab => {
    if (tab.id !== id || tab.kind !== 'tool') return tab;
    const next = tab.tool === 'analysis' && scope?.analysisFiles
      ? {analysisFiles:scope.analysisFiles}
      : tab.tool === 'tagging' && scope?.taggingItemIds ? {taggingItemIds:scope.taggingItemIds} : undefined;
    return {...tab, scope:next, nested:tab.scope || next ? undefined : tab.nested};
  });
}

export function moveToolViewScope<T extends ScopedTab>(tab: T, moves: {from: string; to: string}[]): T {
  if (tab.kind !== 'tool') return tab;
  let changed = false;
  const analysisFiles = tab.scope?.analysisFiles?.map(file => {
    const path = applyExplorerPathMoves(file.path, moves);
    if (path === file.path) return file;
    changed = true;
    return {...file, path, name:path.split('/').pop() ?? file.name, workspaceImageId:applyWorkspaceAssetIdMoves(file.workspaceImageId, moves)};
  });
  const taggingItemIds = tab.scope?.taggingItemIds?.map(id => {
    const next = applyWorkspaceAssetIdMoves(id, moves)!;
    if (next !== id) changed = true;
    return next;
  });
  const nestedId = applyWorkspaceAssetIdMoves(tab.nested?.itemId, moves);
  const nested = tab.nested && nestedId !== tab.nested.itemId ? {...tab.nested, itemId:nestedId!} : tab.nested;
  return changed || nested !== tab.nested ? {...tab, nested, scope:tab.scope ? {...tab.scope, analysisFiles, taggingItemIds} : undefined} : tab;
}

export function pruneToolViewScope<T extends ScopedTab>(tab: T, paths: string[], removedIds: ReadonlySet<string>): T {
  if (tab.kind !== 'tool') return tab;
  const deletedPath = (path: string) => paths.some(root => path === root || path.startsWith(`${root}/`));
  const deletedId = (id: string) => removedIds.has(id) || (id.startsWith('asset:') && deletedPath(id.slice('asset:'.length)));
  const analysisFiles = tab.scope?.analysisFiles?.filter(file => !deletedPath(file.path) && (!file.workspaceImageId || !deletedId(file.workspaceImageId)));
  const taggingItemIds = tab.scope?.taggingItemIds?.filter(id => !deletedId(id));
  const nested = tab.nested && deletedId(tab.nested.itemId) ? undefined : tab.nested;
  if (analysisFiles?.length === tab.scope?.analysisFiles?.length && taggingItemIds?.length === tab.scope?.taggingItemIds?.length && nested === tab.nested) return tab;
  return {...tab, nested, scope:tab.scope ? {...tab.scope, analysisFiles, taggingItemIds} : undefined};
}
