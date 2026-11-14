import { PROJECT_TYPE_PROFILES, resolveTargetModel } from '../lib/projectProfiles';
import type { ProjectType, TargetModelId } from '../types';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  ProjectState,
  SourceImage,
  EditedAsset,
  ToolName,
  TaggingConfig,
  WorkspaceSettings,
  BuildSession,
  createProject,
  createDataset,
  CleanupOverlay,
  Dataset,
} from '../types';
import { OBJECT_STORES } from '../lib/constants';
import { dbBatchPut, dbDelete, dbGetAll, dbPut } from '../services/persistence/indexedDBService';
import { snapshotFileIfNeeded } from '../services/project/fileSnapshotService';
import { isLegacyProjectRootPath } from '../services/project/projectPathFilters';
import { migrateLegacyCaptions } from '../services/caption/captionMigrationService';

const revokePreviewUrl = (previewUrl: string | undefined) => {
  if (!previewUrl) {
    return;
  }

  try {
    URL.revokeObjectURL(previewUrl);
  } catch (error) {
    console.warn('Failed to revoke preview URL', error);
  }
};

const stripEditedAssetPreviewUrl = (item: EditedAsset): EditedAsset => ({
  ...item,
  previewUrl: undefined,
});

const isLegacyDatasetItem = (item: EditedAsset): boolean =>
  [item.manifestPath, item.imageDataPath, item.psdDataPath]
    .filter((path): path is string => Boolean(path))
    .some((path) => isLegacyProjectRootPath(path));

type LegacyDatasetState = Dataset & {
  parentPath?: string; filePath?: string; assetIds?: string[]; assetPaths?: string[]; psdAssetPaths?: string[];
  overwriteCaptions?: boolean; captionOverrides?: Record<string, string[]>;
};
const normalizeDataset = (dataset: LegacyDatasetState): Dataset => {
  const { parentPath: _parentPath, filePath: _filePath, assetIds: _assetIds, assetPaths: _assetPaths,
    psdAssetPaths: _psdAssetPaths, overwriteCaptions: _overwriteCaptions, captionOverrides: _captionOverrides, ...current } = dataset;
  return {
    ...current,
    assetOrder: [...new Set(dataset.assetOrder ?? [])],
  };
};

interface ProjectStore extends ProjectState {
  // Project management
  initializeProject: (name: string, projectType: ProjectType, targetModel?: TargetModelId) => void;
  setProjectProfile: (profile: { projectType?: ProjectType; targetModel?: TargetModelId }) => void;
  loadProject: (project: ProjectState) => void;
  renameProject: (name: string) => void;
  setCurrentTool: (tool: ToolName) => void;
  
  // Source images
  addSourceImage: (image: SourceImage) => void;
  addSourceImages: (images: SourceImage[]) => void;
  hydrateSourceImages: () => Promise<void>;
  removeSourceImage: (id: string) => void;
  updateSourceImage: (id: string, updates: Partial<SourceImage>) => void;
  getSourceImages: () => SourceImage[];

  // Datasets
  updateDataset: (id: string, updates: Partial<Pick<Dataset, 'name' | 'triggerWord' | 'assetOrder'>>) => void;
  
  // Edited image variants
  addDatasetItem: (item: EditedAsset) => void;
  hydrateDatasetItems: () => Promise<void>;
  removeDatasetItem: (id: string) => void;
  updateDatasetItem: (id: string, updates: Partial<EditedAsset>) => void;
  softDeleteDatasetItem: (id: string) => void;
  getDatasetItems: (includeDeleted?: boolean) => EditedAsset[];
  
  // Cleanup overlays
  addCleanupOverlay: (overlay: CleanupOverlay) => void;
  updateCleanupOverlay: (id: string, updates: Partial<CleanupOverlay>) => void;
  removeCleanupOverlay: (id: string) => void;
  
  // Tool runtime state
  setToolState: (tool: ToolName, state: unknown) => void;
  getToolState: (tool: ToolName) => unknown;
  
  // Tagging
  updateTaggingConfig: (updates: Partial<TaggingConfig>) => void;

  // Workspace settings
  updateWorkspaceSettings: (updates: Partial<WorkspaceSettings>) => void;
  updateBuildSession: (session: BuildSession | ((current: BuildSession) => BuildSession)) => void;
}

