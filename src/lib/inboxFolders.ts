import type { WorkspaceImage } from './workspaceImages';
import { PROJECT_LAYOUT } from '../services/project/projectLayoutService';
import { isProjectDatasetPath } from '../services/dataset/datasetFolderService';

export type FolderRow = { path: string; name: string; depth: number; count: number };

export const INBOX_PREFIX = `Project/${PROJECT_LAYOUT.rawDir}/`;
const relativePath = (item: WorkspaceImage) => (item.assetPath ?? '').replace(/^Project\//, '');
/** Folder of an inbox item relative to the project (for example `inbox/day1`). */
export const inboxFolderOf = (item: WorkspaceImage) => relativePath(item).split('/').slice(0, -1).join('/');
export const isInboxItem = (item: WorkspaceImage) => !!item.assetPath?.startsWith(INBOX_PREFIX);
export const isInFolder = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`);

/** Folders that contain images, with their ancestors, as an indented tree (`count` includes subfolders). */
export const buildFolderRows = (folders: string[]): FolderRow[] => {
  const all = new Set<string>();
  for (const folder of folders) { const parts = folder.split('/'); for (let length = 1; length <= parts.length; length += 1) all.add(parts.slice(0, length).join('/')); }
  return [...all].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
    .map((path) => ({ path, name: path.split('/').pop() ?? path, depth: path.split('/').length - 1, count: folders.filter((folder) => isInFolder(path, folder)).length }));
};

/** Toggles a folder together with its subfolders: all checked becomes unchecked, otherwise everything becomes checked. */
export const toggleFolderSelection = (rows: FolderRow[], deselected: ReadonlySet<string>, folder: string): Set<string> => {
  const family = rows.filter((row) => isInFolder(folder, row.path)).map((row) => row.path);
  const next = new Set(deselected);
  if (family.every((path) => !deselected.has(path))) family.forEach((path) => next.add(path)); else family.forEach((path) => next.delete(path));
  return next;
};

/** An image is selected unless its own folder was unchecked (subfolders are unchecked together with their parent). */
export const isInboxItemSelected = (item: WorkspaceImage, deselected: ReadonlySet<string>) => !deselected.has(inboxFolderOf(item));

/** Explorer path (`Project/inbox/day1`) of the inbox folder that holds `path`, or undefined outside the inbox. */
export const inboxFolderOfPath = (path: string | undefined): string | undefined => {
  const normalized = (path ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^Project\//, '');
  const root = INBOX_PREFIX.replace(/^Project\//, '');
  if (!normalized.startsWith(root)) return undefined;
  const folder = normalized.split('/').slice(0, -1).join('/');
  return `Project/${folder}`;
};

const asExplorerPath = (path: string) => path.startsWith('Project/') ? path : `Project/${path}`;

/** Build Sources: `undefined` means the whole inbox; otherwise a folder is selected when it or one of its ancestors is listed. */
export const isInboxFolderInSources = (folder: string, sources: readonly string[] | undefined): boolean =>
  !sources || sources.some((source) => isInFolder(asExplorerPath(source), asExplorerPath(folder)));

export const isInboxItemInSources = (item: WorkspaceImage, sources: readonly string[] | undefined): boolean =>
  isInboxFolderInSources(inboxFolderOfPath(item.assetPath) ?? '', sources);

/**
 * Toggles a folder (with its subfolders) in the Sources list and returns the new list of explorer paths.
 * `rows` are the current inbox folders (see `buildFolderRows`). The list is stored as the topmost fully selected folders;
 * images directly inside a partly selected parent cannot be expressed and become unselected.
 */
export const toggleSourceFolder = (rows: FolderRow[], sources: readonly string[] | undefined, folder: string): string[] => {
  const paths = rows.map((row) => asExplorerPath(row.path));
  const target = asExplorerPath(folder);
  const selected = new Set(paths.filter((path) => isInboxFolderInSources(path, sources)));
  const family = paths.filter((path) => isInFolder(target, path));
  if (family.every((path) => selected.has(path))) family.forEach((path) => selected.delete(path)); else family.forEach((path) => selected.add(path));
  const full = (path: string) => paths.filter((other) => isInFolder(path, other)).every((other) => selected.has(other));
  return paths.filter((path) => selected.has(path) && full(path)
    && !paths.some((other) => other !== path && isInFolder(other, path) && selected.has(other) && full(other)));
};

type FolderTreeNode = { path: string; kind: 'folder' | 'file'; children?: FolderTreeNode[] };

/** Inbox folders of an Explorer tree (project-relative, for example `inbox/day1`), including empty ones and the inbox itself. */
export const collectInboxFolders = (tree: FolderTreeNode | null | undefined): string[] => {
  const root = INBOX_PREFIX.replace(/^Project\//, '').slice(0, -1);
  const found: string[] = [];
  const visit = (node: FolderTreeNode) => {
    if (node.kind !== 'folder') return;
    const path = node.path.replace(/^Project\//, '');
    if (isInFolder(root, path)) found.push(path);
    node.children?.forEach(visit);
  };
  if (tree) visit(tree);
  return found;
};

export type InboxFolderCounts = {
  /** Folder tree rows; `count` includes subfolders and is 0 for empty folders. */
  rows: FolderRow[];
  /** Images in the inbox, in the dataset/ folder, and in the ticked Sources. */
  inbox: number;
  dataset: number;
  ticked: number;
};

/**
 * Per-folder image counts for the Sources panel. `emptyFolders` are folders from the Explorer tree so folders
 * without images still get a row. Videos are not counted: they need frames first.
 */
export const countInboxFolders = (items: readonly WorkspaceImage[], emptyFolders: readonly string[] = [], sources?: readonly string[]): InboxFolderCounts => {
  const inboxItems = items.filter((item) => item.kind !== 'video' && isInboxItem(item));
  const imageFolders = inboxItems.map(inboxFolderOf);
  const rows = buildFolderRows([...imageFolders, ...emptyFolders]);
  const counted = new Map<string, number>();
  for (const folder of imageFolders) {
    const parts = folder.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      const path = parts.slice(0, length).join('/');
      counted.set(path, (counted.get(path) ?? 0) + 1);
    }
  }
  return {
    rows: rows.map((row) => ({ ...row, count: counted.get(row.path) ?? 0 })),
    inbox: inboxItems.length,
    dataset: items.filter((item) => item.kind !== 'video' && isProjectDatasetPath(item.assetPath)).length,
    ticked: inboxItems.filter((item) => isInboxItemInSources(item, sources)).length,
  };
};
