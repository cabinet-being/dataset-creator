import { create } from 'zustand';
import type { ProjectDirectoryHandle } from '../services/project/projectDirectoryService';

interface UIState {
  // Current selections
  selectedSourceImageIds: Set<string>;
  selectedDatasetItemIds: Set<string>;
  hoveredImageId?: string;
  
  // View modes
  darkMode: boolean;
  viewMode: 'grid' | 'list';
  
  // UI flags
  showSettings: boolean;
  showHelp: boolean;

  // Project directory session
  projectDirectoryHandle?: ProjectDirectoryHandle;
  projectDirectoryName?: string;
  assetPreviewRefreshKey: number;
  /** Bumped when files appear outside Explorer actions (for example a saved export ZIP). */
  explorerRevision: number;

  // Caption tool header actions
  taggingToolbar: {
    visible: boolean;
  };

  taggingModals: {
    datasetTags: boolean;
    settings: boolean;
  };
  
  // Notifications
  notifications: Array<{
    id: string;
    type: 'info' | 'success' | 'error' | 'warning';
    message: string;
    timestamp: Date;
  }>;

  operationLogs: Array<{
    id: string;
    level: 'info' | 'warning' | 'error' | 'success';
    message: string;
    timestamp: Date;
  }>;
}

interface UIActions {
  // Selection
  toggleSourceImageSelection: (id: string) => void;
  toggleDatasetItemSelection: (id: string) => void;
  clearSourceImageSelection: () => void;
  clearDatasetItemSelection: () => void;
  setHoveredImageId: (id?: string) => void;
  
  // View
  setDarkMode: (dark: boolean) => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  toggleDarkMode: () => void;
  
  // UI
  setShowSettings: (show: boolean) => void;
  setShowHelp: (show: boolean) => void;

  // Project directory session
  setProjectDirectory: (directory?: { handle?: ProjectDirectoryHandle; name?: string }) => void;
  refreshAssetPreviews: () => void;
  requestExplorerRefresh: () => void;

  // Edit tool header actions
  setTaggingToolbar: (toolbar: Partial<UIState['taggingToolbar']>) => void;
  setTaggingModal: (modal: Partial<UIState['taggingModals']>) => void;
  
  // Notifications
  addNotification: (type: UIState['notifications'][0]['type'], message: string) => void;
  removeNotification: (id: string) => void;

  // Operation log
  addOperationLog: (level: UIState['operationLogs'][0]['level'], message: string) => void;
  clearOperationLogs: () => void;
}

export const useUIStore = create<UIState & UIActions>((set, get) => ({
  selectedSourceImageIds: new Set(),
  selectedDatasetItemIds: new Set(),
  hoveredImageId: undefined,
  darkMode: true,
  viewMode: 'grid',
  showSettings: false,
  showHelp: false,
  projectDirectoryHandle: undefined,
  projectDirectoryName: undefined,
  assetPreviewRefreshKey: 0,
  explorerRevision: 0,

  taggingToolbar: {
    visible: false,
  },
  taggingModals: {
    datasetTags: false,
    settings: false,
  },
  notifications: [],
  operationLogs: [
    {
      id: 'session-start',
      level: 'success',
      message: 'Workspace ready',
      timestamp: new Date(),
    },
  ],
  
  toggleSourceImageSelection: (id: string) =>
    set((state) => {
      const newSet = new Set(state.selectedSourceImageIds);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return { selectedSourceImageIds: newSet };
    }),
  
  toggleDatasetItemSelection: (id: string) =>
    set((state) => {
      const newSet = new Set(state.selectedDatasetItemIds);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return { selectedDatasetItemIds: newSet };
    }),
  
  clearSourceImageSelection: () =>
    set({ selectedSourceImageIds: new Set() }),
  
  clearDatasetItemSelection: () =>
    set({ selectedDatasetItemIds: new Set() }),
  
  setHoveredImageId: (id?: string) =>
    set({ hoveredImageId: id }),
  
  setDarkMode: (dark: boolean) =>
    set({ darkMode: dark }),
  
  setViewMode: (mode: 'grid' | 'list') =>
    set({ viewMode: mode }),
  
  toggleDarkMode: () =>
    set((state) => ({ darkMode: !state.darkMode })),
  
  setShowSettings: (show: boolean) =>
    set({ showSettings: show }),
  
  setShowHelp: (show: boolean) =>
    set({ showHelp: show }),

  setProjectDirectory: (directory) =>
    set({
      projectDirectoryHandle: directory?.handle,
      projectDirectoryName: directory?.name,
    }),

  requestExplorerRefresh: () => set((state) => ({ explorerRevision: state.explorerRevision + 1 })),
  refreshAssetPreviews: () =>
    set((state) => ({ assetPreviewRefreshKey: state.assetPreviewRefreshKey + 1 })),

  setTaggingToolbar: (toolbar) =>
    set((state) => {
      const nextToolbar = {
        ...state.taggingToolbar,
        ...toolbar,
      };

      if (state.taggingToolbar.visible === nextToolbar.visible) {
        return state;
      }

      return { taggingToolbar: nextToolbar };
    }),

  setTaggingModal: (modal) =>
    set((state) => {
      const nextModals = {
        ...state.taggingModals,
        ...modal,
      };

      if (
        state.taggingModals.datasetTags === nextModals.datasetTags &&
        state.taggingModals.settings === nextModals.settings
      ) {
        return state;
      }

      return { taggingModals: nextModals };
    }),
  
  addNotification: (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    set((state) => ({
      notifications: [
        ...state.notifications,
        { id, type, message, timestamp: new Date() },
      ],
    }));

    const duration = type === 'error' || type === 'warning' ? 8000 : 4000;
    window.setTimeout(() => get().removeNotification(id), duration);
  },
  
  removeNotification: (id: string) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  addOperationLog: (level, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    set((state) => ({
      operationLogs: [
        ...state.operationLogs.slice(-999),
        { id, level, message, timestamp: new Date() },
      ],
    }));
  },

  clearOperationLogs: () => set({ operationLogs: [] }),
}));
