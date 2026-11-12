import { lazy, type ComponentProps, type MouseEvent } from 'react';
import type { AnalysisScopeTarget, ToolViewContext } from '../../lib/workspaceToolScope';
export type { AnalysisScopeTarget } from '../../lib/workspaceToolScope';
import type { Dataset } from '../../types';
import type { DatasetToolName } from '../../lib/toolDefinitions';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import type { ImportInputFile, ImportImagesOptions, ImportImagesResult } from '../../services/import/importService';
import { CleanupTool } from '../tools/CleanupTool';
import { FinalReviewTool } from '../tools/FinalReviewTool';
import { TaggingTool } from '../tools/TaggingTool';
import { PhotopeaBlobViewer } from '../photopea/PhotopeaFrame';

const ImportTool = lazy(() => import('../tools/ImportTool').then(module => ({default:module.ImportTool})));
const SimilarityReviewTool = lazy(() => import('../tools/SimilarityReviewTool').then(module => ({default:module.SimilarityReviewTool})));
const AnalysisTool = lazy(() => import('../tools/AnalysisTool').then(module => ({default:module.AnalysisTool})));
const ExportTool = lazy(() => import('../tools/ExportTool').then(module => ({default:module.ExportTool})));
const VideoFramesTool = lazy(() => import('../tools/VideoFramesTool').then(module => ({default:module.VideoFramesTool})));
const BuildWorkspace = lazy(() => import('../build/BuildWorkspace').then(module => ({default:module.BuildWorkspace})));

export type AssetContextMenuHandler = (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
export type { DatasetToolName } from '../../lib/toolDefinitions';
type DatasetUpdates = Partial<Pick<Dataset, 'assetOrder'>>;

type DatasetContext = {
  kind: 'dataset';
  datasetId: string;
  onUpdate: (updates: DatasetUpdates) => void | Promise<void>;
  onAddFiles: () => void;
  onAutoAssemble: () => void;
};
type FileContext = { kind: 'file'; file: AnalysisScopeTarget };
type Props = {
  active: boolean;
  viewId?: string;
  directory?: ProjectDirectoryHandle | null;
  onAssetContextMenu?: AssetContextMenuHandler;
  onOpenItem?: (itemId: string) => void;
  onOpenProjectFile?: (path: string) => void;
  onRefresh?: () => void | Promise<void>;
  onOpenImport?: () => void;
  onImportFiles?: (files: ImportInputFile[], execution?: Pick<ImportImagesOptions, 'signal' | 'onProgress'>) => Promise<ImportImagesResult>;
  items?: WorkspaceImage[];
} & (
  | ToolViewContext
  | { tool: DatasetToolName; context: DatasetContext }
  | { tool: 'analysis' | 'tagging'; context: FileContext }
  | { tool: 'clean'; context: FileContext & {onSavePsd: NonNullable<ComponentProps<typeof PhotopeaBlobViewer>['onSavePsd']>} }
  | { tool: 'video'; context: ({kind: 'project'} | FileContext) & {viewId: string; onSaved?: () => void | Promise<void>} }
);

// One renderer owns tool wiring. The context union keeps Dataset callbacks and
// file targets together instead of allowing unrelated optional scope props.
export function WorkspaceTool({ tool, context, active, viewId, directory, items = [], onAssetContextMenu, onOpenItem, onOpenProjectFile, onRefresh, onOpenImport, onImportFiles }: Props) {
  if (tool === 'video') {
    return <VideoFramesTool active={active} tabId={context.viewId} projectDirectoryHandle={directory}
      file={context.kind === 'file' ? context.file.file : undefined}
      fileName={context.kind === 'file' ? context.file.name : undefined} onSaved={context.onSaved} />;
  }
  if (tool === 'clean' && context.kind === 'file') {
    return <PhotopeaBlobViewer active={active} file={context.file.file} fileName={context.file.name} onSavePsd={context.onSavePsd} />;
  }
  const dataset = context.kind === 'dataset' ? context : undefined;
  const project = context.kind === 'project' ? context : undefined;
  const file = context.kind === 'file' ? context.file : undefined;
  const selection = context.kind === 'selection' ? context : undefined;
  const review = context.kind === 'review' ? context.scope : undefined;
  switch (tool) {
    case 'build': return <BuildWorkspace active={active} viewId={viewId ?? 'tool:build'} directory={directory} items={items} onImportFiles={onImportFiles} onRefresh={onRefresh} />;
    case 'import': return <ImportTool active={active} onImportFiles={onImportFiles} />;
    case 'add-files': return dataset
      ? <FinalReviewTool active={active} datasetId={dataset.datasetId} mode="select" viewId={viewId} onRefresh={onRefresh} onUpdateDataset={dataset.onUpdate} onOpenImport={onOpenImport} onOpenAssetContextMenu={onAssetContextMenu} />
      : null;
    case 'select': return <SimilarityReviewTool />;
    case 'clean': return <CleanupTool active={active} selectedImageId={project?.selectedItemId ?? null} onSelectImage={onOpenItem} onOpenProjectFile={onOpenProjectFile} projectDirectoryHandle={directory} />;
    case 'analysis': return <AnalysisTool viewId={viewId} active={active} datasetId={dataset?.datasetId} onUpdateDataset={dataset?.onUpdate} projectDirectoryHandle={directory}
      fileTarget={file} fileTargets={selection && 'files' in selection ? selection.files : undefined} onOpenAssetContextMenu={onAssetContextMenu} onAutoAssemble={dataset?.onAutoAssemble} />;
    case 'review': return <FinalReviewTool active={active} datasetId={dataset?.datasetId} mode="review" onUpdateDataset={dataset?.onUpdate}
      scope={review} viewId={viewId} onRefresh={onRefresh} onAddFiles={dataset?.onAddFiles} onOpenImport={onOpenImport} onOpenAssetContextMenu={onAssetContextMenu} />;
    case 'tagging': return <TaggingTool viewId={viewId} active={active} datasetId={dataset?.datasetId}
      selectedItemId={file ? file.workspaceImageId : selection && 'itemIds' in selection ? selection.selectedItemId ?? null : project?.selectedItemId ?? null} singleFileMode={Boolean(file)}
      scopedItemIds={selection && 'itemIds' in selection ? selection.itemIds : undefined} onOpenItem={onOpenItem} onOpenAssetContextMenu={onAssetContextMenu} />;
    case 'export': return <ExportTool active={active} />;
  }
}
