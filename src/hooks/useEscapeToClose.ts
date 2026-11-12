import { useEffect } from 'react';

/** While `active`, pressing Escape runs `onEscape` (window-level keydown). */
export function useEscapeToClose(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEscape();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);
}
