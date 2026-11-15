import { create } from 'zustand';
import { useProjectStore } from './useProjectStore';
import { flushProjectSave } from '../hooks/useProjectSave';
type Entry = { project: string; label: string; undo: () => void | Promise<void>; redo: () => void | Promise<void> };
type History = { past: Entry[]; future: Entry[]; busy: boolean; push: (entry: Omit<Entry, 'project'>) => void; undo: () => Promise<void>; redo: () => Promise<void> };
type PendingEntry = Omit<Entry, 'project'>;
export type HistoryTransactionWriter = { push: (entry: PendingEntry) => void };
let projectEpoch = 0;
// Transactions still running. Undo/Redo wait for them so they act on the finished action, not on the one before it.
const runningTransactions = new Set<Promise<void>>();
const settleRunningTransactions = async () => { while (runningTransactions.size) await Promise.allSettled([...runningTransactions]); };

const compoundEntry = (label: string, entries: PendingEntry[]): PendingEntry => ({
  label,
  undo: async () => {
    const capture = captureHistoryEpoch();
    for (const entry of [...entries].reverse()) { if (!isHistoryEpochCurrent(capture)) return; await entry.undo(); }
  },
  redo: async () => {
    const capture = captureHistoryEpoch();
    for (const entry of entries) { if (!isHistoryEpochCurrent(capture)) return; await entry.redo(); }
  },
});

export type HistoryEpochCapture = { project: string; epoch: number };
export function captureHistoryEpoch(): HistoryEpochCapture { return { project: useProjectStore.getState().id, epoch: projectEpoch }; }
export function isHistoryEpochCurrent(capture: HistoryEpochCapture): boolean {
  return capture.project === useProjectStore.getState().id && capture.epoch === projectEpoch;
}

/** Groups history emitted by existing domain owners into one user-visible action. */
export async function runHistoryTransaction<T>(label: string, action: (writer: HistoryTransactionWriter) => Promise<T>): Promise<T> {
  const pending = { label, project: useProjectStore.getState().id, epoch: projectEpoch, entries: [] as PendingEntry[] };
  const writer: HistoryTransactionWriter = { push: entry => pending.entries.push(entry) };
  let finish!: () => void;
  const running = new Promise<void>(resolve => { finish = resolve; });
  runningTransactions.add(running);
  try { return await action(writer); }
  finally {
    if (pending.entries.length && pending.project === useProjectStore.getState().id && pending.epoch === projectEpoch) {
      useHistoryStore.getState().push(compoundEntry(label, pending.entries));
    }
    runningTransactions.delete(running); finish();
  }
}
export const useHistoryStore = create<History>((set, get) => ({
  past: [], future: [], busy: false,
  push: entry => {
    set(state => ({ past: [...state.past.filter(item => item.project === useProjectStore.getState().id).slice(-19), { ...entry, project: useProjectStore.getState().id }], future: [] }));
  },
  undo: async () => {
    if (runningTransactions.size) await settleRunningTransactions();
    const state = get(); const entry = state.past[state.past.length - 1];
    if (!entry || state.busy || entry.project !== useProjectStore.getState().id) return;
    const capture = captureHistoryEpoch();
    set({ busy: true });
    try {
      await entry.undo();
      if (!isHistoryEpochCurrent(capture)) return;
      // Keep edits made while the operation was saving. A new edit starts a new redo branch.
      set(current => ({ past: current.past.filter(item => item !== entry), future: current.past[current.past.length - 1] === entry ? [...current.future, entry] : [] }));
      await flushProjectSave();
    } finally { if (isHistoryEpochCurrent(capture)) set({ busy: false }); }
  },
  redo: async () => {
    if (runningTransactions.size) await settleRunningTransactions();
    const state = get(); const entry = state.future[state.future.length - 1];
    if (!entry || state.busy || entry.project !== useProjectStore.getState().id) return;
    const capture = captureHistoryEpoch();
    set({ busy: true });
    try {
      await entry.redo();
      if (!isHistoryEpochCurrent(capture)) return;
      set(current => ({ future: current.future.filter(item => item !== entry), past: [...current.past.slice(0, state.past.length), entry, ...current.past.slice(state.past.length)].slice(-20) }));
      await flushProjectSave();
    } finally { if (isHistoryEpochCurrent(capture)) set({ busy: false }); }
  },
}));
useProjectStore.subscribe((state, previous) => { if (state.id !== previous.id) { projectEpoch += 1; useHistoryStore.setState({ past: [], future: [], busy: false }); } });
