import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Check, FilePlus, FolderOpen, GitBranch, Layers3, Monitor, Moon, PanelBottom, PanelLeft, PanelRight, Pencil, Sun, type LucideIcon } from 'lucide-react';
import type { ToolName } from '../../types';
import { TOOL_DEFINITIONS } from '../../lib/toolDefinitions';
import { MenuSurface } from '../ui/MenuSurface';
import { useCommandRunner, useCommandState } from './Commands';

export type WorkspaceMenu = 'file' | 'view' | 'tools' | 'windows';
const MENUS: { id: WorkspaceMenu; label: string }[] = [
  {id:'file',label:'File'}, {id:'view',label:'View'}, {id:'tools',label:'Tools'}, {id:'windows',label:'Windows'},
];
export const WORKSPACE_WINDOWS = [
  {id:'explorer',label:'Explorer',icon:PanelLeft}, {id:'inspector',label:'Inspector',icon:PanelRight},
  {id:'output',label:'Output',icon:PanelBottom}, {id:'project',label:'Project',icon:FolderOpen},
  {id:'dataset',label:'Dataset',icon:Layers3},
] as const;

function CommandMenuItem({ command, label, icon: Icon, checked, choice, onClose }: {
  command: string; label: string; icon: LucideIcon; checked?: boolean; choice?: boolean; onClose: () => void;
}) {
  const state = useCommandState(command);
  const run = useCommandRunner();
  return <button type="button" disabled={state.disabled} title={state.reason}
    role={checked === undefined ? 'menuitem' : choice ? 'menuitemradio' : 'menuitemcheckbox'} aria-checked={checked}
    onClick={() => { onClose(); run(command); }}
    className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-secondary disabled:opacity-50">
    <Icon className="h-4 w-4" /><span className="flex-1">{label}</span>
    {checked && <Check className="h-4 w-4" />}
  </button>;
}

export function WorkspaceMenus({ openMenu, onOpenMenuChange, fileButtonRef, enabledTools, activeTool, theme, isWindowOpen, onCommands }: {
  openMenu: WorkspaceMenu | null;
  onOpenMenuChange: (menu: WorkspaceMenu | null) => void;
  fileButtonRef: RefObject<HTMLButtonElement>;
  enabledTools: readonly ToolName[];
  activeTool: ToolName | null;
  theme: 'system' | 'light' | 'dark';
  isWindowOpen: (id: string) => boolean;
  onCommands: () => void;
}) {
  const id = useId();
  const triggers = useRef<Partial<Record<WorkspaceMenu, HTMLButtonElement | null>>>({});
  const [focused, setFocused] = useState<WorkspaceMenu>('file');
  const [initialFocus, setInitialFocus] = useState<'first' | 'last'>('first');
  const [position, setPosition] = useState({left:0, top:0, maxHeight:400});
  useLayoutEffect(() => {
    if (!openMenu) return;
    const place = () => {
      const rect = triggers.current[openMenu]?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(256, window.innerWidth - 32);
      setPosition({left:Math.max(16,Math.min(rect.left,window.innerWidth-width-16)),top:rect.bottom+4,maxHeight:Math.max(80,window.innerHeight-rect.bottom-16)});
    };
    place(); window.addEventListener('resize',place);
    return () => window.removeEventListener('resize',place);
  }, [openMenu]);
  const run = useCommandRunner();
  const close = () => onOpenMenuChange(null);
  const item = (command: string, label: string, icon: LucideIcon, checked?: boolean) =>
    <CommandMenuItem key={command} command={command} label={label} icon={icon} checked={checked} choice={command.startsWith('theme.') || command.startsWith('tool.')} onClose={close} />;
  const content = (menu: WorkspaceMenu) => {
    switch (menu) {
      case 'file': return <>
        {item('project.new','New Project Directory',FilePlus)}
        {item('project.open','Open Project Directory',FolderOpen)}
        {item('project.rename','Rename',Pencil)}
        {item('project.versions','Versions',GitBranch)}
      </>;
      case 'view': return <>
        {item('theme.system','System',Monitor,theme === 'system')}
        {item('theme.light','Light',Sun,theme === 'light')}
        {item('theme.dark','Dark',Moon,theme === 'dark')}
      </>;
      case 'tools': return enabledTools.map(tool => item(`tool.${tool}`,TOOL_DEFINITIONS[tool].label,TOOL_DEFINITIONS[tool].icon,activeTool === tool));
      case 'windows': return WORKSPACE_WINDOWS.map(window => item(`window.${window.id}`,window.label,window.icon,isWindowOpen(`window:${window.id}`)));
    }
  };
  return <header className="relative z-30 flex min-h-9 shrink-0 flex-wrap items-center border-b border-border bg-card px-3 text-sm">
    {openMenu && <button type="button" aria-label="Close menu" tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={close} />}
    <div role="menubar" aria-label="Main menu" className="relative z-50 flex" onKeyDown={event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = MENUS.findIndex(menu => menu.id === (openMenu ?? focused));
      const next = MENUS[(index + (event.key === 'ArrowRight' ? 1 : -1) + MENUS.length) % MENUS.length].id;
      setFocused(next); setInitialFocus('first'); triggers.current[next]?.focus();
      if (openMenu) onOpenMenuChange(next);
    }}>
      {MENUS.map(menu => <div key={menu.id} className="relative">
        <button ref={node => { triggers.current[menu.id] = node; if (menu.id === 'file') (fileButtonRef as {current: HTMLButtonElement | null}).current = node; }}
          id={`${id}-${menu.id}-trigger`} type="button" role="menuitem" tabIndex={focused === menu.id ? 0 : -1}
          aria-haspopup="menu" aria-expanded={openMenu === menu.id} aria-controls={openMenu === menu.id ? `${id}-${menu.id}` : undefined}
          onFocus={() => setFocused(menu.id)}
          onClick={() => { setInitialFocus('first'); onOpenMenuChange(openMenu === menu.id ? null : menu.id); }}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault(); setInitialFocus(event.key === 'ArrowUp' ? 'last' : 'first'); onOpenMenuChange(menu.id);
          }}
          className={`rounded px-3 py-1.5 font-medium transition-colors ${openMenu === menu.id ? 'bg-secondary' : 'hover:bg-secondary'}`}>
          {menu.label}
        </button>
        {openMenu === menu.id && <MenuSurface id={`${id}-${menu.id}`} aria-labelledby={`${id}-${menu.id}-trigger`}
          initialFocus={initialFocus} onDismiss={close} style={position} className="fixed overflow-y-auto w-64 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-1 shadow-xl">
          {content(menu.id)}
        </MenuSurface>}
      </div>)}
    </div>
    <button type="button" className="relative z-40 rounded px-3 py-1.5 font-medium transition-colors hover:bg-secondary" onClick={() => { close(); run('settings'); }}>Settings</button>
    <button type="button" onClick={() => { close(); onCommands(); }} className="relative z-40 ml-auto flex items-center gap-4 rounded border border-border px-3 py-1 text-xs text-muted-foreground" aria-label="Search commands">Commands <kbd>Ctrl / ⌘ K</kbd></button>
  </header>;
}
