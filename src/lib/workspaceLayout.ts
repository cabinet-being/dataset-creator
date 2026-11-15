export type DockSide = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type DockGroup = { type: 'tabs'; id: string; tabs: string[]; active: string | null };
export type DockSplit = { type: 'split'; id: string; axis: 'horizontal' | 'vertical'; ratio: number; first: DockNode; second: DockNode };
export type DockNode = DockGroup | DockSplit;
export type DockRect = { x: number; y: number; width: number; height: number };
export type DockFloat = { id: string; root: DockNode; bounds: DockRect; minimized: boolean };
export type DockLocation = { host: 'left' | 'main'; group: string; index: number; neighbor?: string; side: DockSide };
export type DockLayout = {
  version: 1;
  left: DockNode | null;
  main: DockNode;
  sidebarRatio: number;
  floating: DockFloat[];
  locations: Record<string, DockLocation>;
  focusedGroup: string;
  pinned?: string[];
};
export type DockSource = { type: 'tab'; id: string } | { type: 'group'; id: string } | { type: 'host'; id: string };
export type DockTarget = { host: string; group: string; side: DockSide; index?: number };
export const EXPLORER_VIEW = 'window:explorer';
export const DATASET_VIEW = 'window:dataset';
export const DOCK_STORAGE_KEY = 'dataset-creator-docking-v1';
export const DOCK_HEADER_HEIGHT = 36;
export const DOCK_GUTTER = 6;
const identity = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
export const dockGroup = (tabs: string[] = [], id = identity('group')): DockGroup => ({ type: 'tabs', id, tabs, active: tabs[0] ?? null });
export const dockSplit = (first: DockNode, second: DockNode, axis: DockSplit['axis'], ratio = 0.5): DockSplit => ({ type: 'split', id: identity('split'), axis, ratio, first, second });
export const dockGroups = (node: DockNode | null): DockGroup[] => !node ? [] : node.type === 'tabs' ? [node] : [...dockGroups(node.first), ...dockGroups(node.second)];
/** Keep a Welcome / new-editor destination when closing the last editor leaves only utility panels. */
export const ensureDockEditorGroup = (layout: DockLayout): DockLayout => {
  if (dockGroups(layout.main).some(group => !group.tabs.length || group.tabs.some(id => !id.startsWith('window:')))) return layout;
  return { ...layout, main: dockSplit(dockGroup(), layout.main, 'horizontal', 0.75) };
};
export const dockViews = (node: DockNode | null): string[] => dockGroups(node).flatMap((group) => group.tabs);
export const isLegacyDatasetView = (id: string): boolean => /^dataset:[^:]+$/.test(id);

