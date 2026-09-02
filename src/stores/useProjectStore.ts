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
  createDataset,
  CleanupOverlay,
  Dataset,
} from '../types';
import { OBJECT_STORES } from '../lib/constants';
import { createDatasetImageAssetKey, normalizeDatasetAssetOrder } from '../lib/datasetAssets';
import { dbBatchPut, dbDelete, dbGetAll, dbPut } from '../services/persistence/indexedDBService';
import { snapshotFileIfNeeded } from '../services/project/fileSnapshotService';
import { filterLegacyProjectAssetPaths, isLegacyProjectRootPath } from '../services/project/projectPathFilters';

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

const stripSyntheticPreviewUrl = (item: SyntheticImage): SyntheticImage => ({
  ...item,
  previewUrl: undefined,
});

const isLegacyDatasetItem = (item: SyntheticImage): boolean =>
  [item.manifestPath, item.imageDataPath, item.psdDataPath]
    .filter((path): path is string => Boolean(path))
    .some((path) => isLegacyProjectRootPath(path));

const getPsdAssetPaths = (assetPaths: string[]): string[] =>
  filterLegacyProjectAssetPaths(assetPaths).filter((path) => path.toLowerCase().endsWith('.psd'));

const normalizeDataset = (dataset: Dataset): Dataset => {
  const assetIds = [...new Set(dataset.assetIds ?? [])];
  const assetPaths = filterLegacyProjectAssetPaths([...new Set([...(dataset.assetPaths ?? []), ...(dataset.psdAssetPaths ?? [])])]);
  const psdAssetPaths = filterLegacyProjectAssetPaths([
    ...new Set([...(dataset.psdAssetPaths ?? []), ...getPsdAssetPaths(assetPaths)]),
  ]);
  return {
    ...dataset,
    assetIds,
    assetPaths,
    psdAssetPaths,
    assetOrder: normalizeDatasetAssetOrder(dataset.assetOrder, assetIds, assetPaths),
    overwriteCaptions: dataset.overwriteCaptions ?? false,
    captionOverrides: dataset.captionOverrides ?? {},
  };
};

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

  // Datasets
  createDataset: (name?: string) => Dataset;
  upsertDataset: (dataset: Dataset) => void;
  updateDataset: (id: string, updates: Partial<Pick<Dataset, 'name' | 'parentPath' | 'filePath' | 'triggerWord' | 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'assetOrder' | 'overwriteCaptions' | 'captionOverrides'>>) => void;
  removeDataset: (id: string) => void;
  addAssetsToDataset: (id: string, assetIds: string[]) => void;
  
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
              revokePreviewUrl(image.previewUrl);
            }
            for (const item of Object.values(state.datasetItems)) {
              revokePreviewUrl(item.previewUrl);
            }

            return createProject(name);
          }),

        loadProject: (project: ProjectState) =>
          set((state) => {
            for (const image of Object.values(state.sourceImages)) {
              revokePreviewUrl(image.previewUrl);
            }
            for (const item of Object.values(state.datasetItems)) {
              revokePreviewUrl(item.previewUrl);
            }

            const defaults = createProject(project.name);
            const supportedDatasetItems = Object.fromEntries(
              Object.entries(project.datasetItems ?? {}).filter(([, item]) => !isLegacyDatasetItem(item))
            );
            for (const [id, item] of Object.entries(project.datasetItems ?? {})) {
              if (isLegacyDatasetItem(item)) {
                void dbDelete(OBJECT_STORES.DATASET_ITEMS, id);
              }
            }

            return {
              ...defaults,
              ...project,
              datasetItems: supportedDatasetItems,
              datasets: Object.fromEntries(
                Object.entries(project.datasets ?? {}).map(([id, dataset]) => [
                  id,
                  normalizeDataset(dataset),
                ])
              ),
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
            const datasets = Object.fromEntries(
              Object.entries(state.datasets).map(([datasetId, dataset]) => {
                const assetIds = dataset.assetIds.filter((assetId) => assetId !== id);
                return [
                  datasetId,
                  {
                  ...dataset,
                  assetIds,
                  assetOrder: normalizeDatasetAssetOrder(
                    (dataset.assetOrder ?? []).filter((key) => key !== createDatasetImageAssetKey(id)),
                    assetIds,
                    dataset.assetPaths
                  ),
                  updatedAt: new Date(),
                },
                ];
              })
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
              datasets,
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

        createDataset: (name = 'New Dataset') => {
          const dataset = createDataset(name);
          set((state) => ({
            ...state,
            datasets: {
              ...state.datasets,
              [dataset.id]: dataset,
            },
            lastModified: new Date(),
          }));
          return dataset;
        },

        upsertDataset: (dataset) =>
          set((state) => ({
            ...state,
            datasets: {
              ...state.datasets,
              [dataset.id]: normalizeDataset(dataset),
            },
            lastModified: new Date(),
          })),

        updateDataset: (id, updates) =>
          set((state) => {
            const dataset = state.datasets[id];
            if (!dataset) {
              return state;
            }

            const assetIds = updates.assetIds ? [...new Set(updates.assetIds)] : dataset.assetIds;
            const assetPaths = updates.assetPaths
              ? filterLegacyProjectAssetPaths([...new Set(updates.assetPaths)])
              : filterLegacyProjectAssetPaths(dataset.assetPaths);
            const psdAssetPaths = updates.psdAssetPaths
              ? filterLegacyProjectAssetPaths([...new Set(updates.psdAssetPaths)])
              : updates.assetPaths
                ? getPsdAssetPaths(updates.assetPaths)
                : filterLegacyProjectAssetPaths(dataset.psdAssetPaths);
            const normalizedPsdAssetPaths = filterLegacyProjectAssetPaths([
              ...new Set([...psdAssetPaths, ...getPsdAssetPaths(assetPaths)]),
            ]);

            return {
              ...state,
              datasets: {
                ...state.datasets,
                [id]: {
                  ...dataset,
                  ...updates,
                  assetIds,
                  assetPaths,
                  psdAssetPaths: normalizedPsdAssetPaths,
                  assetOrder: normalizeDatasetAssetOrder(updates.assetOrder ?? dataset.assetOrder, assetIds, assetPaths),
                  overwriteCaptions: updates.overwriteCaptions ?? dataset.overwriteCaptions ?? false,
                  captionOverrides: updates.captionOverrides ?? dataset.captionOverrides ?? {},
                  updatedAt: new Date(),
                },
              },
              lastModified: new Date(),
            };
          }),

        removeDataset: (id) =>
          set((state) => {
            const { [id]: _, ...datasets } = state.datasets;
            return {
              ...state,
              datasets,
              lastModified: new Date(),
            };
          }),

        addAssetsToDataset: (id, assetIds) =>
          set((state) => {
            const dataset = state.datasets[id];
            if (!dataset) {
              return state;
            }
            const existingAssetIds = new Set(Object.keys(state.sourceImages));
            const nextAssetIds = [
              ...new Set([
                ...dataset.assetIds,
                ...assetIds.filter((assetId) => existingAssetIds.has(assetId)),
              ]),
            ];
            const nextAssetOrder = normalizeDatasetAssetOrder(
              [
                ...(dataset.assetOrder ?? []),
                ...nextAssetIds.map(createDatasetImageAssetKey),
              ],
              nextAssetIds,
              dataset.assetPaths
            );
            return {
              ...state,
              datasets: {
                ...state.datasets,
                [id]: {
                  ...dataset,
                  assetIds: nextAssetIds,
                  assetOrder: nextAssetOrder,
                  updatedAt: new Date(),
                },
              },
              lastModified: new Date(),
            };
          }),
        
        addDatasetItem: (item: SyntheticImage) =>
          set((state) => {
            void dbPut(OBJECT_STORES.DATASET_ITEMS, stripSyntheticPreviewUrl(item));

            return {
              ...state,
              datasetItems: { ...state.datasetItems, [item.id]: item },
              lastModified: new Date(),
            };
          }),

        hydrateDatasetItems: async () => {
          const storedItems = await dbGetAll<SyntheticImage>(OBJECT_STORES.DATASET_ITEMS);
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
              ...Object.fromEntries(supportedItems.map((item) => [item.id, stripSyntheticPreviewUrl(item)])),
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
        
        updateDatasetItem: (id: string, updates: Partial<SyntheticImage>) =>
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
            void dbPut(OBJECT_STORES.DATASET_ITEMS, stripSyntheticPreviewUrl(updatedItem));

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
            void dbPut(OBJECT_STORES.DATASET_ITEMS, stripSyntheticPreviewUrl(updatedItem));

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
