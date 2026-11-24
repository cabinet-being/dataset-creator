import { useCallback } from 'react';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { persistCaptionTagsForItems } from '../../services/caption/captionMutationService';
import type { QualityAction } from '../../services/quality/metrics';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { runHistoryTransaction } from '../../stores/useHistoryStore';
import { useUIStore } from '../../stores/useUIStore';

type Options = {
  datasetItems: readonly WorkspaceImage[];
  directory?: ProjectDirectoryHandle | null;
  onSelectId?: (id: string) => void;
  /** Receives every flagged id. When set it is used instead of `onSelectId` (which only gets the first one). */
  onSelectIds?: (ids: string[], action: QualityAction) => void;
};

/** Whether a quality action has a handler here: tag removal, or selecting files (never deleting them). */
export const canApplyQualityAction = (_source: unknown, action: QualityAction) =>
  (action.kind === 'remove' && Boolean(action.tags?.length)) ||
  ((action.kind === 'remove' || action.kind === 'review') && Boolean(action.ids?.length));

/** Applies quality-report actions in Build. Tag removal is one undoable history step; nothing is rewritten automatically. */
export function useQualityActions({ datasetItems, directory, onSelectId, onSelectIds }: Options) {
  const notify = useUIStore((state) => state.addNotification);
  const apply = useCallback(async (_source: unknown, action: QualityAction) => {
    if (action.kind === 'remove' && action.tags?.length) {
      const tags = new Set(action.tags.map((tag) => tag.toLocaleLowerCase()));
      const targets = datasetItems.filter((item) => item.tags !== undefined);
      const skipped = datasetItems.length - targets.length;
      if (!targets.length) { notify('info', `No Dataset captions with saved tags to update${skipped ? ` (${skipped} skipped)` : ''}.`); return; }
      if (!window.confirm(`Remove ${action.tags.length} tag${action.tags.length === 1 ? '' : 's'} (${action.tags.join(', ')}) from ${targets.length} Dataset caption${targets.length === 1 ? '' : 's'}?${skipped ? ` ${skipped} file${skipped === 1 ? ' has' : 's have'} no saved tags and will be skipped.` : ''}`)) return;
      try {
        const changed = await runHistoryTransaction('Remove common caption tags', async (historyWriter) =>
          persistCaptionTagsForItems({
            items: [...targets], directory, flush: flushProjectSave, historyWriter,
            resolveTags: (item) => (item.tags ?? []).filter((tag) => !tags.has(tag.toLocaleLowerCase())),
          }));
        notify('success', `${changed ?? targets.length} caption${changed === 1 ? '' : 's'} updated${skipped ? `, ${skipped} skipped (no saved tags)` : ''}.`);
      } catch (error) { notify('error', error instanceof Error ? error.message : 'Removing tags failed.'); }
      return;
    }
    if ((action.kind === 'remove' || action.kind === 'review') && action.ids?.length) {
      if (onSelectIds) {
        onSelectIds(action.ids, action);
        return;
      }
      onSelectId?.(action.ids[0]);
      notify('info', `${action.ids.length} file${action.ids.length === 1 ? '' : 's'} flagged; showing the first. Nothing was deleted.`);
    }
  }, [datasetItems, directory, notify, onSelectId, onSelectIds]);
  return { apply, canApply: canApplyQualityAction };
}
