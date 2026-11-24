import { create } from 'zustand';
export type Operation = {
  id: string; viewId: string; label: string;
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  completed?: number; total?: number; message?: string; cancel?: () => void;
};
/** Operation view id for project file work (Explorer mutations, indexing, version restore). */
export const PROJECT_OPERATION_VIEW = 'project-files';
export const isOperationRunning = (operation: Operation) => operation.status === 'running' || operation.status === 'cancelling';
type Operations = {
  entries: Operation[];
  start: (operation: Omit<Operation, 'status'>) => void;
  update: (id: string, values: Partial<Pick<Operation, 'completed' | 'total' | 'message'>>) => void;
  finish: (id: string, status: 'completed' | 'cancelled' | 'failed', message?: string) => void;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
};
export const useOperationStore = create<Operations>((set, get) => ({
  entries: [],
  start: operation => set(state => ({ entries: [...state.entries.filter(entry => entry.id !== operation.id && isOperationRunning(entry)), ...state.entries.filter(entry => entry.id !== operation.id && !isOperationRunning(entry)).slice(-9), { ...operation, status: 'running' }] })),
  update: (id, values) => set(state => ({ entries: state.entries.map(entry => entry.id === id && isOperationRunning(entry) ? { ...entry, ...values } : entry) })),
  finish: (id, status, message) => set(state => ({ entries: state.entries.map(entry => entry.id === id ? { ...entry, status, message: message ?? entry.message, cancel: undefined } : entry) })),
  cancel: id => {
    const operation = get().entries.find(entry => entry.id === id);
    if (!operation?.cancel || operation.status !== 'running') return;
    set(state => ({ entries: state.entries.map(entry => entry.id === id ? { ...entry, status: 'cancelling' } : entry) }));
    operation.cancel();
  },
  dismiss: id => set(state => ({ entries: state.entries.filter(entry => entry.id !== id || isOperationRunning(entry)) })),
}));
