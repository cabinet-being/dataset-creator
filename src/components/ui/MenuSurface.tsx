import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { clampSurfaceToViewport } from '../../lib/viewportGeometry';
export function MenuSurface({ onDismiss, children, initialFocus = 'first', closeOnTab = true, ...props }: HTMLAttributes<HTMLDivElement> & { onDismiss: () => void; initialFocus?: 'first' | 'last'; closeOnTab?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const dismissRef = useRef(onDismiss); dismissRef.current = onDismiss;
  const returnFocus = useRef<HTMLElement | null>(null);
  const [viewportStyle, setViewportStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? []);
  const place = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    if (!anchorRef.current?.isConnected) { dismissRef.current(); return; }
    const previousTransform = element.style.transform; element.style.transform = '';
    const bounds = element.getBoundingClientRect();
    element.style.transform = previousTransform;
    const anchor = anchorRef.current.parentElement?.getBoundingClientRect();
    const explicitLeft = typeof props.style?.left === 'number' ? props.style.left : undefined;
    const explicitTop = typeof props.style?.top === 'number' ? props.style.top : undefined;
    const nominalLeft = explicitLeft ?? (props.className?.includes('right-0') ? (anchor?.right ?? 0) - bounds.width : anchor?.left ?? 0);
    const nominalTop = explicitTop ?? (props.className?.includes('bottom-full') ? (anchor?.top ?? 0) - bounds.height : anchor?.bottom ?? 0);
    const viewport = window.visualViewport;
    const constrained = clampSurfaceToViewport({ left: nominalLeft, top: nominalTop, width: bounds.width, height: bounds.height }, {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
    });
    const next = {
      visibility: 'visible',
      position: 'fixed',
      left: `${constrained.x}px`,
      top: `${constrained.y}px`,
      transform: 'none',
      zIndex: props.style?.zIndex ?? 2000,
      maxHeight: `${constrained.maxHeight}px`,
      overflowY: 'auto',
      overscrollBehavior: 'contain',
    } satisfies CSSProperties;
    setViewportStyle(current => current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight && current.visibility === 'visible' ? current : next);
  }, [props.className, props.style?.left, props.style?.top, props.style?.zIndex]);
  useLayoutEffect(() => {
    // StrictMode replays this effect after it has already focused the first item.
    // Keep the original trigger rather than capturing an item that will unmount.
    returnFocus.current ??= document.activeElement as HTMLElement;
    buttons().forEach(button => { if (button.tagName === 'BUTTON' && !button.hasAttribute('role')) button.setAttribute('role', 'menuitem'); if (button.tagName === 'BUTTON') button.tabIndex = -1; });
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
  const surface = <div {...props} style={{ ...props.style, ...viewportStyle }} ref={ref} role={props.role ?? 'menu'} data-state="open" onKeyDown={event => {
    const entries = buttons(); const index = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape' || (event.key === 'Tab' && closeOnTab)) { event.preventDefault(); event.stopPropagation(); onDismiss(); returnFocus.current?.focus(); return; }
    if ((event.target as HTMLElement).matches('input,select,textarea')) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus(); entries[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = [...entries.slice(index + 1), ...entries.slice(0, index + 1)].find(button => button.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (next) { event.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
    }
  }}>{children}</div>;
  return <><span ref={anchorRef} aria-hidden="true" className="pointer-events-none absolute h-0 w-0" />{createPortal(surface, document.body)}</>;
}
