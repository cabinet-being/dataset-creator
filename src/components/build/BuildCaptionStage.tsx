import { useEffect, useMemo, useState } from 'react';
import { ImageIcon, Loader2 } from 'lucide-react';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { runHistoryTransaction } from '../../stores/useHistoryStore';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { persistCaptionTagsForItems } from '../../services/caption/captionMutationService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { useUIStore } from '../../stores/useUIStore';
import { CaptionEditor } from '../caption/CaptionEditor';
import { parseTags, sameTags } from './buildCaptionTags';

const itemName = (item: WorkspaceImage) => item.originalFileName || item.fileName;

type Props = {
  /** Dataset members (physical files in dataset/), videos excluded. */
  items: WorkspaceImage[];
  suggestions: string[];
  directory?: ProjectDirectoryHandle | null;
};

/** Minimal caption stage: Dataset items with missing captions first, edited with the shared CaptionEditor. */
export function BuildCaptionStage({ items, suggestions, directory }: Props) {
  const notify = useUIStore((state) => state.addNotification);
  const sorted = useMemo(() => [...items].sort((left, right) => Number(Boolean(left.tags?.length)) - Number(Boolean(right.tags?.length)) ||
    itemName(left).localeCompare(itemName(right))), [items]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const current = sorted.find((item) => item.id === selectedId) ?? sorted[0];
  const previews = useWorkspacePreviewUrls(sorted);
  useEffect(() => { setDraft(current?.tags?.join(', ') ?? ''); }, [current?.id, current?.tags]);
  const missing = sorted.filter((item) => !item.tags?.length).length;

  const save = async () => {
    if (!current || saving) return;
    const tags = parseTags(draft);
    if (sameTags(current.tags, tags)) return;
    setSaving(true);
    try {
      await runHistoryTransaction('Edit caption', async (historyWriter) => {
        await persistCaptionTagsForItems({ items: [current], resolveTags: () => tags, directory, flush: flushProjectSave, historyWriter });
      });
      const next = sorted.find((item) => item.id !== current.id && !item.tags?.length);
      if (next && tags.length) setSelectedId(next.id);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not save the caption.');
    } finally { setSaving(false); }
  };

  if (!sorted.length) return <div data-testid="build-caption-stage" className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
    <p>The Dataset is empty. Select images first, then caption them here.</p></div>;
  return <main data-testid="build-caption-stage" className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_22rem]">
    <section aria-label="Dataset items" className="min-h-0 overflow-auto p-4">
      <p className="mb-3 text-xs text-muted-foreground">{missing ? `${missing} without a caption (shown first)` : 'Every Dataset item has a caption'}</p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
        {sorted.map((item) => <li key={item.id}>
          <button type="button" onClick={() => setSelectedId(item.id)} title={itemName(item)} aria-pressed={item.id === current?.id}
            className={`relative block aspect-square w-full overflow-hidden rounded border-2 ${item.id === current?.id ? 'border-primary' : 'border-transparent'}`}>
            {previews[item.id] ? <img src={previews[item.id]} alt={itemName(item)} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-secondary"><ImageIcon className="h-5 w-5" /></span>}
            {!item.tags?.length && <span className="absolute left-1 top-1 rounded bg-amber-500 px-1 text-[10px] text-white">No caption</span>}
          </button>
        </li>)}
      </ul>
    </section>
    <aside className="min-h-0 overflow-auto border-l border-border p-4">
      {current && <div className="space-y-3">
        <p className="truncate font-medium" title={itemName(current)}>{itemName(current)}</p>
        <CaptionEditor key={current.id} value={draft} onChange={setDraft} suggestions={suggestions} rows={8} disabled={saving} ariaLabel="Caption" placeholder="tag one, tag two" />
        <button type="button" disabled={saving || sameTags(current.tags, parseTags(draft))} onClick={() => void save()} className="flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40">
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}Save caption</button>
      </div>}
    </aside>
  </main>;
}
