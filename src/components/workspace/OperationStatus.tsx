import { useEffect } from 'react';
import { isOperationRunning, useOperationStore } from '../../stores/useOperationStore';
export function OperationStatus({ onFocusView }: { onFocusView: (id: string) => void }) {
  const { entries, cancel, dismiss } = useOperationStore();
  const active = entries.filter(isOperationRunning);
  const failed = entries.filter(entry => entry.status === 'failed');
  useEffect(() => {
    if (!active.length) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [active.length]);
  if (!entries.length) return null;
  return <details className="relative" onKeyDown={event => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }}>
    <summary className="cursor-pointer whitespace-nowrap">{active.length ? `${active.length} running` : failed.length ? `${failed.length} failed` : 'Operations'}</summary>
    <div className="absolute bottom-7 right-0 z-[2000] max-h-72 w-[min(24rem,85vw)] overflow-auto rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-xl">
      {entries.map(entry => <div key={entry.id} className="border-b border-border py-2 last:border-0">
        <div className="flex items-center gap-2"><button className="min-w-0 flex-1 truncate text-left font-medium" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onFocusView(entry.viewId); }}>{entry.label}</button><span className="text-xs text-muted-foreground">{entry.status}</span>
          {entry.status === 'running' && entry.cancel ? <button onClick={() => cancel(entry.id)}>Cancel</button> : !isOperationRunning(entry) ? <button aria-label={`Dismiss ${entry.label}`} onClick={() => dismiss(entry.id)}>×</button> : null}</div>
        {entry.completed !== undefined && entry.total !== undefined && <p className="mt-1 text-xs text-muted-foreground">{entry.completed}/{entry.total}</p>}
        {entry.message && <p className="mt-1 break-words text-xs text-muted-foreground">{entry.message}</p>}
      </div>)}
    </div>
  </details>;
}
