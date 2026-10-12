import { useEffect, useId, useState, type RefObject } from 'react';
import { isOperationRunning, useOperationStore } from '../stores/useOperationStore';

/** Tracks a tool's operation independently of which dock tab is visible. */
export function useOperation(label: string, root: RefObject<HTMLElement>, fallbackViewId: string) {
  const id = useId();
  const [api] = useState(() => ({
    start: (cancel?: () => void, total?: number) => useOperationStore.getState().start({ id, label, viewId: root.current?.closest<HTMLElement>('[data-dock-view]')?.dataset.dockView ?? fallbackViewId, cancel, completed: total === undefined ? undefined : 0, total }),
    progress: (completed: number, total: number, message?: string) => useOperationStore.getState().update(id, { completed, total, message }),
    finish: (status: 'completed' | 'cancelled' | 'failed', message?: string) => useOperationStore.getState().finish(id, status, message),
  }));
  useEffect(() => () => {
    const operation = useOperationStore.getState().entries.find(entry => entry.id === id);
    if (operation?.cancel && isOperationRunning(operation)) {
      operation.cancel();
      api.finish('cancelled', 'Tab closed. Completed files remain saved.');
    }
    // Non-cancellable writes finish through their own promise even if saving replaces the tab.
  }, [api, id]);
  return api;
}