/** Collapse legacy Dataset editors and the Dataset utility window into one canonical dock view. */
export const normalizeDatasetDockLayout = (layout: DockLayout): DockLayout => {
  const aliases = (id: string) => id === DATASET_VIEW || isLegacyDatasetView(id);
  const normalizeScopedTool = (id: string) => id.replace(/^dataset:[^:]+:(select|analysis|review|tagging)$/, 'dataset:global:$1');
  const groups = dockHosts(layout).flatMap((host) => dockGroups(host.root).map((group) => ({ host: host.id, group })));
  const candidates = groups.filter(({ group }) => group.tabs.some(aliases));
  if (!candidates.length) return layout;
  const activeCandidate = candidates.find(({ group }) => group.id === layout.focusedGroup && aliases(group.active ?? ''));
  const canonicalCandidate = candidates.find(({ group }) => group.tabs.includes(DATASET_VIEW));
  const winner = activeCandidate ?? canonicalCandidate ?? candidates[0];
  const pinned = new Set(layout.pinned ?? []);
  const datasetPinned = [...pinned].some(aliases);
  for (const id of [...pinned]) if (aliases(id)) pinned.delete(id);
  if (datasetPinned) pinned.add(DATASET_VIEW);
  const prune = (node: DockNode): DockNode | null => {
    if (node.type === 'tabs') {
      const aliasIndexes = node.tabs.flatMap((id, index) => aliases(id) ? [index] : []);
      const tabs = [...new Set(node.tabs.filter((id) => !aliases(id)).map(normalizeScopedTool))];
      if (node.id === winner.group.id) tabs.splice(Math.min(aliasIndexes[0] ?? tabs.length, tabs.length), 0, DATASET_VIEW);
      if (!tabs.length) return null;
      const normalizedActive = normalizeScopedTool(node.active ?? '');
      const active = aliases(node.active ?? '')
        ? node.id === winner.group.id ? DATASET_VIEW : tabs[0]
        : tabs.includes(normalizedActive) ? normalizedActive : tabs[0];
      return { ...node, tabs, active };
    }
    const first = prune(node.first);
    const second = prune(node.second);
    return first && second ? { ...node, first, second } : first ?? second;
  };
  const left = layout.left ? prune(layout.left) : null;
  const main = prune(layout.main) ?? dockGroup([], 'main-empty');
  const floating = layout.floating.flatMap((host) => {
    const root = prune(host.root);
    return root ? [{ ...host, root }] : [];
  });
  const locations = Object.fromEntries(Object.entries(layout.locations).filter(([id]) => !aliases(id)).map(([id, location]) => [normalizeScopedTool(id), location]));
  const previousLocation = layout.locations[DATASET_VIEW] ?? Object.entries(layout.locations).find(([id]) => isLegacyDatasetView(id))?.[1];
  if (previousLocation) locations[DATASET_VIEW] = previousLocation;
  return { ...layout, left, main, floating, locations, pinned: [...pinned], focusedGroup: activeCandidate ? winner.group.id : layout.focusedGroup };
};
export const dockHosts = (layout: DockLayout): { id: string; root: DockNode | null }[] => [
  { id: 'left', root: layout.left }, { id: 'main', root: layout.main }, ...layout.floating.map((host) => ({ id: host.id, root: host.root })),
];
export const findDockGroup = (layout: DockLayout, view: string) => {
  for (const host of dockHosts(layout)) {
    const group = dockGroups(host.root).find((entry) => entry.tabs.includes(view));
    if (group) return { host: host.id, group };
  }
  return null;
};
export const mapDockNode = (node: DockNode, transform: (node: DockNode) => DockNode): DockNode => transform(node.type === 'split'
  ? { ...node, first: mapDockNode(node.first, transform), second: mapDockNode(node.second, transform) } : node);
