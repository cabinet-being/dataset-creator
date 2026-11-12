import type { ToolName } from '../types';
import { DATASET_TOOL_DEFINITIONS, LEGACY_DATASET_TOOL_ALIASES, type DatasetToolName } from './toolDefinitions';
import { DATASET_VIEW } from './workspaceLayout';
import type { FileWorkspaceTab } from './workspaceFileTabs';
import type { ToolSelectionScope } from './workspaceToolScope';

export type InspectorContext = 'empty' | 'tool' | 'dataset' | 'file' | 'review' | 'analysis' | 'caption' | 'photopea';

export type WorkspaceTabState = {
  pinned?: boolean;
  dirty?: boolean;
};

export type ToolWorkspaceTab = {
  id: string;
  kind: 'tool';
  tool: ToolName;
  scope?: ToolSelectionScope;
  nested?: ToolNestedView;
} & WorkspaceTabState;

export type ToolNestedView = {
  kind: 'file';
  itemId: string;
};

export type DatasetToolWorkspaceTab = {
  id: string;
  kind: 'dataset-tool';
  datasetId: string;
  tool: DatasetToolName;
  nested?: ToolNestedView;
} & WorkspaceTabState;

export type DatasetWorkspaceTab = {
  id: string;
  kind: 'dataset';
  datasetId: string;
} & WorkspaceTabState;

export type WorkspaceWindowId = 'inspector' | 'output' | 'project' | 'dataset';
export type WindowWorkspaceTab = {
  id: `window:${WorkspaceWindowId}`;
  kind: 'window';
  window: WorkspaceWindowId;
} & WorkspaceTabState;

export type WorkspaceTab = ToolWorkspaceTab | DatasetToolWorkspaceTab | FileWorkspaceTab | DatasetWorkspaceTab | WindowWorkspaceTab;

export type PersistedWorkspaceTab =
  | {
      kind: 'tool';
      tool: ToolName;
      pinned?: boolean;
      id?: string;
      scope?: Pick<ToolSelectionScope, 'review'>;
    }
  | {
      kind: 'dataset';
      datasetId: string;
      pinned?: boolean;
    }
  | {
      kind: 'dataset-tool';
      datasetId: string;
      tool: DatasetToolName;
      pinned?: boolean;
    }
  | {
      kind: 'window';
      window: WindowWorkspaceTab['window'];
      pinned?: boolean;
    };

export const createToolTab = (tool: ToolName, scope?: ToolSelectionScope): ToolWorkspaceTab => ({
  id: scope?.review
    ? `tool:review:${encodeURIComponent(scope.review.kind === 'directory' ? scope.review.path : scope.review.paths.join('|'))}`
    : `tool:${tool}`,
  kind: 'tool',
  tool,
  scope,
});

export const createFileTabId = (): string => `file:${crypto.randomUUID()}`;
export const createDatasetToolTabId = (datasetId: string, tool: DatasetToolName): string => `dataset:${datasetId}:${tool}`;

export const isDatasetToolName = (tool: unknown): tool is DatasetToolName =>
  typeof tool === 'string' && Object.prototype.hasOwnProperty.call(DATASET_TOOL_DEFINITIONS, tool);

/** Resolves current and legacy dataset tool ids (`select` was Add files before it got its own id). */
export const normalizeDatasetToolName = (tool: unknown): DatasetToolName | null =>
  isDatasetToolName(tool) ? tool
    : typeof tool === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_DATASET_TOOL_ALIASES, tool) ? LEGACY_DATASET_TOOL_ALIASES[tool]
      : null;

/** Rewrites a legacy `dataset:<id>:<tool>` view id to the current dataset tool id. */
export const migrateDatasetToolTabId = (id: string): string => {
  const match = /^(dataset:[^:]+:)([^:]+)$/.exec(id);
  if (!match || isDatasetToolName(match[2])) return id;
  const tool = normalizeDatasetToolName(match[2]);
  return tool ? `${match[1]}${tool}` : id;
};

