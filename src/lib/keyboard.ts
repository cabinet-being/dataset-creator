export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'repeat' | 'getModifierState'>;

export const isTextEntry = (target: EventTarget | null) => target instanceof HTMLElement &&
  Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));

export function matchesShortcut(event: ShortcutEvent, shortcut: string): boolean {
  if (event.isComposing || event.getModifierState?.('AltGraph')) return false;
  const parts = shortcut.split('+');
  const key = parts.pop()!;
  if (Boolean(event.ctrlKey || event.metaKey) !== parts.includes('Mod')) return false;
  if (event.altKey !== parts.includes('Alt')) return false;
  if (key === '?') return event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (event.shiftKey !== parts.includes('Shift')) return false;
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === '/' ? 'Slash' : key;
  return event.code === code || event.key.toLowerCase() === key.toLowerCase();
}

export const shortcutLabel = (shortcut?: string) => (shortcut ?? '').replace('Mod',
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl');

export function captureShortcut(event: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key) || event.isComposing || event.getModifierState('AltGraph')) return null;
  const key = event.code.startsWith('Key') ? event.code.slice(3) : event.code === 'Slash' ? '/' : event.key;
  return [...(event.ctrlKey || event.metaKey ? ['Mod'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key].join('+');
}
