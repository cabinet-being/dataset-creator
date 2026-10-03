import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, Dispatch, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from 'react';
import { Grip, Maximize2, Minimize2, Pin, Plus, X } from 'lucide-react';
import {
  DOCK_GUTTER, DOCK_HEADER_HEIGHT, EXPLORER_VIEW, clampDockRect, dockGroups, dockSourceNode, dockViews,
  floatDockSource, focusDockView, getDockPreview, getDockSide, measureDockLayout, moveDockSource,
  pinDockHost, resizeDockSplit,
  type DockDividerRect, type DockGroupRect, type DockLayout, type DockRect, type DockSource, type DockTarget,
} from '../../lib/workspaceLayout';
import './workspace.css';

export type DockView = {
  id: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  pinned?: boolean;
  dirty?: boolean;
  content: ReactNode;
};
type Props = {
  layout: DockLayout;
  onLayout: Dispatch<SetStateAction<DockLayout>>;
  views: DockView[];
  onFocus: (id: string) => void;
  onClose: (ids: string[]) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onOpenTool: (group: string, x: number, y: number) => void;
};
type Interaction = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  initial: DockLayout;
  started: boolean;
} & ({ kind: 'drag'; source: DockSource; bounds: DockRect; target: DockTarget | null }
  | { kind: 'split'; divider: DockDividerRect }
  | { kind: 'resize'; host: string; bounds: DockRect });
const contains = (rect: DockRect, x: number, y: number) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

