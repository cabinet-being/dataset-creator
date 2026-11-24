import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Check, ImageIcon, Loader2, Sparkles } from 'lucide-react';
import { LocalTaggerConnectPrompt } from '../../components/tagging/LocalTaggerConnectPrompt';
import { TriggerWordInput } from '../../components/ui/TriggerWordInput';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { changeDatasetTriggerWord } from '../../lib/triggerWordActions';
import { useSizedPreviewUrls } from '../../lib/previewUrlCache';
import { cn } from '../../lib/utils';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { applyCaptionTagBatch, persistCaptionBatch } from '../../services/caption/captionMutationService';
import { countTagFrequencies, type QualityReport } from '../../services/quality/metrics';
import { normalizeTag } from '../../services/quality/metrics/text';
import { selectActiveCharacterTraits, useProjectStore } from '../../stores/useProjectStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { useUIStore } from '../../stores/useUIStore';
import type { BuildSession } from '../../types';
import { buildFrameEntries, groupFrameEntries, isDatasetEntry, type FrameEntry } from './frameEntries';
import { getCaptionState, idsBetween, planProposalApply, proposalTagsFor } from './captionEntries';
import { Lightbox } from './Lightbox';
import type { useBoardPipeline } from './useBoardPipeline';
import { VirtualTileGrid } from './VirtualTileGrid';
import type { useProjectRuntime } from '../useProjectRuntime';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const CARD = 208;
const MAX_CHIPS = 8;
const fieldClass = 'min-h-[44px] rounded-md border border-border bg-background px-3 text-sm';
const buttonClass = cn('min-h-[44px] rounded-md border border-border px-3 text-sm hover:bg-secondary disabled:opacity-40', focusRing);

type Props = {
  runtime: ReturnType<typeof useProjectRuntime>;
  candidates: readonly WorkspaceImage[];
  effectiveItems: readonly WorkspaceImage[];
  session: BuildSession;
  pipeline: ReturnType<typeof useBoardPipeline>['pipeline'];
  patchSession: (update: (session: BuildSession) => BuildSession) => void;
  /** Quality report of the Dataset; its common-tags insight gives the profile advice. */
  report: QualityReport;
};

