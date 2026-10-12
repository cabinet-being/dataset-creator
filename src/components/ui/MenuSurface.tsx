import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { clampSurfaceToViewport } from '../../lib/viewportGeometry';
export function MenuSurface({ onDismiss, children, initialFocus = 'first', ...props }: HTMLAttributes<HTMLDivElement> & { onDismiss: () => void; initialFocus?: 'first' | 'last' }) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [viewportStyle, setViewportStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  const place = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const previousTransform = element.style.transform;
    element.style.transform = '';
    const bounds = element.getBoundingClientRect();
    element.style.transform = previousTransform;
    const viewport = window.visualViewport;
    const constrained = clampSurfaceToViewport(bounds, {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
    });
    const next = {
      visibility: 'visible',
      transform: `translate(${constrained.x - bounds.left}px, ${constrained.y - bounds.top}px)`,
      maxHeight: `${constrained.maxHeight}px`,
      overflowY: 'auto',
      overscrollBehavior: 'contain',
    } satisfies CSSProperties;
    setViewportStyle(current => current.transform === next.transform && current.maxHeight === next.maxHeight && current.visibility === 'visible' ? current : next);
  }, []);
  useLayoutEffect(() => {
    // StrictMode replays this effect after it has already focused the first item.
    // Keep the original trigger rather than capturing an item that will unmount.
    returnFocus.current ??= document.activeElement as HTMLElement;
    buttons().forEach(button => { if (!button.hasAttribute('role')) button.setAttribute('role', 'menuitem'); button.tabIndex = -1; });
    place();
    const entries = buttons();
    entries[initialFocus === 'last' ? entries.length - 1 : 0]?.focus();
    const observer = new ResizeObserver(place); observer.observe(ref.current!);
    const visualViewport = window.visualViewport;
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    visualViewport?.addEventListener('resize', place); visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      visualViewport?.removeEventListener('resize', place); visualViewport?.removeEventListener('scroll', place);
      requestAnimationFrame(() => { if (document.activeElement === document.body && returnFocus.current?.isConnected) returnFocus.current.focus(); });
    };
  }, [initialFocus, place]);
  return <div {...props} style={{ ...props.style, ...viewportStyle }} ref={ref} role="menu" data-state="open" onKeyDown={event => {
    const entries = buttons(); const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onDismiss(); returnFocus.current?.focus(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus(); entries[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = [...entries.slice(index + 1), ...entries.slice(0, index + 1)].find(button => button.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (next) { event.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
    }
  }}>{children}</div>;
}
