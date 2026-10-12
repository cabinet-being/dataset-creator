import { dockGroups, findDockGroup, measureDockLayout, type DockGroupRect, type DockLayout } from './workspaceLayout';

export const COMPACT_WORKSPACE_WIDTH = 760;
/** Project the saved desktop layout; resizing never rewrites its groups, pins or geometry. */
export function measureResponsiveWorkspace(layout: DockLayout, width: number, height: number, editorIds: string[], activeEditor: string | null, panel: string | null) {
  if (width >= COMPACT_WORKSPACE_WIDTH) {
    const measured = measureDockLayout(layout, width, height);
    if (activeEditor !== null) return measured;
    return { ...measured, groups: measured.groups.map(entry => entry.group.active && !entry.group.active.startsWith('window:')
      ? { ...entry, group: { ...entry.group, active: null } } : entry) };
  }
  const active = activeEditor && editorIds.includes(activeEditor) ? activeEditor : null;
  const editorGroup = (active ? findDockGroup(layout, active)?.group : undefined) ?? dockGroups(layout.main)[0];
  const groups: DockGroupRect[] = [{ host: 'main', group: { type: 'tabs', id: editorGroup?.id ?? 'compact-editors', tabs: editorIds, active }, rect: { x: 0, y: 0, width, height }, zIndex: 0, minimized: false }];
  if (panel) {
    const panelWidth = Math.min(380, width);
    groups.push({ host: 'compact-panel', group: { type: 'tabs', id: 'compact-panel', tabs: [panel], active: panel }, rect: { x: panel === 'window:explorer' ? 0 : width - panelWidth, y: 0, width: panelWidth, height }, zIndex: 100, minimized: false });
  }
  return { groups, dividers: [] };
}
