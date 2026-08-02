import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import {
  applyAugmentation,
  generateAugmentationConfigs,
  generateSeedFromImage,
} from '../../services/augmentation/augmentationService';
import { createSyntheticImage, type AspectRatio, type AugmentationConfig } from '../../types';
import {
  WORKSPACE_KIND_STYLES,
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameStyle,
  toWorkspaceImages,
} from '../../lib/workspaceImages';

type CleanupWorkingEdit = {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
};

type CleanupStageState = {
  workingEdits?: Record<string, CleanupWorkingEdit>;
};

type PreviewCacheEntry = { blob: Blob; url: string };

type AugmentStageState = {
  selectedType?: AugmentationConfig['type'];
  configsByType?: Partial<Record<AugmentationConfig['type'], AugmentationConfig>>;
};

type AugmentCandidate = {
  key: string;
  displayIdentity: string;
  label: string;
  kind: 'source' | 'synthetic';
  blob: Blob;
  previewUrl?: string;
  width: number;
  height: number;
  aspectRatio: AspectRatio;
  sourceImageId: string;
  syntheticImageId?: string;
  syntheticType?: string;
};

const TYPE_LABELS: Record<AugmentationConfig['type'], string> = {
  flip_h: 'Flip H',
  flip_v: 'Flip V',
  color: 'Gradient',
  rotate: 'Rotate',
};

const getDefaultConfig = (type: AugmentationConfig['type']): AugmentationConfig => {
  switch (type) {
    case 'flip_h':
      return { type: 'flip_h' };
    case 'flip_v':
      return { type: 'flip_v' };
    case 'color':
      return { type: 'color' };
    case 'rotate':
      return {
        type: 'rotate',
        rotationDegrees: 15,
        rotationVariants: 3,
      };
  }
};

