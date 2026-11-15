import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ImageIcon, Loader2 } from 'lucide-react';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { runHistoryTransaction } from '../../stores/useHistoryStore';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { persistCaptionTagsForItems } from '../../services/caption/captionMutationService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { useUIStore } from '../../stores/useUIStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCommands } from '../workspace/Commands';
import { CaptionEditor } from '../caption/CaptionEditor';
import { parseTags, sameTags } from './buildCaptionTags';

const itemName = (item: WorkspaceImage) => item.originalFileName || item.fileName;

type CaptionFilter = 'all' | 'missing' | 'has';

type Props = {
  /** Whether the Build tab is visible; keyboard shortcuts only work then. */
  active?: boolean;
  /** Dataset members (physical files in dataset/), videos excluded. */
  items: WorkspaceImage[];
  suggestions: string[];
  directory?: ProjectDirectoryHandle | null;
};

/** Caption stage: edit Dataset captions one by one or add/remove a tag for several items at once. */
export function BuildCaptionStage({ active = true, items, suggestions, directory }: Props) {
  const notify = useUIStore((state) => state.addNotification);
  const triggerWord = useProjectStore((state) => state.dataset.triggerWord).trim();
  const rootRef = useRef<HTMLElement>(null);
  const sorted = useMemo(() => [...items].sort((left, right) => Number(Boolean(left.tags?.length)) - Number(Boolean(right.tags?.length)) ||
    itemName(left).localeCompare(itemName(right))), [items]);
  const [filter, setFilter] = useState<CaptionFilter>('all');
  const filtered = useMemo(() => sorted.filter((item) => filter === 'all' || Boolean(item.tags?.length) === (filter === 'has')), [filter, sorted]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [batchTag, setBatchTag] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const current = filtered.find((item) => item.id === selectedId) ?? filtered[0];
  const currentIndex = current ? filtered.indexOf(current) : -1;
  const previews = useWorkspacePreviewUrls(filtered);
  useEffect(() => { setDraft(current?.tags?.join(', ') ?? ''); }, [current?.id, current?.tags]);
  useEffect(() => { setMarked((ids) => { const live = new Set(items.map((item) => item.id)); const next = new Set([...ids].filter((id) => live.has(id))); return next.size === ids.size ? ids : next; }); }, [items]);
  const missing = sorted.filter((item) => !item.tags?.length).length;
  const markedItems = filtered.filter((item) => marked.has(item.id));

  const nextMissingAfter = (id: string) => {
    const from = filtered.findIndex((item) => item.id === id);
    return [...filtered.slice(from + 1), ...filtered.slice(0, Math.max(0, from))].find((item) => item.id !== id && !item.tags?.length);
  };
  const move = (step: number) => {
    const next = filtered[Math.max(0, Math.min(filtered.length - 1, currentIndex + step))];
    if (next) setSelectedId(next.id);
  };
  const save = async (advance = false) => {
    if (!current || saving) return;
    const tags = parseTags(draft);
    const changed = !sameTags(current.tags, tags);
    if (changed) {
      setSaving(true);
      try {
        await runHistoryTransaction('Edit caption', async (historyWriter) => {
          await persistCaptionTagsForItems({ items: [current], resolveTags: () => tags, directory, flush: flushProjectSave, historyWriter });
        });
      } catch (error) {
        notify('error', error instanceof Error ? error.message : 'Could not save the caption.');
        return;
      } finally { setSaving(false); }
    }
    if (!changed && !advance) return;
    if (advance || tags.length) {
      const next = nextMissingAfter(current.id);
      if (next) setSelectedId(next.id);
    }
  };
  const addTrigger = async () => {
    if (!current || saving) return;
    setSaving(true);
    try {
      await runHistoryTransaction('Add trigger word', async (historyWriter) => {
        await persistCaptionTagsForItems({ items: [current], resolveTags: (item) => item.tags ?? [], repairTrigger: true, directory, flush: flushProjectSave, historyWriter });
      });
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not add the trigger word.');
    } finally { setSaving(false); }
  };
  const applyBatch = async (mode: 'add' | 'remove') => {
    const tag = batchTag.trim();
    if (!tag || !markedItems.length || saving) return;
    const key = tag.toLocaleLowerCase();
    setSaving(true);
    try {
      await runHistoryTransaction(mode === 'add' ? 'Add caption tag' : 'Remove caption tag', async (historyWriter) => {
        await persistCaptionTagsForItems({
          items: markedItems, directory, flush: flushProjectSave, historyWriter,
          resolveTags: (item) => mode === 'add'
            ? [...(item.tags ?? []).filter((value) => value.toLocaleLowerCase() !== key), tag]
            : (item.tags ?? []).filter((value) => value.toLocaleLowerCase() !== key),
        });
      });
      setBatchTag('');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not update the captions.');
    } finally { setSaving(false); }
  };
  const choose = (item: WorkspaceImage, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (event.shiftKey && anchor.current) {
      const from = filtered.findIndex((candidate) => candidate.id === anchor.current);
      const to = filtered.indexOf(item);
      setMarked(new Set(filtered.slice(Math.min(from, to), Math.max(from, to) + 1).map((candidate) => candidate.id)));
    } else if (event.ctrlKey || event.metaKey) {
      setMarked((ids) => { const next = new Set(ids); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; });
      anchor.current = item.id;
    } else { setMarked(new Set()); anchor.current = item.id; }
    setSelectedId(item.id);
  };

  useCommands([
    { id: 'build.caption.next', label: 'Caption: Next item', shortcut: 'J', active, disabled: currentIndex >= filtered.length - 1, run: () => move(1) },
    { id: 'build.caption.previous', label: 'Caption: Previous item', shortcut: 'K', active, disabled: currentIndex <= 0, run: () => move(-1) },
    { id: 'build.caption.save-next', label: 'Caption: Save and go to next without caption', shortcut: 'Mod+Enter', active, allowInInput: true, disabled: saving || !current, run: () => save(true) },
  ], () => rootRef.current);

  if (!sorted.length) return <div data-testid="build-caption-stage" className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
    <p>The Dataset is empty. Select images first, then caption them here.</p></div>;
  return <main ref={rootRef} data-testid="build-caption-stage" className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
    <div className="grid min-h-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_22rem]">
    <section aria-label="Dataset items" className="min-h-0 overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <p>{missing ? `${missing} without a caption (shown first)` : 'Every Dataset item has a caption'}</p>
        <select aria-label="Caption filter" data-testid="build-caption-filter" value={filter} onChange={(event) => setFilter(event.target.value as CaptionFilter)} className="rounded border border-border bg-background px-2 py-1 text-foreground">
          <option value="all">All</option><option value="missing">Missing caption</option><option value="has">Has caption</option></select>
        <span data-testid="build-caption-count">{filtered.length === sorted.length ? `${sorted.length} items` : `${filtered.length} of ${sorted.length} items`}{marked.size ? ` · ${marked.size} selected` : ''}</span>
      </div>
      {!!markedItems.length && <div role="group" aria-label="Bulk caption tag" className="mb-3 flex flex-wrap items-center gap-2 rounded bg-secondary px-3 py-2 text-xs">
        <strong>{markedItems.length} selected</strong>
        <input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} aria-label="Tag" placeholder="tag" className="rounded border border-border bg-background px-2 py-1" />
        <button type="button" disabled={saving || !batchTag.trim()} onClick={() => void applyBatch('add')} className="rounded border border-border px-2 py-1 disabled:opacity-40">Add tag to selected</button>
        <button type="button" disabled={saving || !batchTag.trim()} onClick={() => void applyBatch('remove')} className="rounded border border-border px-2 py-1 disabled:opacity-40">Remove tag from selected</button>
        <button type="button" onClick={() => setMarked(new Set())} className="underline">Clear</button>
      </div>}
      {!filtered.length && <p className="text-sm text-muted-foreground">No items match this filter.</p>}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
        {filtered.map((item) => <li key={item.id}>
          <button type="button" onClick={(event) => choose(item, event)} title={itemName(item)} aria-pressed={item.id === current?.id} data-selected={marked.has(item.id)}
            className={`relative block aspect-square w-full overflow-hidden rounded border-2 ${item.id === current?.id ? 'border-primary' : marked.has(item.id) ? 'border-sky-500' : 'border-transparent'}`}>
            {previews[item.id] ? <img src={previews[item.id]} alt={itemName(item)} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-secondary"><ImageIcon className="h-5 w-5" /></span>}
            {!item.tags?.length && <span className="absolute left-1 top-1 rounded bg-amber-500 px-1 text-[10px] text-white">No caption</span>}
          </button>
        </li>)}
      </ul>
    </section>
    <aside className="min-h-0 overflow-auto border-l border-border p-4">
      {current && <div className="space-y-3">
        <p className="truncate font-medium" title={itemName(current)}>{itemName(current)}</p>
        {triggerWord && <div className="flex items-start gap-2">
          <span data-testid="build-caption-trigger" title="Written to the TXT file automatically" className="shrink-0 rounded bg-secondary px-2 py-1 font-mono text-xs">{triggerWord}</span>
          <span className="pt-1 text-xs text-muted-foreground">+ tags below</span></div>}
        {triggerWord && current.captionTriggerMissing === true && <div role="alert" data-testid="build-caption-trigger-missing" className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
          <span className="flex-1">The caption file does not start with the trigger word.</span>
          <button type="button" disabled={saving} onClick={() => void addTrigger()} className="rounded border border-border px-2 py-0.5 disabled:opacity-40">Add trigger</button></div>}
        <CaptionEditor key={current.id} value={draft} onChange={setDraft} suggestions={suggestions} rows={8} disabled={saving} ariaLabel="Caption" placeholder="tag one, tag two" />
        <button type="button" disabled={saving || sameTags(current.tags, parseTags(draft))} onClick={() => void save()} className="flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40">
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}Save caption</button>
      </div>}
    </aside>
    </div>
    <p className="border-t border-border px-4 py-1.5 text-xs text-muted-foreground">J / K previous or next item · Ctrl/⌘+Enter save and go to the next item without a caption · Shift or Ctrl/⌘ click selects several items for bulk tags</p>
  </main>;
}
