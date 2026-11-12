import { ArrowLeft, File, FileJson, Layers3, PanelRight, Video } from 'lucide-react';
import { InspectorSection } from '../ui/InspectorSection';
import { InspectorSelectionDetails } from './InspectorSelectionDetails';
import { InspectorSlot } from './InspectorHost';
import { isFileBackedTab } from '../../lib/workspaceFileTabs';
import type { WorkspaceTab } from '../../lib/workspaceTabs';
import { TOOL_LABELS } from '../../lib/constants';
import { TOOL_ICONS as toolIcons } from '../../lib/toolDefinitions';
import type { ToolName } from '../../types';
import type { InspectorSelectionPayload } from '../../stores/useInspectorSelectionStore';

export type InspectorSectionId = 'object' | 'actions' | 'file' | 'dataset' | 'photopea' | 'review' | 'analysis' | 'caption';

export type FileInspectorMetadata = {
  dimensions?: { width: number; height: number };
  format: string;
  size: string;
  captionEntries: { label: string; tags: string[] }[];
  tags?: string[];
};

const getAspectRatioLabel = (width: number, height: number): string => {
  const divisor = (left: number, right: number): number => (right === 0 ? left : divisor(right, left % right));
  const value = divisor(width, height);
  return `${Math.round(width / value)}:${Math.round(height / value)}`;
};

export function WorkspaceInspector({
  activeTab, activeTabId, activeTool, activeDatasetName, activeInspectorSelection, inspectorSectionsOpen, setInspectorSectionOpen,
  fileInspectorMetadata, showFileInspector, showAnalysisInspector, inspectorWindowOpen, onFocusView,
}: {
  activeTab: WorkspaceTab | null;
  activeTabId: string | null;
  activeTool: ToolName | null;
  activeDatasetName: string | undefined;
  activeInspectorSelection: InspectorSelectionPayload | null;
  inspectorSectionsOpen: Record<InspectorSectionId, boolean>;
  setInspectorSectionOpen: (section: InspectorSectionId, open: boolean) => void;
  fileInspectorMetadata: FileInspectorMetadata | null;
  showFileInspector: boolean;
  showAnalysisInspector: boolean;
  inspectorWindowOpen: boolean;
  onFocusView: (id: string) => void;
}) {
  const Icon =
    activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
      ? Layers3
      : activeTab && isFileBackedTab(activeTab)
        ? activeTab.fileKind === 'video'
          ? Video
          : activeTab.fileKind === 'json'
            ? FileJson
            : File
        : activeTool
          ? toolIcons[activeTool]
          : PanelRight;
  const title =
    activeTab?.kind === 'dataset' || activeTab?.kind === 'dataset-tool'
      ? activeDatasetName ?? 'Dataset'
      : activeTab && isFileBackedTab(activeTab)
        ? activeTab.name
        : activeTool
          ? TOOL_LABELS[activeTool]
          : 'Workspace';
  const selectedItems = activeInspectorSelection?.items ?? [];


  return (
    <div className="text-xs">
      <div className="mb-3 flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{activeInspectorSelection?.title ?? title}</div>
          {activeTab && isFileBackedTab(activeTab) && <p className="mt-1 truncate text-muted-foreground">{activeTab.path}</p>}
          {activeInspectorSelection && <p className="mt-1 text-muted-foreground">{selectedItems.length} selected</p>}
        </div>
        {activeTabId && <button className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary" aria-label="Return to active editor" title="Return to editor" onClick={() => onFocusView(activeTabId)}><ArrowLeft size={16} /></button>}
      </div>

      {activeInspectorSelection ? (
        <InspectorSelectionDetails
          selection={activeInspectorSelection}
          open={inspectorSectionsOpen.object}
          onOpenChange={(open) => setInspectorSectionOpen('object', open)}
        />
      ) : (
        <InspectorSection title="Details" open={inspectorSectionsOpen.object} onOpenChange={(open) => setInspectorSectionOpen('object', open)}>
          <div className="space-y-2 text-muted-foreground">
            {activeTab && isFileBackedTab(activeTab) ? <p>{activeTab.fileKind.toUpperCase()} file</p> : <p>{activeTab ? title : 'No active selection'}</p>}
            {activeTab && isFileBackedTab(activeTab) && <p className="break-all font-mono text-[10px]">{activeTab.path}</p>}
            {activeTool && <p>{TOOL_LABELS[activeTool]} workspace</p>}
          </div>
        </InspectorSection>
      )}

      {!activeInspectorSelection && showFileInspector && fileInspectorMetadata && activeTab && isFileBackedTab(activeTab) ? (
        <InspectorSection
          title="File"
          open={inspectorSectionsOpen.file}
          onOpenChange={(open) => setInspectorSectionOpen('file', open)}
        >
          <div className="space-y-2">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Format</span>
              <span className="font-medium">{fileInspectorMetadata.format}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Workspace asset</span>
              <span className="font-medium">{activeTab.workspaceImageId ? 'Linked' : 'External'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Size</span>
              <span className="font-medium">{fileInspectorMetadata.size}</span>
            </div>
            {fileInspectorMetadata.dimensions ? (
              <>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Dimensions</span>
                  <span className="font-medium">
                    {fileInspectorMetadata.dimensions.width} x {fileInspectorMetadata.dimensions.height}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Aspect ratio</span>
                  <span className="font-medium">
                    {getAspectRatioLabel(fileInspectorMetadata.dimensions.width, fileInspectorMetadata.dimensions.height)}
                  </span>
                </div>
              </>
            ) : null}
            {fileInspectorMetadata.captionEntries.length > 0 ? (
              <div className="border-t border-border pt-2.5">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Caption</span>
                  <span className="text-[10px] text-muted-foreground">
                    {fileInspectorMetadata.captionEntries.reduce((count, entry) => count + entry.tags.length, 0)} tags
                  </span>
                </div>
                <div className="space-y-2">
                  {fileInspectorMetadata.captionEntries.map((entry) => (
                    <div key={entry.label} className="space-y-1">
                      {fileInspectorMetadata.captionEntries.length > 1 ? (
                        <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                          {entry.label}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-1.5">
                        {entry.tags.map((tag, index) => (
                          <span
                            key={`${entry.label}-${tag}-${index}`}
                            className="max-w-full truncate rounded-sm border border-border bg-secondary/70 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-foreground"
                            title={tag}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </InspectorSection>
      ) : null}

      {showAnalysisInspector ? (
        <InspectorSection
          title="Analysis"
          open={inspectorSectionsOpen.analysis}
          onOpenChange={(open) => setInspectorSectionOpen('analysis', open)}
        >
          {inspectorWindowOpen && <InspectorSlot id="analysis-inspector-root" />}
        </InspectorSection>
      ) : null}

    </div>
  );
}
