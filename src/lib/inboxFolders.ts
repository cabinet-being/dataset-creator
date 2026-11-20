import type { WorkspaceImage } from './workspaceImages';
import { PROJECT_LAYOUT } from '../services/project/projectLayoutService';

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
