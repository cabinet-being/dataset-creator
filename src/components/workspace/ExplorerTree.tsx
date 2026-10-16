import { useEffect, useRef, type ComponentType, type DragEvent } from 'react';
import { ChevronDown, ChevronRight, File, FileJson, FolderOpen, Video } from 'lucide-react';
import { getExplorerFileKind } from '../../services/project/explorerFileService';
import { selectFileNameStem } from '../../lib/fileNameSelection';

export type ExplorerTreeNode = {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  children?: ExplorerTreeNode[];
};

export type ExplorerTreeProps = {
  node: ExplorerTreeNode;
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  dropTargetPath: string | null;
  inlineEdit: {
    mode: 'create' | 'rename';
    parentPath: string;
    path?: string;
    kind: 'folder' | 'file';
    value: string;
  } | null;
  focusedPath: string | null;
  onToggle: (path: string) => void;
  onFocus: (node: ExplorerTreeNode) => void;
  onSelect: (node: ExplorerTreeNode, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void;
  onContextMenu: (node: ExplorerTreeNode, x: number, y: number) => void;
  onInlineChange: (value: string) => void;
  onInlineCommit: () => void;
  onInlineCancel: () => void;
  onDragStartItem: (node: ExplorerTreeNode) => void;
  onDragEndItems: () => void;
  onDropTargetChange: (path: string | null) => void;
  onDropItems: (node: ExplorerTreeNode, event: DragEvent) => void;
  depth?: number;
};

export const getExplorerIcon = (node: ExplorerTreeNode): ComponentType<{ className?: string }> => {
  if (node.kind === 'folder') {
    return FolderOpen;
  }
  switch (getExplorerFileKind(node.name)) {
    case 'image':
    case 'psd':
      return File;
    case 'json':
      return FileJson;
    case 'text':
      return File;
    case 'video':
      return Video;
    default:
      return File;
  }
};

export const ExplorerTree = ({
  node,
  expandedPaths,
  selectedPaths,
  dropTargetPath,
  inlineEdit,
  focusedPath,
  onToggle,
  onFocus,
  onSelect,
  onContextMenu,
  onInlineChange,
  onInlineCommit,
  onInlineCancel,
  onDragStartItem,
  onDragEndItems,
  onDropTargetChange,
  onDropItems,
  depth = 0,
}: ExplorerTreeProps) => {
  const isFolder = node.kind === 'folder';
  const isExpanded = isFolder && expandedPaths.has(node.path);
  const isSelected = selectedPaths.has(node.path);
  const isFocused = focusedPath === node.path;
  const isDropTarget = isFolder && dropTargetPath === node.path;
  const isRenaming = inlineEdit?.mode === 'rename' && inlineEdit.path === node.path;
  const Icon = getExplorerIcon(node);
  const wasEditing = useRef(false);
  const pendingFocus = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Inputs must not be nested inside a button. Keep the row's appearance while
  // editing, then return keyboard focus only if removing the input lost it.
  const Row = isRenaming ? 'div' : 'button';
  useEffect(() => {
    // The root survives a rename; the edited row's path/key does not. Retain
    // the request until the refreshed tree contains its destination row.
    if (depth !== 0) return;
    const editing = Boolean(inlineEdit);
    if (wasEditing.current && !editing) pendingFocus.current = true;
    wasEditing.current = editing;
    if (editing) pendingFocus.current = false;
    if (!pendingFocus.current) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== document.body) {
        pendingFocus.current = false;
        return;
      }
      const row = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-explorer-row]') ?? [])
        .find(element => element.dataset.explorerPath === (focusedPath ?? node.path));
      if (row) {
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
        pendingFocus.current = false;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [depth, inlineEdit, focusedPath, node]);

  return (
    <div ref={containerRef}>
      <Row
        type={isRenaming ? undefined : "button"}
        aria-label={node.name}
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-pressed={isRenaming ? undefined : isSelected}
        onFocus={() => onFocus(node)}
        data-explorer-row
        data-explorer-path={node.path}
        draggable={!isRenaming}
        onClick={(event) => {
          if (isRenaming) return;
          onSelect(node, event);
          if (isFolder && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            onToggle(node.path);
          }
        }}
        onKeyDown={(event) => {
          if (!isRenaming && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onContextMenu(node, bounds.left, bounds.bottom);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(node, event.clientX, event.clientY);
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'copyMove';
          event.dataTransfer.setData('text/plain', node.path);
          onDragStartItem(node);
        }}
        onDragEnd={onDragEndItems}
        onDragOver={(event) => {
          if (node.kind === 'folder') {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
            onDropTargetChange(node.path);
          }
        }}
        onDrop={(event) => {
          if (node.kind !== 'folder') {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onDropTargetChange(null);
          onDropItems(node, event);
        }}
        className={`flex h-7 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-xs hover:bg-secondary ${
          isSelected ? 'bg-primary/15 text-foreground' : ''
        } ${isFocused ? 'outline outline-1 outline-primary/60' : ''} ${
          isDropTarget ? 'bg-primary/20 text-foreground ring-1 ring-inset ring-primary' : ''
        }`}
        style={{ paddingLeft: 4 + depth * 12 }}
        title={node.path}
      >
        {isFolder ? (
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {isRenaming ? (
          <input
            aria-label={`Rename ${node.name}`}
            value={inlineEdit.value}
            autoFocus
            onFocus={(event) => {
              if (inlineEdit.kind === 'folder') {
                event.currentTarget.select();
                return;
              }
              selectFileNameStem(event.currentTarget);
            }}
            onChange={(event) => onInlineChange(event.target.value)}
            onBlur={onInlineCommit}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onInlineCommit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onInlineCancel();
              }
            }}
            className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        )}
        {isDropTarget ? <span className="ml-auto shrink-0 text-[10px] font-medium text-primary">Import here</span> : null}
      </Row>
      {inlineEdit?.mode === 'create' && inlineEdit.parentPath === node.path && (
        <div style={{ paddingLeft: 4 + (depth + 1) * 12 }} className="flex h-7 items-center gap-1">
          <span className="w-3.5 shrink-0" />
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label={`New ${inlineEdit.kind} name`}
            value={inlineEdit.value}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onInlineChange(event.target.value)}
            onBlur={onInlineCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onInlineCommit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onInlineCancel();
              }
            }}
            className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs"
          />
        </div>
      )}
      {isExpanded &&
        node.children?.map((child) => (
          <ExplorerTree
            key={child.path}
            node={child}
            expandedPaths={expandedPaths}
            selectedPaths={selectedPaths}
            dropTargetPath={dropTargetPath}
            inlineEdit={inlineEdit}
            focusedPath={focusedPath}
            onToggle={onToggle}
            onFocus={onFocus}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onInlineChange={onInlineChange}
            onInlineCommit={onInlineCommit}
            onInlineCancel={onInlineCancel}
            onDragStartItem={onDragStartItem}
            onDragEndItems={onDragEndItems}
            onDropTargetChange={onDropTargetChange}
            onDropItems={onDropItems}
            depth={depth + 1}
          />
        ))}
    </div>
  );
};
