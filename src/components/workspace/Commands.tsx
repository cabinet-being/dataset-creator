import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { captureShortcut, isTextEntry, matchesShortcut, shortcutLabel } from '../../lib/keyboard';
import { useUIStore } from '../../stores/useUIStore';
import { createCommandRegistry, type Command } from '../../lib/commandRegistry';
export type { Command } from '../../lib/commandRegistry';

type CommandPreferences = { singles: boolean; bindings: Record<string, string> };
const Context = createContext<(ReturnType<typeof createCommandRegistry> & { open: (help?: boolean) => void }) | null>(null);
const storageKey = 'dataset-creator-shortcuts-v1';
export function useCommands(commands: Command[], scope?: () => HTMLElement | null) {
  const api = useContext(Context);
  const ref = useRef(commands); ref.current = commands.map(command => ({ ...command, scope: command.scope ?? scope }));
  useEffect(() => api?.register(() => ref.current), [api]);
  const state = JSON.stringify(commands.map(({ id, label, disabled, reason, active, shortcut, shortcutEnabled }) => ({ id, label, disabled, reason, active, shortcut, shortcutEnabled })));
  useEffect(() => { api?.changed(); }, [api, state]);
}
export const useCommandPalette = () => useContext(Context)!.open;
export const useCommandState = (id: string): { label?: string; disabled: boolean; reason?: string } => {
  const api = useContext(Context)!;
  return JSON.parse(useSyncExternalStore(api.subscribe, () => api.snapshot(id)));
};
export const useCommandRunner = () => {
  const api = useContext(Context)!;
  return (id: string) => {
    try { Promise.resolve(api.run(id)).catch(reportError); } catch (error) { reportError(error); }
  };
};
const reportError = (error: unknown) => useUIStore.getState().addNotification('error', error instanceof Error ? error.message : 'Command failed');