export const useProjectStore = create<ProjectStore>()(
  devtools(
      (set, get) => ({
        ...createProject('Untitled Project', 'general'),
        
        initializeProject: (name: string, projectType: ProjectType, targetModel?: TargetModelId) =>
          set((state) => {
            for (const image of Object.values(state.sourceImages)) {
              revokePreviewUrl(image.previewUrl);
            }
            for (const item of Object.values(state.datasetItems)) {
              revokePreviewUrl(item.previewUrl);
            }

            return createProject(name, projectType, targetModel);
          }),

        loadProject: (project: ProjectState) =>
          set((state) => {
            for (const image of Object.values(state.sourceImages)) {
              revokePreviewUrl(image.previewUrl);
            }
            for (const item of Object.values(state.datasetItems)) {
              revokePreviewUrl(item.previewUrl);
            }

            const defaults = createProject(project.name, project.projectType);
            const supportedDatasetItems = Object.fromEntries(
              Object.entries(project.datasetItems ?? {}).filter(([, item]) => !isLegacyDatasetItem(item))
            );
            for (const [id, item] of Object.entries(project.datasetItems ?? {})) {
              if (isLegacyDatasetItem(item)) {
                void dbDelete(OBJECT_STORES.DATASET_ITEMS, id);
              }
            }

            const legacyDatasets = (project as ProjectState & { datasets?: Record<string, Dataset> }).datasets;
            const fallbackDataset = Object.values(legacyDatasets ?? {})[0] ?? createDataset(project.name);
            const legacyDatasetState = (project.dataset ?? fallbackDataset) as LegacyDatasetState;
            const dataset = normalizeDataset(legacyDatasetState);
            const legacyDatasetForCaption = {
              ...dataset,
              assetIds: legacyDatasetState.assetIds ?? [],
              assetPaths: legacyDatasetState.assetPaths ?? [],
              psdAssetPaths: legacyDatasetState.psdAssetPaths ?? [],
            };
            const migrated = project.captionMigration ? null : migrateLegacyCaptions({
              legacy: legacyDatasetState,
              dataset: legacyDatasetForCaption,
              sourceImages: project.sourceImages ?? {},
              datasetItems: supportedDatasetItems,
              pathAssets: [...legacyDatasetForCaption.assetPaths, ...legacyDatasetForCaption.psdAssetPaths].map((path) => ({ path, available: false })),
            });
            return {
              ...defaults,
              ...project,
              targetModel: resolveTargetModel(project.targetModel),
              sourceImages: migrated?.sourceImages ?? project.sourceImages,
              datasetItems: migrated?.datasetItems ?? supportedDatasetItems,
              dataset,
              captionMigration: project.captionMigration ?? migrated?.report,
              workspaceSettings: {
                ...defaults.workspaceSettings,
                ...project.workspaceSettings,
              },
              buildSession: project.buildSession ?? defaults.buildSession,
              lastModified: new Date(),
            };
          }),

        setProjectProfile: ({ projectType, targetModel }) =>
          set((state) => ({
            ...state,
            ...(projectType ? { projectType } : {}),
            ...(targetModel ? { targetModel } : {}),
            lastModified: new Date(),
          })),

        renameProject: (name: string) =>
          set((state) => ({
            ...state,
            name,
            lastModified: new Date(),
          })),
        
        setCurrentTool: (tool: ToolName) =>
          set((state) => ({
            ...state,
            currentTool: PROJECT_TYPE_PROFILES[state.projectType].enabledTools.includes(tool) ? tool : state.currentTool,
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

          const hydratedImages = await Promise.all(
            storedImages.map(async (image) => {
              const originalFile = await snapshotFileIfNeeded(image.originalFile);
              return {
                ...image,
                originalFile,
                previewUrl: URL.createObjectURL(originalFile),
              };
            })
          );

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
            revokePreviewUrl(imageToRemove?.previewUrl);
            for (const item of Object.values(state.datasetItems)) {
              if (item.sourceImageId === id) {
                revokePreviewUrl(item.previewUrl);
              }
            }

            const { [id]: _, ...rest } = state.sourceImages;
            const remainingDatasetItems = Object.fromEntries(
              Object.entries(state.datasetItems).filter(([, item]) => item.sourceImageId !== id)
            );
            const dataset = {
              ...state.dataset,
              assetOrder: (state.dataset.assetOrder ?? []).filter((key) => key !== `image:${id}`),
              updatedAt: new Date(),
            };
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
              dataset,
              lastModified: new Date(),
            };
          }),
        
        updateSourceImage: (id: string, updates: Partial<SourceImage>) =>
          set((state) => {
            const currentImage = state.sourceImages[id];
            if (!currentImage) {
              return state;
            }
            const originalFileChanged =
              updates.originalFile !== undefined && updates.originalFile !== currentImage.originalFile;
            const previewUrlChanged =
              updates.previewUrl !== undefined && updates.previewUrl !== currentImage.previewUrl;
            if ((originalFileChanged || previewUrlChanged) && currentImage.previewUrl) {
              revokePreviewUrl(currentImage.previewUrl);
            }
            const updatedImage = {
              ...currentImage,
              ...updates,
              previewUrl: originalFileChanged && updates.previewUrl === undefined ? undefined : updates.previewUrl ?? currentImage.previewUrl,
            };
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

        updateDataset: (_id, updates) =>
          set((state) => {
            const dataset = state.dataset;
            return {
              ...state,
              dataset: {
                ...dataset,
                ...updates,
                id: 'global',
                assetOrder: [...new Set(updates.assetOrder ?? dataset.assetOrder)],
                updatedAt: new Date(),
              },
              lastModified: new Date(),
            };
          }),

        addDatasetItem: (item: EditedAsset) =>
          set((state) => {
            void dbPut(OBJECT_STORES.DATASET_ITEMS, stripEditedAssetPreviewUrl(item));

            return {
              ...state,
              datasetItems: { ...state.datasetItems, [item.id]: item },
              lastModified: new Date(),
            };
          }),

        hydrateDatasetItems: async () => {
          const storedItems = await dbGetAll<EditedAsset>(OBJECT_STORES.DATASET_ITEMS);
          const currentSourceIds = new Set(Object.keys(get().sourceImages));
          const supportedItems = storedItems.filter(
            (item) => !isLegacyDatasetItem(item) && currentSourceIds.has(item.sourceImageId)
          );
          await Promise.all(
            storedItems
              .filter((item) => !supportedItems.includes(item))
              .map((item) => dbDelete(OBJECT_STORES.DATASET_ITEMS, item.id))
          );

          if (supportedItems.length === 0) {
            return;
          }

          set((state) => ({
            ...state,
            datasetItems: {
              ...state.datasetItems,
              ...Object.fromEntries(supportedItems.map((item) => [item.id, stripEditedAssetPreviewUrl(item)])),
            },
            lastModified: new Date(),
          }));
        },
        
        removeDatasetItem: (id: string) =>
          set((state) => {
            revokePreviewUrl(state.datasetItems[id]?.previewUrl);
            const { [id]: _, ...rest } = state.datasetItems;
            void dbDelete(OBJECT_STORES.DATASET_ITEMS, id);
            return { ...state, datasetItems: rest, lastModified: new Date() };
          }),
        
        updateDatasetItem: (id: string, updates: Partial<EditedAsset>) =>
          set((state) => {
            const currentItem = state.datasetItems[id];
            if (!currentItem) {
              return state;
            }
            const imageDataChanged = updates.imageData !== undefined && updates.imageData !== currentItem.imageData;
            const previewUrlChanged = updates.previewUrl !== undefined && updates.previewUrl !== currentItem.previewUrl;
            if ((imageDataChanged || previewUrlChanged) && currentItem.previewUrl) {
              revokePreviewUrl(currentItem.previewUrl);
            }
            const updatedItem = {
              ...currentItem,
              ...updates,
              previewUrl: imageDataChanged && updates.previewUrl === undefined ? undefined : updates.previewUrl ?? currentItem.previewUrl,
            };
            void dbPut(OBJECT_STORES.DATASET_ITEMS, stripEditedAssetPreviewUrl(updatedItem));

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
            void dbPut(OBJECT_STORES.DATASET_ITEMS, stripEditedAssetPreviewUrl(updatedItem));

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
        
        setToolState: (tool: ToolName, toolState: unknown) =>
          set((state) => ({
            ...state,
            toolState: { ...state.toolState, [tool]: toolState },
            lastModified: new Date(),
          })),
        
        getToolState: (tool: ToolName) => get().toolState[tool],
        
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

        updateBuildSession: (session) =>
          set((state) => ({
            ...state,
            buildSession: typeof session === 'function' ? session(state.buildSession) : session,
            lastModified: new Date(),
          })),
      })
  )
);