const updateHost = (layout: DockLayout, host: string, transform: (root: DockNode | null) => DockNode | null): DockLayout => {
  if (host === 'left') return { ...layout, left: transform(layout.left) };
  if (host === 'main') return { ...layout, main: transform(layout.main) ?? dockGroup([], 'main-empty') };
  return { ...layout, floating: layout.floating.flatMap((entry) => {
    if (entry.id !== host) return [entry];
    const root = transform(entry.root);
    return root ? [{ ...entry, root }] : [];
  }) };
};
const pruneViews = (node: DockNode | null, removed: Set<string>): DockNode | null => {
  if (!node) return null;
  if (node.type === 'tabs') {
    const tabs = node.tabs.filter((view) => !removed.has(view));
    if (tabs.length === node.tabs.length) return node;
    return tabs.length ? { ...node, tabs, active: tabs.includes(node.active ?? '') ? node.active : tabs[0] } : null;
  }
  const first = pruneViews(node.first, removed);
  const second = pruneViews(node.second, removed);
  return first && second ? { ...node, first, second } : first ?? second;
};
const locate = (node: DockNode, view: string, parent?: DockSplit, firstChild = false): Omit<DockLocation, 'host'> | null => {
  if (node.type === 'split') return locate(node.first, view, node, true) ?? locate(node.second, view, node, false);
  if (!node.tabs.includes(view)) return null;
  return { group: node.id, index: node.tabs.indexOf(view), neighbor: parent ? dockViews(firstChild ? parent.second : parent.first)[0] : undefined,
    side: !parent ? 'center' : parent.axis === 'horizontal' ? firstChild ? 'left' : 'right' : firstChild ? 'top' : 'bottom' };
};
export const removeDockViews = (layout: DockLayout, views: string[]): DockLayout => {
  const removed = new Set(views);
  let next = { ...layout, locations: { ...layout.locations } };
  for (const host of dockHosts(layout)) {
    if ((host.id === 'left' || host.id === 'main') && host.root) {
      for (const view of views) {
        const location = locate(host.root, view);
        if (location) next.locations[view] = { ...location, host: host.id };
      }
    }
    next = updateHost(next, host.id, (root) => pruneViews(root, removed));
  }
  return next;
};
export const dockSourceNode = (layout: DockLayout, source: DockSource): DockNode | null => {
  if (source.type === 'tab') return findDockGroup(layout, source.id) ? dockGroup([source.id]) : null;
  const hosts = dockHosts(layout);
  if (source.type === 'host') return hosts.find((host) => host.id === source.id)?.root ?? null;
  return hosts.flatMap((host) => dockGroups(host.root)).find((group) => group.id === source.id) ?? null;
};
const insertNode = (root: DockNode | null, target: DockTarget, source: DockNode, preserveSplits = false): DockNode => {
  if (!root) return source;
  return mapDockNode(root, (node) => {
    if (node.id !== target.group) return node;
    if (target.side === 'center' && node.type === 'tabs') {
      if (preserveSplits && source.type === 'split') {
        const firstGroup = dockGroups(source)[0];
        return mapDockNode(source, (child) => child.id === firstGroup.id && child.type === 'tabs'
          ? { ...child, tabs: [...node.tabs, ...child.tabs] } : child);
      }
      const incoming = dockViews(source);
      const tabs = node.tabs.filter((view) => !incoming.includes(view));
      tabs.splice(target.index ?? tabs.length, 0, ...incoming);
      return { ...node, tabs, active: incoming[0] ?? node.active };
    }
    const before = target.side === 'left' || target.side === 'top';
    return dockSplit(before ? source : node, before ? node : source, target.side === 'left' || target.side === 'right' ? 'horizontal' : 'vertical');
  });
};
export const moveDockSource = (layout: DockLayout, source: DockSource, target: DockTarget): DockLayout => {
  const incoming = dockSourceNode(layout, source);
  if (!incoming || dockViews(incoming).includes(EXPLORER_VIEW)) return layout;
  const host = dockHosts(layout).find((entry) => entry.id === target.host);
  const targetGroup = dockGroups(host?.root ?? null).find((group) => group.id === target.group);
  if (!targetGroup) return layout;
  const incomingViews = dockViews(incoming);
  if (incomingViews.every((view) => targetGroup.tabs.includes(view)) && (source.type !== 'tab' || targetGroup.tabs.length === 1)) return layout;
  const next = removeDockViews(layout, incomingViews);
  const insertion = target.index === undefined ? target : { ...target, index: target.index - targetGroup.tabs.slice(0, target.index).filter((id) => incomingViews.includes(id)).length };
  const updated = updateHost(next, target.host, (root) => insertNode(root, insertion, incoming));
  const activeGroup = findDockGroup(updated, incomingViews[0]);
  return { ...updated, focusedGroup: activeGroup?.group.id ?? updated.focusedGroup };
};
export const getDockPreview = (layout: DockLayout, source: DockSource, target: DockTarget, width: number, height: number): DockRect | null => {
  const next = moveDockSource(layout, source, target);
  if (next === layout) return null;
  const incoming = new Set(dockViews(dockSourceNode(layout, source)));
  const rectangles = measureDockLayout(next, width, height).groups
    .filter((entry) => entry.group.tabs.some((view) => incoming.has(view)))
    .map((entry) => entry.rect);
  if (!rectangles.length) return null;
  const x = Math.min(...rectangles.map((rect) => rect.x));
  const y = Math.min(...rectangles.map((rect) => rect.y));
  return { x, y, width: Math.max(...rectangles.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rectangles.map((rect) => rect.y + rect.height)) - y };
};
export const focusDockView = (layout: DockLayout, view: string): DockLayout => {
  const found = findDockGroup(layout, view);
  if (!found) return layout;
  let next = updateHost(layout, found.host, (root) => root && mapDockNode(root, (node) => node.id === found.group.id && node.type === 'tabs' ? { ...node, active: view } : node));
  if (found.host !== 'left' && found.host !== 'main') {
    const host = next.floating.find((entry) => entry.id === found.host)!;
    next = { ...next, floating: [...next.floating.filter((entry) => entry.id !== found.host), { ...host, minimized: false }] };
  }
  return { ...next, focusedGroup: found.group.id };
};
export const openDockView = (layout: DockLayout, view: string): DockLayout => {
  if (findDockGroup(layout, view)) return focusDockView(layout, view);
  const location = layout.locations[view];
  const region = view === EXPLORER_VIEW ? 'left' : location?.host ?? 'main';
  const root = region === 'left' ? layout.left : layout.main;
  const groups = dockGroups(root);
  const previousGroup = groups.find((group) => group.id === location?.group);
  const neighbor = groups.find((group) => group.tabs.includes(location?.neighbor ?? ''));
  const focused = groups.find(group => group.id === layout.focusedGroup);
  const editorGroup = groups.find(group => !group.tabs.length || group.tabs.some(id => !id.startsWith('window:')));
  const emptyEditor = view.startsWith('window:') ? undefined : groups.find(group => !group.tabs.length);
  const target = previousGroup ?? emptyEditor ?? neighbor ?? (view.startsWith('window:') ? focused : focused?.tabs.some(id => !id.startsWith('window:')) ? focused : editorGroup) ?? groups[0];
  const incoming = dockGroup([view]);
  const next = updateHost(layout, region, (node) => target
    ? insertNode(node, { host: region, group: target.id, side: previousGroup || target !== neighbor ? 'center' : location!.side, index: previousGroup ? location?.index : undefined }, incoming)
    : incoming);
  return focusDockView(next, view);
};
export const floatDockSource = (layout: DockLayout, source: DockSource, bounds: DockRect): DockLayout => {
  const root = dockSourceNode(layout, source);
  if (!root || dockViews(root).includes(EXPLORER_VIEW)) return layout;
  const next = removeDockViews(layout, dockViews(root));
  return { ...next, floating: [...next.floating, { id: identity('float'), root, bounds, minimized: false }], focusedGroup: dockGroups(root)[0].id };
};
export const pinDockHost = (layout: DockLayout, hostId: string): DockLayout => {
  const host = layout.floating.find((entry) => entry.id === hostId);
  if (!host) return layout;
  const views = dockViews(host.root);
  const first = views[0];
  if (!first) return layout;
  const location = layout.locations[first];
  const region = location?.host ?? 'main';
  const groups = dockGroups(region === 'left' ? layout.left : layout.main);
  const previous = groups.find((group) => group.id === location?.group);
  const neighbor = groups.find((group) => group.tabs.includes(location?.neighbor ?? ''));
  const target = previous ?? neighbor ?? groups[0];
  const next = { ...layout, floating: layout.floating.filter((entry) => entry.id !== hostId) };
  const updated = updateHost(next, region, (root) => target ? insertNode(root, { host: region, group: target.id, side: previous ? 'center' : neighbor ? location!.side : 'center', index: previous ? location?.index : undefined }, host.root, true) : host.root);
  return focusDockView(updated, first);
};
export const resizeDockSplit = (layout: DockLayout, splitId: string, ratio: number): DockLayout => {
  const value = Math.max(0.02, Math.min(0.98, ratio));
  if (splitId === 'sidebar') return { ...layout, sidebarRatio: value };
  let next = layout;
  for (const host of dockHosts(layout)) next = updateHost(next, host.id, (root) => root && mapDockNode(root, (node) => node.id === splitId && node.type === 'split' ? { ...node, ratio: value } : node));
  return next;
};
export type DockGroupRect = { group: DockGroup; host: string; rect: DockRect; zIndex: number; minimized: boolean };
export type DockDividerRect = { id: string; axis: DockSplit['axis']; rect: DockRect; parent: DockRect; zIndex: number; minimum: number; maximum: number };
export const dockMinimum = (node: DockNode | null): { width: number; height: number } => {
  if (!node || node.type === 'tabs') return { width: 180, height: 110 };
  const first = dockMinimum(node.first);
  const second = dockMinimum(node.second);
  return node.axis === 'horizontal' ? { width: first.width + second.width + DOCK_GUTTER, height: Math.max(first.height, second.height) }
    : { width: Math.max(first.width, second.width), height: first.height + second.height + DOCK_GUTTER };
};
export const clampDockRect = (rect: DockRect, width: number, height: number, minimized = false): DockRect => {
  const nextWidth = Math.min(Math.max(240, rect.width), width);
  const nextHeight = Math.min(Math.max(150, rect.height), height);
  return { width: nextWidth, height: nextHeight, x: Math.max(0, Math.min(width - nextWidth, rect.x)), y: Math.max(0, Math.min(height - (minimized ? DOCK_HEADER_HEIGHT : nextHeight), rect.y)) };
};
export const measureDockLayout = (layout: DockLayout, width: number, height: number) => {
  const groups: DockGroupRect[] = [];
  const dividers: DockDividerRect[] = [];
  const divide = (id: string, axis: DockSplit['axis'], ratio: number, rect: DockRect, first: DockNode, second: DockNode, zIndex: number) => {
    const horizontal = axis === 'horizontal';
    const available = Math.max(0, (horizontal ? rect.width : rect.height) - DOCK_GUTTER);
    const firstMinimum = dockMinimum(first)[horizontal ? 'width' : 'height'];
    const secondMinimum = dockMinimum(second)[horizontal ? 'width' : 'height'];
    const minimum = Math.min(firstMinimum, available * firstMinimum / (firstMinimum + secondMinimum));
    const maximum = available - Math.min(secondMinimum, available * secondMinimum / (firstMinimum + secondMinimum));
    const size = Math.max(minimum, Math.min(maximum, available * ratio));
    const firstRect = { ...rect, [horizontal ? 'width' : 'height']: size };
    const secondRect = { ...rect, [horizontal ? 'x' : 'y']: (horizontal ? rect.x : rect.y) + size + DOCK_GUTTER, [horizontal ? 'width' : 'height']: available - size };
    dividers.push({ id, axis, parent: rect, zIndex: zIndex + 3, minimum, maximum, rect: { x: horizontal ? rect.x + size : rect.x, y: horizontal ? rect.y : rect.y + size, width: horizontal ? DOCK_GUTTER : rect.width, height: horizontal ? rect.height : DOCK_GUTTER } });
    return [firstRect, secondRect];
  };
  const visit = (node: DockNode, rect: DockRect, host: string, zIndex: number, minimized = false) => {
    if (node.type === 'tabs') { groups.push({ group: node, rect, host, zIndex, minimized }); return; }
    const [first, second] = divide(node.id, node.axis, node.ratio, rect, node.first, node.second, zIndex);
    visit(node.first, first, host, zIndex, minimized);
    visit(node.second, second, host, zIndex, minimized);
  };
  const entire = { x: 0, y: 0, width, height };
  if (layout.left) {
    const [left, main] = divide('sidebar', 'horizontal', layout.sidebarRatio, entire, layout.left, layout.main, 0);
    visit(layout.left, left, 'left', 0);
    visit(layout.main, main, 'main', 0);
  } else visit(layout.main, entire, 'main', 0);
  layout.floating.forEach((host, index) => {
    const bounds = clampDockRect(host.bounds, width, height, host.minimized);
    if (!host.minimized) visit(host.root, { ...bounds, y: bounds.y + DOCK_HEADER_HEIGHT, height: Math.max(0, bounds.height - DOCK_HEADER_HEIGHT) }, host.id, 100 + index * 10);
  });
  return { groups, dividers };
};
export const getDockSide = (rect: DockRect, x: number, y: number): DockSide => {
  const relativeX = (x - rect.x) / Math.max(1, rect.width);
  const relativeY = (y - rect.y) / Math.max(1, rect.height);
  const edges = [{ side: 'left' as const, distance: relativeX }, { side: 'right' as const, distance: 1 - relativeX }, { side: 'top' as const, distance: relativeY }, { side: 'bottom' as const, distance: 1 - relativeY }].sort((first, second) => first.distance - second.distance);
  return edges[0].distance <= 0.25 ? edges[0].side : 'center';
};

