import * as Dialog from '@radix-ui/react-dialog';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getWorkspaceDisplayName, type WorkspaceImage } from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { addAssetsToDataset, removeAssetsFromDataset, setAssetsExcluded } from '../../lib/assetActions';
import { isTextEntry } from '../../lib/keyboard';
import { useCommands } from '../workspace/Commands';
import { WorkspaceAssetFrame } from './WorkspaceAssetFrame';

type Props = { membership?: 'add' | 'remove'; showOrder?: boolean; items: WorkspaceImage[]; renderItem: (item: WorkspaceImage) => ReactNode; active?: boolean;
  className?: string;
  toolbarControls?: ReactNode; onScopeChange?: (items: WorkspaceImage[]) => void; onAdd?: (items: WorkspaceImage[]) => void | Promise<void>;
  directInteraction?: boolean; externalFiltering?: boolean; getGroup?: (item: WorkspaceImage) => string;
  renderGroupHeader?: (group: string, count: number) => ReactNode; collapsedGroups?: ReadonlySet<string> };
const PAGE_SIZE = 100;
export function AssetGallery({ items, renderItem, membership = 'add', showOrder = true, active = true, className = '', toolbarControls, onScopeChange, onAdd = addAssetsToDataset, directInteraction = false, externalFiltering = false, getGroup, renderGroupHeader, collapsedGroups }: Props) {
  const root = useRef<HTMLDivElement>(null); const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(''); const [caption, setCaption] = useState('all');
  const [sort, setSort] = useState('original'); const [size, setSize] = useState(210);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState(''); const anchor = useRef('');
  const [page, setPage] = useState(0); const [previewId, setPreviewId] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const result = items.filter(item => `${item.fileName} ${item.originalFileName ?? ''} ${item.tags?.join(' ') ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (caption === 'all' || Boolean(item.tags?.length) === (caption === 'captioned')));
    return sort === 'name' ? result.sort((a, b) => getWorkspaceDisplayName(a).localeCompare(getWorkspaceDisplayName(b), undefined, { numeric: true })) : result;
  }, [items, query, caption, sort]);
  const filteredIds = useMemo(() => new Set(filtered.map((item) => item.id)), [filtered]);
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => filteredIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [filteredIds]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const isGroupCollapsed = (group: string) => [...(collapsedGroups ?? [])].some((path) => group === path || group.startsWith(`${path}/`));
  const navigable = getGroup ? filtered.filter((item) => !isGroupCollapsed(getGroup(item))) : filtered;
  const firstNavigableVisibleId = visible.find((item) => !getGroup || !isGroupCollapsed(getGroup(item)))?.id;
  const selectedItems = filtered.filter(item => selected.has(item.id));
  const scope = selectedItems.length ? selectedItems : filtered;
  const onScopeRef = useRef(onScopeChange); onScopeRef.current = onScopeChange;
  const scopeRef = useRef<WorkspaceImage[]>([]);
  useEffect(() => {
    if (scope.length !== scopeRef.current.length || scope.some((item, i) => scopeRef.current[i] !== item)) { scopeRef.current = scope; onScopeRef.current?.(scope); }
  });
  const preview = filtered.find(item => item.id === previewId);
  const previewItems = useMemo(() => preview ? [preview] : [], [preview]);
  const previews = useWorkspacePreviewUrls(previewItems);
  const scopeActive = active && Boolean(root.current?.closest<HTMLElement>('[data-dock-view]')?.style.display !== 'none');
  const changeMembership = () => membership === 'remove' ? removeAssetsFromDataset(selectedItems) : onAdd(selectedItems);
  const exclude = selectedItems.some(item => !item.excludedFromDataset);
  useCommands([
    { id: 'gallery.search', label: 'Search files', shortcut: '/', active: scopeActive && !externalFiltering, run: () => search.current?.focus() },
    { id: membership === 'remove' ? 'gallery.remove' : 'gallery.add', label: membership === 'remove' ? 'Remove selected from Dataset' : 'Add selected to Dataset', shortcut: membership === 'remove' ? undefined : 'D', active: scopeActive, disabled: !selectedItems.length, run: changeMembership },
    { id: 'gallery.exclude', label: exclude ? 'Exclude selected from export' : 'Include selected in export', shortcut: 'E', active: scopeActive, disabled: !selectedItems.some(item => item.kind === 'image' || item.kind === 'edited'), run: () => setAssetsExcluded(selectedItems, exclude) },
  ], () => root.current?.closest<HTMLElement>('[data-dock-view]') ?? root.current);
  const focus = (id: string) => { setFocusId(id); requestAnimationFrame(() => {
    const element = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-asset-cell]') ?? []).find(node => node.dataset.assetCell === id); element?.focus(); element?.scrollIntoView({ block: 'nearest' });
  }); };
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); anchor.current = id; return next; });
  const selectDirect = (id: string, extend: boolean, additive: boolean) => setSelected(current => {
    if (extend) {
      const start = Math.max(0, filtered.findIndex(item => item.id === (anchor.current || id)));
      const end = Math.max(0, filtered.findIndex(item => item.id === id));
      if (!anchor.current) anchor.current = id;
      return new Set(filtered.slice(Math.min(start, end), Math.max(start, end) + 1).map(item => item.id));
    }
    anchor.current = id;
    if (!additive) return new Set([id]);
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const reset = () => { setSelected(new Set()); setPage(0); };
  return <div ref={root} className={`asset-gallery ${className}`}>
    <div className="gallery-toolbar flex flex-wrap items-center gap-2 pb-3">
      {!externalFiltering && <input ref={search} type="search" aria-label="Search files" placeholder="Search files…" value={query} onChange={e => { setQuery(e.target.value); reset(); }} className="min-w-32 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" />}
      {!externalFiltering && <select aria-label="Caption filter" value={caption} onChange={e => { setCaption(e.target.value); reset(); }} className="rounded-md border border-border bg-background p-2 text-sm"><option value="all">All captions</option><option value="captioned">Captioned</option><option value="missing">Missing captions</option></select>}
      {!externalFiltering && showOrder && <select aria-label="Gallery order" value={sort} onChange={e => { setSort(e.target.value); setPage(0); }} className="rounded-md border border-border bg-background p-2 text-sm"><option value="original">Original order</option><option value="name">Name</option></select>}
      <select aria-label="Thumbnail size" value={size} onChange={e => setSize(Number(e.target.value))} className="rounded-md border border-border bg-background p-2 text-sm"><option value={150}>Small</option><option value={210}>Medium</option><option value={300}>Large</option></select>
      {toolbarControls}
      <span className="text-xs text-muted-foreground">{filtered.length}/{items.length}</span>
    </div>
    {!!selectedItems.length && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm" role="status">
      <span>{selectedItems.length} selected</span><button className="ml-auto rounded px-2 py-1" onClick={() => void changeMembership()}>{membership === 'remove' ? 'Remove from Dataset' : 'Add to Dataset'}</button>
      {selectedItems.some(item => item.kind === 'image' || item.kind === 'edited') && <button className="rounded px-2 py-1" onClick={() => setAssetsExcluded(selectedItems, exclude)}>{exclude ? 'Exclude' : 'Include'}</button>}
      <button aria-label="Clear selection" className="rounded px-2 py-1" onClick={() => setSelected(new Set())}>Clear</button>
    </div>}
    <div className="asset-grid grid gap-3" role={directInteraction ? 'listbox' : 'group'} aria-multiselectable={directInteraction || undefined} aria-label="Files" style={{ gridTemplateColumns: `repeat(auto-fill,minmax(min(100%,${size}px),1fr))` }} onKeyDown={event => {
      if (isTextEntry(event.target) || event.nativeEvent.isComposing || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyA') { event.preventDefault(); event.stopPropagation(); setSelected(new Set(filtered.map(item => item.id))); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSelected(new Set()); return; }
      const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-asset-cell]');
      if (!cell || event.target !== cell) return;
      const index = navigable.findIndex(item => item.id === cell.dataset.assetCell);
      if (index < 0) return;
      if (event.key === ' ') { event.preventDefault(); toggle(navigable[index].id); }
      if (event.key === 'Enter') { event.preventDefault(); setPreviewId(navigable[index].id); }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const columns = Math.max(1, getComputedStyle(event.currentTarget).gridTemplateColumns.split(' ').length);
        const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, PageDown: PAGE_SIZE, PageUp: -PAGE_SIZE };
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? navigable.length - 1 : Math.max(0, Math.min(navigable.length - 1, index + offsets[event.key]));
        if (event.shiftKey) { const start = Math.max(0, filtered.findIndex(item => item.id === (anchor.current || navigable[index].id))); const end = filtered.findIndex(item => item.id === navigable[next].id); if (!anchor.current) anchor.current = navigable[index].id; setSelected(new Set(filtered.slice(Math.min(start, end), Math.max(start, end) + 1).map(item => item.id))); }
        else anchor.current = navigable[next].id;
        setPage(Math.floor(filtered.findIndex(item => item.id === navigable[next].id) / PAGE_SIZE)); focus(navigable[next].id);
      }
    }}>
      {visible.map((item, index) => {
        const group = getGroup?.(item);
        const previousGroup = index > 0 ? getGroup?.(visible[index - 1]) : undefined;
        const groupCount = group ? filtered.filter((candidate) => getGroup?.(candidate) === group).length : 0;
        const header = group && group !== previousGroup && renderGroupHeader ? renderGroupHeader(group, groupCount) : null;
        if (group && isGroupCollapsed(group)) return header ? <Fragment key={`group:${group}`}>{header}</Fragment> : null;
        return <Fragment key={item.id}>{header}<div data-asset-cell={item.id} tabIndex={item.id === focusId || (!visible.some(item => item.id === focusId) && item.id === firstNavigableVisibleId) ? 0 : -1}
        role={directInteraction ? 'option' : undefined} aria-selected={directInteraction ? selected.has(item.id) : undefined}
        aria-label={`${getWorkspaceDisplayName(item)}${selected.has(item.id) ? ', selected' : ''}`} className={`group/asset relative min-w-0 rounded-lg ${directInteraction ? 'cursor-default' : ''} ${selected.has(item.id) ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
        onClick={event => { if (directInteraction && !(event.target as HTMLElement).closest('button,input,a,[contenteditable="true"]')) selectDirect(item.id, event.shiftKey, event.ctrlKey || event.metaKey); }}
        onDoubleClick={event => { if (directInteraction && !(event.target as HTMLElement).closest('button,input,a,[contenteditable="true"]')) setPreviewId(item.id); }}
        onFocus={() => setFocusId(item.id)}>
        {!directInteraction && <div className="mb-1 flex items-center justify-between gap-2"><label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${getWorkspaceDisplayName(item)}`} /><span className="truncate" title={getWorkspaceDisplayName(item)}>{getWorkspaceDisplayName(item)}</span></label><button className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground" aria-label={`Preview ${getWorkspaceDisplayName(item)}`} onClick={() => setPreviewId(item.id)}>Open</button></div>}
        {renderItem(item)}
      </div></Fragment>;})}
    </div>
    {!filtered.length && <div className="py-12 text-center text-sm text-muted-foreground"><p>{items.length ? 'No matching files' : 'No files'}</p>{items.length > 0 && <button className="mt-3 rounded border border-border px-3 py-2" onClick={() => { setQuery(''); setCaption('all'); reset(); }}>Reset filters</button>}</div>}
    {filtered.length > PAGE_SIZE && <nav aria-label="Gallery pages" className="mt-4 flex items-center justify-center gap-4 text-sm"><button disabled={!currentPage} onClick={() => { setPage(currentPage - 1); focus(filtered[(currentPage - 1) * PAGE_SIZE].id); }}>Previous</button><span>{currentPage + 1} / {Math.ceil(filtered.length / PAGE_SIZE)}</span><button disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length} onClick={() => { setPage(currentPage + 1); focus(filtered[(currentPage + 1) * PAGE_SIZE].id); }}>Next</button></nav>}
    <Dialog.Root open={Boolean(preview)} onOpenChange={open => { if (!open) { setPreviewId(null); if (preview) { setPage(Math.floor(filtered.indexOf(preview) / PAGE_SIZE)); focus(preview.id); } } }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[2200] bg-black/80" />
      <Dialog.Content onCloseAutoFocus={event => event.preventDefault()} aria-describedby={undefined} className="fixed inset-6 z-[2201] flex flex-col rounded-xl border border-border bg-background p-4" onKeyDown={event => {
        if (isTextEntry(event.target) || !preview) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const index = filtered.indexOf(preview); setPreviewId(filtered[Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))].id); }
      }}>
        <div className="flex items-center justify-between gap-3"><Dialog.Title className="truncate text-sm font-medium">{preview ? getWorkspaceDisplayName(preview) : ''}</Dialog.Title><Dialog.Close className="rounded px-3 py-2 text-sm">Close</Dialog.Close></div>
        <div className="min-h-0 flex-1 overflow-auto p-3">{preview && <WorkspaceAssetFrame item={preview} previewUrl={previews[preview.id]} alt={getWorkspaceDisplayName(preview)} className="mx-auto h-full max-w-5xl" imageClassName="h-full w-full object-contain" />}</div>
        <div className="flex justify-center gap-4 text-sm"><button disabled={!preview || filtered.indexOf(preview) === 0} onClick={() => preview && setPreviewId(filtered[filtered.indexOf(preview) - 1].id)}>Previous</button><span>{preview ? filtered.indexOf(preview) + 1 : 0} / {filtered.length}</span><button disabled={!preview || filtered.indexOf(preview) === filtered.length - 1} onClick={() => preview && setPreviewId(filtered[filtered.indexOf(preview) + 1].id)}>Next</button></div>
      </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
