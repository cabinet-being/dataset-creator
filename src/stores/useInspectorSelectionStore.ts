import { useEffect } from 'react';
import { create } from 'zustand';
import type { WorkspaceImage } from '../lib/workspaceImages';
import { useProjectStore } from './useProjectStore';

export type InspectorSelectionPayload = {
  title: string;
  items: WorkspaceImage[];
  outputItem?: WorkspaceImage;
  status?: string;
  detail?: string;
  sourcePath?: string;
  outputPath?: string;
};

type InspectorSelectionState = {
  selections: Record<string, InspectorSelectionPayload>;
  activeOwnerId: string | null;
  projectId: string | null;
  setSelection: (ownerId: string, payload: InspectorSelectionPayload) => void;
  clearSelection: (ownerId: string) => void;
  resetForProject: (projectId: string) => void;
};

export const useInspectorSelectionStore = create<InspectorSelectionState>((set) => ({
  selections: {},
  activeOwnerId: null,
  projectId: useProjectStore.getState().id,
  setSelection: (ownerId, payload) => set((state) => ({
    selections: { ...state.selections, [ownerId]: payload },
    activeOwnerId: ownerId,
  })),
  clearSelection: (ownerId) => set((state) => {
    if (!state.selections[ownerId]) return state;
    const selections = { ...state.selections };
    delete selections[ownerId];
    return { selections, activeOwnerId: state.activeOwnerId === ownerId ? null : state.activeOwnerId };
  }),
  resetForProject: (projectId) => set((state) => state.projectId === projectId
    ? state
    : { projectId, selections: {}, activeOwnerId: null }),
}));

let observedProjectId = useProjectStore.getState().id;
useProjectStore.subscribe((state) => {
  if (state.id === observedProjectId) return;
  observedProjectId = state.id;
  useInspectorSelectionStore.getState().resetForProject(state.id);
});

/** Publish one tool's selection while it is active; ownership guards stale cleanup. */
export const usePublishInspectorSelection = (
  active: boolean,
  ownerId: string,
  payload: InspectorSelectionPayload | null
): void => {
  const projectId = useProjectStore((state) => state.id);
  useEffect(() => {
    const { setSelection, clearSelection } = useInspectorSelectionStore.getState();
    if (active && payload) {
      setSelection(ownerId, payload);
      return () => clearSelection(ownerId);
    }
    clearSelection(ownerId);
    return undefined;
  }, [active, ownerId, payload, projectId]);
};
