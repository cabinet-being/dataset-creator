import { useLayoutEffect, useRef, type HTMLAttributes } from 'react';
export function MenuSurface({ onDismiss, children, initialFocus = 'first', ...props }: HTMLAttributes<HTMLDivElement> & { onDismiss: () => void; initialFocus?: 'first' | 'last' }) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  useLayoutEffect(() => {
    // StrictMode replays this effect after it has already focused the first item.
    // Keep the original trigger rather than capturing an item that will unmount.
    returnFocus.current ??= document.activeElement as HTMLElement;
    buttons().forEach(button => { if (!button.hasAttribute('role')) button.setAttribute('role', 'menuitem'); button.tabIndex = -1; });
    const entries = buttons();
    entries[initialFocus === 'last' ? entries.length - 1 : 0]?.focus();
    return () => { requestAnimationFrame(() => { if (document.activeElement === document.body && returnFocus.current?.isConnected) returnFocus.current.focus(); }); };
  }, []);
  return <div {...props} ref={ref} role="menu" data-state="open" onKeyDown={event => {
    const entries = buttons(); const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onDismiss(); returnFocus.current?.focus(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = [...entries.slice(index + 1), ...entries.slice(0, index + 1)].find(button => button.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (next) { event.preventDefault(); next.focus(); }
    }
  }}>{children}</div>;
}
