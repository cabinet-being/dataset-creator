import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { BarChart3, Download, Layers3, Pencil, Plus, Sparkles, Tags, Wand2 } from 'lucide-react';
import type { Dataset, ProjectType } from '../../types';
import { ADVANCED_TOOL_GROUP_LABEL, TOOL_DEFINITIONS, type DatasetToolName } from '../../lib/toolDefinitions';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { AssetGallery } from '../ui/AssetGallery';
import { BrickMasonry } from '../ui/BrickMasonry';
import { WorkspacePreviewCard } from '../ui/WorkspacePreviewCard';
import { ContextActionGroups } from '../ui/ContextActions';
import { datasetBoardItems, DATASET_BOARD_SORT_OPTIONS, type DatasetBoardSortMode } from '../../lib/datasetBoard';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { DatasetAssemblyDialog } from './DatasetAssemblyDialog';
import { TriggerWordInput } from '../ui/TriggerWordInput';

export type EmptyDatasetSuggestion = { signature: string; items: WorkspaceImage[]; assetIds: string[]; totalCount: number };
type Props = {
  viewId?: string; dataset: Dataset; items: WorkspaceImage[]; active: boolean; suggestion: EmptyDatasetSuggestion | null;
  onTool: (tool: DatasetToolName) => void;
  onBuild?: () => void;
  onExport: () => void;
  onRename?: (name: string) => void;
  onUpdate: (updates: Partial<Pick<Dataset, 'triggerWord'>>) => void;
  canDrop: (event: DragEvent<HTMLDivElement>) => boolean;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onContextMenu: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
  onApplySuggestion: (suggestion: EmptyDatasetSuggestion) => void;
  onDismissSuggestion: (signature: string) => void;
  projectDirectoryHandle?: ProjectDirectoryHandle;
  projectId: string;
  projectType: ProjectType;
  excludedCategories: string[];
  includedCategories: string[];
  onApplyAssembly: (paths: string[]) => Promise<void>;
  assemblyRequestToken?: number;
  onAssemblyRequestHandled?: () => void;
};
const EMPTY_ITEMS: WorkspaceImage[] = [];
export function DatasetBoard({ viewId, dataset, items, active, suggestion, onTool, onBuild, onExport, onRename, onUpdate, canDrop, onDrop, onContextMenu, onApplySuggestion, onDismissSuggestion,
  projectDirectoryHandle, projectId, projectType, excludedCategories, includedCategories, onApplyAssembly, assemblyRequestToken, onAssemblyRequestHandled }: Props) {
  const [sort, setSort] = useState<DatasetBoardSortMode>('name');
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(dataset.name);
  useEffect(() => { setNameDraft(dataset.name); setRenaming(false); }, [dataset.id, dataset.name]);
  const commitName = () => {
    if (!renaming) return;
    setRenaming(false);
    const name = nameDraft.trim();
    if (name && name !== dataset.name) onRename?.(name);
    else setNameDraft(dataset.name);
  };
  const [dropActive, setDropActive] = useState(false);
  const [assemblyOpen, setAssemblyOpen] = useState(false);
  useEffect(() => { if (assemblyRequestToken) { setAssemblyOpen(true); onAssemblyRequestHandled?.(); } }, [assemblyRequestToken, onAssemblyRequestHandled]);
  const boardItems = useMemo(() => datasetBoardItems(items, dataset, sort), [items, dataset, sort]);
  const previewUrls = useWorkspacePreviewUrls(boardItems);
  const suggestionPreviewUrls = useWorkspacePreviewUrls(suggestion?.items ?? EMPTY_ITEMS);
  const linked = items.length;
  const captioned = boardItems.filter(item => item.tags?.length).length;
  return <div className={`h-full min-h-0 overflow-auto p-3 sm:p-5 ${dropActive ? 'ring-2 ring-inset ring-primary bg-primary/5' : ''}`}
    onDragOver={event => { if (canDrop(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); } }}
    onDragEnter={event => { if (canDrop(event)) setDropActive(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
    onDrop={event => { setDropActive(false); onDrop(event); }}>
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {renaming ? <input aria-label="Dataset name" autoFocus value={nameDraft}
              onChange={event => setNameDraft(event.target.value)} onBlur={commitName}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); commitName(); }
                if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); setNameDraft(dataset.name); }
              }} className="min-w-0 rounded border border-border bg-background px-2 py-1 text-xl font-semibold" />
              : <h2 className="truncate text-xl font-semibold">{dataset.name}</h2>}
            {onRename && !renaming && <button type="button" aria-label="Rename Dataset" onClick={() => setRenaming(true)} className="rounded p-1 text-muted-foreground hover:bg-secondary"><Pencil size={15} /></button>}
          </div>
          <p className="text-sm text-muted-foreground">{linked} assets · {captioned}/{boardItems.length} captions</p>
        </div>
        <ContextActionGroups mode="toolbar" groups={[[
          { id: 'add', label: 'Add files', icon: Plus, onSelect: () => onTool('add-files') },
          { id: 'assemble', label: 'Auto assemble', icon: Sparkles, onSelect: () => setAssemblyOpen(true) },
          ...(onBuild ? [{ id: 'build', label: TOOL_DEFINITIONS.build.label, icon: Wand2, variant: 'primary' as const, onSelect: onBuild }] : []),
        ]]} />
      </header>
      <details className="rounded border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm">Dataset options</summary>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">Trigger
            <TriggerWordInput value={dataset.triggerWord} onApply={triggerWord => onUpdate({ triggerWord })} className="w-44 max-w-full rounded border border-border bg-background px-2 py-1.5" />
          </label>
        </div>
      </details>
      <details className="rounded border border-border px-3 py-2" data-testid="dataset-advanced-tools">
        <summary className="cursor-pointer text-sm">{ADVANCED_TOOL_GROUP_LABEL}</summary>
        <div className="mt-3">
          <ContextActionGroups mode="toolbar" groups={[[
            { id: 'review', label: TOOL_DEFINITIONS.review.label, icon: Layers3, onSelect: () => onTool('review') },
            { id: 'caption', label: TOOL_DEFINITIONS.tagging.label, icon: Tags, onSelect: () => onTool('tagging') },
            { id: 'analysis', label: TOOL_DEFINITIONS.analysis.label, icon: BarChart3, onSelect: () => onTool('analysis') },
            { id: 'export', label: TOOL_DEFINITIONS.export.label, icon: Download, onSelect: onExport },
          ]]} />
        </div>
      </details>
      {dropActive && <p role="status" className="text-sm text-primary">Release to add files</p>}
      {items.length > 0 ? (
              <AssetGallery
                inspectorOwnerId={viewId}
                active={active}
                directInteraction
                membership="remove" showOrder={false}
                toolbarControls={<select aria-label="Dataset order" value={sort} onChange={event => setSort(event.target.value as DatasetBoardSortMode)} className="rounded-md border border-border bg-background p-2 text-sm">
                  {DATASET_BOARD_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>}
                items={boardItems}
                className="p-3"
                renderItem={(item) => (
                  <WorkspacePreviewCard
                    item={item}
                    previewUrl={previewUrls[item.id]}
                    className="gallery-masonry-item"
                    onOpenContextMenu={(_item, event) => onContextMenu(item, event)}
                    footer={
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
                        <div className="flex items-end justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white">{item.originalFileName ?? item.fileName}</p>
                            <p className="text-xs text-gray-300">
                              {item.label} · {item.width} x {item.height}
                            </p>
                          </div>
                        </div>
                      </div>
                    }
                  />
                )}
              />
      ) : suggestion ? (
            <div className="min-h-40 rounded border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Suggested fill</p>
                  <p className="text-xs text-muted-foreground">
                    {suggestion.totalCount} captioned asset
                    {suggestion.totalCount !== 1 ? 's' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onApplySuggestion(suggestion)}
                    className="inline-flex items-center rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Add {suggestion.totalCount} asset
                    {suggestion.totalCount !== 1 ? 's' : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismissSuggestion(suggestion.signature)}
                    className="inline-flex items-center rounded border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <BrickMasonry
                items={suggestion.items}
                getKey={(item) => item.id}
                getEstimate={(item) => item.height / Math.max(1, item.width)}
                className="p-3"
                renderItem={(item) => (
                  <WorkspacePreviewCard
                    item={item}
                    previewUrl={suggestionPreviewUrls[item.id]}
                    className="gallery-masonry-item opacity-45 grayscale transition hover:opacity-65 hover:grayscale-0"
                    footer={
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
                        <div className="flex items-end justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white">{item.originalFileName ?? item.fileName}</p>
                            <p className="text-xs text-gray-300">
                              {item.tags?.length ?? 0} tag{(item.tags?.length ?? 0) !== 1 ? 's' : ''}
                            </p>
                          </div>
                        </div>
                      </div>
                    }
                  />
                )}
              />
            </div>
      ) : (
        <div className="py-10 text-center"><p className="text-sm text-muted-foreground">{linked ? 'No linked files available' : 'Empty Dataset'}</p></div>
      )}
    </div>
    <DatasetAssemblyDialog open={assemblyOpen} onOpenChange={setAssemblyOpen} dataset={dataset} items={items}
      directory={projectDirectoryHandle} projectId={projectId} projectType={projectType}
      excludedCategories={excludedCategories} includedCategories={includedCategories} onApply={onApplyAssembly} />
  </div>;
}
