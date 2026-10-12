import { create } from 'zustand';
import { useProjectStore } from './useProjectStore';
import { flushProjectSave } from '../hooks/useProjectSave';
type Entry = { project: string; label: string; undo: () => void | Promise<void>; redo: () => void | Promise<void> };
type History = { past: Entry[]; future: Entry[]; busy: boolean; push: (entry: Omit<Entry, 'project'>) => void; undo: () => Promise<void>; redo: () => Promise<void> };
export const useHistoryStore = create<History>((set, get) => ({
  past: [], future: [], busy: false,
  push: entry => set(state => ({ past: [...state.past.filter(item => item.project === useProjectStore.getState().id).slice(-19), { ...entry, project: useProjectStore.getState().id }], future: [] })),
  undo: async () => {
    const state = get(); const entry = state.past[state.past.length - 1];
    if (!entry || state.busy || entry.project !== useProjectStore.getState().id) return;
    set({ busy: true });
    try {
      await entry.undo();
      if (entry.project !== useProjectStore.getState().id) return;
      // Keep edits made while the operation was saving. A new edit starts a new redo branch.
      set(current => ({ past: current.past.filter(item => item !== entry), future: current.past[current.past.length - 1] === entry ? [...current.future, entry] : [] }));
      await flushProjectSave();
    } finally { set({ busy: false }); }
  },
  redo: async () => {
    const state = get(); const entry = state.future[state.future.length - 1];
    if (!entry || state.busy || entry.project !== useProjectStore.getState().id) return;
    set({ busy: true });
    try {
      await entry.redo();
      if (entry.project !== useProjectStore.getState().id) return;
      set(current => ({ future: current.future.filter(item => item !== entry), past: [...current.past.slice(0, state.past.length), entry, ...current.past.slice(state.past.length)].slice(-20) }));
      await flushProjectSave();
    } finally { set({ busy: false }); }
  },
}));
useProjectStore.subscribe((state, previous) => { if (state.id !== previous.id) useHistoryStore.setState({ past: [], future: [] }); });
