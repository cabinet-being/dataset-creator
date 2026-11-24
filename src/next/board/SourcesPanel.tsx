import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ChevronDown, ChevronRight, FilePlus2, FolderInput, FolderPlus, Pencil } from 'lucide-react';
import { Button } from '../../components/ui/button';
import {
  collectInboxFolders, countInboxFolders, INBOX_PREFIX, isInboxFolderInSources, isInFolder, toggleSourceFolder,
} from '../../lib/inboxFolders';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { cn } from '../../lib/utils';
import type { useProjectRuntime } from '../useProjectRuntime';

type Runtime = ReturnType<typeof useProjectRuntime>;

const INBOX_ROOT = INBOX_PREFIX.slice(0, -1);
const explorerPath = (folder: string) => `Project/${folder}`;
const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Left column of the Board: the `inbox` folder tree with image counts, Source checkboxes and a drop zone.
 * Every file change goes through the Explorer mutations, which also keep `profile.sources` and `origin` current.
 */
export function SourcesPanel({ runtime, items, sources, onSourcesChange }: {
  runtime: Runtime;
  /** Every image of the project (inbox and dataset/) used for the counts. */
  items: readonly WorkspaceImage[];
  /** `undefined` means the whole inbox is ticked. */
  sources: readonly string[] | undefined;
  onSourcesChange: (next: string[]) => void;
}) {
  const { explorer, explorerMutations, isProjectDirectoryBusy } = runtime;
  const { inlineExplorerEdit, setInlineExplorerEdit } = explorerMutations;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(INBOX_ROOT);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const committing = useRef(false);

  const emptyFolders = useMemo(() => collectInboxFolders(explorer.explorerTree), [explorer.explorerTree]);
  const counts = useMemo(() => countInboxFolders(items, emptyFolders, sources), [items, emptyFolders, sources]);
  const rows = counts.rows;
  const visibleRows = useMemo(() => rows.filter(row => !rows.some(other => other.path !== row.path && isInFolder(other.path, row.path) && collapsed.has(other.path))), [rows, collapsed]);
  const hasChildren = (path: string) => rows.some(row => row.path !== path && isInFolder(path, row.path));

  useEffect(() => { if (!rows.some(row => row.path === active)) setActive(INBOX_ROOT); }, [rows, active]);
  useEffect(() => { if (!inlineExplorerEdit) committing.current = false; }, [inlineExplorerEdit]);

  const nodeOf = (folder: string) => explorer.findExplorerNodeByPath(explorerPath(folder));
  const toggleCollapsed = (path: string) => setCollapsed(current => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  const busy = isProjectDirectoryBusy;

  const commitEdit = async () => {
    if (committing.current) return;
    committing.current = true;
    try { await explorerMutations.commitInlineExplorerEdit(); }
    finally { requestAnimationFrame(() => { committing.current = false; }); }
  };

  const startCreate = () => {
    const node = nodeOf(active);
    if (!node) return;
    setCollapsed(current => { const next = new Set(current); next.delete(active); return next; });
    void explorerMutations.handleExplorerNewFolder(node);
  };
  const startRename = (folder: string) => {
    const node = nodeOf(folder);
    if (node && folder !== INBOX_ROOT) void explorerMutations.handleExplorerRename(node);
  };

  const dropInto = (event: DragEvent, folder: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    if (busy) return;
    const dragged = explorer.draggedExplorerEntriesRef.current;
    const destination = explorerPath(folder);
    // A folder cannot move into itself or its own subfolder; everything else is moved or imported by the Explorer owner.
    if (dragged?.some(entry => isInFolder(entry.path, destination))) return;
    explorerMutations.handleExplorerDrop(event, destination);
  };
  const dragOver = (event: DragEvent, folder: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
    setDropTarget(folder);
  };
  const endDrag = () => { explorer.setCurrentDraggedExplorerEntries(null); setDropTarget(null); };

  const editInput = (label: string, depth: number) => <div className="flex min-h-[44px] items-center" style={{ paddingLeft: 8 + depth * 16 }}>
    <input aria-label={label} autoFocus value={inlineExplorerEdit?.value ?? ''}
      onFocus={event => event.currentTarget.select()}
      onChange={event => inlineExplorerEdit && setInlineExplorerEdit({ ...inlineExplorerEdit, value: event.target.value })}
      onBlur={() => void commitEdit()}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void commitEdit(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); committing.current = true; explorerMutations.cancelInlineExplorerEdit(); }
      }}
      className={cn('min-h-[36px] min-w-0 flex-1 rounded-md border border-primary bg-background px-2 text-sm', focusRing)} />
  </div>;

  return <aside data-sources-panel aria-label="Sources"
    onDragOver={event => dragOver(event, INBOX_ROOT)} onDrop={event => dropInto(event, INBOX_ROOT)} onDragLeave={() => setDropTarget(null)}
    className={cn('flex min-h-0 w-full shrink-0 flex-col border-b border-border bg-card md:w-[260px] md:border-b-0 md:border-r', dropTarget === INBOX_ROOT && 'ring-2 ring-inset ring-primary')}>
    <div className="flex items-center gap-1 border-b border-border px-3 py-2">
      <h2 className="mr-auto text-sm font-semibold">Sources</h2>
      <Button variant="ghost" size="icon" className="h-11 w-11" aria-label="Add files" title="Add files" disabled={busy}
        onClick={() => void explorerMutations.handleExplorerImport(explorerPath(active))}><FilePlus2 className="h-4 w-4" /></Button>
      <Button variant="ghost" size="icon" className="h-11 w-11" aria-label="Add folder" title="Add folder" disabled={busy}
        onClick={() => void explorerMutations.handleExplorerImport(explorerPath(active), true)}><FolderInput className="h-4 w-4" /></Button>
      <Button variant="ghost" size="icon" className="h-11 w-11" aria-label="New folder" title="New folder" disabled={busy}
        onClick={startCreate}><FolderPlus className="h-4 w-4" /></Button>
    </div>

    <div role="tree" aria-label="Inbox folders" className="max-h-60 min-h-0 flex-1 overflow-auto py-1 md:max-h-none">
      {visibleRows.length === 0 && <p data-sources-empty className="m-3 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
        Drop images or folders here, or use Add files.
      </p>}
      {visibleRows.map(row => {
        const folderPath = explorerPath(row.path);
        const family = rows.filter(other => isInFolder(row.path, other.path));
        const checked = isInboxFolderInSources(row.path, sources);
        const partial = !checked && family.some(other => isInboxFolderInSources(other.path, sources));
        const renaming = inlineExplorerEdit?.mode === 'rename' && inlineExplorerEdit.path === folderPath;
        const creatingHere = inlineExplorerEdit?.mode === 'create' && inlineExplorerEdit.parentPath === folderPath;
        const isRoot = row.path === INBOX_ROOT;
        const open = !collapsed.has(row.path);
        return <div key={row.path}>
          {renaming ? editInput(`Rename ${row.name}`, row.depth) : <div role="treeitem" aria-selected={active === row.path} aria-expanded={hasChildren(row.path) ? open : undefined}
            data-source-folder={row.path} draggable={!isRoot && !busy}
            onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', folderPath); const node = nodeOf(row.path); if (node) explorer.setCurrentDraggedExplorerEntries([explorer.createExplorerEntryForNode(node)]); }}
            onDragEnd={endDrag} onDragOver={event => dragOver(event, row.path)} onDrop={event => dropInto(event, row.path)}
            className={cn('group flex min-h-[44px] items-center gap-1 pr-1', active === row.path && 'bg-primary/15', dropTarget === row.path && 'bg-primary/25 ring-1 ring-inset ring-primary')}
            style={{ paddingLeft: 4 + row.depth * 16 }}>
            {hasChildren(row.path)
              ? <button type="button" aria-label={`${open ? 'Collapse' : 'Expand'} ${row.name}`} onClick={() => toggleCollapsed(row.path)}
                className={cn('flex h-11 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground', focusRing)}>
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>
              : <span className="w-8 shrink-0" />}
            <label className="flex h-11 w-9 shrink-0 cursor-pointer items-center justify-center" title="Use this folder when assembling">
              <input type="checkbox" aria-label={`Use ${row.name} as a source`} checked={checked} disabled={busy}
                ref={element => { if (element) element.indeterminate = partial; }}
                onChange={() => onSourcesChange(toggleSourceFolder(rows, sources, row.path))}
                className={cn('h-5 w-5 accent-[hsl(var(--primary))]', focusRing)} />
            </label>
            <button type="button" onClick={() => setActive(row.path)} onDoubleClick={() => startRename(row.path)}
              onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); startRename(row.path); } }}
              className={cn('flex h-11 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left text-sm', focusRing)}>
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span data-source-count className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.count}</span>
            </button>
            {!isRoot && <button type="button" aria-label={`Rename ${row.name}`} title="Rename" disabled={busy} onClick={() => startRename(row.path)}
              className={cn('flex h-11 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground', focusRing)}>
              <Pencil className="h-3.5 w-3.5" /></button>}
          </div>}
          {creatingHere && editInput('New folder name', row.depth + 1)}
        </div>;
      })}
    </div>

    <dl data-sources-summary className="space-y-1 border-t border-border px-3 py-3 text-xs text-muted-foreground">
      <div className="flex justify-between"><dt>Inbox</dt><dd data-count-inbox className="tabular-nums text-foreground">{counts.inbox}</dd></div>
      <div className="flex justify-between"><dt>Ticked sources</dt><dd data-count-ticked className="tabular-nums text-foreground">{counts.ticked}</dd></div>
      <div className="flex justify-between"><dt>Dataset</dt><dd data-count-dataset className="tabular-nums text-foreground">{counts.dataset}</dd></div>
    </dl>
  </aside>;
}