function CaptionChips({ item, triggerWord }: { item: WorkspaceImage; triggerWord: string }) {
  const state = getCaptionState(item);
  if (state === 'missing') return <span data-caption-state="missing" className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-200">no caption</span>;
  if (state === 'empty') return <span data-caption-state="empty" className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">empty caption</span>;
  const tags = item.tags ?? [];
  return <>
    {triggerWord && <span data-chip="trigger" className="rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground">{triggerWord}</span>}
    {tags.slice(0, MAX_CHIPS).map(tag => <span key={tag} data-chip="tag" className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">{tag}</span>)}
    {tags.length > MAX_CHIPS && <span className="text-[11px] text-muted-foreground">+{tags.length - MAX_CHIPS}</span>}
  </>;
}

/**
 * Caption mode of the Board: only the frames in dataset/. Cards with tag chips, selection, bulk tag edits, Auto-caption and the
 * tag statistics. Every caption change goes through the caption mutation service; each bulk change is one Undo step.
 */
export function CaptionMode({ runtime, candidates, effectiveItems, session, pipeline, patchSession, report }: Props) {
  const notify = useUIStore(state => state.addNotification);
  const triggerWord = useProjectStore(state => state.dataset.triggerWord).trim();
  const characterTraits = useProjectStore(selectActiveCharacterTraits);
  const localTagger = useLocalTaggerStore(state => state.bundle);
  const directory = runtime.projectDirectoryHandle;

  const entries = useMemo(() => buildFrameEntries(candidates, effectiveItems, session).filter(isDatasetEntry), [candidates, effectiveItems, session]);
  const items = useMemo(() => entries.map(entry => entry.item), [entries]);
  const groups = useMemo(() => groupFrameEntries(entries), [entries]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [windowEntries, setWindowEntries] = useState<FrameEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [addTag, setAddTag] = useState('');
  const [removeTag, setRemoveTag] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const live = useMemo(() => new Set(entries.map(entry => entry.id)), [entries]);
  const activeSelection = useMemo(() => new Set([...selected].filter(id => live.has(id))), [selected, live]);
  const selectedItems = useMemo(() => items.filter(item => activeSelection.has(item.id)), [items, activeSelection]);

  const thumbs = useSizedPreviewUrls(useMemo(() => windowEntries.map(entry => entry.item), [windowEntries]), 'thumb');
  const getKey = useCallback((entry: FrameEntry) => entry.id, []);

  const frequencies = useMemo(() => countTagFrequencies(items.map(item => ({ id: item.id, tags: item.tags })), triggerWord), [items, triggerWord]);
  const suggestions = useMemo(() => frequencies.map(entry => entry.tag), [frequencies]);
  const proposalFor = useCallback((item: WorkspaceImage) => proposalTagsFor(session, item, characterTraits), [characterTraits, session]);

  const run = async (action: () => Promise<unknown>, failure: string) => {
    if (saving) return;
    setSaving(true);
    try { await action(); } catch (error) { notify('error', error instanceof Error ? error.message : failure); } finally { setSaving(false); }
  };

  const addToSelected = () => {
    const tag = addTag.trim();
    if (!tag || !selectedItems.length) return;
    void run(async () => { await applyCaptionTagBatch({ items: selectedItems, tags: [tag], mode: 'add', directory, flush: flushProjectSave }); setAddTag(''); }, 'Could not update the captions.');
  };
  // Remove works on the selection, or on every Dataset caption when nothing is selected. Frames without a caption are not touched.
  const removeScope = useMemo(() => (selectedItems.length ? selectedItems : items).filter(item => item.tags?.some(tag => normalizeTag(tag) === normalizeTag(removeTag))), [items, removeTag, selectedItems]);
  const removeFromScope = () => {
    const tag = removeTag.trim();
    if (!tag || !removeScope.length) return;
    void run(async () => { await applyCaptionTagBatch({ items: removeScope, tags: [tag], mode: 'remove', directory, flush: flushProjectSave }); setRemoveTag(''); }, 'Could not update the captions.');
  };

  // Common-tags advice of the profile (constant traits of a character): the tags with their counts and a one-step removal.
  const advice = report.insights.find(metric => metric.id === 'common-tags')?.action;
  const adviceTags = useMemo(() => {
    if (!advice?.tags?.length) return [];
    const counts = new Map(frequencies.map(entry => [entry.tag, entry.files]));
    return advice.tags.map(tag => ({ tag, files: counts.get(normalizeTag(tag)) ?? 0 }));
  }, [advice, frequencies]);
  const applyAdvice = () => {
    const keys = new Set(adviceTags.map(entry => normalizeTag(entry.tag)));
    // Remove the spellings that really occur in the captions.
    const spellings = [...new Set(items.flatMap(item => item.tags ?? []).filter(tag => keys.has(normalizeTag(tag))))];
    const targets = items.filter(item => item.tags?.some(tag => keys.has(normalizeTag(tag))));
    if (!targets.length) return;
    void run(async () => {
      const changed = await applyCaptionTagBatch({ items: targets, tags: spellings, mode: 'remove', directory, flush: flushProjectSave });
      notify('success', `${changed} caption${changed === 1 ? '' : 's'} updated. Ctrl+Z undoes it.`);
    }, 'Removing tags failed.');
  };

  // Auto-caption: the model's suggestions land in session records; applying them writes captions (one Undo).
  const autoScope = useMemo(() => overwrite ? items : items.filter(item => !item.tags?.length), [items, overwrite]);
  const autoCount = pipeline.countTaggingTargets(autoScope);
  const pending = useMemo(() => planProposalApply(items, proposalFor, overwrite, triggerWord), [items, overwrite, proposalFor, triggerWord]);
  const applySuggestions = useCallback(() => {
    const plan = planProposalApply(items, proposalFor, overwrite, triggerWord);
    if (!plan.length) { notify('info', overwrite ? 'No model suggestions to apply.' : 'No suggestions for images without a caption.'); return Promise.resolve(); }
    const byId = new Map(plan.map(entry => [entry.item.id, entry.tags]));
    return run(async () => {
      const changed = await persistCaptionBatch('Auto-caption', { items: plan.map(entry => entry.item), resolveTags: item => byId.get(item.id) ?? item.tags ?? [], directory, flush: flushProjectSave });
      notify('success', `${changed} caption${changed === 1 ? '' : 's'} written from model suggestions. Ctrl+Z undoes it.`);
    }, 'Could not apply the suggestions.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, items, notify, overwrite, proposalFor, saving, triggerWord]);
  const applyLatest = useRef(applySuggestions);
  applyLatest.current = applySuggestions;
  const applyAfterRun = useRef(false);
  const tagging = useRef(false);
  useEffect(() => {
    if (pipeline.phase === 'tagging') { tagging.current = true; return; }
    if (!tagging.current || pipeline.phase !== 'idle') return;
    tagging.current = false;
    if (applyAfterRun.current) { applyAfterRun.current = false; void applyLatest.current(); }
  }, [pipeline.phase]);
  const startAuto = () => { applyAfterRun.current = true; pipeline.startTagging(autoScope); };
  const cancelAuto = () => { applyAfterRun.current = false; pipeline.cancel(); };

  const changeTrigger = (word: string) => { void changeDatasetTriggerWord(word)
    .then(() => patchSession(value => ({ ...value, records: Object.fromEntries(Object.entries(value.records).map(([id, record]) => [id, record.decision === 'accepted' ? { ...record, validation: 'stale' as const } : record])) })))
    .catch(error => notify('error', error instanceof Error ? error.message : 'Could not change the trigger word')); };

  const onCardClick = (event: MouseEvent, entry: FrameEntry) => {
    const ids = entries.map(candidate => candidate.id);
    if (event.shiftKey && anchor.current) { setSelected(new Set(idsBetween(ids, anchor.current, entry.id))); return; }
    if (event.ctrlKey || event.metaKey || event.shiftKey) { toggle(entry.id); return; }
    setOpenId(entry.id);
  };
  const toggle = (id: string) => {
    anchor.current = id;
    setSelected(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  };

  const renderTile = useCallback((entry: FrameEntry, size: number) => {
    const url = thumbs[entry.id];
    const isSelected = activeSelection.has(entry.id);
    return <div data-caption-card={entry.id} data-selected={isSelected} className={cn('relative flex flex-col overflow-hidden rounded-md border bg-card', isSelected ? 'border-primary ring-2 ring-primary' : 'border-border')} style={{ width: size, height: size }}>
      <button type="button" data-tile-id={entry.id} title={entry.name} aria-label={`${entry.name}, ${getCaptionState(entry.item) === 'missing' ? 'no caption' : getCaptionState(entry.item) === 'empty' ? 'empty caption' : (entry.item.tags ?? []).join(', ')}`}
        onClick={event => onCardClick(event, entry)} className={cn('flex min-h-0 flex-1 flex-col text-left', focusRing)}>
        <span className="relative block h-28 shrink-0 bg-secondary">
          {url ? <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />
            : <span className="flex h-full w-full items-center justify-center text-muted-foreground"><ImageIcon aria-hidden className="h-6 w-6" /></span>}
        </span>
        <span className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-hidden p-1.5"><CaptionChips item={entry.item} triggerWord={triggerWord} /></span>
      </button>
      <button type="button" aria-pressed={isSelected} aria-label={`Select ${entry.name}`} tabIndex={-1} onClick={() => toggle(entry.id)}
        className={cn('absolute right-0 top-0 flex h-11 w-11 items-center justify-center', focusRing)}>
        <Check aria-hidden className={cn('h-5 w-5 rounded-full p-0.5', isSelected ? 'bg-primary text-primary-foreground' : 'bg-background/80 text-muted-foreground')} />
      </button>
    </div>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbs, activeSelection, triggerWord, entries]);

  const openIndex = openId ? entries.findIndex(entry => entry.id === openId) : -1;
  useEffect(() => { if (openId && openIndex < 0) setOpenId(null); }, [openId, openIndex]);
  const saveOne = useCallback((item: WorkspaceImage, tags: string[]) => persistCaptionBatch('Edit caption', { items: [item], resolveTags: () => tags, directory, flush: flushProjectSave })
    .then(() => undefined, error => notify('error', error instanceof Error ? error.message : 'Could not save the caption.')), [directory, notify]);
  const captionEditor = useMemo(() => ({ onSave: saveOne, suggestions }), [saveOne, suggestions]);

  const missing = items.filter(item => item.tags === undefined).length;
  const tagging_ = pipeline.phase === 'tagging';
  return <div data-caption-mode className="flex min-h-0 flex-1 flex-col">
    <div data-caption-toolbar className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-2">
      <label className="grid gap-1 text-xs text-muted-foreground">Trigger word
        <TriggerWordInput value={triggerWord} onApply={changeTrigger} className={cn(fieldClass, 'w-44 text-foreground')} /></label>
      <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); addToSelected(); }}>
        <label className="grid gap-1 text-xs text-muted-foreground">Add tag to selected
          <input value={addTag} onChange={event => setAddTag(event.target.value)} aria-label="Add tag to selected" placeholder="tag" className={cn(fieldClass, 'w-40 text-foreground')} /></label>
        <button type="submit" data-caption-add disabled={saving || !addTag.trim() || !selectedItems.length} className={buttonClass}>Add{selectedItems.length ? ` to ${selectedItems.length}` : ''}</button>
      </form>
      <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); removeFromScope(); }}>
        <label className="grid gap-1 text-xs text-muted-foreground">Remove tag
          <input value={removeTag} onChange={event => setRemoveTag(event.target.value)} aria-label="Remove tag" placeholder="tag" className={cn(fieldClass, 'w-40 text-foreground')} /></label>
        <button type="submit" data-caption-remove disabled={saving || !removeTag.trim() || !removeScope.length} className={buttonClass}>
          Remove{removeTag.trim() ? ` from ${removeScope.length}` : ''}</button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-caption-auto disabled={saving || !localTagger || pipeline.phase !== 'idle' || autoCount === 0} onClick={startAuto}
          title={!localTagger ? 'Connect a local caption model first' : autoCount === 0 ? 'Nothing to describe' : undefined} className={cn(buttonClass, 'inline-flex items-center gap-2')}>
          <Sparkles aria-hidden className="h-4 w-4" />Auto-caption {autoCount} {autoCount === 1 ? 'image' : 'images'}</button>
        <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" data-caption-overwrite checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />overwrite existing</label>
        {pending.length > 0 && !tagging_ && <button type="button" data-caption-apply disabled={saving} onClick={() => void applySuggestions()} className={buttonClass}>Apply {pending.length} suggestion{pending.length === 1 ? '' : 's'}</button>}
        {tagging_ && <span role="status" data-caption-progress className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          Captioning{pipeline.progress.total > 0 && ` ${pipeline.progress.completed}/${pipeline.progress.total}`}<button type="button" className={cn(buttonClass, 'min-h-[36px]')} onClick={cancelAuto}>Cancel</button></span>}
      </div>
      {activeSelection.size > 0 && <button type="button" data-clear-selection onClick={() => setSelected(new Set())} className="min-h-[44px] px-2 text-sm text-muted-foreground underline">{activeSelection.size} selected · Clear</button>}
      {!localTagger && <LocalTaggerConnectPrompt className="w-full" message="No local caption model connected. Connect one to use Auto-caption." />}
    </div>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <section aria-label="Dataset captions" className="flex min-h-[320px] min-w-0 flex-1 flex-col">
        <p data-caption-summary className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {items.length} in dataset/{missing ? ` · ${missing} without a caption` : ''} · click opens a frame, Ctrl-click and Shift-click select
        </p>
        {entries.length === 0
          ? <p data-grid-empty className="m-6 rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">The dataset is empty. Assemble frames first, then caption them here.</p>
          : <VirtualTileGrid groups={groups} getKey={getKey} renderTile={renderTile} onWindowChange={setWindowEntries} tileSize={CARD} />}
      </section>
      <aside data-caption-stats aria-label="Tag statistics" className="w-full shrink-0 space-y-4 overflow-auto border-t border-border bg-card p-4 md:w-72 md:border-l md:border-t-0">
        {adviceTags.length > 0 && advice && <section data-caption-advice className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Profile advice</h3>
          <ul className="space-y-1">{adviceTags.slice(0, 5).map(entry => <li key={entry.tag}>“{entry.tag}” on {entry.files}/{items.length}</li>)}</ul>
          {adviceTags.length > 5 && <p className="text-xs text-muted-foreground">and {adviceTags.length - 5} more</p>}
          {advice.kind === 'remove'
            ? <><p>Remove constant traits: the model should bind them to the trigger word, not to the captions.</p>
              <button type="button" data-caption-advice-apply disabled={saving} onClick={applyAdvice} className={buttonClass}>Remove constant traits</button></>
            : <p>Check whether these are constant traits; if so, remove them from the captions.</p>}
        </section>}
        <section className="space-y-2"><h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tags</h3>
          {frequencies.length === 0 ? <p className="text-sm text-muted-foreground">No tags yet.</p>
            : <ul data-tag-frequencies className="space-y-0.5">{frequencies.slice(0, 60).map(entry => <li key={entry.tag}>
              <button type="button" data-tag-frequency={entry.tag} title="Use as the tag to remove" onClick={() => setRemoveTag(entry.tag)}
                className={cn('flex min-h-[32px] w-full items-center justify-between gap-2 rounded px-1 text-left text-sm hover:bg-secondary', focusRing)}>
                <span className="truncate">{entry.tag}</span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{entry.files}/{items.length}</span></button></li>)}</ul>}
        </section>
      </aside>
    </div>
    {openIndex >= 0 && <Lightbox entries={entries} index={openIndex} onIndexChange={index => { const entry = entries[index]; if (entry) setOpenId(entry.id); }} onClose={() => setOpenId(null)} captionEditor={captionEditor} />}
  </div>;
}
