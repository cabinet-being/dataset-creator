export type SaveState = { status: 'saved' | 'pending' | 'saving' | 'error'; error?: unknown };

/** Serializes snapshots and only advances the saved baseline after a successful write. */
export function createSaveQueue<T>(initial: T, write: (snapshot: T, previous: T) => Promise<void>, changed: (state: SaveState) => void) {
  let baseline = initial;
  let latest = initial;
  let stopped = false;
  let running: Promise<void> | undefined;
  let lane: Promise<unknown> | undefined;
  let exclusiveCount = 0;
  const schedule = <R>(task: () => Promise<R>): Promise<R> => {
    const result = lane ? lane.catch(() => {}).then(task) : task();
    const scheduled = result.finally(() => { if (lane === scheduled) lane = undefined; });
    lane = scheduled;
    return scheduled;
  };
  const drain = async () => {
    while (!stopped && latest !== baseline) {
      const snapshot = latest;
      changed({ status: 'saving' });
      try { await write(snapshot, baseline); }
      catch (error) { if (!stopped) changed({ status: 'error', error }); throw error; }
      baseline = snapshot;
      if (!stopped) changed({ status: latest === baseline ? 'saved' : 'pending' });
    }
  };
  return {
    enqueue(snapshot: T) {
      if (stopped) return;
      latest = snapshot;
      changed({ status: latest === baseline ? 'saved' : running ? 'saving' : 'pending' });
    },
    isDirty: () => latest !== baseline || exclusiveCount > 0,
    stop: () => { stopped = true; },
    /** Filesystem mutations run between saves. Do not call flush from inside the action. */
    runExclusive<R>(action: () => Promise<R>): Promise<R> {
      exclusiveCount++;
      running = undefined;
      return schedule(async () => {
        if (stopped) throw new Error('The project changed before the file operation could start.');
        await drain();
        try { return await action(); }
        finally { await drain(); }
      }).finally(() => { exclusiveCount--; });
    },
    flush(): Promise<void> {
      if (running) return running;
      const pending = schedule(drain).finally(() => { if (running === pending) running = undefined; });
      running = pending;
      return pending;
    },
  };
}
