import { useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { computeDistanceMatrix, performClustering } from '../../services/similarity/similarityService';
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

export const SimilarityReviewTool = () => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const editedAssetsById = useProjectStore((state) => state.datasetItems);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const softDeleteDatasetItem = useProjectStore((state) => state.softDeleteDatasetItem);
  const { addNotification } = useUIStore();
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const editedAssets = useMemo(
    () => Object.values(editedAssetsById).filter((item) => !item.deleted),
    [editedAssetsById]
  );

  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [uiThreshold, setUiThreshold] = useState(0.7);
  const similarityThreshold = useMemo(() => {
    const remapped = 0.2 + 0.8 * Math.sqrt(uiThreshold);
    if (import.meta.env.DEV) {
      console.log(`[duplicates] threshold remap: ${uiThreshold.toFixed(2)} -> ${remapped.toFixed(3)}`);
    }
    return remapped;
  }, [uiThreshold]);

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

  const duplicateGroups = useMemo<SimilarityCluster[]>(() => {
    if (import.meta.env.DEV) {
      console.log(`[duplicates] images: ${images.length}`);
      console.log(`[duplicates] threshold: ${similarityThreshold}`);
    }

    const embeddings = new Map<string, Float32Array>();
    for (const image of images) {
      const embedding = sourceImageById[image.sourceImageId]?.embedding;
      if (embedding) {
        embeddings.set(image.id, embedding);
      }
    }

    if (embeddings.size < 2) {
      if (import.meta.env.DEV) {
        console.log('[duplicates] groups: 0');
      }
      return [];
    }

    const matrix = computeDistanceMatrix(embeddings);
    const clusters = performClustering(
      Array.from(embeddings.keys()),
      matrix,
      similarityThreshold
    ).filter((cluster) => cluster.imageIds.length > 1);

    if (import.meta.env.DEV) {
      console.log(`[duplicates] groups: ${clusters.length}`);
      console.log(`[duplicates] group sizes: [${clusters.map((cluster) => cluster.imageIds.length).join(', ')}]`);
    }

    return clusters;
  }, [images, similarityThreshold]);

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
    const remainingImages = Math.max(images.length - 1, 0);

    if (import.meta.env.DEV) {
      console.log(`[duplicates] remaining images after delete: ${remainingImages}`);
    }

    addNotification('info', 'Image removed');
  };

  const handleRemoveCluster = (clusterIds: string[]) => {
    const idsToRemove = clusterIds.slice(1);

    for (const id of idsToRemove) {
      handleRemoveImage(id);
    }

    if (import.meta.env.DEV) {
      console.log(
        `[duplicates] remaining images after delete: ${Math.max(images.length - idsToRemove.length, 0)}`
      );
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
              <h3 className="text-sm font-semibold">Remove Duplicates</h3>
              <p className="truncate text-xs text-muted-foreground">
                Review visually similar source and generated images.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="similarity-threshold">
              Threshold
            </label>
            <input
              id="similarity-threshold"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={uiThreshold}
              onChange={(event) => setUiThreshold(parseFloat(event.target.value))}
              className="w-32"
            />
            <span className="w-12 text-right font-mono text-xs">
              {uiThreshold.toFixed(2)}
            </span>
          </div>
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
                      Average similarity: {(cluster.avgSimilarity * 100).toFixed(1)}%
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
            <p className="text-sm font-medium text-muted-foreground">No duplicate groups at this threshold</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Lower the threshold to widen the match set.
            </p>
          </div>
        </div>
      )}

    </div>
  );
};
