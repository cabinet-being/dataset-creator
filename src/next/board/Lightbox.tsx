import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Inbox, Pin, Ban, Pencil, X } from 'lucide-react';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';
import { CaptionEditor } from '../../components/caption/CaptionEditor';
import { parseTags, sameTags } from '../../components/build/buildCaptionTags';
import { useSizedPreviewUrls } from '../../lib/previewUrlCache';
import { cn } from '../../lib/utils';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { isDatasetEntry, overrideKeyAction, type FrameEntry } from './frameEntries';
import type { BoardActions } from './useBoardPipeline';
import { StatusBadge } from './StatusBadge';
import { useBoardTools } from './toolOverlays';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const isTextField = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const formatBytes = (bytes: number | undefined) => {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** Caption editing in the lightbox (Caption mode): `onSave` writes through the caption mutation service. */
export type LightboxCaptionEditor = { onSave: (item: WorkspaceImage, tags: string[]) => Promise<void>; suggestions?: string[] };

function CaptionField({ item, editor, pendingSave }: { item: WorkspaceImage; editor: LightboxCaptionEditor; pendingSave: React.MutableRefObject<(() => Promise<void>) | null> }) {
  const saved = item.tags;
  const [draft, setDraft] = useState(saved?.join(', ') ?? '');
  const [saving, setSaving] = useState(false);
  const tags = parseTags(draft);
  // A new caption is "different" from a missing one: saving an empty draft over a missing caption creates an empty caption file.
  const changed = saved === undefined ? true : !sameTags(saved, tags);
  const save = async () => {
    if (saving || !changed) return;
    setSaving(true);
    try { await editor.onSave(item, tags); } finally { setSaving(false); }
  };
  // Lets the lightbox save an unsaved draft before it moves to another frame.
  pendingSave.current = changed && !saving ? save : null;
  useEffect(() => () => { pendingSave.current = null; }, [pendingSave]);
  return <div data-lightbox-caption-editor className="space-y-2"
    onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); } }}>
    <CaptionEditor value={draft} onChange={setDraft} suggestions={editor.suggestions} rows={6} disabled={saving} ariaLabel="Caption" placeholder="tag one, tag two" />
    <button type="button" data-lightbox-caption-save disabled={saving || !changed} onClick={() => void save()}
      className={cn('min-h-[44px] rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-40', focusRing)}>Save caption</button>
  </div>;
}

/**
 * Full-size view of one frame with its status and caption (read only). Arrow keys move through `entries`
 * (the filtered grid order) and Escape closes; both listen only while the overlay is mounted and ignore text fields.
 */
