export type Command = { id: string; label: string; group?: string; shortcut?: string; shortcutEnabled?: boolean; disabled?: boolean;
  reason?: string; active?: boolean; allowInInput?: boolean; scope?: () => HTMLElement | null; run: () => void | Promise<unknown> };

export function createCommandRegistry() {
  const sources = new Set<() => Command[]>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const commands = () => [...new Map([...sources].flatMap(get => get()).filter(command => command.active !== false).map(command => [command.id, command])).values()];
  const find = (id: string) => commands().find(command => command.id === id);
  return {
    commands, find, changed,
    register(get: () => Command[]) { sources.add(get); changed(); return () => { sources.delete(get); changed(); }; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // A stable scalar snapshot for React; callbacks stay in the registry, not in render state.
    snapshot(id: string) {
      const command = find(id);
      return JSON.stringify(command ? { label: command.label, disabled: Boolean(command.disabled), reason: command.reason } : { disabled: true, reason: 'No active document' });
    },
    run(id: string) {
      const command = find(id);
      if (!command || command.disabled) throw new Error(command?.reason ?? 'This action is unavailable for the active document.');
      return command.run();
    },
  };
}
