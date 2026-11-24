import { useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/useUIStore';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const LEVEL_CLASS = { error: 'text-destructive', warning: 'text-yellow-600 dark:text-yellow-500', success: 'text-emerald-600 dark:text-emerald-500', info: 'text-muted-foreground' } as const;

/** Activity: the operation log kept in the UI store (the last 1000 entries), following the newest entry unless scrolled up. */
export function ActivityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const logs = useUIStore(state => state.operationLogs);
  const clear = useUIStore(state => state.clearOperationLogs);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const node = list.current;
    if (open && node && follow.current) node.scrollTop = node.scrollHeight;
  }, [open, logs.length]);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
      <Dialog.Content data-activity-dialog aria-describedby="activity-description"
        className="fixed left-1/2 top-1/2 z-[2101] flex max-h-[90vh] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-border bg-card p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">Activity</Dialog.Title>
        <Dialog.Description id="activity-description" className="text-sm text-muted-foreground">Log of imports, analysis, exports and other operations.</Dialog.Description>
        <div ref={list} data-activity-log tabIndex={0} role="log" aria-label="Activity log"
          onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}
          className={cn('h-80 min-h-0 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px]', focusRing)}>
          {logs.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
          {logs.map(entry => <p key={entry.id} className={LEVEL_CLASS[entry.level]}>[{entry.timestamp.toLocaleTimeString()}] {entry.level.toUpperCase().padEnd(7, ' ')} {entry.message}</p>)}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" data-activity-clear disabled={!logs.length} onClick={clear} className={cn('min-h-[44px] rounded-md border border-border px-4 text-sm hover:bg-secondary disabled:opacity-40', focusRing)}>Clear</button>
          <Dialog.Close asChild><button type="button" className={cn('min-h-[44px] rounded-md border border-border px-4 text-sm hover:bg-secondary', focusRing)}>Close</button></Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