export function Lightbox({ entries, index, onIndexChange, onClose, actions, captionEditor }: {
  entries: readonly FrameEntry[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Pin, Ban, Clear and Return for the shown frame; absent means a read-only overlay. */
  actions?: BoardActions;
  /** Makes the caption editable (Caption mode). */
  captionEditor?: LightboxCaptionEditor;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const entry = entries[index];
  const tools = useBoardTools();
  const last = entries.length - 1;
  const pendingSave = useRef<(() => Promise<void>) | null>(null);
  // Navigation first persists the unsaved caption draft of the shown frame.
  const go = (target: number) => {
    const save = pendingSave.current;
    if (save) void save().then(() => onIndexChange(target)); else onIndexChange(target);
  };
  const goRef = useRef(go);
  goRef.current = go;

  // P and B toggle Pin and Ban of the shown frame; the handler reads the latest frame and actions through a ref.
  const choose = (key: 'pin' | 'ban') => {
    if (!actions || actions.busy || !entry) return;
    const action = overrideKeyAction([entry], key);
    void (action === 'clear' ? actions.clearOverride([entry.item]) : action === 'pin' ? actions.pinImages([entry.item]) : actions.banImages([entry.item]));
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  const current = useMemo(() => entry ? [entry.item] : [], [entry]);
  const neighbours = useMemo(() => [entries[index - 1], entries[index + 1]].flatMap(neighbour => neighbour ? [neighbour.item] : []), [entries, index]);
  const previews = useSizedPreviewUrls(current, 'large', { focusId: entry?.id, prefetch: neighbours });

  // useEscapeToClose keeps the first callback, so route it through a ref to always close the current frame's grid state.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEscapeToClose(true, () => closeRef.current());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextField(event.target) || (event.target instanceof Element && event.target.closest('[data-tool-overlay]')) || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); goRef.current(index - 1); }
      if (event.key === 'ArrowRight' && index < last) { event.preventDefault(); goRef.current(index + 1); }
      if ((event.key === 'p' || event.key === 'P' || event.key === 'b' || event.key === 'B') && !event.repeat) {
        event.preventDefault();
        chooseRef.current(event.key.toLowerCase() === 'p' ? 'pin' : 'ban');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, last]);

  // Move focus into the overlay. On close the grid puts focus on the frame shown last (the opener is not restored here,
  // because focusing it would move the grid cursor back to the frame the overlay was opened from).
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('[data-lightbox-close]')?.focus(); }, []);
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]; const final = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); final.focus(); }
    else if (!event.shiftKey && document.activeElement === final) { event.preventDefault(); first.focus(); }
  };

  if (!entry) return null;
  const { item, label } = entry;
  const url = previews[entry.id];
  const size = [`${item.width} × ${item.height}`, formatBytes(item.byteSize)].filter(Boolean).join(' · ');
  const caption = item.tags === undefined ? null : item.tags.join(', ');

  return <div ref={dialog} role="dialog" aria-modal="true" aria-label={`Frame ${entry.name}`} data-lightbox onKeyDown={trapTab}
    className="fixed inset-0 z-[2000] flex flex-col bg-background/95 text-foreground backdrop-blur-sm md:flex-row">
    <div className="relative flex min-h-0 flex-1 items-center justify-center p-4" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      {url
        ? <img data-lightbox-image src={url} alt={`${entry.name}: ${label.reason}`} className={cn('max-h-full max-w-full rounded-md object-contain', label.muted && 'opacity-70')} />
        : <p className="text-sm text-muted-foreground">Loading preview…</p>}
      <button type="button" aria-label="Previous frame" data-lightbox-prev disabled={index <= 0} onClick={() => go(index - 1)}
        className={cn('absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card disabled:opacity-40', focusRing)}>
        <ChevronLeft aria-hidden className="h-5 w-5" /></button>
      <button type="button" aria-label="Next frame" data-lightbox-next disabled={index >= last} onClick={() => go(index + 1)}
        className={cn('absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card disabled:opacity-40', focusRing)}>
        <ChevronRight aria-hidden className="h-5 w-5" /></button>
    </div>
    <aside className="max-h-[45%] w-full shrink-0 space-y-4 overflow-auto border-t border-border bg-card p-4 md:max-h-none md:w-80 md:border-l md:border-t-0">
      <div className="flex items-start gap-2">
        <h2 data-lightbox-name className="min-w-0 flex-1 break-words text-base font-semibold">{entry.name}</h2>
        <button type="button" aria-label="Close" data-lightbox-close onClick={onClose}
          className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border hover:bg-secondary', focusRing)}>
          <X aria-hidden className="h-5 w-5" /></button>
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">{index + 1} / {entries.length}</p>
      <dl className="space-y-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Status</dt>
          <dd className="mt-1 space-y-1"><StatusBadge label={label} /><p data-lightbox-reason>{label.reason}</p></dd></div>
        <div><dt className="text-xs text-muted-foreground">Size</dt><dd data-lightbox-size>{size}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Folder</dt><dd data-lightbox-folder className="break-all">{entry.folder}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Caption</dt>
          {captionEditor
            ? <dd className="mt-1">{caption === null && <p data-lightbox-caption className="mb-1 text-muted-foreground">No caption yet</p>}
              <CaptionField key={`${entry.id}:${caption ?? ''}`} item={item} editor={captionEditor} pendingSave={pendingSave} /></dd>
            : <dd data-lightbox-caption className={cn('whitespace-pre-wrap break-words', !caption && 'text-muted-foreground')}>
              {caption === null ? 'No caption yet' : caption || 'Empty caption'}</dd>}</div>
      </dl>
      {tools && <button type="button" data-action="photopea" onClick={() => tools.editInPhotopea(item)}
        className={cn('flex min-h-[44px] w-full items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-secondary', focusRing)}>
        <Pencil aria-hidden className="h-4 w-4" />Edit in Photopea</button>}
      {actions && <div data-lightbox-actions className="space-y-2">
        <button type="button" data-action="pin" disabled={actions.busy} aria-keyshortcuts="P" onClick={() => choose('pin')}
          className={cn('flex min-h-[44px] w-full items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-secondary disabled:opacity-50', focusRing)}>
          <Pin aria-hidden className="h-4 w-4" />{entry.record?.override === 'pin' ? 'Unpin' : 'Pin — always include'}<kbd className="ml-auto text-xs text-muted-foreground">P</kbd></button>
        <button type="button" data-action="ban" disabled={actions.busy} aria-keyshortcuts="B" onClick={() => choose('ban')}
          className={cn('flex min-h-[44px] w-full items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-secondary disabled:opacity-50', focusRing)}>
          <Ban aria-hidden className="h-4 w-4" />{entry.record?.override === 'ban' ? 'Unban' : isDatasetEntry(entry) ? 'Remove from dataset' : 'Ban — never include'}<kbd className="ml-auto text-xs text-muted-foreground">B</kbd></button>
        {isDatasetEntry(entry) && <button type="button" data-action="return" disabled={actions.busy} onClick={() => void actions.returnToInbox([entry.item])}
          className={cn('flex min-h-[44px] w-full items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-secondary disabled:opacity-50', focusRing)}>
          <Inbox aria-hidden className="h-4 w-4" />Return to inbox</button>}
      </div>}
      <p className="text-xs text-muted-foreground">← → to browse · {actions ? 'P pin · B ban · ' : ''}Esc to close</p>
    </aside>
  </div>;
}