export const DockWorkspace = ({ layout, onLayout, views, onFocus, onClose, onContextMenu, onOpenTool }: Props) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const suppressClick = useRef(false);
  const focusFrame = useRef<(id: string) => void>(() => {});
  const viewById = useMemo(() => new Map(views.map((view) => [view.id, view])), [views]);
  const measured = useMemo(() => measureDockLayout(layout, size.width, size.height), [layout, size]);
  const sourceViews = interaction?.kind === 'drag' ? dockViews(dockSourceNode(interaction.initial, interaction.source)) : [];
  const activeDrop = interaction?.kind === 'drag' && interaction.started ? interaction.target : null;
  const preview = useMemo(() => interaction?.kind === 'drag' && interaction.started && interaction.target
    ? getDockPreview(interaction.initial, interaction.source, interaction.target, size.width, size.height)
    : null, [interaction, size]);
  const positions = new Map<string, DockGroupRect>();
  for (const entry of measured.groups) for (const id of entry.group.tabs) positions.set(id, entry);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setSize({ width: root.clientWidth, height: root.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const handleFrameFocus = () => {
      timer = window.setTimeout(() => {
        const frame = document.activeElement;
        if (!(frame instanceof HTMLIFrameElement)) return;
        const view = frame.closest<HTMLElement>('[data-dock-view]');
        if (view?.dataset.dockView && view.style.display !== 'none') focusFrame.current(view.dataset.dockView);
      }, 0);
    };
    window.addEventListener('blur', handleFrameFocus);
    return () => { window.removeEventListener('blur', handleFrameFocus); window.clearTimeout(timer); };
  }, []);

  const begin = (event: ReactPointerEvent, action: { kind: 'drag'; source: DockSource; bounds: DockRect; target: DockTarget | null } | { kind: 'split'; divider: DockDividerRect } | { kind: 'resize'; host: string; bounds: DockRect }) => {
    if (event.button !== 0 || !rootRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = rootRef.current.getBoundingClientRect();
    const next = { ...action, pointerId: event.pointerId, initial: layout, startX: event.clientX - bounds.left, startY: event.clientY - bounds.top, currentX: event.clientX - bounds.left, currentY: event.clientY - bounds.top, started: action.kind !== 'drag' } as Interaction;
    interactionRef.current = next;
    setInteraction(next);
    rootRef.current.setPointerCapture(event.pointerId);
  };
  const beginDrag = (event: ReactPointerEvent, source: DockSource, bounds: DockRect) => {
    const node = dockSourceNode(layout, source);
    if (!node || dockViews(node).includes(EXPLORER_VIEW)) return;
    begin(event, { kind: 'drag', source, bounds, target: null } as Extract<Interaction, { kind: 'drag' }>);
  };

  const targetAt = (current: Extract<Interaction, { kind: 'drag' }>, x: number, y: number): DockTarget | null => {
    const ids = dockViews(dockSourceNode(current.initial, current.source));
    const candidates = [...measured.groups].sort((first, second) => second.zIndex - first.zIndex);
    const entry = candidates.find((candidate) => contains(candidate.rect, x, y)
      && !(current.source.type === 'host' && candidate.host === current.source.id)
      && !(candidate.group.tabs.length > 0 && candidate.group.tabs.every((id) => ids.includes(id))));
    if (!entry) return null;
    if (y < entry.rect.y + DOCK_HEADER_HEIGHT) {
      const rootBounds = rootRef.current!.getBoundingClientRect();
      const tabs = Array.from(rootRef.current!.querySelectorAll<HTMLElement>('[data-dock-tab]')).filter((element) => element.dataset.dockGroup === entry.group.id);
      const index = tabs.findIndex((element) => { const rect = element.getBoundingClientRect(); return x + rootBounds.left < rect.left + rect.width / 2; });
      return { host: entry.host, group: entry.group.id, side: 'center', index: index < 0 ? entry.group.tabs.length : index };
    }
    return { host: entry.host, group: entry.group.id, side: getDockSide(entry.rect, x, y) };
  };

  const pointerMove = (event: ReactPointerEvent) => {
    const current = interactionRef.current;
    if (!current || current.pointerId !== event.pointerId || !rootRef.current) return;
    const bounds = rootRef.current.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const started = current.started || Math.hypot(x - current.startX, y - current.startY) >= 5;
    let next = { ...current, currentX: x, currentY: y, started };
    if (next.kind === 'drag') next = { ...next, target: started && !event.altKey ? targetAt(next, x, y) : null };
    if (next.kind === 'split') {
      const { divider } = next;
      const horizontal = divider.axis === 'horizontal';
      const length = Math.max(1, (horizontal ? divider.parent.width : divider.parent.height) - DOCK_GUTTER);
      const offset = (horizontal ? x - divider.parent.x : y - divider.parent.y) - DOCK_GUTTER / 2;
      onLayout(resizeDockSplit(current.initial, divider.id, Math.max(divider.minimum, Math.min(divider.maximum, offset)) / length));
    }
    if (next.kind === 'resize') {
      const rect = clampDockRect({ ...next.bounds, width: next.bounds.width + x - next.startX, height: next.bounds.height + y - next.startY }, size.width, size.height);
      onLayout({ ...current.initial, floating: current.initial.floating.map((host) => host.id === next.host ? { ...host, bounds: rect } : host) });
    }
    interactionRef.current = next;
    setInteraction(next);
  };
  const cancel = () => {
    const current = interactionRef.current;
    if (!current) return;
    onLayout(current.initial);
    interactionRef.current = null;
    setInteraction(null);
    if (rootRef.current?.hasPointerCapture(current.pointerId)) rootRef.current.releasePointerCapture(current.pointerId);
  };
  const finish = (event: ReactPointerEvent) => {
    const current = interactionRef.current;
    if (!current || current.pointerId !== event.pointerId || !rootRef.current) return;
    if (current.kind === 'drag' && !current.started && current.source.type === 'tab') {
      onLayout((layout) => focusDockView(layout, current.source.id));
      onFocus(current.source.id);
    }
    if (current.kind === 'drag' && current.started) {
      suppressClick.current = true;
      const bounds = rootRef.current.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const target = event.altKey ? null : targetAt(current, x, y);
      if (target) onLayout(moveDockSource(current.initial, current.source, target));
      else if (x >= 0 && y >= 0 && x <= size.width && y <= size.height) {
        const freeBounds = clampDockRect({ ...current.bounds, x: current.bounds.x + x - current.startX, y: current.bounds.y + y - current.startY }, size.width, size.height);
        if (current.source.type === 'host') {
          const hostId = current.source.id;
          const host = current.initial.floating.find((entry) => entry.id === hostId)!;
          onLayout({ ...current.initial, floating: [...current.initial.floating.filter((entry) => entry.id !== hostId), { ...host, bounds: freeBounds }] });
        } else onLayout(floatDockSource(current.initial, current.source, freeBounds));
      }
      const source = dockSourceNode(current.initial, current.source);
      const active = dockGroups(source).find((group) => group.id === current.initial.focusedGroup)?.active ?? dockGroups(source)[0]?.active;
      if (active) onFocus(active);
    }
    interactionRef.current = null;
    setInteraction(null);
    if (rootRef.current.hasPointerCapture(event.pointerId)) rootRef.current.releasePointerCapture(event.pointerId);
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  };
  useEffect(() => {
    if (!interaction) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
    const blur = () => cancel();
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', blur); };
  });
  const focus = (id: string) => { onLayout((current) => focusDockView(current, id)); onFocus(id); };
  focusFrame.current = focus;
  const visibleViews = new Set(measured.groups.map((entry) => entry.group.active));

  return (
    <div ref={rootRef} className="dock-workspace" data-dock-workspace onPointerMove={pointerMove} onPointerUp={finish} onPointerCancel={cancel}
      onLostPointerCapture={() => { if (interactionRef.current) cancel(); }} onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}>
      {views.map((view) => {
        const position = positions.get(view.id);
        const visible = visibleViews.has(view.id) && position;
        return <section key={view.id} data-dock-view={view.id} className="dock-view" aria-label={view.title}
          onPointerDownCapture={() => { if (visible) focus(view.id); }}
          onFocusCapture={() => { if (visible) focus(view.id); }}
          style={position ? { display: visible ? undefined : 'none', left: position.rect.x, top: position.rect.y + DOCK_HEADER_HEIGHT, width: position.rect.width, height: Math.max(0, position.rect.height - DOCK_HEADER_HEIGHT), zIndex: position.zIndex + 1 } : { display: 'none' }}>
          {view.content}
        </section>;
      })}
      {measured.groups.map((entry) => {
        const pinned = entry.group.tabs.filter((id) => viewById.get(id)?.pinned);
        const tabs = [...pinned, ...entry.group.tabs.filter((id) => !pinned.includes(id))];
        const fixed = tabs.includes(EXPLORER_VIEW);
        const floating = layout.floating.find((host) => host.id === entry.host);
        return <div key={entry.group.id} className="dock-group" data-dock-group-id={entry.group.id} data-dock-host={entry.host} style={{ left: entry.rect.x, top: entry.rect.y, width: entry.rect.width, height: entry.rect.height, zIndex: entry.zIndex }}>
          <div className="dock-header" role="tablist" aria-label="Workspace group" style={{ zIndex: entry.zIndex + 2 }}>
            {!fixed && <button type="button" aria-label="Move group" title="Move group" className="dock-button dock-grip" onPointerDown={(event) => beginDrag(event, { type: 'group', id: entry.group.id }, entry.rect)}><Grip className="h-3 w-3" /></button>}
            <div className="dock-tabs">
              {tabs.map((id) => {
                const view = viewById.get(id);
                if (!view) return null;
                const Icon = view.icon;
                return <div key={id} role="tab" aria-selected={entry.group.active === id} tabIndex={0} data-dock-tab={id} data-dock-group={entry.group.id}
                  className={`dock-tab ${entry.group.active === id ? 'dock-tab-active' : ''}`}
                  onClick={() => focus(id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') focus(id); }}
                  onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) beginDrag(event, { type: 'tab', id }, entry.rect); }}
                  onAuxClick={(event) => { if (event.button === 1 && !view.pinned) { event.preventDefault(); onClose([id]); } }}
                  onContextMenu={(event) => { event.preventDefault(); onContextMenu(id, event.clientX, event.clientY); }} title={view.title}>
                  {view.pinned && <Pin className="h-3 w-3 shrink-0" />}<Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{view.title}</span>
                  {view.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                  {!view.pinned && <button type="button" className="dock-button" aria-label={`Close ${view.title}`} onClick={(event) => { event.stopPropagation(); onClose([id]); }}><X className="h-3 w-3" /></button>}
                </div>;
              })}
            </div>
            <button type="button" className="dock-button" aria-label="Open tool" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); onOpenTool(entry.group.id, bounds.left, bounds.bottom); }}><Plus className="h-3.5 w-3.5" /></button>
            {!fixed && tabs.length > 0 && <button type="button" className="dock-button" aria-label={floating ? 'Dock group' : 'Detach group'} title={floating ? 'Dock group' : 'Detach group'}
              onClick={() => onLayout((current) => floating ? pinDockHost(current, floating.id) : floatDockSource(current, { type: 'group', id: entry.group.id }, clampDockRect({ ...entry.rect, width: Math.min(600, entry.rect.width), height: Math.min(450, entry.rect.height) }, size.width, size.height)))}><Pin className="h-3.5 w-3.5" /></button>}
          </div>
        </div>;
      })}
      {measured.dividers.map((divider) => <div key={divider.id} role="separator" tabIndex={0} aria-label={`Resize ${divider.id === 'sidebar' ? 'sidebar' : 'panels'}`} aria-orientation={divider.axis === 'horizontal' ? 'vertical' : 'horizontal'}
        className={`dock-divider ${divider.axis === 'horizontal' ? 'dock-divider-horizontal' : 'dock-divider-vertical'}`} style={{ left: divider.rect.x, top: divider.rect.y, width: divider.rect.width, height: divider.rect.height, zIndex: divider.zIndex }}
        onPointerDown={(event) => begin(event, { kind: 'split', divider })}
        onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const horizontal = divider.axis === 'horizontal'; const length = (horizontal ? divider.parent.width : divider.parent.height) - DOCK_GUTTER; const current = horizontal ? divider.rect.x - divider.parent.x : divider.rect.y - divider.parent.y; const offset = current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -16 : 16); onLayout((layout) => resizeDockSplit(layout, divider.id, Math.max(divider.minimum, Math.min(divider.maximum, offset)) / Math.max(1, length))); }} />)}
      {layout.floating.map((host, index) => {
        const rect = clampDockRect(host.bounds, size.width, size.height, host.minimized);
        const title = dockViews(host.root).map((id) => viewById.get(id)?.title).filter(Boolean).join(' · ');
        return <div key={host.id} className="dock-floating" data-dock-floating={host.id} style={{ left: rect.x, top: rect.y, width: rect.width, height: host.minimized ? DOCK_HEADER_HEIGHT : rect.height, zIndex: 100 + index * 10 }}>
          <div className="dock-floating-title" title="Drag to dock; hold Alt to move freely" onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) beginDrag(event, { type: 'host', id: host.id }, rect); }}>
            <Grip className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">{title}</span>
            <button type="button" className="dock-button" aria-label={host.minimized ? 'Restore window' : 'Minimize window'} onClick={() => onLayout((current) => ({ ...current, floating: current.floating.map((entry) => entry.id === host.id ? { ...entry, minimized: !entry.minimized } : entry) }))}>{host.minimized ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}</button>
            <button type="button" className="dock-button" aria-label="Dock window" onClick={() => onLayout((current) => pinDockHost(current, host.id))}><Pin className="h-3.5 w-3.5" /></button>
            <button type="button" className="dock-button" aria-label="Close window" onClick={() => onClose(dockViews(host.root))}><X className="h-3.5 w-3.5" /></button>
          </div>
        </div>;
      })}
      {layout.floating.filter((host) => !host.minimized).map((host) => {
        const rect = clampDockRect(host.bounds, size.width, size.height);
        return <button key={`resize:${host.id}`} type="button" className="dock-float-resize" aria-label="Resize window"
          style={{ left: rect.x + rect.width - 16, top: rect.y + rect.height - 16, zIndex: 106 + layout.floating.indexOf(host) * 10 }}
          onPointerDown={(event) => begin(event, { kind: 'resize', host: host.id, bounds: rect })}><Grip className="h-4 w-4" /></button>;
      })}
      {interaction && <div className="dock-interaction-shield" style={{ cursor: interaction.kind === 'split' ? interaction.divider.axis === 'horizontal' ? 'ew-resize' : 'ns-resize' : interaction.kind === 'resize' ? 'se-resize' : 'grabbing' }} />}
      {preview && activeDrop && <div className="dock-preview" data-dock-preview={activeDrop.side}
        style={{ left: preview.x, top: preview.y, width: preview.width, height: preview.height }} />}
      {interaction?.kind === 'drag' && interaction.started && <div className="dock-drag-label" style={{ left: interaction.currentX + 12, top: interaction.currentY + 12 }}>{sourceViews.map((id) => viewById.get(id)?.title).join(' · ')}</div>}
    </div>
  );
};
