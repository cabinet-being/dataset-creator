import type { MouseEvent, MutableRefObject } from 'react';
import { WorkspaceTool, type AssetContextMenuHandler, type DatasetToolName } from './WorkspaceTool';
import { DatasetBoard, type EmptyDatasetSuggestion } from './DatasetBoard';
import { addDatasetReferences } from '../../lib/assetActions';
import { DATASET_VIEW } from '../../lib/workspaceLayout';
import type { DatasetToolWorkspaceTab } from '../../lib/workspaceTabs';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { ExplorerItemEntry } from '../../hooks/useWorkspaceCommands';
import { flushProjectSave } from '../../hooks/useProjectSave';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { useOperationStore } from '../../stores/useOperationStore';
import { useProjectStore } from '../../stores/useProjectStore';
import type { Dataset, ProjectState, ProjectType, ToolName } from '../../types';


const WORKSPACE_TAB_DRAG_TYPE = 'application/x-dataset-creator-workspace-tab';

type AddNotification = (type: 'success' | 'error' | 'warning' | 'info', message: string) => void;
type DatasetUpdates = Partial<Pick<Dataset, 'name' | 'triggerWord' | 'assetOrder'>>;
type DatasetContextMenuHandler = (dataset: Dataset, item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;

export function DatasetWorkspaceView({
  dataset, items, active, suggestion, projectDirectoryHandle, projectId, projectType, assemblyRequestToken, setAssemblyRequestToken,
  workspaceSettings, openDatasetToolTab, navigateToTool, updateDatasetFileBackedState, addNotification, openDatasetBoardAssetContextMenu,
  applyEmptyDatasetSuggestion, dismissEmptyDatasetSuggestion, draggedExplorerEntriesRef, draggedExplorerEntries,
  getExplorerEntriesFromTransferPath, setCurrentDraggedExplorerEntries, collectDatasetAssetIdsFromExplorerEntries,
  collectDatasetAssetPathsFromExplorerEntries, indexProjectWorkspaceAssets, importDroppedFilesIntoDataset,
}: {
  dataset: Dataset;
  items: WorkspaceImage[];
  active: boolean;
  suggestion: EmptyDatasetSuggestion | null;
  projectDirectoryHandle: ProjectDirectoryHandle | undefined;
  projectId: string;
  projectType: ProjectType;
  assemblyRequestToken: number;
  setAssemblyRequestToken: (token: number) => void;
  workspaceSettings: ProjectState['workspaceSettings'];
  openDatasetToolTab: (datasetId: string, tool: DatasetToolName) => void;
  navigateToTool: (tool: ToolName) => void;
  updateDatasetFileBackedState: (dataset: Dataset, updates: DatasetUpdates) => Promise<void>;
  addNotification: AddNotification;
  openDatasetBoardAssetContextMenu: DatasetContextMenuHandler;
  applyEmptyDatasetSuggestion: (dataset: Dataset, suggestion: EmptyDatasetSuggestion) => Promise<void>;
  dismissEmptyDatasetSuggestion: (signature: string) => void;
  draggedExplorerEntriesRef: MutableRefObject<ExplorerItemEntry[] | null>;
  draggedExplorerEntries: ExplorerItemEntry[] | null;
  getExplorerEntriesFromTransferPath: (path: string) => ExplorerItemEntry[];
  setCurrentDraggedExplorerEntries: (entries: ExplorerItemEntry[] | null) => void;
  collectDatasetAssetIdsFromExplorerEntries: (entries: ExplorerItemEntry[]) => string[];
  collectDatasetAssetPathsFromExplorerEntries: (entries: ExplorerItemEntry[]) => string[];
  indexProjectWorkspaceAssets: () => Promise<void>;
  importDroppedFilesIntoDataset: (dataTransfer: DataTransfer, dataset: Dataset) => Promise<{ assetIds: string[]; assetPaths: string[] }>;
}) {
  return (
  <DatasetBoard viewId={DATASET_VIEW} dataset={dataset} items={items} active={active} suggestion={suggestion}
    projectDirectoryHandle={projectDirectoryHandle} projectId={projectId} projectType={projectType}
    assemblyRequestToken={assemblyRequestToken}
    onAssemblyRequestHandled={() => setAssemblyRequestToken(0)}
    excludedCategories={workspaceSettings.excludedProjectCategories ?? []} includedCategories={workspaceSettings.includedProjectCategories ?? []}
    onTool={tool => openDatasetToolTab(dataset.id, tool)} onExport={() => navigateToTool('export')}
    onUpdate={updates => { void updateDatasetFileBackedState(dataset, updates).catch(error => addNotification('error', `Could not save Dataset: ${error instanceof Error ? error.message : String(error)}`)); }}
    onRename={name => { void updateDatasetFileBackedState(dataset, { name }).catch(error => addNotification('error', `Could not rename Dataset: ${error instanceof Error ? error.message : String(error)}`)); }}
    onContextMenu={(item, event) => openDatasetBoardAssetContextMenu(dataset, item, event)}
    onApplySuggestion={suggestion => { void applyEmptyDatasetSuggestion(dataset, suggestion).catch(error => addNotification('error', `Could not add suggested files: ${error instanceof Error ? error.message : String(error)}`)); }}
    onDismissSuggestion={dismissEmptyDatasetSuggestion}
    onApplyAssembly={async paths => {
      const addedCount = await addDatasetReferences({ assetPaths: paths });
      if (!addedCount) { addNotification('info', 'Selected images are already in this Dataset'); return; }
      await flushProjectSave();
      addNotification('success', `Added ${addedCount} coverage image${addedCount === 1 ? '' : 's'} to ${dataset.name}`);
    }}
    canDrop={event => !event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE) && Boolean(draggedExplorerEntriesRef.current?.length || draggedExplorerEntries?.length || event.dataTransfer.types.includes('text/plain') || event.dataTransfer.types.includes('Files'))}
    onDrop={event => {
        if (event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE)) {
          return;
        }
        const transferPath = event.dataTransfer.getData('text/plain');
        const droppedEntries =
          draggedExplorerEntriesRef.current ??
          draggedExplorerEntries ??
          (transferPath ? getExplorerEntriesFromTransferPath(transferPath) : null);
        const hasFiles = event.dataTransfer.types.includes('Files');
        if (!droppedEntries?.length && !hasFiles) {
          return;
        }
        event.preventDefault();
        const dataTransfer = event.dataTransfer;
        setCurrentDraggedExplorerEntries(null);
        const operationId = crypto.randomUUID();
        const operations = useOperationStore.getState();
        operations.start({ id: operationId, viewId: DATASET_VIEW, label: 'Add files to Dataset' });
        void (async () => {
          let assetIds = droppedEntries?.length
            ? collectDatasetAssetIdsFromExplorerEntries(droppedEntries)
            : [];
          let assetPaths = droppedEntries?.length
            ? collectDatasetAssetPathsFromExplorerEntries(droppedEntries)
            : [];
          if (droppedEntries?.length && assetIds.length === 0 && assetPaths.length === 0) {
            await indexProjectWorkspaceAssets();
            assetIds = collectDatasetAssetIdsFromExplorerEntries(droppedEntries);
            assetPaths = collectDatasetAssetPathsFromExplorerEntries(droppedEntries);
          }
          if (hasFiles) {
            const imported = await importDroppedFilesIntoDataset(dataTransfer, dataset);
            assetIds = [...assetIds, ...imported.assetIds];
            assetPaths = [...assetPaths, ...imported.assetPaths];
          }
          if (assetIds.length > 0 || assetPaths.length > 0) {
            const addedCount = await addDatasetReferences({ assetIds, assetPaths });
            if (addedCount > 0) {
              await flushProjectSave();
              addNotification('success', `Added ${addedCount} asset${addedCount !== 1 ? 's' : ''} to ${dataset.name}`);
            } else {
              addNotification('info', 'Selected assets are already in this Dataset');
            }
          } else {
            addNotification('warning', 'No supported project assets found to add');
          }
        })().then(() => operations.finish(operationId, 'completed')).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          operations.finish(operationId, 'failed', message);
          addNotification('error', `Could not add files: ${message}`);
        });
    }} />
  );
}

