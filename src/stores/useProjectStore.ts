import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  ProjectState,
  SourceImage,
  SyntheticImage,
  StageName,
  TaggingConfig,
  WorkspaceSettings,
  createProject,
  CleanupOverlay,
} from '../types';
import { OBJECT_STORES } from '../lib/constants';
import { dbBatchPut, dbDelete, dbGetAll, dbPut } from '../services/persistence/indexedDBService';

interface ProjectStore extends ProjectState {
  // Project management
  initializeProject: (name: string) => void;
  loadProject: (project: ProjectState) => void;
  renameProject: (name: string) => void;
  setCurrentStage: (stage: StageName) => void;
  
  // Source images
  addSourceImage: (image: SourceImage) => void;
  addSourceImages: (images: SourceImage[]) => void;
  hydrateSourceImages: () => Promise<void>;
  removeSourceImage: (id: string) => void;
  updateSourceImage: (id: string, updates: Partial<SourceImage>) => void;
  getSourceImages: () => SourceImage[];
  
  // Synthetic images
  addDatasetItem: (item: SyntheticImage) => void;
  hydrateDatasetItems: () => Promise<void>;
  removeDatasetItem: (id: string) => void;
  updateDatasetItem: (id: string, updates: Partial<SyntheticImage>) => void;
  softDeleteDatasetItem: (id: string) => void;
  getDatasetItems: (includeDeleted?: boolean) => SyntheticImage[];
  
  // Cleanup overlays
  addCleanupOverlay: (overlay: CleanupOverlay) => void;
  updateCleanupOverlay: (id: string, updates: Partial<CleanupOverlay>) => void;
  removeCleanupOverlay: (id: string) => void;
  
  // Stage state
  setStageState: (stage: StageName, state: unknown) => void;
  getStageState: (stage: StageName) => unknown;
  
  // Tagging
  updateTaggingConfig: (updates: Partial<TaggingConfig>) => void;

  // Workspace settings
  updateWorkspaceSettings: (updates: Partial<WorkspaceSettings>) => void;
}

