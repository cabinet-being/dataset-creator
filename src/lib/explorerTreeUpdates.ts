import type { ExplorerTreeNode } from '../components/workspace/ExplorerTree';
import type { ExplorerPathChange } from '../services/project/explorerFileService';

export type ExplorerChanges = { moves: ExplorerPathChange[]; paths: string[] };
export const emptyExplorerChanges = (): ExplorerChanges => ({ moves: [], paths: [] });

export const findExplorerTreeNode = (tree: ExplorerTreeNode | null, path: string): ExplorerTreeNode | undefined => {
  if (!tree) return;
  if (tree.path === path) return tree;
  for (const child of tree.children ?? []) {
    if (path === child.path || path.startsWith(`${child.path}/`)) return findExplorerTreeNode(child, path);
  }
};

// Replace only ancestors of the changed entry; unrelated branches keep identity.
export const replaceExplorerTreeNode = (tree: ExplorerTreeNode, path: string, replacement?: ExplorerTreeNode): ExplorerTreeNode => {
  if (path === tree.path) return replacement ?? tree;
  if (!path.startsWith(`${tree.path}/`)) return tree;
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (tree.path === parent) {
    const children = (tree.children ?? []).filter(child => child.path !== path);
    if (replacement) children.push(replacement);
    children.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1);
    return { ...tree, children };
  }
  const children = tree.children ?? [];
  const branchPath = `${tree.path}/${path.slice(tree.path.length + 1).split('/')[0]}`;
  const branch = children.find(child => child.path === branchPath);
  if (!branch && !replacement) return tree;
  const updated = replaceExplorerTreeNode(branch ?? {
    path: branchPath, name: branchPath.split('/').pop()!, kind: 'folder', children: [],
  }, path, replacement);
  return { ...tree, children: branch ? children.map(child => child === branch ? updated : child) : [...children, updated] };
};

export const moveExplorerTreeNodes = (tree: ExplorerTreeNode, moves: ExplorerPathChange[]): ExplorerTreeNode => {
  let next = tree;
  for (const { from, to } of moves) {
    if (from === to) continue;
    const node = findExplorerTreeNode(next, from);
    if (!node) continue;
    const relocate = (entry: ExplorerTreeNode): ExplorerTreeNode => {
      const path = to + entry.path.slice(from.length);
      return { ...entry, path, name: path.split('/').pop()!, children: entry.children?.map(relocate) };
    };
    next = replaceExplorerTreeNode(replaceExplorerTreeNode(next, from), to, relocate(node));
  }
  return next;
};

export const sortExplorerNodes = (nodes: ExplorerTreeNode[]): ExplorerTreeNode[] =>
  [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) {
      const order = { folder: 0, dataset: 1, file: 2 };
      return order[a.kind] - order[b.kind];
    }
    return a.name.localeCompare(b.name);
  });

export const buildEmptyExplorerTree = (projectName: string): ExplorerTreeNode => ({
  name: projectName || 'Project',
  path: 'Project',
  kind: 'folder',
  children: [],
});

export const sanitizeExplorerTree = (node: ExplorerTreeNode | null): ExplorerTreeNode | null => {
  if (!node) {
    return null;
  }

  return {
    ...node,
    children: node.children
      ?.map((child) => sanitizeExplorerTree(child))
      .filter((child): child is ExplorerTreeNode => Boolean(child)),
  };
};

export type ExplorerPathEntry = { path: string; kind: 'folder' | 'file' };

export const getVisibleExplorerNodes = (node: ExplorerTreeNode | null, expandedPaths: ReadonlySet<string>): ExplorerTreeNode[] => {
  if (!node || (node.kind === 'folder' && !expandedPaths.has(node.path))) {
    return [];
  }

  const nodes: ExplorerTreeNode[] = [];
  const visit = (entry: ExplorerTreeNode) => {
    nodes.push(entry);
    if (entry.kind === 'folder' && expandedPaths.has(entry.path)) {
      entry.children?.forEach(visit);
    }
  };
  node.children?.forEach(visit);
  return nodes;
};

export const getAllExplorerNodes = (node: ExplorerTreeNode | null): ExplorerTreeNode[] => {
  if (!node) {
    return [];
  }

  const nodes: ExplorerTreeNode[] = [];
  const visit = (entry: ExplorerTreeNode) => {
    nodes.push(entry);
    entry.children?.forEach(visit);
  };
  node.children?.forEach(visit);
  return nodes;
};

export const getParentExplorerPath = (path: string): string =>
  path.split('/').slice(0, -1).join('/') || 'Project';

export const getTopLevelExplorerEntries = <T extends ExplorerPathEntry>(entries: T[]): T[] =>
  entries.filter(
    (entry) =>
      !entries.some(
        (candidate) =>
          candidate.kind === 'folder' &&
          candidate.path !== entry.path &&
          entry.path.startsWith(`${candidate.path}/`)
      )
  );

export const getExplorerRangePaths = (visibleNodes: ExplorerTreeNode[], anchorPath: string, targetPath: string): string[] | null => {
  const anchorIndex = visibleNodes.findIndex((entry) => entry.path === anchorPath);
  const targetIndex = visibleNodes.findIndex((entry) => entry.path === targetPath);
  if (anchorIndex < 0 || targetIndex < 0) {
    return null;
  }
  const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return visibleNodes.slice(start, end + 1).map((entry) => entry.path);
};