export const AugmentationStage = () => {
  const sourceImages = useProjectStore((state) => Object.values(state.sourceImages));
  const datasetItems = useProjectStore((state) =>
    Object.values(state.datasetItems).filter((item) => !item.deleted)
  );
  const addDatasetItem = useProjectStore((state) => state.addDatasetItem);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const softDeleteDatasetItem = useProjectStore((state) => state.softDeleteDatasetItem);
  const setStageState = useProjectStore((state) => state.setStageState);
  const cleanupStageState = useProjectStore(
    (state) => (state.stageState.clean as CleanupStageState | undefined) ?? {}
  );
  const augmentStageState = useProjectStore(
    (state) => (state.stageState.augment as AugmentStageState | undefined) ?? {}
  );
  const { addNotification } = useUIStore();

  const [selectedImageKey, setSelectedImageKey] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [syntheticPreviewUrls, setSyntheticPreviewUrls] = useState<Record<string, string>>({});
  const syntheticPreviewCacheRef = useRef<Record<string, PreviewCacheEntry>>({});

  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, datasetItems, cleanupStageState.workingEdits),
    [cleanupStageState.workingEdits, datasetItems, sourceImages]
  );

  useEffect(() => {
    setSyntheticPreviewUrls((previous) => {
      const next: Record<string, string> = {};
      const activeIds = new Set(datasetItems.map((item) => item.id));

      for (const item of datasetItems) {
        const cached = syntheticPreviewCacheRef.current[item.id];
        if (cached && cached.blob === item.imageData) {
          next[item.id] = cached.url;
          continue;
        }

        if (cached) {
          URL.revokeObjectURL(cached.url);
        }

        const url = URL.createObjectURL(item.imageData);
        syntheticPreviewCacheRef.current[item.id] = { blob: item.imageData, url };
        next[item.id] = url;
      }

      for (const [id, cached] of Object.entries(syntheticPreviewCacheRef.current)) {
        if (activeIds.has(id)) {
          continue;
        }
        URL.revokeObjectURL(cached.url);
        delete syntheticPreviewCacheRef.current[id];
      }

      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      const changed =
        previousKeys.length !== nextKeys.length ||
        nextKeys.some((id) => previous[id] !== next[id]);

      return changed ? next : previous;
    });
  }, [datasetItems]);

  useEffect(() => {
    return () => {
      Object.values(syntheticPreviewCacheRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
      syntheticPreviewCacheRef.current = {};
    };
  }, []);

  const candidates = useMemo<AugmentCandidate[]>(() => {
    return workspaceImages.map((item) => ({
      key: item.id,
      displayIdentity: item.displayIdentity,
      label: item.label,
      kind: item.kind,
      blob: item.imageData,
      previewUrl: item.previewUrl ?? (item.syntheticImageId ? syntheticPreviewUrls[item.syntheticImageId] : undefined),
      width: item.width,
      height: item.height,
      aspectRatio: item.aspectRatio,
      sourceImageId: item.sourceImageId,
      syntheticImageId: item.syntheticImageId,
      syntheticType: item.syntheticType,
    }));
  }, [syntheticPreviewUrls, workspaceImages]);

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.key === selectedImageKey) ?? null,
    [candidates, selectedImageKey]
  );

  useEffect(() => {
    if (selectedImageKey && !selectedCandidate) {
      setSelectedImageKey(null);
    }
  }, [selectedCandidate, selectedImageKey]);

  const selectedType = augmentStageState.selectedType ?? 'flip_h';
  const currentConfig = useMemo(
    () => augmentStageState.configsByType?.[selectedType] ?? getDefaultConfig(selectedType),
    [augmentStageState.configsByType, selectedType]
  );

  const updateAugmentStageState = (nextState: AugmentStageState) => {
    setStageState('augment', nextState);
  };

  const updateCurrentConfig = (nextConfig: AugmentationConfig) => {
    updateAugmentStageState({
      ...augmentStageState,
      selectedType,
      configsByType: {
        ...(augmentStageState.configsByType ?? {}),
        [selectedType]: {
          ...nextConfig,
          type: selectedType,
        },
      },
    });
  };

  const handleTypeChange = (type: AugmentationConfig['type']) => {
    updateAugmentStageState({
      ...augmentStageState,
      selectedType: type,
      configsByType: {
        ...(augmentStageState.configsByType ?? {}),
        [type]: augmentStageState.configsByType?.[type] ?? getDefaultConfig(type),
      },
    });
  };

  const handleRotationDegreesChange = (rotationDegrees: number) => {
    updateCurrentConfig({
      ...currentConfig,
      rotationDegrees,
    });
  };

  const handleRotationVariantsChange = (rotationVariants: number) => {
    updateCurrentConfig({
      ...currentConfig,
      rotationVariants,
    });
  };

  const outputConfigs = useMemo(() => {
    if (!selectedCandidate) {
      return [];
    }

    return generateAugmentationConfigs({
      ...currentConfig,
      type: selectedType,
      rotationSeed:
        currentConfig.rotationSeed ?? generateSeedFromImage(`${selectedCandidate.key}:${selectedType}`),
    });
  }, [currentConfig, selectedCandidate, selectedType]);

  useEffect(() => {
    let canceled = false;
    let localUrl: string | null = null;

    setPreviewUrl(null);

    if (!selectedCandidate || outputConfigs.length === 0) {
      setIsPreviewLoading(false);
      return () => undefined;
    }

    setIsPreviewLoading(true);

    applyAugmentation(selectedCandidate.blob, outputConfigs[0])
      .then((blob) => {
        if (canceled) {
          return;
        }
        localUrl = URL.createObjectURL(blob);
        setPreviewUrl(localUrl);
      })
      .catch((error) => {
        console.error('Failed to build augmentation preview:', error);
        if (!canceled) {
          addNotification('error', 'Failed to build augmentation preview');
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsPreviewLoading(false);
        }
      });

    return () => {
      canceled = true;
      if (localUrl) {
        URL.revokeObjectURL(localUrl);
      }
    };
  }, [addNotification, outputConfigs, selectedCandidate]);

  const closeEditor = () => {
    setSelectedImageKey(null);
  };

  const handleSaveAugmentation = async (saveCopy: boolean) => {
    if (!selectedCandidate || outputConfigs.length === 0) {
      return;
    }

    setIsProcessing(true);

    try {
      for (const config of outputConfigs) {
        const augmentedBlob = await applyAugmentation(selectedCandidate.blob, config);
        const augmentedItem = createSyntheticImage(
          selectedCandidate.sourceImageId,
          augmentedBlob,
          selectedCandidate.width,
          selectedCandidate.height,
          'augmented',
          selectedCandidate.aspectRatio
        );
        augmentedItem.augmentationConfig = config;
        addDatasetItem(augmentedItem);
      }

      if (!saveCopy) {
        if (selectedCandidate.kind === 'source') {
          updateSourceImage(selectedCandidate.sourceImageId, { hidden: true });
        } else if (selectedCandidate.syntheticImageId) {
          softDeleteDatasetItem(selectedCandidate.syntheticImageId);
        }
      }

      addNotification(
        'success',
        saveCopy
          ? `Saved ${outputConfigs.length} augmented copy item(s)`
          : `Saved ${outputConfigs.length} augmented item(s)`
      );
      closeEditor();
    } catch (error) {
      console.error('Failed to save augmentation:', error);
      addNotification('error', 'Failed to save augmentation');
    } finally {
      setIsProcessing(false);
    }
  };

  if (candidates.length === 0) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground">No images available for augmentation.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden min-h-[calc(100vh-13rem)] flex flex-col">
      {!selectedCandidate ? (
        <>
          <div className="border-b border-border p-4 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold">Augmentation Gallery</h3>
              <p className="text-sm text-muted-foreground">
                Choose an image to augment. Source and Synthetic images are edited one at a time.
              </p>
            </div>
            <div className="text-sm text-muted-foreground">
              {candidates.length} image{candidates.length !== 1 ? 's' : ''}
            </div>
          </div>

          <div className="p-6 gallery-masonry overflow-y-auto">
            {candidates.map((candidate, index) => (
              <button
                key={candidate.key}
                onClick={() => setSelectedImageKey(candidate.key)}
                className={`gallery-masonry-item group relative rounded-lg overflow-hidden bg-secondary ${getWorkspaceKindFrameClass(candidate.kind)} hover:border-primary transition-colors text-left`}
                style={getWorkspaceKindFrameStyle(candidate.kind)}
              >
                <div className="relative min-h-[12rem] bg-black flex items-center justify-center overflow-hidden">
                  {candidate.previewUrl ? (
                    <img
                      src={candidate.previewUrl}
                      alt={`Image ${candidate.displayIdentity}`}
                      className="w-full h-auto object-contain"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {candidate.width} x {candidate.height}
                    </span>
                  )}

                  <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
                    <div className="flex items-end justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white">Image #{index + 1}</p>
                        <p className="line-clamp-1 text-xs text-gray-300">
                          {candidate.syntheticType === 'augmented' ? 'Augmented' : 'Ready to augment'}
                        </p>
                      </div>
                      <span className={getWorkspaceKindBadgeClass(candidate.kind)}>
                        {WORKSPACE_KIND_STYLES[candidate.kind].label}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="border-b border-border p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                onClick={closeEditor}
                className="p-2 rounded-md bg-secondary hover:bg-muted transition-colors"
                title="Cancel"
              >
                <ArrowLeft size={18} />
              </button>
              <div>
                <h3 className="font-semibold">Augment Image</h3>
                <p className="text-xs text-muted-foreground">
                  {selectedCandidate.label} #{selectedCandidate.displayIdentity}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleSaveAugmentation(false)}
                disabled={isProcessing || outputConfigs.length === 0}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity text-sm font-medium"
              >
                Save
              </button>
              <button
                onClick={() => void handleSaveAugmentation(true)}
                disabled={isProcessing || outputConfigs.length === 0}
                className="px-4 py-2 bg-secondary hover:bg-muted disabled:opacity-50 rounded-md transition-colors text-sm font-medium"
              >
                Save Copy
              </button>
              <button
                onClick={closeEditor}
                disabled={isProcessing}
                className="px-4 py-2 bg-secondary hover:bg-muted disabled:opacity-50 rounded-md transition-colors text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="border-b border-border p-4 flex items-start gap-4 flex-wrap">
            <div>
              <label className="block text-sm font-medium mb-1">Augmentation Type</label>
              <select
                value={selectedType}
                onChange={(event) => handleTypeChange(event.target.value as AugmentationConfig['type'])}
                className="px-3 py-2 rounded-md border border-border bg-background text-sm"
              >
                <option value="flip_h">Flip Horizontal</option>
                <option value="flip_v">Flip Vertical</option>
                <option value="color">Gradient Map</option>
                <option value="rotate">Rotate</option>
              </select>
            </div>

            {selectedType === 'rotate' && (
              <>
                <div className="min-w-[180px]">
                  <label className="block text-sm font-medium mb-1">
                    Max Rotation: {currentConfig.rotationDegrees ?? 15} deg
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="180"
                    value={currentConfig.rotationDegrees ?? 15}
                    onChange={(event) => handleRotationDegreesChange(parseInt(event.target.value, 10))}
                    className="w-full"
                  />
                </div>
                <div className="min-w-[180px]">
                  <label className="block text-sm font-medium mb-1">
                    Variants: {currentConfig.rotationVariants ?? 3}
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={currentConfig.rotationVariants ?? 3}
                    onChange={(event) => handleRotationVariantsChange(parseInt(event.target.value, 10))}
                    className="w-full"
                  />
                </div>
              </>
            )}

            <div className="rounded-md bg-secondary/40 border border-border px-3 py-2 text-sm text-muted-foreground">
              Type: <strong>{TYPE_LABELS[selectedType]}</strong> | Outputs:{' '}
              <strong>{outputConfigs.length}</strong>
            </div>
          </div>

          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
            <div className="min-h-[28rem] bg-black flex items-center justify-center overflow-hidden border-b lg:border-b-0 lg:border-r border-border">
              {selectedCandidate.previewUrl ? (
                <img
                  src={selectedCandidate.previewUrl}
                  alt={`Original ${selectedCandidate.displayIdentity}`}
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <span className="text-xs text-muted-foreground">
                  {selectedCandidate.width} x {selectedCandidate.height}
                </span>
              )}
            </div>

            <div className="min-h-[28rem] bg-black flex items-center justify-center overflow-hidden relative">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={`Augmented preview ${selectedCandidate.displayIdentity}`}
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <span className="text-sm text-muted-foreground">
                  {isPreviewLoading ? 'Generating preview...' : 'No preview available'}
                </span>
              )}
              <div className="absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
                Preview 1 of {outputConfigs.length || 0}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