export function DatasetToolView({
  tab, dataset, activeTabId, projectDirectoryHandle, indexProjectWorkspaceAssets, updateDatasetFileBackedState, addNotification,
  openDatasetToolTab, setAssemblyRequestToken, openProjectDataset, navigateToTool, openAssetExplorerContextMenu, openDatasetBoardAssetContextMenu,
}: {
  tab: DatasetToolWorkspaceTab;
  dataset: Dataset | undefined;
  activeTabId: string | null;
  projectDirectoryHandle: ProjectDirectoryHandle | undefined;
  indexProjectWorkspaceAssets: () => Promise<void>;
  updateDatasetFileBackedState: (dataset: Dataset, updates: DatasetUpdates) => Promise<void>;
  addNotification: AddNotification;
  openDatasetToolTab: (datasetId: string, tool: DatasetToolName) => void;
  setAssemblyRequestToken: (token: number) => void;
  openProjectDataset: () => void;
  navigateToTool: (tool: ToolName) => void;
  openAssetExplorerContextMenu: AssetContextMenuHandler;
  openDatasetBoardAssetContextMenu: DatasetContextMenuHandler;
}) {
  if (!dataset) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Dataset is no longer available
      </div>
    );
  }

  const updateDataset = (updates: Partial<Pick<Dataset, 'assetOrder'>>) => {
    const latestDataset = useProjectStore.getState().dataset;
    if (!latestDataset) {
      addNotification('warning', 'Dataset is no longer available');
      return;
    }
    return updateDatasetFileBackedState(latestDataset, updates);
  };
  return <WorkspaceTool tool={tab.tool} viewId={tab.id} active={activeTabId === tab.id} directory={projectDirectoryHandle}
    onRefresh={() => indexProjectWorkspaceAssets()}
    context={{kind:'dataset', datasetId:dataset.id, onUpdate:updateDataset, onAddFiles:() => openDatasetToolTab(dataset.id, 'select'), onAutoAssemble:() => { setAssemblyRequestToken(Date.now()); openProjectDataset(); }}}
    onOpenImport={() => navigateToTool('import')}
    onAssetContextMenu={tab.tool === 'select' ? openAssetExplorerContextMenu : (item, event) => openDatasetBoardAssetContextMenu(dataset, item, event)} />;
}