/** Project tool that owns enablement and inspector behavior for a dataset tool tab. */
export const getDatasetToolBaseTool = (tool: DatasetToolName): ToolName => DATASET_TOOL_DEFINITIONS[tool].baseTool;

export const createWorkspaceTabFromPersisted = (tab: PersistedWorkspaceTab): WorkspaceTab => {
  if (tab.kind === 'tool') {
    return { ...createToolTab(tab.tool, tab.scope), id: tab.id ?? createToolTab(tab.tool, tab.scope).id, pinned: tab.pinned };
  }
  if (tab.kind === 'dataset') {
    return { id: DATASET_VIEW, kind: 'window', window: 'dataset', pinned: tab.pinned };
  }
  if (tab.kind === 'window') {
    const workspaceTab: WindowWorkspaceTab = {
      id: `window:${tab.window}`,
      kind: 'window',
      window: tab.window,
      pinned: tab.pinned,
    };
    return workspaceTab;
  }
  return {
    id: createDatasetToolTabId(tab.datasetId, tab.tool),
    kind: 'dataset-tool',
    datasetId: tab.datasetId,
    tool: tab.tool,
    pinned: tab.pinned,
  };
};

export const persistWorkspaceTab = (tab: WorkspaceTab): PersistedWorkspaceTab | null => {
  if (tab.kind === 'tool') {
    return { kind: 'tool', tool: tab.tool, id: tab.id, scope: tab.scope?.review ? { review: tab.scope.review } : undefined, pinned: tab.pinned };
  }
  if (tab.kind === 'dataset') return { kind: 'window', window: 'dataset', pinned: tab.pinned };
  if (tab.kind === 'dataset-tool') {
    return { kind: 'dataset-tool', datasetId: tab.datasetId, tool: tab.tool, pinned: tab.pinned };
  }
  if (tab.kind === 'window') {
    return { kind: 'window', window: tab.window, pinned: tab.pinned };
  }
  return null;
};

export const dedupeWorkspaceTabs = (tabs: WorkspaceTab[]): WorkspaceTab[] => {
  const seenIds = new Set<string>();
  return tabs.filter((tab) => {
    if (seenIds.has(tab.id)) {
      return false;
    }
    seenIds.add(tab.id);
    return true;
  });
};

export const orderWorkspaceTabs = (tabs: WorkspaceTab[]): WorkspaceTab[] => [
  ...tabs.filter((tab) => tab.pinned),
  ...tabs.filter((tab) => !tab.pinned),
];

export const isDatasetToolTab = (tab: WorkspaceTab): tab is DatasetToolWorkspaceTab => tab.kind === 'dataset-tool';
export const getInspectorContext = (tab: WorkspaceTab | null, activeTool: ToolName | null): InspectorContext => {
  if (!tab) {
    return 'empty';
  }

  if (tab.kind === 'dataset' || (tab.kind === 'window' && tab.window === 'dataset')) {
    return 'dataset';
  }

  if (tab.kind === 'file-caption' || activeTool === 'tagging') {
    return 'caption';
  }

  if (tab.kind === 'file-analysis') {
    return 'analysis';
  }

  if (tab.kind === 'file-edit' || (tab.kind === 'file-view' && tab.fileKind === 'psd')) {
    return 'photopea';
  }

  if (tab.kind === 'file-view' || tab.kind === 'file-video') {
    return 'file';
  }

  if ((tab.kind === 'tool' && tab.tool === 'review') || (tab.kind === 'dataset-tool' && (tab.tool === 'add-files' || tab.tool === 'review'))) {
    return 'review';
  }

  if ((tab.kind === 'tool' && tab.tool === 'analysis') || (tab.kind === 'dataset-tool' && tab.tool === 'analysis')) {
    return 'analysis';
  }

  return activeTool ? 'tool' : 'empty';
};
