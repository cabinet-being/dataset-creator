import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { computeDistanceMatrix, getClusterLevel, performClustering } from '../../services/similarity/similarityService';
import {
  getStrictness,
  getStrictnessThreshold,
  getSimilarityLevel,
  SIMILARITY_BASIS_LABELS,
  SIMILARITY_STRICTNESS,
  type SimilarityStrictnessId,
} from '../../services/similarity/similarityLevels';
import { useSimilarityFeatures, type SimilarityFeatures } from '../../services/similarity/useSimilarityFeatures';
import { SimilarityCluster } from '../../types';
import {
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameOverlayClass,
  getWorkspaceKindFrameOverlayStyle,
  getWorkspaceKindFrameStyle,
  toWorkspaceImages,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { BrickMasonry } from '../ui/BrickMasonry';
import { MasonryImageFrame } from '../ui/MasonryImageFrame';
import { AlertCircle, ChevronDown, SlidersHorizontal, Trash2 } from 'lucide-react';
import { isProjectPathIncluded } from '../../lib/projectCategories';

/** Single labelled "Strictness" slider shared by Similar images and Analysis. */
export const SimilarityStrictnessControl = ({
  value,
  onChange,
  features,
  className = '',
}: {
  value: SimilarityStrictnessId;
  onChange: (value: SimilarityStrictnessId) => void;
  features: Pick<SimilarityFeatures, 'basis' | 'modelState' | 'progress' | 'error' | 'loadModel'>;
  className?: string;
}) => {
  const id = useId();
  const index = Math.max(0, SIMILARITY_STRICTNESS.findIndex((entry) => entry.id === value));
  const strictness = getStrictness(value);
  const level = getSimilarityLevel(strictness.level);
  const { basis, modelState, progress, error, loadModel } = features;
  return (
    <div className={`min-w-[12rem] text-xs ${className}`}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <label htmlFor={id} className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Strictness
        </label>
        <span className="font-medium">{strictness.label}: {level.label.toLowerCase()} and closer</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={SIMILARITY_STRICTNESS.length - 1}
        step={1}
        value={index}
        aria-valuetext={`${strictness.label}: ${level.label}`}
        onChange={(event) => onChange(SIMILARITY_STRICTNESS[Number(event.target.value)]?.id ?? 'strict')}
        className="w-full"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        {SIMILARITY_STRICTNESS.map((entry) => <span key={entry.id}>{entry.label}</span>)}
      </div>
      <p className="mt-1 text-muted-foreground">{level.description}</p>
      <div
        className={`mt-2 rounded border px-2 py-1 ${basis === 'dinov2' ? 'border-border text-muted-foreground' : 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}
        data-similarity-basis={basis}
      >
        <span>Compared by: {SIMILARITY_BASIS_LABELS[basis]}</span>
        {basis === 'histogram' && modelState === 'loading' ? (
          <span> · Preparing DINOv2 {progress.completed}/{progress.total}…</span>
        ) : null}
        {basis === 'histogram' && (modelState === 'missing' || modelState === 'error') ? (
          <>
            <span> · Brightness only, results are rough.</span>{' '}
            <button type="button" onClick={loadModel} className="underline underline-offset-2">
              Download DINOv2 (88 MB)
            </button>
          </>
        ) : null}
        {error ? <p className="mt-1 text-destructive">{error}</p> : null}
      </div>
    </div>
  );
};

export const SimilarityReviewTool = () => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const editedAssetsById = useProjectStore((state) => state.datasetItems);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const excludedProjectCategories = useMemo(() => workspaceSettings.excludedProjectCategories ?? [], [workspaceSettings.excludedProjectCategories]);
  const includedProjectCategories = useMemo(() => workspaceSettings.includedProjectCategories ?? [], [workspaceSettings.includedProjectCategories]);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const softDeleteDatasetItem = useProjectStore((state) => state.softDeleteDatasetItem);
  const { addNotification } = useUIStore();
  const sourceImages = useMemo(() => Object.values(sourceImagesById).filter((image) =>
    isProjectPathIncluded(image.originalFilePath, excludedProjectCategories, includedProjectCategories)
  ), [excludedProjectCategories, includedProjectCategories, sourceImagesById]);
  const editedAssets = useMemo(
    () => Object.values(editedAssetsById).filter((item) =>
      !item.deleted && isProjectPathIncluded(item.imageDataPath ?? sourceImagesById[item.sourceImageId]?.originalFilePath, excludedProjectCategories, includedProjectCategories)
    ),
    [editedAssetsById, excludedProjectCategories, includedProjectCategories, sourceImagesById]
  );

  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [strictness, setStrictness] = useState<SimilarityStrictnessId>('strict');

  const images = useMemo(
    () => toWorkspaceImages(sourceImages, editedAssets),
    [sourceImages, editedAssets]
  );
  const previewUrls = useWorkspacePreviewUrls(images);
  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images]);
  const sourceImageById = useMemo(
    () => Object.fromEntries(sourceImages.map((image) => [image.id, image])),
    [sourceImages]
  );
  const cleanupInputReason = images.length > 0 ? 'synced to cleanup tool' : 'no images remaining';
  const histogramFor = useCallback(
    (image: WorkspaceImage) => {
      const source = sourceImageById[image.sourceImageId];
      return source && image.imageData === source.originalFile ? source.embedding : undefined;
    },
    [sourceImageById]
  );
  const similarityFeatures = useSimilarityFeatures(images, { histogramFor });
  const { basis, embeddings: featureById } = similarityFeatures;
  const similarityThreshold = getStrictnessThreshold(strictness, basis);

  const { duplicateGroups, levelByClusterId } = useMemo(() => {
    const embeddings = new Map(Object.entries(featureById));
    if (embeddings.size < 2) {
      return { duplicateGroups: [] as SimilarityCluster[], levelByClusterId: {} as Record<string, string> };
    }

    const matrix = computeDistanceMatrix(embeddings);
    const clusters = performClustering(
      Array.from(embeddings.keys()),
      matrix,
      similarityThreshold
    ).filter((cluster) => cluster.imageIds.length > 1);
    const levels = Object.fromEntries(
      clusters.map((cluster) => [cluster.id, getClusterLevel(cluster.imageIds, matrix, basis)?.label ?? 'Related'])
    );

    return { duplicateGroups: clusters, levelByClusterId: levels };
  }, [basis, featureById, similarityThreshold]);

  useEffect(() => {
    if (selectedClusterId && !duplicateGroups.some((cluster) => cluster.id === selectedClusterId)) {
      setSelectedClusterId(null);
    }
  }, [duplicateGroups, selectedClusterId]);

  const handleRemoveImage = (id: string) => {
    if (id.startsWith('source:')) {
      updateSourceImage(id.replace(/^source:/, ''), { hidden: true });
    } else {
      softDeleteDatasetItem(id.replace(/^edited:/, ''));
    }
    addNotification('info', 'Image removed');
  };

  const handleRemoveCluster = (clusterIds: string[]) => {
    const idsToRemove = clusterIds.slice(1);

    for (const id of idsToRemove) {
      handleRemoveImage(id);
    }

    addNotification('info', `Removed ${idsToRemove.length} duplicate image${idsToRemove.length !== 1 ? 's' : ''} from cluster`);
  };

  if (images.length === 0) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center px-4 text-center">
        <div className="max-w-sm">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No comparable images</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add image assets from Explorer or open a Dataset with source images.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="rounded-md border border-border bg-card/80">
        <div className="flex flex-col gap-4 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
              <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Similar images</h3>
              <p className="truncate text-xs text-muted-foreground">
                Review visually similar source and generated images.
              </p>
            </div>
          </div>
          <SimilarityStrictnessControl
            value={strictness}
            onChange={setStrictness}
            features={similarityFeatures}
            className="w-full md:w-80"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Images</p>
          <p className="mt-1 text-lg font-semibold">{images.length}</p>
        </div>
        <div className="rounded-md border border-border bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Groups</p>
          <p className="mt-1 text-lg font-semibold">{duplicateGroups.length}</p>
        </div>
        <div className="rounded-md border border-border bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Input</p>
          <p className="mt-1 truncate text-sm font-medium">{cleanupInputReason}</p>
        </div>
      </div>

      {duplicateGroups.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card/70">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">
              Duplicate groups ({duplicateGroups.length})
            </h3>
            <p className="text-xs text-muted-foreground">
              Expand a group to compare assets before removing redundant variants.
            </p>
          </div>

          <div className="space-y-3 p-3">
            {duplicateGroups.map((cluster) => (
              <div
                key={cluster.id}
                className="overflow-hidden rounded-md border border-border bg-background"
              >
                <button
                  onClick={() =>
                    setSelectedClusterId(
                      selectedClusterId === cluster.id ? null : cluster.id
                    )
                  }
                  className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-secondary"
                >
                  <div className="text-left">
                    <p className="text-sm font-medium">
                      Group with {cluster.imageIds.length} image
                      {cluster.imageIds.length !== 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {levelByClusterId[cluster.id]}
                    </p>
                  </div>
                  <ChevronDown
                    size={20}
                    className={`transition-transform ${
                      selectedClusterId === cluster.id ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {selectedClusterId === cluster.id && (
                  <div className="border-t border-border bg-secondary/30 p-4">
                    <BrickMasonry
                      className="mb-4"
                      items={cluster.imageIds
                        .map((imageId) => imageById.get(imageId))
                        .filter((image): image is WorkspaceImage => Boolean(image))}
                      getKey={(image) => image.id}
                      getEstimate={(image) => image.height / Math.max(1, image.width)}
                      renderItem={(image) => (
                          <div
                            className={`gallery-masonry-item group relative overflow-hidden rounded-md bg-black ${getWorkspaceKindFrameClass(image.kind)}`}
                            style={getWorkspaceKindFrameStyle(image.kind)}
                          >
                            <MasonryImageFrame
                              src={previewUrls[image.id]}
                              alt={image.fileName}
                              width={image.width}
                              height={image.height}
                              placeholder="Preview unavailable"
                            >
                              <div
                                className={getWorkspaceKindFrameOverlayClass()}
                                style={getWorkspaceKindFrameOverlayStyle(image.kind)}
                              />
                            </MasonryImageFrame>

                            <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                onClick={() => handleRemoveImage(image.id)}
                                className="rounded-md bg-destructive p-2 text-destructive-foreground hover:opacity-90"
                                title="Remove image"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>

                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                              <p className="truncate text-xs text-white">
                                {image.fileName}
                              </p>
                              <span className={`mt-1 ${getWorkspaceKindBadgeClass(image.kind)}`}>
                                {image.label}
                              </span>
                            </div>
                          </div>
                      )}
                    />

                    <button
                      onClick={() => handleRemoveCluster(cluster.imageIds)}
                      className="w-full rounded-md bg-destructive/20 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/30"
                    >
                      Keep 1, remove {cluster.imageIds.length - 1} duplicate{cluster.imageIds.length - 1 !== 1 ? 's' : ''}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {duplicateGroups.length === 0 && (
        <div className="flex min-h-[260px] flex-1 items-center justify-center rounded-md border border-dashed border-border bg-secondary/40 px-4 text-center">
          <div>
            <p className="text-sm font-medium text-muted-foreground">No duplicate groups at this strictness</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Move Strictness towards Loose to widen the match set.
            </p>
          </div>
        </div>
      )}

    </div>
  );
};
