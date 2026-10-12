export type WorkspaceLocation = { projectId: string; viewId: string | null };
const STATE_KEY = 'datasetCreatorView';

export function readWorkspaceLocation(state: unknown): WorkspaceLocation | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[STATE_KEY];
  if (!value || typeof value !== 'object') return null;
  const location = value as Record<string, unknown>;
  return typeof location.projectId === 'string' && (location.viewId === null || typeof location.viewId === 'string')
    ? { projectId: location.projectId, viewId: location.viewId } : null;
}

export function sameWorkspaceLocation(a: WorkspaceLocation | null, b: WorkspaceLocation) {
  return a?.projectId === b.projectId && a.viewId === b.viewId;
}

/** History stores identifiers only. Files and directory permissions stay in the live workspace. */
export function writeWorkspaceLocation(history: Pick<History, 'state' | 'pushState' | 'replaceState'>, href: string, location: WorkspaceLocation, toolSlug: string | null, mode: 'push' | 'replace') {
  const url = new URL(href);
  if (toolSlug) url.searchParams.set('tool', toolSlug);
  else url.searchParams.delete('tool');
  if (sameWorkspaceLocation(readWorkspaceLocation(history.state), location) && url.href === href) return;
  const state = history.state && typeof history.state === 'object' ? history.state : {};
  history[mode === 'push' ? 'pushState' : 'replaceState']({ ...state, [STATE_KEY]: location }, '', `${url.pathname}${url.search}${url.hash}`);
}