export function CommandProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createCommandRegistry);
  const [mode, setMode] = useState<'commands' | 'help' | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [recording, setRecording] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState('');
  const [prefs, setPrefs] = useState<CommandPreferences>(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (saved && typeof saved.singles === 'boolean' && saved.bindings && typeof saved.bindings === 'object') return { singles: saved.singles, bindings: Object.fromEntries(Object.entries(saved.bindings).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) };
    } catch {} return { singles: true, bindings: {} };
  });
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const modeRef = useRef(mode); modeRef.current = mode;
  const focusBefore = useRef<HTMLElement | null>(null);
  const [api] = useState(() => ({
    ...registry,
    open: (help = false) => { focusBefore.current = document.activeElement as HTMLElement; setQuery(''); setIndex(0); setRecording(null); setMode(help ? 'help' : 'commands'); },
  }));
  const getCommands = () => {
    return registry.commands().map(command => ({ ...command, shortcut: command.shortcutEnabled === false ? undefined : prefsRef.current.bindings[command.id] ?? command.shortcut }));
  };
  const [, refresh] = useState(0);
  useEffect(() => mode ? registry.subscribe(() => refresh(value => value + 1)) : undefined, [mode, registry]);
  const execute = (command: Command) => {
    if (command.disabled) return;
    const origin = focusBefore.current;
    setMode(null);
    focusBefore.current = null;
    requestAnimationFrame(() => {
      if (document.activeElement === document.body && origin?.isConnected && origin.getClientRects().length) origin.focus();
    });
    try { Promise.resolve(command.run()).catch(error => useUIStore.getState().addNotification('error', error instanceof Error ? error.message : 'Command failed')); }
    catch (error) { useUIStore.getState().addNotification('error', error instanceof Error ? error.message : 'Command failed'); }
  };
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch {} }, [prefs]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.getModifierState('AltGraph') || modeRef.current) return;
      if (document.querySelector('[data-workspace-busy="true"]')) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"]')) return;
      if (matchesShortcut(event, 'Mod+K')) { event.preventDefault(); api.open(); return; }
      if (!isTextEntry(event.target) && prefsRef.current.singles && matchesShortcut(event, '?')) { event.preventDefault(); api.open(true); return; }
      if (event.target instanceof HTMLElement && event.target.closest('button, [role=button], summary, a, [role=tab]') && [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const command = getCommands().find(command => command.shortcut &&
        (!command.scope || Boolean(command.scope()?.contains(event.target as Node))) &&
        (!isTextEntry(event.target) || command.allowInInput) &&
        (prefsRef.current.singles || command.shortcut.includes('+')) && matchesShortcut(event, command.shortcut));
      if (command) { event.preventDefault(); execute(command); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [api]);
  const commands = getCommands().filter(command => `${command.label} ${command.group ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const boundedIndex = Math.min(index, Math.max(0, commands.length - 1));
  const currentIndex = commands[boundedIndex]?.disabled ? commands.findIndex(command => !command.disabled) : boundedIndex;
  return <Context.Provider value={api}>{children}
    <Dialog.Root open={Boolean(mode)} onOpenChange={open => { if (!open) setMode(null); }}>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[3000] bg-black/50 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); if (focusBefore.current?.isConnected) focusBefore.current.focus(); }}
          className="command-dialog fixed left-1/2 top-[12%] z-[3001] flex max-h-[76vh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
          <Dialog.Title className="sr-only">{mode === 'help' ? 'Keyboard shortcuts' : 'Commands'}</Dialog.Title>
          <div className="flex items-center gap-3 border-b border-border p-4"><Search size={18} className="text-muted-foreground" />
            <input autoFocus aria-label={mode === 'help' ? 'Search shortcuts' : 'Search commands'} placeholder={mode === 'help' ? 'Keyboard shortcuts' : 'Search commands…'} value={query}
              onChange={event => { setQuery(event.target.value); setIndex(0); }}
              role={mode === 'help' ? 'searchbox' : 'combobox'} aria-autocomplete={mode === 'help' ? undefined : 'list'} aria-expanded={mode === 'help' ? undefined : true} aria-controls="command-results" aria-activedescendant={mode !== 'help' && currentIndex >= 0 && commands.length ? `command-${currentIndex}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none" onKeyDown={event => {
                if (event.isPropagationStopped() || event.nativeEvent.isComposing || mode === 'help') return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); let next = currentIndex; for (let step = 0; step < commands.length; step++) { next = (next + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % commands.length; if (!commands[next].disabled) break; } setIndex(next); document.getElementById(`command-${next}`)?.scrollIntoView({ block: 'nearest' }); }
                if (event.key === 'Enter' && commands[currentIndex]) { event.preventDefault(); execute(commands[currentIndex]); }
              }} />
            <Dialog.Close aria-label="Close commands" className="rounded p-1"><X size={16} /></Dialog.Close></div>
          {mode === 'help' && <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.singles} onChange={e => setPrefs({ ...prefs, singles: e.target.checked })} />Single-key shortcuts</label>
            <button className="ml-auto" onClick={() => setPrefs({ singles: true, bindings: {} })}>Reset shortcuts</button>
            <p className="w-full text-muted-foreground">Ctrl / Cmd + K · Commands. Tab · Next control. Escape · Back. Arrow keys · Navigate.</p>
            {bindingError && <p role="alert" className="w-full text-destructive">{bindingError}</p>}
          </div>}
          <div id="command-results" role={mode === 'help' ? 'group' : 'listbox'} aria-label="Commands" className="min-h-0 overflow-auto p-2">
            {commands.map((command, i) => <div key={command.id} id={`command-${i}`} role={mode === 'help' ? undefined : 'option'} aria-selected={mode === 'help' ? undefined : currentIndex === i} aria-disabled={mode === 'help' ? undefined : command.disabled} onMouseDown={event => { if (mode !== 'help') event.preventDefault(); }} onClick={() => { if (mode !== 'help') execute(command); }}
              className={`flex items-center gap-2 rounded-lg ${currentIndex === i ? 'bg-secondary' : ''}`}>
              <div title={command.disabled ? command.reason : undefined} className={`flex min-w-0 flex-1 items-center justify-between gap-4 px-3 py-3 text-left text-sm ${command.disabled ? 'opacity-40' : 'cursor-pointer'}`}><span className="truncate">{command.label}</span><kbd className="shrink-0 text-xs text-muted-foreground">{shortcutLabel(command.shortcut)}</kbd></div>
              {mode === 'help' && <button aria-label={`Change shortcut for ${command.label}`} className="mr-2 rounded px-2 py-1 text-xs text-muted-foreground" onClick={() => { setRecording(command.id); setBindingError(''); }}
                onKeyDown={event => {
                  if (recording !== command.id) return;
                  event.preventDefault(); event.stopPropagation();
                  if (event.key === 'Escape') { setRecording(null); return; }
                  if (event.key === 'Backspace') { setPrefs({ ...prefs, bindings: { ...prefs.bindings, [command.id]: '' } }); setRecording(null); return; }
                  const binding = captureShortcut(event.nativeEvent); if (!binding) return;
                  const conflict = getCommands().find(other => other.id !== command.id && other.shortcut?.toLowerCase() === binding.toLowerCase());
                  if (conflict || ['mod+k', '?'].includes(binding.toLowerCase())) { setBindingError(`Already used: ${conflict?.label ?? 'Commands / help'}`); return; }
                  setPrefs({ ...prefs, bindings: { ...prefs.bindings, [command.id]: binding } }); setRecording(null);
                }}>{recording === command.id ? 'Press keys…' : 'Edit'}</button>}
            </div>)}
            {!commands.length && <p className="p-6 text-center text-sm text-muted-foreground">No commands found</p>}
          </div>
          <div className="flex justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground"><span>{mode === 'help' ? 'Click Edit to record · Backspace to clear' : '↑ ↓ Navigate · Enter Run'}</span><button onClick={() => { setMode(mode === 'help' ? 'commands' : 'help'); setQuery(''); }}> {mode === 'help' ? 'Commands' : 'Keyboard shortcuts'}</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </Context.Provider>;
}
