import type { InspectorSelectionPayload } from '../../stores/useInspectorSelectionStore';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { resolveAssetCaption } from '../../services/caption/captionResolver';
import { InspectorSection } from '../ui/InspectorSection';

export function InspectorSelectionDetails({
  selection,
  open,
  onOpenChange,
}: {
  selection: InspectorSelectionPayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { items } = selection;
  const sourceMemberCount = items.filter((item) => Boolean(item.assetPath && isProjectDatasetPath(item.assetPath))).length;
  const outputItem = selection.outputItem;
  const captionItems = outputItem ? [outputItem] : items;
  const captions = captionItems.map((item) => ({ item, caption: resolveAssetCaption(item) }));
  const captionTagCount = captions.reduce((count, entry) => count + entry.caption.tags.length, 0);

  return (
    <InspectorSection title="Details" open={open} onOpenChange={onOpenChange}>
      <div className="space-y-2">
        {selection.status && <div className="flex justify-between gap-3"><span className="text-muted-foreground">Status</span><span className="text-right font-medium">{selection.status}</span></div>}
        {selection.detail && <p className="text-muted-foreground">{selection.detail}</p>}
        {items.length === 0 && <p className="text-muted-foreground">Select an asset to inspect its properties.</p>}
        <div className="flex justify-between gap-3"><span className="text-muted-foreground">Selection</span><span className="font-medium">{items.length} item{items.length === 1 ? '' : 's'}</span></div>
        {outputItem ? (
          <>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Source in Dataset</span><span className="font-medium">{sourceMemberCount ? 'Yes' : 'No'}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Output in Dataset</span><span className="font-medium">{outputItem.assetPath && isProjectDatasetPath(outputItem.assetPath) ? 'Yes' : 'No'}</span></div>
          </>
        ) : <div className="flex justify-between gap-3"><span className="text-muted-foreground">In Dataset</span><span className="font-medium">{sourceMemberCount} of {items.length}</span></div>}
        <div className="flex justify-between gap-3"><span className="text-muted-foreground">Caption tags</span><span className="font-medium">{captionTagCount}</span></div>
        {(outputItem || items.length === 1) && <div className="flex justify-between gap-3"><span className="text-muted-foreground">Dimensions</span><span className="font-medium">{(outputItem ?? items[0]).width} × {(outputItem ?? items[0]).height}</span></div>}
        {captions.some((entry) => entry.caption.text) && <div className="border-t border-border pt-2"><p className="mb-1 text-muted-foreground">{outputItem ? 'Output caption' : 'Caption'}</p><div className="space-y-1">{captions.filter((entry) => entry.caption.text).slice(0, 3).map(({ item, caption }) => <p key={item.id} className="break-words text-foreground" title={caption.text}>{items.length > 1 ? `${item.originalFileName ?? item.fileName}: ` : ''}{caption.text}</p>)}{captions.filter((entry) => entry.caption.text).length > 3 && <p className="text-muted-foreground">+{captions.filter((entry) => entry.caption.text).length - 3} more</p>}</div></div>}

        {captionItems.length > 0 && !captions.some(entry => entry.caption.text) && <p className="text-muted-foreground">No caption</p>}
        {(selection.sourcePath || selection.outputPath || items.length === 1 && items[0].assetPath) && (
          <details className="border-t border-border pt-2 text-muted-foreground">
            <summary className="cursor-pointer">Technical details</summary>
            <div className="mt-2 space-y-1 break-all font-mono text-[10px]">
              {(selection.sourcePath || (items.length === 1 ? items[0].assetPath : undefined)) && <p>Source: {selection.sourcePath ?? items[0].assetPath}</p>}
              {selection.outputPath && <p>Output: {selection.outputPath}</p>}
            </div>
          </details>
        )}
      </div>
    </InspectorSection>
  );
}