export type LegacyDockLayout = Record<string, unknown>;
export const migrateDockLayout = (legacy: LegacyDockLayout, editorIds: string[], width = 1280, height = 800): DockLayout => {
  let main: DockNode = dockGroup(editorIds, 'main-editors');
  const layout: DockLayout = { version: 1, left: legacy.leftPanelOpen === false ? null : dockGroup([EXPLORER_VIEW], 'left-explorer'), main, sidebarRatio: typeof legacy.leftPanelWidth === 'number' ? legacy.leftPanelWidth / width : 0.22, floating: [], locations: {}, focusedGroup: 'main-editors' };
  if (legacy.bottomPanelOpen !== false && !legacy.outputWindowOpen) main = dockSplit(main, dockGroup(['window:output']), 'vertical', 1 - (Number(legacy.bottomPanelHeight) || 190) / height);
  if (legacy.rightPanelOpen !== false && !legacy.inspectorWindowOpen) main = dockSplit(main, dockGroup(['window:inspector']), 'horizontal', 1 - (Number(legacy.rightPanelWidth) || 280) / (width * (1 - layout.sidebarRatio)));
  layout.main = main;
  for (const view of ['dataset', 'inspector', 'output']) {
    if (!legacy[`${view}WindowOpen`]) continue;
    const panel = legacy[`${view}Window`] as Partial<DockRect> & { minimized?: boolean } | undefined;
    layout.floating.push({ id: identity('float'), root: dockGroup([`window:${view}`]), bounds: { x: panel?.x ?? 100, y: panel?.y ?? 100, width: panel?.width ?? 320, height: panel?.height ?? 360 }, minimized: panel?.minimized ?? false });
  }
  const legacyTabs = Array.isArray(legacy.openTabs) ? legacy.openTabs : [];
  for (const tab of legacyTabs) {
    if (tab?.kind !== 'window' || !['dataset', 'inspector', 'output'].includes(tab.window)) continue;
    const id = `window:${tab.window}`;
    const next = removeDockViews(layout, [id]);
    const target = dockGroups(next.main).find((group) => group.id === 'main-editors') ?? dockGroups(next.main)[0];
    next.main = insertNode(next.main, { host: 'main', group: target.id, side: 'center' }, dockGroup([id]));
    if (tab.pinned) next.pinned = [...(next.pinned ?? []), id];
    Object.assign(layout, next);
  }
  return layout;
};
// Windows removed from the UI; saved layouts that still reference them are cleaned up on read.
const REMOVED_VIEWS = new Set(['window:project']);
export const parseDockLayout = (value: unknown): DockLayout | null => {
  if (!value || typeof value !== 'object') return null;
  const data = value as DockLayout;
  if (data.version !== 1 || !Array.isArray(data.floating)) return null;
  const nodes = new Set<string>();
  const views = new Set<string>();
  const readNode = (input: DockNode | null, host: string, depth = 0): DockNode | null => {
    if (!input || depth > 40 || typeof input.id !== 'string' || nodes.has(input.id)) return null;
    nodes.add(input.id);
    if (input.type === 'tabs' && Array.isArray(input.tabs)) {
      const tabs = input.tabs.filter((id): id is string => typeof id === 'string' && !REMOVED_VIEWS.has(id) && !(id === EXPLORER_VIEW && host !== 'left') && !views.has(id) && Boolean(views.add(id)));
      if (!tabs.length && input.tabs.some((id) => REMOVED_VIEWS.has(id))) return null;
      return { type: 'tabs', id: input.id, tabs, active: tabs.includes(input.active ?? '') ? input.active : tabs[0] ?? null };
    }
    if (input.type !== 'split' || !['horizontal', 'vertical'].includes(input.axis)) return null;
    const first = readNode(input.first, host, depth + 1);
    const second = readNode(input.second, host, depth + 1);
    return first && second ? { ...input, ratio: Number.isFinite(input.ratio) ? Math.max(0.02, Math.min(0.98, input.ratio)) : 0.5, first, second } : first ?? second;
  };
  const left = readNode(data.left, 'left');
  const main = readNode(data.main, 'main') ?? dockGroup([], 'main-empty');
  const hosts = new Set(['left', 'main']);
  const floating = data.floating.flatMap((host) => {
    if (!host || typeof host.id !== 'string' || hosts.has(host.id) || !host.bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(host.bounds[key as keyof DockRect]))) return [];
    hosts.add(host.id);
    const root = readNode(host.root, host.id);
    return root && dockViews(root).length ? [{ ...host, root, minimized: Boolean(host.minimized) }] : [];
  });
  const locations: Record<string, DockLocation> = {};
  if (data.locations && typeof data.locations === 'object') for (const [id, location] of Object.entries(data.locations)) {
    if (!REMOVED_VIEWS.has(id) && location && ['left', 'main'].includes(location.host) && typeof location.group === 'string' && ['left', 'right', 'top', 'bottom', 'center'].includes(location.side)) locations[id] = { ...location, index: Number.isFinite(location.index) ? location.index : 0 };
  }
  return { version: 1, left, main, floating, locations, pinned: Array.isArray(data.pinned) ? data.pinned.filter((id) => typeof id === 'string' && !REMOVED_VIEWS.has(id)) : [], sidebarRatio: Number.isFinite(data.sidebarRatio) ? Math.max(0.05, Math.min(0.8, data.sidebarRatio)) : 0.22, focusedGroup: typeof data.focusedGroup === 'string' ? data.focusedGroup : dockGroups(main)[0].id };
};