export const useProjectStore = create<ProjectStore>()(
  devtools(
      (set, get) => ({
        ...createProject('Untitled Project'),
        
        initializeProject: (name: string) =>
          set((state) => {
            for (const image of Object.values(state.sourceImages)) {
              if (image.previewUrl) {
                try {
                  URL.revokeObjectURL(image.previewUrl);
                } catch (error) {
                  console.warn('Failed to revoke preview URL', error);
                }
              }
            }

            return createProject(name);
          }),

        loadProject: (project: ProjectState) =>
          set((state) => {
            for (const image of Object.values(state.sourceImages)) {
              if (image.previewUrl) {
                try {
                  URL.revokeObjectURL(image.previewUrl);
                } catch (error) {
                  console.warn('Failed to revoke preview URL', error);
                }
              }
            }

            const defaults = createProject(project.name);

            return {
              ...defaults,
              ...project,
              workspaceSettings: {
                ...defaults.workspaceSettings,
                ...project.workspaceSettings,
              },
              lastModified: new Date(),
            };
          }),

        renameProject: (name: string) =>
          set((state) => ({
            ...state,
            name,
            lastModified: new Date(),
          })),
        
        setCurrentStage: (stage: StageName) =>
          set((state) => ({
            ...state,
            currentStage: stage,
            lastModified: new Date(),
          })),
        
        addSourceImage: (image: SourceImage) =>
          set((state) => {
            void dbPut(OBJECT_STORES.SOURCE_IMAGES, {
              ...image,
              previewUrl: undefined,
            });

            return {
              ...state,
              sourceImages: { ...state.sourceImages, [image.id]: image },
              lastModified: new Date(),
            };
          }),

        addSourceImages: (images: SourceImage[]) =>
          set((state) => {
            void dbBatchPut(
              OBJECT_STORES.SOURCE_IMAGES,
              images.map((image) => ({
                ...image,
                previewUrl: undefined,
              }))
            );

            return {
              ...state,
              sourceImages: {
                ...state.sourceImages,
                ...Object.fromEntries(images.map((image) => [image.id, image])),
              },
              lastModified: new Date(),
            };
          }),

        hydrateSourceImages: async () => {
          const storedImages = await dbGetAll<SourceImage>(OBJECT_STORES.SOURCE_IMAGES);

          if (storedImages.length === 0) {
            return;
          }

          const hydratedImages = storedImages.map((image) => ({
            ...image,
            previewUrl: URL.createObjectURL(image.originalFile),
          }));

          set((state) => ({
            ...state,
            sourceImages: {
              ...state.sourceImages,
              ...Object.fromEntries(hydratedImages.map((image) => [image.id, image])),
            },
            lastModified: new Date(),
          }));
        },
        
        removeSourceImage: (id: string) =>
          set((state) => {
            const imageToRemove = state.sourceImages[id];
            if (imageToRemove?.previewUrl) {
              try {
                URL.revokeObjectURL(imageToRemove.previewUrl);
              } catch (error) {
                console.warn('Failed to revoke preview URL', error);
              }
            }

            const { [id]: _, ...rest } = state.sourceImages;
            const remainingDatasetItems = Object.fromEntries(
              Object.entries(state.datasetItems).filter(([, item]) => item.sourceImageId !== id)
            );
            void dbDelete(OBJECT_STORES.SOURCE_IMAGES, id);
            for (const item of Object.values(state.datasetItems)) {
              if (item.sourceImageId === id) {
                void dbDelete(OBJECT_STORES.DATASET_ITEMS, item.id);
              }
            }
            return {
              ...state,
              sourceImages: rest,
              datasetItems: remainingDatasetItems,
              lastModified: new Date(),
            };
          }),
        
        updateSourceImage: (id: string, updates: Partial<SourceImage>) =>
          set((state) => {
            const updatedImage = { ...state.sourceImages[id], ...updates };
            void dbPut(OBJECT_STORES.SOURCE_IMAGES, {
              ...updatedImage,
              previewUrl: undefined,
            });

            return {
              ...state,
              sourceImages: {
                ...state.sourceImages,
                [id]: updatedImage,
              },
              lastModified: new Date(),
            };
          }),
        
        getSourceImages: () => Object.values(get().sourceImages),
        
        addDatasetItem: (item: SyntheticImage) =>
          set((state) => {
            void dbPut(OBJECT_STORES.DATASET_ITEMS, item);

            return {
              ...state,
              datasetItems: { ...state.datasetItems, [item.id]: item },
              lastModified: new Date(),
            };
          }),

        hydrateDatasetItems: async () => {
          const storedItems = await dbGetAll<SyntheticImage>(OBJECT_STORES.DATASET_ITEMS);

          if (storedItems.length === 0) {
            return;
          }

          set((state) => ({
            ...state,
            datasetItems: {
              ...state.datasetItems,
              ...Object.fromEntries(storedItems.map((item) => [item.id, item])),
            },
            lastModified: new Date(),
          }));
        },
        
        removeDatasetItem: (id: string) =>
          set((state) => {
            const { [id]: _, ...rest } = state.datasetItems;
            void dbDelete(OBJECT_STORES.DATASET_ITEMS, id);
            return { ...state, datasetItems: rest, lastModified: new Date() };
          }),
        
        updateDatasetItem: (id: string, updates: Partial<SyntheticImage>) =>
          set((state) => {
            const updatedItem = { ...state.datasetItems[id], ...updates };
            void dbPut(OBJECT_STORES.DATASET_ITEMS, updatedItem);

            return {
              ...state,
              datasetItems: {
                ...state.datasetItems,
                [id]: updatedItem,
              },
              lastModified: new Date(),
            };
          }),
        
        softDeleteDatasetItem: (id: string) =>
          set((state) => {
            if (!state.datasetItems[id]) {
              return state;
            }
            const updatedItem = {
              ...state.datasetItems[id],
              deleted: true,
              deletedAt: new Date(),
            };
            void dbPut(OBJECT_STORES.DATASET_ITEMS, updatedItem);

            return {
              ...state,
              datasetItems: {
                ...state.datasetItems,
                [id]: updatedItem,
              },
              lastModified: new Date(),
            };
          }),
        
        getDatasetItems: (includeDeleted = false) => {
          const items = Object.values(get().datasetItems);
          return includeDeleted ? items : items.filter((item) => !item.deleted);
        },
        
        addCleanupOverlay: (overlay: CleanupOverlay) =>
          set((state) => ({
            ...state,
            cleanupOverlays: { ...state.cleanupOverlays, [overlay.id]: overlay },
          })),
        
        updateCleanupOverlay: (id: string, updates: Partial<CleanupOverlay>) =>
          set((state) => ({
            ...state,
            cleanupOverlays: {
              ...state.cleanupOverlays,
              [id]: { ...state.cleanupOverlays[id], ...updates },
            },
          })),
        
        removeCleanupOverlay: (id: string) =>
          set((state) => {
            const { [id]: _, ...rest } = state.cleanupOverlays;
            return { ...state, cleanupOverlays: rest };
          }),
        
        setStageState: (stage: StageName, stageState: unknown) =>
          set((state) => ({
            ...state,
            stageState: { ...state.stageState, [stage]: stageState },
            lastModified: new Date(),
          })),
        
        getStageState: (stage: StageName) => get().stageState[stage],
        
        updateTaggingConfig: (updates: Partial<any>) =>
          set((state) => ({
            ...state,
            taggingConfig: { ...state.taggingConfig, ...updates },
            lastModified: new Date(),
          })),

        updateWorkspaceSettings: (updates: Partial<WorkspaceSettings>) =>
          set((state) => ({
            ...state,
            workspaceSettings: { ...state.workspaceSettings, ...updates },
            lastModified: new Date(),
          })),
      })
  )
);
