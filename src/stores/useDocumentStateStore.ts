import { create } from 'zustand';

type DocumentState = { dirty: boolean; check: () => Promise<boolean> };
type State = {
  documents: Record<string, DocumentState>;
  register: (viewId: string, document: DocumentState) => () => void;
  changed: (viewId: string, check: DocumentState['check'], dirty: boolean) => void;
};
export const useDocumentStateStore = create<State>((set) => ({
  documents: {},
  register: (viewId, document) => {
    set(state => ({ documents: { ...state.documents, [viewId]: document } }));
    return () => set(state => {
      if (state.documents[viewId]?.check !== document.check) return state;
      const documents = { ...state.documents }; delete documents[viewId];
      return { documents };
    });
  },
  changed: (viewId, check, dirty) => set(state => {
    const document = state.documents[viewId];
    if (!document || document.check !== check || document.dirty === dirty) return state;
    return { documents: { ...state.documents, [viewId]: { ...document, dirty } } };
  }),
}));

export async function checkDirtyDocuments(viewIds: string[]): Promise<string[]> {
  const documents = useDocumentStateStore.getState().documents;
  const results = await Promise.all(viewIds.map(async id => {
    const document = documents[id];
    if (!document) return null;
    const dirty = await document.check();
    if (useDocumentStateStore.getState().documents[id]?.check !== document.check) {
      throw new Error('The editor changed while checking its document. Please try again.');
    }
    return dirty ? id : null;
  }));
  return results.filter((id): id is string => id !== null);
}
