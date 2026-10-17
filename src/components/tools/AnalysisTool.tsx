import { useId, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BarChart3,
  Boxes,
  GitCompareArrows,
  Layers3,
  LocateFixed,
  SearchX,
  SlidersHorizontal,
  Tags,
} from 'lucide-react';
import { ASPECT_RATIO_LABELS, ASPECT_RATIOS } from '../../lib/constants';
import { useInspectorPortalRoot } from '../../hooks/useInspectorPortalRoot';
import {
  createWorkspaceFileAssetId,
  inferWorkspaceAspectRatio,
  toWorkspaceImages,
  toWorkspaceReviewAssets,
  type WorkspaceFileAsset,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { collectWorkspaceFileAssets, generateMissingWorkspacePsdPreviews } from '../../lib/workspaceFileAssets';
import { isProjectPathIncluded } from '../../lib/projectCategories';
import { generateEmbedding, generateImageHash } from '../../services/image/embeddingService';
import { computeDistanceMatrix, findSimilarPairs, performClustering } from '../../services/similarity/similarityService';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { addAssetsToDataset, removeAssetsFromDataset } from '../../lib/assetActions';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import type { AspectRatio, Dataset, SimilarityCluster, SimilarityResult } from '../../types';
import { WorkspacePreviewCard } from '../ui/WorkspacePreviewCard';
import { persistCaptionTagsForItems } from '../../services/caption/captionMutationService';
import { flushProjectSave } from '../../hooks/useProjectSave';

type AnalysisTargetMode = 'project' | 'dataset' | 'file';
type AnalysisView = 'overview' | 'duplicates' | 'similar' | 'coverage' | 'tags' | 'outliers';
type SimilarGroupSort = 'risk' | 'similarity' | 'coverage' | 'size';
type SimilarGroupFilter = 'all' | 'high-confidence' | 'weak' | 'same-color' | 'tag-mismatch' | 'redundant';

type EmbeddingCacheEntry = { blob: Blob; embedding: Float32Array };
type TraitCacheEntry = { blob: Blob; traits: VisualTraits };
type PsdPreviewCacheEntry = { previewUrl: string; blob: Blob };

type AnalysisFileTarget = {
  path: string;
  name: string;
  fileKind: string;
  file: File | Blob;
  workspaceImageId?: string;
};

type VisualTraits = {
  hash: string;
  dominantColors: string[];
  brightness: number;
  contrast: number;
  colorSignature: [number, number, number];
};

type DuplicateGroup = {
  id: string;
  items: WorkspaceImage[];
  score: number;
  reason: 'exact visual match' | 'near visual match' | 'high-confidence duplicate';
  suggestedKeepId: string;
  maxHashDistance: number | null;
};

type SimilarGroup = {
  id: string;
  items: WorkspaceImage[];
  score: number;
  confidence: number;
  coverageValue: number;
  tagOverlap: number;
  colorSimilarity: number;
  compositionSimilarity: number;
  duplicatePressure: number;
  reasons: string[];
  avgSimilarity: number;
};

type CoverageAddRecommendation = {
  kind: 'add';
  id: string;
  item: WorkspaceImage;
  gain: number;
  redundancyScore: number;
  confidence: number;
  reason: string;
  improves: string[];
};

type CoverageRemoveRecommendation = {
  kind: 'remove';
  id: string;
  item: WorkspaceImage;
  redundancyScore: number;
  confidence: number;
  reason: string;
  nearestTitle: string;
};

type CoverageCaptionRecommendation = {
  kind: 'caption';
  id: string;
  item: WorkspaceImage;
  reason: string;
};

type CoverageBalanceWarning = {
  kind: 'balance';
  id: string;
  label: string;
  detail: string;
  severity: 'info' | 'warning';
};

type CoverageSections = {
  add: CoverageAddRecommendation[];
  remove: CoverageRemoveRecommendation[];
  captions: CoverageCaptionRecommendation[];
  balance: CoverageBalanceWarning[];
};

type RedundancyProfile = {
  score: number;
  nearestItems: WorkspaceImage[];
  strongestSimilarity: number;
  hashDistance: number | null;
  tagOverlap: number;
  colorSimilarity: number;
  orientationMatch: boolean;
  aspectMatch: boolean;
};

type TagAnalysis = {
  totalCaptionable: number;
  captioned: number;
  missingCaptionItems: WorkspaceImage[];
  triggerWord: string;
  triggerPresent: number;
  triggerMissingItems: WorkspaceImage[];
  frequencies: Array<{ tag: string; count: number; percent: number; items: WorkspaceImage[] }>;
  overused: Array<{ tag: string; count: number; percent: number; items: WorkspaceImage[] }>;
  rare: Array<{ tag: string; count: number; percent: number; items: WorkspaceImage[] }>;
  inconsistent: Array<{ tag: string; items: WorkspaceImage[]; reason: string }>;
  balanceScore: number;
};

type Outlier = {
  id: string;
  item: WorkspaceImage;
  score: number;
  reasons: string[];
};

type AnalysisToolProps = {
  datasetId?: string;
  active?: boolean;
  projectDirectoryHandle?: ProjectDirectoryHandle | null;
  fileTarget?: AnalysisFileTarget;
  fileTargets?: AnalysisFileTarget[];
  onOpenAssetContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
  onAutoAssemble?: () => void;
  onUpdateDataset?: (
    updates: Partial<Pick<Dataset, 'assetOrder'>>
  ) => void | Promise<void>;
};

const GRAPH_LIMIT = 96;
const COVERAGE_CANDIDATE_LIMIT = 128;
const SIMILARITY_THRESHOLD_DEFAULT = 0.94;
const DUPLICATE_HASH_DISTANCE = 4;
const DUPLICATE_RISK_THRESHOLD = 0.96;
const TAG_OVERUSED_PERCENT = 42;

const getPairKey = (left: string, right: string): string =>
  left < right ? `${left}:${right}` : `${right}:${left}`;

const getItemTitle = (item?: WorkspaceImage): string => item?.originalFileName ?? item?.fileName ?? 'Asset';

const getProjectRelativePath = (path: string): string => path.replace(/^Project\//, '');

const isAnalysisVisualAsset = (item: WorkspaceImage): boolean =>
  item.kind === 'image' || item.kind === 'edited' || item.kind === 'psd';

const createAnalysisVisualItem = (
  item: WorkspaceImage,
  psdPreview?: PsdPreviewCacheEntry
): WorkspaceImage | null => {
  if (item.kind === 'image' || item.kind === 'edited') {
    return item;
  }

  if (item.kind !== 'psd' || !item.previewUrl || !psdPreview || psdPreview.previewUrl !== item.previewUrl) {
    return null;
  }

  const width = item.width > 1 ? item.width : 1;
  const height = item.height > 1 ? item.height : 1;
  return {
    ...item,
    imageData: psdPreview.blob,
    width,
    height,
    aspectRatio: inferWorkspaceAspectRatio(width, height),
    allowObjectPreviewUrl: true,
  };
};

const normalizeTags = (tags: string[] = []): string[] =>
  [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];

const getCaptionTags = (item: WorkspaceImage, _dataset?: Dataset): string[] => normalizeTags(item.tags);

const getOrientation = (item: WorkspaceImage): 'portrait' | 'landscape' | 'square' => {
  const ratio = item.width / Math.max(1, item.height);
  if (ratio > 1.12) {
    return 'landscape';
  }
  if (ratio < 0.88) {
    return 'portrait';
  }
  return 'square';
};

const hammingDistance = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  let distance = Math.abs(left.length - right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      distance += 1;
    }
  }
  return distance;
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

const colorDistance = (left?: VisualTraits, right?: VisualTraits): number => {
  if (!left || !right) {
    return 1;
  }
  const distance = Math.hypot(
    left.colorSignature[0] - right.colorSignature[0],
    left.colorSignature[1] - right.colorSignature[1],
    left.colorSignature[2] - right.colorSignature[2]
  );
  return Math.min(1, distance / 441.7);
};

const colorSimilarity = (left?: VisualTraits, right?: VisualTraits): number => 1 - colorDistance(left, right);

const tagOverlap = (left: string[], right: string[]): number => {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = left.filter((tag) => rightSet.has(tag)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
};

const getItemSimilarity = (
  pairMap: Map<string, SimilarityResult>,
  left: string,
  right: string
): number => pairMap.get(getPairKey(left, right))?.similarity ?? 0;

const buildVisualTraits = async (item: WorkspaceImage): Promise<VisualTraits> => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to create analysis canvas');
  }

  canvas.width = 24;
  canvas.height = 24;
  const url = URL.createObjectURL(item.imageData);
  const img = new Image();

  return new Promise((resolve, reject) => {
    img.onload = async () => {
      try {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const buckets = new Map<string, { count: number; rgb: [number, number, number] }>();
        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let totalLuma = 0;
        const lumas: number[] = [];

        for (let index = 0; index < data.length; index += 4) {
          const r = data[index];
          const g = data[index + 1];
          const b = data[index + 2];
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const key = `${Math.round(r / 48) * 48},${Math.round(g / 48) * 48},${Math.round(b / 48) * 48}`;
          const bucket = buckets.get(key) ?? { count: 0, rgb: [r, g, b] as [number, number, number] };
          bucket.count += 1;
          buckets.set(key, bucket);
          totalR += r;
          totalG += g;
          totalB += b;
          totalLuma += luma;
          lumas.push(luma);
        }

        const pixelCount = Math.max(1, data.length / 4);
        const brightness = totalLuma / pixelCount / 255;
        const contrast = Math.sqrt(
          lumas.reduce((sum, luma) => sum + Math.pow(luma / 255 - brightness, 2), 0) / pixelCount
        );
        const dominantColors = [...buckets.values()]
          .sort((left, right) => right.count - left.count)
          .slice(0, 3)
          .map(({ rgb }) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`);
        const hash = await generateImageHash(item.imageData);

        URL.revokeObjectURL(url);
        resolve({
          hash,
          dominantColors,
          brightness,
          contrast,
          colorSignature: [
            totalR / pixelCount,
            totalG / pixelCount,
            totalB / pixelCount,
          ],
        });
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load ${item.fileName} for analysis`));
    };
    img.src = url;
  });
};

const createFileTargetItem = (
  fileTarget: AnalysisFileTarget,
  existingItem?: WorkspaceImage
): WorkspaceImage => {
  if (existingItem) {
    return existingItem;
  }

  const kind = fileTarget.fileKind === 'psd' ? 'psd' : fileTarget.fileKind === 'video' ? 'video' : 'image';
  return {
    id: fileTarget.workspaceImageId ?? createWorkspaceFileAssetId(fileTarget.path),
    sourceImageId: '',
    kind,
    label: kind === 'psd' ? 'PSD' : kind === 'video' ? 'Video' : 'Image',
    displayIdentity: 'target',
    fileName: fileTarget.name,
    assetPath: fileTarget.path,
    imageData: fileTarget.file,
    width: 1,
    height: 1,
    aspectRatio: '1:1',
  };
};

const MetricPill = ({ label, value }: { label: string; value: string | number }) => (
  <span className="inline-flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1 text-[11px]">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono font-medium text-foreground">{value}</span>
  </span>
);

const TraitSwatches = ({ colors }: { colors: string[] }) => (
  <div className="flex gap-1">
    {colors.slice(0, 3).map((color) => (
      <span
        key={color}
        className="h-4 w-4 rounded border border-white/20"
        style={{ backgroundColor: color }}
        title={color}
      />
    ))}
  </div>
);

const AnalysisAssetCard = ({
  item,
  previewUrl,
  selected = false,
  onSelect,
  onOpenAssetContextMenu,
  footer,
}: {
  item: WorkspaceImage;
  previewUrl?: string;
  selected?: boolean;
  onSelect?: () => void;
  onOpenAssetContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
  footer?: ReactNode;
}) => {
  const squarePreviewItem = { ...item, width: 1, height: 1 };
  return (
    <WorkspacePreviewCard
      item={squarePreviewItem}
      previewUrl={previewUrl}
      alt={item.fileName}
      onClick={onSelect}
      onOpenContextMenu={
        onOpenAssetContextMenu ? (_previewItem, event) => onOpenAssetContextMenu(item, event) : undefined
      }
      className={`min-w-0 rounded-lg ${selected ? 'ring-2 ring-primary/40' : ''}`}
      imageClassName="object-contain"
      footer={
        footer ?? (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-2">
            <p className="truncate text-xs font-medium text-white">{getItemTitle(item)}</p>
            <p className="mt-0.5 text-[10px] text-gray-300">
              {item.label} · {item.width} x {item.height}
            </p>
          </div>
        )
      }
    />
  );
};

const buildDuplicateGroups = (
  visualItems: WorkspaceImage[],
  traitsById: Record<string, VisualTraits>,
  pairMap: Map<string, SimilarityResult>,
  dataset?: Dataset
): DuplicateGroup[] => {
  const parent = new Map(visualItems.map((item) => [item.id, item.id]));
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) {
      return current;
    }
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  };
  const pairDistances = new Map<string, number>();

  for (let leftIndex = 0; leftIndex < visualItems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < visualItems.length; rightIndex += 1) {
      const left = visualItems[leftIndex];
      const right = visualItems[rightIndex];
      const leftTraits = traitsById[left.id];
      const rightTraits = traitsById[right.id];
      const distance = leftTraits && rightTraits ? hammingDistance(leftTraits.hash, rightTraits.hash) : null;
      const similarity = getItemSimilarity(pairMap, left.id, right.id);
      if (distance !== null) {
        pairDistances.set(getPairKey(left.id, right.id), distance);
      }
      if ((distance !== null && distance <= DUPLICATE_HASH_DISTANCE) || similarity >= DUPLICATE_RISK_THRESHOLD) {
        union(left.id, right.id);
      }
    }
  }

  const groups = new Map<string, WorkspaceImage[]>();
  for (const item of visualItems) {
    const root = find(item.id);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  }

  return [...groups.values()]
    .filter((items) => items.length > 1)
    .map((items, index) => {
      let maxHashDistance: number | null = null;
      for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
          const distance = pairDistances.get(getPairKey(items[leftIndex].id, items[rightIndex].id));
          if (distance !== undefined) {
            maxHashDistance = Math.max(maxHashDistance ?? 0, distance);
          }
        }
      }
      const suggestedKeep = [...items].sort(
        (left, right) =>
          getCaptionTags(right, dataset).length - getCaptionTags(left, dataset).length ||
          right.width * right.height - left.width * left.height ||
          getItemTitle(left).localeCompare(getItemTitle(right))
      )[0];
      const strongestSimilarity = Math.max(
        0,
        ...items.flatMap((left, leftIndex) =>
          items.slice(leftIndex + 1).map((right) => getItemSimilarity(pairMap, left.id, right.id))
        )
      );
      const reason =
        maxHashDistance === 0
          ? 'exact visual match' as const
          : maxHashDistance !== null && maxHashDistance <= DUPLICATE_HASH_DISTANCE
            ? 'near visual match' as const
            : 'high-confidence duplicate' as const;
      return {
        id: `duplicate-${index}`,
        items,
        score: Math.max(maxHashDistance === null ? 0 : 1 - maxHashDistance / 64, strongestSimilarity),
        reason,
        suggestedKeepId: suggestedKeep.id,
        maxHashDistance,
      };
    })
    .sort((left, right) => right.score - left.score || right.items.length - left.items.length);
};

const buildSimilarGroups = ({
  clusters,
  itemById,
  pairMap,
  traitsById,
  dataset,
  duplicateGroups,
}: {
  clusters: SimilarityCluster[];
  itemById: Map<string, WorkspaceImage>;
  pairMap: Map<string, SimilarityResult>;
  traitsById: Record<string, VisualTraits>;
  dataset?: Dataset;
  duplicateGroups: DuplicateGroup[];
}): SimilarGroup[] => {
  const duplicateIds = new Set(duplicateGroups.flatMap((group) => group.items.map((item) => item.id)));
  return clusters
    .map((cluster, index) => {
      const groupItems = cluster.imageIds
        .map((id) => itemById.get(id))
        .filter((item): item is WorkspaceImage => Boolean(item));
      if (groupItems.length < 2) {
        return null;
      }
      if (groupItems.some((item) => duplicateIds.has(item.id))) {
        return null;
      }

      const similarities: number[] = [];
      const tagScores: number[] = [];
      const colorScores: number[] = [];
      for (let leftIndex = 0; leftIndex < groupItems.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < groupItems.length; rightIndex += 1) {
          const left = groupItems[leftIndex];
          const right = groupItems[rightIndex];
          similarities.push(getItemSimilarity(pairMap, left.id, right.id));
          tagScores.push(tagOverlap(getCaptionTags(left, dataset), getCaptionTags(right, dataset)));
          colorScores.push(colorSimilarity(traitsById[left.id], traitsById[right.id]));
        }
      }
      const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const avgSimilarity = average(similarities);
      const avgTagOverlap = average(tagScores);
      const avgColorSimilarity = average(colorScores);
      const orientations = new Set(groupItems.map(getOrientation));
      const aspects = new Set(groupItems.map((item) => item.aspectRatio));
      const duplicatePressure = groupItems.filter((item) => duplicateIds.has(item.id)).length / groupItems.length;
      const coverageValue = Math.round((orientations.size + aspects.size) / 6 * 100);
      const compositionSimilarity = Math.round((avgSimilarity * 0.72 + avgColorSimilarity * 0.18 + avgTagOverlap * 0.1) * 100);
      const confidence = Math.round((avgSimilarity * 0.62 + avgColorSimilarity * 0.22 + Math.max(avgTagOverlap, 0.25) * 0.16) * 100);
      const reasons = [
        avgSimilarity >= 0.9 ? 'pose' : 'composition',
        avgColorSimilarity >= 0.82 ? 'color' : null,
        avgTagOverlap >= 0.32 ? 'character' : null,
        duplicatePressure > 0 ? 'near duplicate' : null,
      ].filter((reason): reason is string => Boolean(reason));

      return {
        id: `similar-${index}`,
        items: groupItems,
        score: Math.round(avgSimilarity * 100),
        confidence,
        coverageValue,
        tagOverlap: Math.round(avgTagOverlap * 100),
        colorSimilarity: Math.round(avgColorSimilarity * 100),
        compositionSimilarity,
        duplicatePressure: Math.round(duplicatePressure * 100),
        reasons: reasons.length ? reasons : ['composition'],
        avgSimilarity,
      };
    })
    .filter((group): group is SimilarGroup => Boolean(group));
};

const buildRedundancyProfile = ({
  items,
  referenceItems,
  pairMap,
  traitsById,
  dataset,
}: {
  items: WorkspaceImage[];
  referenceItems: WorkspaceImage[];
  pairMap: Map<string, SimilarityResult>;
  traitsById: Record<string, VisualTraits>;
  dataset?: Dataset;
}): Map<string, RedundancyProfile> => {
  const profiles = new Map<string, RedundancyProfile>();

  for (const item of items) {
    const candidates = referenceItems.filter((reference) => reference.id !== item.id);
    const scored = candidates
      .map((reference) => {
        const embeddingSimilarity = getItemSimilarity(pairMap, item.id, reference.id);
        const itemTraits = traitsById[item.id];
        const referenceTraits = traitsById[reference.id];
        const hashDistance = itemTraits && referenceTraits ? hammingDistance(itemTraits.hash, referenceTraits.hash) : null;
        const hashSimilarity = hashDistance === null ? 0 : Math.max(0, 1 - hashDistance / 18);
        const tags = tagOverlap(getCaptionTags(item, dataset), getCaptionTags(reference, dataset));
        const colors = colorSimilarity(itemTraits, referenceTraits);
        const orientationMatch = getOrientation(item) === getOrientation(reference);
        const aspectMatch = item.aspectRatio === reference.aspectRatio;
        const traitSimilarity = (
          colors * 0.34 +
          (orientationMatch ? 0.22 : 0) +
          (aspectMatch ? 0.18 : 0) +
          tags * 0.26
        );
        const score = Math.max(
          hashSimilarity * 0.96,
          embeddingSimilarity * 0.56 + traitSimilarity * 0.34 + hashSimilarity * 0.1
        );

        return {
          reference,
          score,
          embeddingSimilarity,
          hashDistance,
          tagOverlap: tags,
          colorSimilarity: colors,
          orientationMatch,
          aspectMatch,
        };
      })
      .sort((left, right) => right.score - left.score);

    const nearest = scored[0];
    profiles.set(item.id, {
      score: nearest?.score ?? 0,
      nearestItems: scored.slice(0, 3).map((entry) => entry.reference),
      strongestSimilarity: nearest?.embeddingSimilarity ?? 0,
      hashDistance: nearest?.hashDistance ?? null,
      tagOverlap: nearest?.tagOverlap ?? 0,
      colorSimilarity: nearest?.colorSimilarity ?? 0,
      orientationMatch: nearest?.orientationMatch ?? false,
      aspectMatch: nearest?.aspectMatch ?? false,
    });
  }

  return profiles;
};

const buildTagAnalysis = (items: WorkspaceImage[], dataset?: Dataset, overusedThreshold = TAG_OVERUSED_PERCENT): TagAnalysis => {
  const captionable = items.filter((item) => item.kind === 'image' || item.kind === 'edited' || item.kind === 'psd');
  const triggerWord = dataset?.triggerWord.trim().toLowerCase() ?? '';
  const tagEntries = captionable.map((item) => ({ item, tags: getCaptionTags(item, dataset) }));
  const missingCaptionItems = tagEntries.filter(({ tags }) => tags.length === 0).map(({ item }) => item);
  const triggerMissingItems = triggerWord
    ? tagEntries.filter(({ tags }) => !tags.includes(triggerWord)).map(({ item }) => item)
    : [];
  const frequencyMap = new Map<string, WorkspaceImage[]>();

  for (const { item, tags } of tagEntries) {
    for (const tag of tags.filter((entry) => entry !== triggerWord)) {
      frequencyMap.set(tag, [...(frequencyMap.get(tag) ?? []), item]);
    }
  }

  const total = Math.max(1, captionable.length);
  const frequencies = [...frequencyMap.entries()]
    .map(([tag, tagItems]) => ({ tag, count: tagItems.length, percent: Math.round(tagItems.length / total * 100), items: tagItems }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
  const overused = frequencies.filter((entry) => entry.percent >= overusedThreshold).slice(0, 8);
  const rare = frequencies.filter((entry) => entry.count === 1).slice(0, 10);
  const inconsistent = frequencies
    .filter((entry) => entry.count >= 2 && entry.count <= Math.max(2, Math.round(total * 0.22)))
    .slice(0, 6)
    .map((entry) => ({ tag: entry.tag, items: entry.items, reason: 'Low support inside this target' }));
  const balanceScore = Math.max(0, Math.round(100 - overused.length * 8 - missingCaptionItems.length / total * 35 - rare.length * 1.5));

  return {
    totalCaptionable: captionable.length,
    captioned: captionable.length - missingCaptionItems.length,
    missingCaptionItems,
    triggerWord,
    triggerPresent: triggerWord ? tagEntries.filter(({ tags }) => tags.includes(triggerWord)).length : 0,
    triggerMissingItems,
    frequencies,
    overused,
    rare,
    inconsistent,
    balanceScore,
  };
};

const buildCoverageSections = ({
  dataset,
  datasetItems,
  projectCandidates,
  redundancyById,
  tagAnalysis,
  duplicateGroups,
}: {
  dataset?: Dataset;
  datasetItems: WorkspaceImage[];
  projectCandidates: WorkspaceImage[];
  redundancyById: Map<string, RedundancyProfile>;
  tagAnalysis: TagAnalysis;
  duplicateGroups: DuplicateGroup[];
}): CoverageSections => {
  const emptySections: CoverageSections = { add: [], remove: [], captions: [], balance: [] };
  if (!dataset) {
    return emptySections;
  }

  const totalDatasetItems = datasetItems.length;
  const orientationCounts = new Map<string, number>();
  const aspectCounts = new Map<AspectRatio, number>();
  for (const item of datasetItems) {
    orientationCounts.set(getOrientation(item), (orientationCounts.get(getOrientation(item)) ?? 0) + 1);
    aspectCounts.set(item.aspectRatio, (aspectCounts.get(item.aspectRatio) ?? 0) + 1);
  }
  const rarestOrientation = ['portrait', 'landscape', 'square'].sort(
    (left, right) => (orientationCounts.get(left) ?? 0) - (orientationCounts.get(right) ?? 0)
  )[0];
  const rarestAspect = [...ASPECT_RATIOS].sort(
    (left, right) => (aspectCounts.get(left) ?? 0) - (aspectCounts.get(right) ?? 0)
  )[0];
  const duplicateItemIds = new Set(duplicateGroups.flatMap((group) => group.items.map((item) => item.id)));

  const add = projectCandidates
    .map((item) => {
      const redundancy = redundancyById.get(item.id);
      const redundancyScore = Math.round((redundancy?.score ?? 0) * 100);
      const orientation = getOrientation(item);
      const orientationGain = orientation === rarestOrientation ? 20 : 0;
      const aspectGain = item.aspectRatio === rarestAspect ? 18 : 0;
      const tagCount = getCaptionTags(item, dataset).length;
      const candidateTags = getCaptionTags(item, dataset);
      const rareTagGain = candidateTags.filter((tag) => tagAnalysis.rare.some((entry) => entry.tag === tag)).length;
      const colorGain = (redundancy?.colorSimilarity ?? 0) < 0.62 ? 12 : 0;
      const tagGain = tagCount > 0 ? Math.min(20, rareTagGain * 8 + Math.min(tagCount, 6)) : 0;
      const redundancyPenalty = Math.round(redundancyScore * 0.35);
      const gain = Math.round(orientationGain + aspectGain + colorGain + tagGain - redundancyPenalty);
      const improves = [
        orientation === rarestOrientation ? 'orientation' : null,
        item.aspectRatio === rarestAspect ? 'aspect' : null,
        colorGain > 0 ? 'color diversity' : null,
        rareTagGain > 0 ? 'tag diversity' : null,
      ].filter((entry): entry is string => Boolean(entry));
      return {
        id: `add:${item.id}`,
        kind: 'add' as const,
        item,
        gain,
        redundancyScore,
        confidence: Math.max(30, Math.min(94, 54 + gain - Math.round(redundancyScore * 0.12))),
        reason: improves.length
          ? `Improves ${improves.join(', ')}`
          : `Adds ${orientation} / ${ASPECT_RATIO_LABELS[item.aspectRatio]} candidate`,
        improves,
      };
    })
    .filter((entry) => entry.gain > 0 && entry.redundancyScore < 65 && entry.improves.length > 0)
    .sort((left, right) => right.gain - left.gain || left.redundancyScore - right.redundancyScore)
    .slice(0, 8);

  const remove = datasetItems
    .filter((item) => Boolean(item.sourceImageId))
    .map((item) => {
      const redundancy = redundancyById.get(item.id);
      const redundancyScore = Math.round((redundancy?.score ?? 0) * 100);
      const duplicate = duplicateItemIds.has(item.id);
      const nearestTitle = redundancy?.nearestItems[0] ? getItemTitle(redundancy.nearestItems[0]) : '';
      return {
        id: `remove:${item.id}`,
        kind: 'remove' as const,
        item,
        redundancyScore,
        confidence: duplicate ? Math.max(88, redundancyScore) : Math.max(70, redundancyScore),
        reason: duplicate ? 'Part of a duplicate group' : 'High redundancy inside this Dataset',
        nearestTitle,
      };
    })
    .filter((entry) => duplicateItemIds.has(entry.item.id) || entry.redundancyScore >= 78)
    .sort((left, right) => right.confidence - left.confidence || right.redundancyScore - left.redundancyScore)
    .slice(0, 8);

  const captions = tagAnalysis.missingCaptionItems
    .map((item) => ({
      id: `caption:${item.id}`,
      kind: 'caption' as const,
      item,
      reason: tagAnalysis.triggerWord ? 'Missing caption and trigger word' : 'Missing caption',
    }))
    .sort((left, right) => getItemTitle(left.item).localeCompare(getItemTitle(right.item), undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 12);

  const balance: CoverageBalanceWarning[] = [];
  const addDominantWarning = (label: string, count: number, total: number, detail: string) => {
    if (total < 6 || count / total < 0.7) {
      return;
    }
    balance.push({
      kind: 'balance',
      id: `balance:${label.toLowerCase().replace(/\s+/g, '-')}`,
      label,
      detail,
      severity: count / total >= 0.85 ? 'warning' : 'info',
    });
  };
  const dominantOrientation = [...orientationCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (dominantOrientation) {
    addDominantWarning(
      `${dominantOrientation[0]} heavy`,
      dominantOrientation[1],
      totalDatasetItems,
      `${dominantOrientation[1]} of ${totalDatasetItems} analysis-ready assets share this orientation.`
    );
  }
  const dominantAspect = [...aspectCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (dominantAspect) {
    addDominantWarning(
      `${ASPECT_RATIO_LABELS[dominantAspect[0]]} heavy`,
      dominantAspect[1],
      totalDatasetItems,
      `${dominantAspect[1]} of ${totalDatasetItems} analysis-ready assets use this aspect preset.`
    );
  }
  for (const entry of tagAnalysis.overused.slice(0, 4)) {
    balance.push({
      kind: 'balance',
      id: `balance:tag:${entry.tag}`,
      label: `${entry.tag} overused`,
      detail: `${entry.percent}% of captioned analysis-ready assets use this tag.`,
      severity: entry.percent >= 65 ? 'warning' : 'info',
    });
  }

  return { add, remove, captions, balance };
};

const buildOutliers = ({
  items,
  pairMap,
  traitsById,
  tagAnalysis,
  dataset,
}: {
  items: WorkspaceImage[];
  pairMap: Map<string, SimilarityResult>;
  traitsById: Record<string, VisualTraits>;
  tagAnalysis: TagAnalysis;
  dataset?: Dataset;
}): Outlier[] => {
  const orientationCounts = new Map<string, number>();
  for (const item of items) {
    orientationCounts.set(getOrientation(item), (orientationCounts.get(getOrientation(item)) ?? 0) + 1);
  }
  const dominantOrientation = [...orientationCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];

  return items
    .map((item) => {
      const strongestSimilarity = Math.max(
        0,
        ...items.filter((entry) => entry.id !== item.id).map((entry) => getItemSimilarity(pairMap, item.id, entry.id))
      );
      const tags = getCaptionTags(item, dataset);
      const traits = traitsById[item.id];
      const reasons = [
        strongestSimilarity < 0.72 ? 'low similarity' : null,
        tags.length === 0 ? 'no caption' : null,
        dominantOrientation && getOrientation(item) !== dominantOrientation ? 'orientation mismatch' : null,
        traits && (traits.brightness < 0.22 || traits.brightness > 0.86) ? 'brightness outlier' : null,
        tags.some((tag) => tagAnalysis.rare.some((entry) => entry.tag === tag)) ? 'rare tag mix' : null,
      ].filter((reason): reason is string => Boolean(reason));
      return {
        id: `outlier:${item.id}`,
        item,
        score: Math.min(100, reasons.length * 22 + Math.round((1 - strongestSimilarity) * 32)),
        reasons,
      };
    })
    .filter((outlier) => outlier.reasons.length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 24);
};

const sortSimilarGroups = (groups: SimilarGroup[], sort: SimilarGroupSort): SimilarGroup[] =>
  [...groups].sort((left, right) => {
    if (sort === 'size') {
      return right.items.length - left.items.length || right.score - left.score;
    }
    if (sort === 'coverage') {
      return right.coverageValue - left.coverageValue || right.confidence - left.confidence;
    }
    if (sort === 'similarity') {
      return right.score - left.score || right.confidence - left.confidence;
    }
    return right.duplicatePressure - left.duplicatePressure || right.confidence - left.confidence;
  });

export const AnalysisTool = ({
  active = true,
  datasetId,
  projectDirectoryHandle,
  fileTarget,
  fileTargets,
  onOpenAssetContextMenu,
  onAutoAssemble,
  onUpdateDataset,
}: AnalysisToolProps = {}) => {
  const controlId = useId();
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const excludedProjectCategories = useMemo(() => workspaceSettings.excludedProjectCategories ?? [], [workspaceSettings.excludedProjectCategories]);
  const includedProjectCategories = useMemo(() => workspaceSettings.includedProjectCategories ?? [], [workspaceSettings.includedProjectCategories]);
  const dataset = useProjectStore((state) => datasetId && state.dataset?.id === datasetId ? state.dataset : undefined);
  const cleanupToolState = useProjectStore(
    (state) =>
      (state.toolState.clean as
        | { workingEdits?: Record<string, { blob: Blob; previewUrl: string; width: number; height: number }> }
        | undefined) ?? {}
  );
  const { addNotification } = useUIStore();
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const analysisInspectorRoot = useInspectorPortalRoot('analysis-inspector-root', active);
  const embeddingCacheRef = useRef<Record<string, EmbeddingCacheEntry>>({});
  const traitCacheRef = useRef<Record<string, TraitCacheEntry>>({});

  const [activeView, setActiveView] = useState<AnalysisView>('overview');
  const [similarityThreshold, setSimilarityThreshold] = useState(SIMILARITY_THRESHOLD_DEFAULT);
  const [similarSort, setSimilarSort] = useState<SimilarGroupSort>('risk');
  const [similarFilter, setSimilarFilter] = useState<SimilarGroupFilter>('all');
  const [overusedThreshold, setOverusedThreshold] = useState(TAG_OVERUSED_PERCENT);
  const scopedFileTargets = useMemo(() => fileTargets ?? (fileTarget ? [fileTarget] : []), [fileTargets, fileTarget]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(scopedFileTargets[0]?.workspaceImageId ?? null);
  const [itemEmbeddings, setItemEmbeddings] = useState<Record<string, Float32Array>>({});
  const [visualTraitsById, setVisualTraitsById] = useState<Record<string, VisualTraits>>({});
  const [workspaceFileAssets, setWorkspaceFileAssets] = useState<WorkspaceFileAsset[]>([]);
  const [psdPreviewBlobsById, setPsdPreviewBlobsById] = useState<Record<string, PsdPreviewCacheEntry>>({});

  const targetMode: AnalysisTargetMode = fileTargets !== undefined || fileTarget !== undefined ? 'file' : dataset ? 'dataset' : 'project';
  const allSourceImages = useMemo(() => Object.values(sourceImagesById).filter((image) =>
    !image.hidden && (targetMode !== 'project' || isProjectPathIncluded(image.originalFilePath, excludedProjectCategories, includedProjectCategories))
  ), [excludedProjectCategories, includedProjectCategories, sourceImagesById, targetMode]);
  const analysisInputKey = useMemo(
    () =>
      [
        targetMode,
        dataset?.id ?? '',
        dataset?.updatedAt ? new Date(dataset.updatedAt).getTime() : '',
        allSourceImages.map((image) => `${image.id}:${normalizeTags(image.tags).join(',')}`).sort().join('|'),
        assetPreviewRefreshKey,
        scopedFileTargets.map((target) => target.path).sort().join(','),
      ].join('::'),
    [
      dataset?.id,
      dataset?.updatedAt,
      allSourceImages,
      assetPreviewRefreshKey,
      scopedFileTargets,
      targetMode,
    ]
  );
  const sourceImages = useMemo(
    () => allSourceImages.filter((image) => targetMode !== 'dataset' || isProjectDatasetPath(image.originalFilePath)),
    [allSourceImages, targetMode]
  );

  useEffect(() => {
    if (!active || !projectDirectoryHandle) {
      setWorkspaceFileAssets([]);
      return;
    }

    let canceled = false;
    const loadFileAssets = async () => {
      try {
        const collectedAssets = targetMode === 'file' ? [] : await collectWorkspaceFileAssets(projectDirectoryHandle);
        const assets = targetMode === 'project'
          ? collectedAssets.filter((asset) => isProjectPathIncluded(asset.path, excludedProjectCategories, includedProjectCategories))
          : targetMode === 'dataset' ? collectedAssets.filter((asset) => isProjectDatasetPath(asset.path)) : collectedAssets;
        if (canceled) {
          return;
        }

        setWorkspaceFileAssets(assets);
        void generateMissingWorkspacePsdPreviews(
          projectDirectoryHandle,
          assets,
          (path, update) => {
            if (canceled) {
              return;
            }
            setWorkspaceFileAssets((currentAssets) =>
              currentAssets.map((asset) => (asset.path === path ? { ...asset, ...update } : asset))
            );
          },
          () => canceled
        );
      } catch (error) {
        if (!canceled) {
          setWorkspaceFileAssets([]);
          addNotification('warning', error instanceof Error ? error.message : 'File assets are unavailable for analysis');
        }
      }
    };

    void loadFileAssets();

    return () => {
      canceled = true;
    };
  }, [active, addNotification, assetPreviewRefreshKey, excludedProjectCategories, includedProjectCategories, projectDirectoryHandle, targetMode]);

  const baseItems = useMemo(
    () => toWorkspaceReviewAssets(sourceImages, workspaceFileAssets, cleanupToolState.workingEdits, []),
    [cleanupToolState.workingEdits, sourceImages, workspaceFileAssets]
  );
  const fileTargetItems = useMemo(
    () => scopedFileTargets.map((target) => {
      const existingItem = baseItems.find(
        (item) =>
          item.id === target.workspaceImageId ||
          item.assetPath === target.path ||
          getProjectRelativePath(item.assetPath ?? '') === getProjectRelativePath(target.path)
      );
      return createFileTargetItem(target, existingItem);
    }),
    [baseItems, scopedFileTargets]
  );
  const items = useMemo(() => {
    if (targetMode === 'file') {
      return fileTargetItems;
    }
    if (fileTargetItems.length === 0) {
      return baseItems;
    }
    const targetIds = new Set(fileTargetItems.map((item) => item.id));
    return [...fileTargetItems, ...baseItems.filter((item) => !targetIds.has(item.id))];
  }, [baseItems, fileTargetItems, targetMode]);
  const psdPreviewRequests = useMemo(
    () =>
      items
        .filter((item) => item.kind === 'psd' && item.previewUrl)
        .map((item) => ({
          id: item.id,
          fileName: item.fileName,
          previewUrl: item.previewUrl as string,
        })),
    [items]
  );
  const psdPreviewSignature = useMemo(
    () =>
      psdPreviewRequests
        .map((item) => `${item.id}:${item.previewUrl}`)
        .sort()
        .join('|'),
    [psdPreviewRequests]
  );

  useEffect(() => {
    let canceled = false;
    const activePsdIds = new Set(psdPreviewRequests.map((item) => item.id));

    setPsdPreviewBlobsById((previous) => {
      const nextEntries = Object.entries(previous).filter(([id]) => activePsdIds.has(id));
      return nextEntries.length === Object.keys(previous).length ? previous : Object.fromEntries(nextEntries);
    });

    const loadPsdPreviewBlobs = async () => {
      for (const item of psdPreviewRequests) {
        const previewUrl = item.previewUrl;
        const cached = psdPreviewBlobsById[item.id];
        if (cached?.previewUrl === previewUrl) {
          continue;
        }

        try {
          const response = await fetch(previewUrl);
          if (!response.ok) {
            throw new Error(`Preview request failed for ${item.fileName}`);
          }
          const blob = await response.blob();
          if (canceled) {
            return;
          }
          setPsdPreviewBlobsById((previous) => ({
            ...previous,
            [item.id]: { previewUrl, blob },
          }));
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn('[analysis] PSD preview blob unavailable', item.id, error);
          }
        }
      }
    };

    void loadPsdPreviewBlobs();
    return () => {
      canceled = true;
    };
  }, [psdPreviewBlobsById, psdPreviewRequests, psdPreviewSignature]);

  const visualItems = useMemo(
    () =>
      items
        .map((item) => createAnalysisVisualItem(item, psdPreviewBlobsById[item.id]))
        .filter((item): item is WorkspaceImage => item !== null && isAnalysisVisualAsset(item))
        .slice(0, GRAPH_LIMIT),
    [items, psdPreviewBlobsById]
  );
  const coverageCandidateItems = useMemo(
    () =>
      dataset
        ? toWorkspaceImages(
            allSourceImages.filter((image) => !isProjectDatasetPath(image.originalFilePath)),
            [],
            cleanupToolState.workingEdits
          ).slice(0, COVERAGE_CANDIDATE_LIMIT)
        : [],
    [allSourceImages, cleanupToolState.workingEdits, dataset]
  );
  const analysisVisualItems = useMemo(() => {
    const byId = new Map<string, WorkspaceImage>();
    for (const item of [...visualItems, ...coverageCandidateItems]) {
      byId.set(item.id, item);
    }
    return [...byId.values()];
  }, [coverageCandidateItems, visualItems]);
  const activeAnalysisItemIds = useMemo(() => analysisVisualItems.map((item) => item.id), [analysisVisualItems]);
  const activeAnalysisItemIdsSignature = useMemo(
    () => [...activeAnalysisItemIds].sort().join('|'),
    [activeAnalysisItemIds]
  );
  const pendingAnalysisAssets = useMemo(
    () =>
      items.filter(
        (item) =>
          item.kind === 'video' ||
          (item.kind === 'psd' && (!item.previewUrl || !psdPreviewBlobsById[item.id]))
      ),
    [items, psdPreviewBlobsById]
  );

  useEffect(() => {
    setSelectedItemId(fileTargetItems[0]?.id ?? null);
  }, [fileTargetItems, targetMode]);

  useEffect(() => {
    const activeIds = new Set(activeAnalysisItemIds);
    setItemEmbeddings((previous) => {
      const nextEntries = Object.entries(previous).filter(([id]) => activeIds.has(id));
      return nextEntries.length === Object.keys(previous).length ? previous : Object.fromEntries(nextEntries);
    });
    setVisualTraitsById((previous) => {
      const nextEntries = Object.entries(previous).filter(([id]) => activeIds.has(id));
      return nextEntries.length === Object.keys(previous).length ? previous : Object.fromEntries(nextEntries);
    });
  }, [activeAnalysisItemIds, activeAnalysisItemIdsSignature, analysisInputKey]);

  useEffect(() => {
    let canceled = false;
    const activeIds = new Set(analysisVisualItems.map((item) => item.id));

    const syncEmbeddings = async () => {
      const nextEmbeddings: Record<string, Float32Array> = {};
      for (const item of analysisVisualItems) {
        const sourceEmbedding = sourceImagesById[item.sourceImageId]?.embedding;
        if (sourceEmbedding) {
          nextEmbeddings[item.id] = sourceEmbedding;
          continue;
        }
        const cached = embeddingCacheRef.current[item.id];
        if (cached && cached.blob === item.imageData) {
          nextEmbeddings[item.id] = cached.embedding;
          continue;
        }
        try {
          const embedding = await generateEmbedding(item.imageData);
          if (canceled) {
            return;
          }
          embeddingCacheRef.current[item.id] = { blob: item.imageData, embedding };
          nextEmbeddings[item.id] = embedding;
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn('[analysis] embedding unavailable', item.id, error);
          }
        }
      }
      if (canceled) {
        return;
      }
      setItemEmbeddings((previous) => {
        const next: Record<string, Float32Array> = {};
        for (const id of activeIds) {
          const embedding = nextEmbeddings[id] ?? previous[id];
          if (embedding) {
            next[id] = embedding;
          }
        }
        return next;
      });
    };

    void syncEmbeddings();
    return () => {
      canceled = true;
    };
  }, [analysisVisualItems, sourceImagesById]);

  useEffect(() => {
    let canceled = false;
    const activeIds = new Set(analysisVisualItems.map((item) => item.id));

    const syncTraits = async () => {
      const nextTraits: Record<string, VisualTraits> = {};
      for (const item of analysisVisualItems) {
        const cached = traitCacheRef.current[item.id];
        if (cached && cached.blob === item.imageData) {
          nextTraits[item.id] = cached.traits;
          continue;
        }
        try {
          const traits = await buildVisualTraits(item);
          if (canceled) {
            return;
          }
          traitCacheRef.current[item.id] = { blob: item.imageData, traits };
          nextTraits[item.id] = traits;
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn('[analysis] visual traits unavailable', item.id, error);
          }
        }
      }
      if (canceled) {
        return;
      }
      setVisualTraitsById((previous) => {
        const next: Record<string, VisualTraits> = {};
        for (const id of activeIds) {
          const traits = nextTraits[id] ?? previous[id];
          if (traits) {
            next[id] = traits;
          }
        }
        return next;
      });
    };

    void syncTraits();
    return () => {
      canceled = true;
    };
  }, [analysisVisualItems]);

  const similarityData = useMemo(() => {
    const usableItems = analysisVisualItems.filter((item) => itemEmbeddings[item.id]);
    const usableTargetItems = visualItems.filter((item) => itemEmbeddings[item.id]);
    if (usableItems.length < 2) {
      return {
        items: usableTargetItems,
        pairMap: new Map<string, SimilarityResult>(),
        similarPairs: [] as SimilarityResult[],
        riskPairs: [] as SimilarityResult[],
        clusters: [] as SimilarityCluster[],
      };
    }

    const embeddings = new Map(usableItems.map((item) => [item.id, itemEmbeddings[item.id]]));
    const matrix = computeDistanceMatrix(embeddings);
    const allPairs = [...matrix.values()].flat();
    const pairMap = new Map(allPairs.map((pair) => [getPairKey(pair.imageId1, pair.imageId2), pair]));
    const similarPairs = findSimilarPairs(matrix, similarityThreshold);
    const riskPairs = findSimilarPairs(matrix, DUPLICATE_RISK_THRESHOLD);
    const clusters = performClustering(
      usableTargetItems.map((item) => item.id),
      matrix,
      similarityThreshold
    ).filter((cluster) => cluster.imageIds.length > 1);

    return { items: usableTargetItems, pairMap, similarPairs, riskPairs, clusters };
  }, [analysisVisualItems, itemEmbeddings, similarityThreshold, visualItems]);

  const itemById = useMemo(
    () => new Map([...items, ...coverageCandidateItems].map((item) => [item.id, item])),
    [coverageCandidateItems, items]
  );

  useEffect(() => {
    setSelectedItemId((currentId) => {
      if (!currentId || itemById.has(currentId)) {
        return currentId;
      }
      return null;
    });
  }, [analysisInputKey, itemById]);

  const visualItemById = useMemo(() => new Map(visualItems.map((item) => [item.id, item])), [visualItems]);
  const duplicateGroups = useMemo(
    () => buildDuplicateGroups(visualItems, visualTraitsById, similarityData.pairMap, dataset),
    [dataset, similarityData.pairMap, visualItems, visualTraitsById]
  );
  const tagAnalysis = useMemo(
    () => buildTagAnalysis(visualItems, dataset, overusedThreshold),
    [dataset, overusedThreshold, visualItems]
  );
  const similarGroups = useMemo(
    () =>
      buildSimilarGroups({
        clusters: similarityData.clusters,
        itemById: visualItemById,
        pairMap: similarityData.pairMap,
        traitsById: visualTraitsById,
        dataset,
        duplicateGroups,
      }),
    [dataset, duplicateGroups, similarityData.clusters, similarityData.pairMap, visualItemById, visualTraitsById]
  );
  const filteredSimilarGroups = useMemo(() => {
    const filtered = similarGroups.filter((group) => {
      if (similarFilter === 'high-confidence') {
        return group.confidence >= 88;
      }
      if (similarFilter === 'weak') {
        return group.confidence < 82;
      }
      if (similarFilter === 'same-color') {
        return group.colorSimilarity >= 82;
      }
      if (similarFilter === 'tag-mismatch') {
        return group.tagOverlap < 18 && group.score >= 86;
      }
      if (similarFilter === 'redundant') {
        return group.duplicatePressure >= 40 || group.coverageValue <= 34;
      }
      return true;
    });
    return sortSimilarGroups(filtered, similarSort);
  }, [similarFilter, similarGroups, similarSort]);
  const datasetItems = useMemo(
    () => visualItems.filter((item) => !dataset || isProjectDatasetPath(item.assetPath)),
    [dataset, visualItems]
  );
  const coverageCandidateRedundancyById = useMemo(
    () =>
      buildRedundancyProfile({
        items: coverageCandidateItems,
        referenceItems: datasetItems,
        pairMap: similarityData.pairMap,
        traitsById: visualTraitsById,
        dataset,
      }),
    [coverageCandidateItems, dataset, datasetItems, similarityData.pairMap, visualTraitsById]
  );
  const datasetRedundancyById = useMemo(
    () =>
      buildRedundancyProfile({
        items: datasetItems,
        referenceItems: datasetItems,
        pairMap: similarityData.pairMap,
        traitsById: visualTraitsById,
        dataset,
      }),
    [dataset, datasetItems, similarityData.pairMap, visualTraitsById]
  );
  const coverageSections = useMemo(() => {
    const redundancyById = new Map<string, RedundancyProfile>([
      ...coverageCandidateRedundancyById,
      ...datasetRedundancyById,
    ]);
    return buildCoverageSections({
      dataset,
      datasetItems,
      projectCandidates: coverageCandidateItems,
      redundancyById,
      tagAnalysis,
      duplicateGroups,
    });
  }, [
    coverageCandidateItems,
    coverageCandidateRedundancyById,
    dataset,
    datasetItems,
    datasetRedundancyById,
    duplicateGroups,
    tagAnalysis,
  ]);
  const coverageItemCount =
    coverageSections.add.length +
    coverageSections.remove.length +
    coverageSections.captions.length +
    coverageSections.balance.length;
  const outliers = useMemo(
    () => buildOutliers({ items: visualItems, pairMap: similarityData.pairMap, traitsById: visualTraitsById, tagAnalysis, dataset }),
    [dataset, similarityData.pairMap, tagAnalysis, visualItems, visualTraitsById]
  );
  const selectedItem = selectedItemId ? itemById.get(selectedItemId) ?? null : null;
  const previewItems = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const recommendation of [
      ...coverageSections.add,
      ...coverageSections.remove,
      ...coverageSections.captions,
    ]) {
      byId.set(recommendation.item.id, recommendation.item);
    }
    return [...byId.values()];
  }, [coverageSections, items]);
  const previewUrls = useWorkspacePreviewUrls(previewItems);

  const orientationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of visualItems) {
      counts.set(getOrientation(item), (counts.get(getOrientation(item)) ?? 0) + 1);
    }
    return counts;
  }, [visualItems]);
  const aspectCounts = useMemo(
    () =>
      Object.fromEntries(
        ASPECT_RATIOS.map((ratio) => [
          ratio,
          visualItems.filter((item) => item.aspectRatio === ratio).length,
        ])
      ) as Record<AspectRatio, number>,
    [visualItems]
  );
  const coverageScore = useMemo(() => {
    const orientationCoverage = ['portrait', 'landscape', 'square'].filter((orientation) => (orientationCounts.get(orientation) ?? 0) > 0).length / 3;
    const aspectCoverage = ASPECT_RATIOS.filter((ratio) => aspectCounts[ratio] > 0).length / ASPECT_RATIOS.length;
    const tagCoverage = tagAnalysis.totalCaptionable ? tagAnalysis.captioned / tagAnalysis.totalCaptionable : 0;
    return Math.round((orientationCoverage * 0.35 + aspectCoverage * 0.25 + tagCoverage * 0.25 + tagAnalysis.balanceScore / 100 * 0.15) * 100);
  }, [aspectCounts, orientationCounts, tagAnalysis.balanceScore, tagAnalysis.captioned, tagAnalysis.totalCaptionable]);
  const traitReadyCount = visualItems.filter((item) => visualTraitsById[item.id]).length;
  const embeddingReadyCount = visualItems.filter((item) => itemEmbeddings[item.id]).length;
  const preparingCount = visualItems.filter((item) => !visualTraitsById[item.id] || !itemEmbeddings[item.id]).length;

  const applyCoverageRecommendation = async (recommendation: CoverageAddRecommendation | CoverageRemoveRecommendation) => {
    if (!dataset || !onUpdateDataset) {
      return;
    }
    if (recommendation.kind === 'add') {
      await addAssetsToDataset([recommendation.item]);
      await flushProjectSave();
      addNotification('success', 'Asset added to Dataset');
      return;
    }
    await removeAssetsFromDataset([recommendation.item]);
    await flushProjectSave();
    addNotification('info', 'Asset removed from Dataset');
  };

  const updateTagsForItems = async (targetItems: WorkspaceImage[], updater: (tags: string[]) => string[]) => {
    if (targetItems.length === 0) {
      return;
    }

    try {
      await persistCaptionTagsForItems({
        items: targetItems,
        resolveTags: (item) => normalizeTags(updater(getCaptionTags(item))),
        directory: projectDirectoryHandle,
        flush: flushProjectSave,
      });
      addNotification('success', `Updated captions for ${targetItems.length} asset${targetItems.length === 1 ? '' : 's'}`);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Unable to save captions');
    }
  };

  const removeTagFromItems = (tag: string, targetItems: WorkspaceImage[]) => {
    void updateTagsForItems(targetItems, (tags) => tags.filter((entry) => entry !== tag));
  };

  const addTriggerToMissingItems = () => {
    if (!tagAnalysis.triggerWord) {
      addNotification('warning', 'Set a Dataset trigger word before applying it');
      return;
    }
    void updateTagsForItems(tagAnalysis.triggerMissingItems, (tags) => [tagAnalysis.triggerWord, ...tags]);
  };

  const targetTitle =
    targetMode === 'file'
      ? scopedFileTargets.length === 1
        ? `File Analysis: ${scopedFileTargets[0]?.name ?? 'Asset'}`
        : `Selection Analysis: ${scopedFileTargets.length} files`
      : targetMode === 'dataset'
        ? `Dataset Analysis: ${dataset?.name ?? 'Dataset'}`
        : 'Project Analysis';
  const targetDescription =
    targetMode === 'file'
      ? scopedFileTargets.length === 1
        ? 'Visual traits, nearest groups, and caption health for one asset.'
        : 'Visual traits, nearest groups, and caption health for the selected files.'
      : targetMode === 'dataset'
        ? 'Duplicate groups, coverage pressure, and tag health for this Dataset.'
        : 'Project-wide duplicate groups, similar groups, and dataset candidates.';

  const attentionItems = [
    duplicateGroups.length > 0 ? `${duplicateGroups.length} duplicate group${duplicateGroups.length === 1 ? '' : 's'} need review` : null,
    tagAnalysis.missingCaptionItems.length > 0 ? `${tagAnalysis.missingCaptionItems.length} asset${tagAnalysis.missingCaptionItems.length === 1 ? '' : 's'} without captions` : null,
    tagAnalysis.overused.length > 0 ? `${tagAnalysis.overused.length} overused tag${tagAnalysis.overused.length === 1 ? '' : 's'} can flatten the dataset` : null,
    outliers.length > 0 ? `${outliers.length} outlier${outliers.length === 1 ? '' : 's'} may need review` : null,
    coverageSections.add.length > 0 ? `${coverageSections.add.length} add candidate${coverageSections.add.length === 1 ? '' : 's'} available` : null,
    coverageSections.remove.length > 0 ? `${coverageSections.remove.length} redundant asset${coverageSections.remove.length === 1 ? '' : 's'} flagged` : null,
    coverageSections.balance.length > 0 ? `${coverageSections.balance.length} balance warning${coverageSections.balance.length === 1 ? '' : 's'}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  const healthItems = [
    { label: 'Duplicates', value: duplicateGroups.length === 0 ? 'No duplicate groups' : `${duplicateGroups.length} duplicate group${duplicateGroups.length === 1 ? '' : 's'}` },
    { label: 'Similar groups', value: String(similarGroups.length) },
    { label: 'Coverage', value: `${coverageScore}/100` },
    { label: 'Captions', value: `${tagAnalysis.captioned}/${tagAnalysis.totalCaptionable} captioned` },
    { label: 'Tags', value: `Balance ${tagAnalysis.balanceScore}/100` },
  ];

  const viewDefinitions = [
    { id: 'overview' as const, label: 'Overview', Icon: BarChart3, count: attentionItems.length },
    { id: 'duplicates' as const, label: 'Duplicates', Icon: GitCompareArrows, count: duplicateGroups.length },
    { id: 'similar' as const, label: 'Similar Groups', Icon: Layers3, count: filteredSimilarGroups.length },
    { id: 'coverage' as const, label: 'Coverage', Icon: Boxes, count: coverageItemCount },
    { id: 'tags' as const, label: 'Tags', Icon: Tags, count: tagAnalysis.frequencies.length },
    { id: 'outliers' as const, label: 'Outliers', Icon: SearchX, count: outliers.length },
  ];

  if (items.length === 0) {
    return <section className="flex min-h-80 items-center justify-center p-8 text-center" aria-label={targetTitle}>
      <div>
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <h3 className="text-sm font-medium">{targetMode === 'file' ? 'No selected files to analyze' : 'No visual assets to analyze'}</h3>
      </div>
    </section>;
  }

  const analysisControls = (
    <div className="space-y-3 text-xs">

      <div>
        <p className="mb-2 text-muted-foreground">View</p>
        <div className="grid gap-1.5">
          {viewDefinitions.map(({ id, label, Icon, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => id === 'coverage' && onAutoAssemble ? onAutoAssemble() : setActiveView(id)}
              className={`flex items-center justify-between rounded-md border px-2 py-2 text-left transition-colors ${
                activeView === id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-secondary'
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
              <span className="font-mono">{count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border bg-background p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <label htmlFor={`${controlId}-similarity`} className="flex items-center gap-1.5 text-muted-foreground">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Similarity
          </label>
          <span className="font-mono">{percent(similarityThreshold)}</span>
        </div>
        <input
          id={`${controlId}-similarity`}
          aria-valuetext={percent(similarityThreshold)}
          type="range"
          min="0.5"
          max="1"
          step="0.01"
          value={similarityThreshold}
          onChange={(event) => setSimilarityThreshold(Number(event.target.value))}
          className="w-full"
        />
        <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">About similarity</summary><p className="mt-1">Controls Similar Groups only. Duplicates use visual hash.</p></details>
      </div>

      {activeView === 'similar' ? (
        <div className="rounded-md border border-border bg-background p-3">
          <label htmlFor={`${controlId}-sort`} className="mb-2 block text-muted-foreground">Sort</label>
          <select
            id={`${controlId}-sort`}
            value={similarSort}
            onChange={(event) => setSimilarSort(event.target.value as SimilarGroupSort)}
            className="w-full rounded border border-border bg-background px-2 py-1 text-foreground"
          >
            <option value="risk">Risk</option>
            <option value="similarity">Similarity</option>
            <option value="coverage">Coverage value</option>
            <option value="size">Size</option>
          </select>
          <label htmlFor={`${controlId}-filter`} className="mb-2 mt-3 block text-muted-foreground">Filter</label>
          <select
            id={`${controlId}-filter`}
            value={similarFilter}
            onChange={(event) => setSimilarFilter(event.target.value as SimilarGroupFilter)}
            className="w-full rounded border border-border bg-background px-2 py-1 text-foreground"
          >
            <option value="all">All groups</option>
            <option value="high-confidence">High confidence</option>
            <option value="weak">Weak groups</option>
            <option value="same-color">Same color</option>
            <option value="tag-mismatch">Tag mismatch</option>
            <option value="redundant">Redundant</option>
          </select>
        </div>
      ) : null}

      {activeView === 'tags' ? (
        <div className="rounded-md border border-border bg-background p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label htmlFor={`${controlId}-overused`} className="text-muted-foreground">Overused threshold</label>
            <span className="font-mono">{overusedThreshold}%</span>
          </div>
          <input
            id={`${controlId}-overused`}
            aria-valuetext={`${overusedThreshold}%`}
            type="range"
            min="20"
            max="80"
            step="1"
            value={overusedThreshold}
            onChange={(event) => setOverusedThreshold(Number(event.target.value))}
            className="w-full"
          />
        </div>
      ) : null}


      {selectedItem ? (
        <div className="rounded-md border border-border bg-background p-3">
          <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Selected asset</p>
          <p className="mt-1 truncate text-sm font-semibold">{getItemTitle(selectedItem)}</p>
          <p className="mt-1 text-muted-foreground">
            {getOrientation(selectedItem)} · {getCaptionTags(selectedItem, dataset).length} tags
          </p>
          {visualTraitsById[selectedItem.id] ? (
            <div className="mt-2 flex items-center justify-between">
              <span className="text-muted-foreground">Colors</span>
              <TraitSwatches colors={visualTraitsById[selectedItem.id].dominantColors} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  const analysisInspectorPortal = analysisInspectorRoot ? createPortal(analysisControls, analysisInspectorRoot) : null;

  return (
    <div className="space-y-5">
      {analysisInspectorPortal}
      {analysisInspectorPortal ? null : analysisControls}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{targetTitle}</h3>
          <details className="mt-1 text-sm text-muted-foreground"><summary className="cursor-pointer">About this analysis</summary><p className="mt-2">{targetDescription}</p></details>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <MetricPill label="Analysis-ready" value={visualItems.length} />
          <MetricPill label="Traits" value={`${traitReadyCount}/${visualItems.length}`} />
          <MetricPill label="Embeddings" value={`${embeddingReadyCount}/${visualItems.length}`} />
          <MetricPill label="Preparing" value={preparingCount > 0 ? `${preparingCount} preparing` : 'Ready'} />
          <MetricPill label="Waiting" value={pendingAnalysisAssets.length} />
        </div>
      </div>

      {activeView === 'overview' ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(22rem,0.8fr)]">
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-base font-semibold">Needs attention</h3>
            <div className="mt-3 grid gap-2">
              {attentionItems.length ? attentionItems.map((item) => (
                <div key={item} className="rounded border border-border bg-background px-3 py-2 text-sm">{item}</div>
              )) : (
                <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No review items for the current analysis state.</div>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="text-base font-semibold">Review Summary</h3>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {healthItems.map((item) => (
                  <div key={item.label} className="rounded border border-border bg-background px-3 py-2">
                    <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{item.label}</p>
                    <p className="mt-1 text-sm font-semibold">{item.value}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="text-base font-semibold">Orientation Mix</h3>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(['portrait', 'landscape', 'square'] as const).map((orientation) => (
                  <div key={orientation} className="rounded border border-border bg-background px-3 py-2">
                    <p className="text-[10px] capitalize text-muted-foreground">{orientation}</p>
                    <p className="mt-1 font-mono text-sm font-semibold">{orientationCounts.get(orientation) ?? 0}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="text-base font-semibold">Aspect Ratio Presets</h3>
              <div className="mt-3 grid gap-2">
                {ASPECT_RATIOS.map((ratio) => (
                  <div key={ratio} className="flex items-center justify-between rounded border border-border bg-background px-3 py-2 text-sm">
                    <span>{ASPECT_RATIO_LABELS[ratio]}</span>
                    <span className="font-mono">{aspectCounts[ratio]}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {activeView === 'duplicates' ? (
        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Duplicate Groups</h3>
              <p className="text-xs text-muted-foreground">Exact, near, and high-confidence visual matches.</p>
            </div>
            <span className="text-xs text-muted-foreground">{duplicateGroups.length} groups</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {duplicateGroups.length ? duplicateGroups.map((group) => (
              <div key={group.id} className="rounded-md border border-border bg-background p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{group.reason}</p>
                    <p className="text-xs text-muted-foreground">
                      {group.items.length} assets · max hash distance {group.maxHashDistance ?? 'n/a'}
                    </p>
                  </div>
                  <MetricPill label="score" value={percent(group.score)} />
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {group.items.slice(0, 6).map((item) => (
                    <AnalysisAssetCard
                      key={item.id}
                      item={item}
                      previewUrl={previewUrls[item.id]}
                      selected={selectedItemId === item.id}
                      onSelect={() => setSelectedItemId(item.id)}
                      onOpenAssetContextMenu={onOpenAssetContextMenu}
                      footer={
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-2">
                          <p className="truncate text-[11px] font-medium text-white">{getItemTitle(item)}</p>
                          <p className="text-[10px] text-gray-300">{group.suggestedKeepId === item.id ? 'Suggested keep' : 'Duplicate candidate'}</p>
                        </div>
                      }
                    />
                  ))}
                </div>
              </div>
            )) : (
              <div className="col-span-full rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                No visual duplicate groups detected.
              </div>
            )}
          </div>
        </section>
      ) : null}

      {activeView === 'similar' ? (
        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Similar Groups</h3>
              <p className="text-xs text-muted-foreground">Useful visual similarity for coverage review, with reasons and metrics.</p>
            </div>
            <span className="text-xs text-muted-foreground">{filteredSimilarGroups.length} groups</span>
          </div>
          <div className="columns-1 gap-3 xl:columns-2 2xl:columns-3">
            {filteredSimilarGroups.length ? filteredSimilarGroups.map((group) => (
              <div key={group.id} className="mb-3 break-inside-avoid rounded-md border border-border bg-background p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">Group {group.id.replace('similar-', '')}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {group.reasons.map((reason) => (
                        <span key={reason} className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase text-muted-foreground">{reason}</span>
                      ))}
                    </div>
                  </div>
                  <MetricPill label="score" value={group.score} />
                </div>
                <div className="mb-3 grid grid-cols-2 gap-1.5 text-[11px]">
                  <MetricPill label="confidence" value={group.confidence} />
                  <MetricPill label="color" value={group.colorSimilarity} />
                  <MetricPill label="tags" value={group.tagOverlap} />
                  <MetricPill label="coverage" value={group.coverageValue} />
                  <MetricPill label="composition" value={group.compositionSimilarity} />
                  <MetricPill label="dup pressure" value={group.duplicatePressure} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {group.items.slice(0, 8).map((item) => (
                    <AnalysisAssetCard
                      key={item.id}
                      item={item}
                      previewUrl={previewUrls[item.id]}
                      selected={selectedItemId === item.id}
                      onSelect={() => setSelectedItemId(item.id)}
                      onOpenAssetContextMenu={onOpenAssetContextMenu}
                      footer={
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-2">
                          <p className="truncate text-[11px] font-medium text-white">{getItemTitle(item)}</p>
                          <p className="text-[10px] text-gray-300">{getOrientation(item)} · {getCaptionTags(item, dataset).length} tags</p>
                        </div>
                      }
                    />
                  ))}
                </div>
              </div>
            )) : (
              <div className="col-span-full rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                No similar groups match the current filter.
              </div>
            )}
          </div>
        </section>
      ) : null}

      {activeView === 'coverage' ? (
        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Coverage</h3>
              <p className="text-xs text-muted-foreground">Add candidates, redundant assets, missing captions, and balance warnings.</p>
            </div>
            <LocateFixed className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="grid gap-4">
            <div className="rounded-md border border-border bg-background p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">Add Candidates</h4>
                <span className="text-xs text-muted-foreground">{coverageSections.add.length} assets</span>
              </div>
              {coverageSections.add.length ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {coverageSections.add.map((recommendation) => (
                    <div key={recommendation.id} className="grid gap-3 rounded border border-border bg-card p-3 sm:grid-cols-[140px_minmax(0,1fr)]">
                      <AnalysisAssetCard
                        item={recommendation.item}
                        previewUrl={previewUrls[recommendation.item.id]}
                        selected={selectedItemId === recommendation.item.id}
                        onSelect={() => setSelectedItemId(recommendation.item.id)}
                        onOpenAssetContextMenu={onOpenAssetContextMenu}
                      />
                      <div className="min-w-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{getItemTitle(recommendation.item)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{recommendation.reason}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void applyCoverageRecommendation(recommendation)}
                            disabled={!dataset || !onUpdateDataset || !recommendation.item.sourceImageId}
                            className="shrink-0 rounded bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold uppercase text-emerald-500 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            Add
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1">
                          {recommendation.improves.map((entry) => (
                            <span key={entry} className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                              {entry}
                            </span>
                          ))}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          <MetricPill label="gain" value={`+${recommendation.gain}`} />
                          <MetricPill label="redundancy" value={recommendation.redundancyScore} />
                          <MetricPill label="confidence" value={recommendation.confidence} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                  No useful add candidates found outside this Dataset.
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-background p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">Remove Redundant</h4>
                <span className="text-xs text-muted-foreground">{coverageSections.remove.length} assets</span>
              </div>
              {coverageSections.remove.length ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {coverageSections.remove.map((recommendation) => (
                    <div key={recommendation.id} className="grid gap-3 rounded border border-border bg-card p-3 sm:grid-cols-[140px_minmax(0,1fr)]">
                      <AnalysisAssetCard
                        item={recommendation.item}
                        previewUrl={previewUrls[recommendation.item.id]}
                        selected={selectedItemId === recommendation.item.id}
                        onSelect={() => setSelectedItemId(recommendation.item.id)}
                        onOpenAssetContextMenu={onOpenAssetContextMenu}
                      />
                      <div className="min-w-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{getItemTitle(recommendation.item)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{recommendation.reason}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void applyCoverageRecommendation(recommendation)}
                            disabled={!dataset || !onUpdateDataset || !recommendation.item.sourceImageId}
                            className="shrink-0 rounded bg-amber-500/15 px-2 py-1 text-[10px] font-semibold uppercase text-amber-500 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            Remove
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          <MetricPill label="redundancy" value={recommendation.redundancyScore} />
                          <MetricPill label="confidence" value={recommendation.confidence} />
                        </div>
                        {recommendation.nearestTitle ? (
                          <p className="mt-3 rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                            Closest to {recommendation.nearestTitle}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                  No duplicate or high-redundancy source assets need removal.
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-background p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">Needs Captions</h4>
                <span className="text-xs text-muted-foreground">{coverageSections.captions.length} assets</span>
              </div>
              {coverageSections.captions.length ? (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {coverageSections.captions.map((recommendation) => (
                    <button
                      key={recommendation.id}
                      type="button"
                      onClick={() => setSelectedItemId(recommendation.item.id)}
                      className="rounded border border-border bg-card px-3 py-2 text-left text-xs hover:bg-secondary"
                    >
                      <p className="truncate font-medium">{getItemTitle(recommendation.item)}</p>
                      <p className="mt-1 text-muted-foreground">{recommendation.reason}</p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                  All analysis-ready assets have captions.
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-background p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">Balance Warnings</h4>
                <span className="text-xs text-muted-foreground">{coverageSections.balance.length} warnings</span>
              </div>
              {coverageSections.balance.length ? (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {coverageSections.balance.map((warning) => (
                    <div
                      key={warning.id}
                      className={`rounded border px-3 py-2 text-xs ${
                        warning.severity === 'warning'
                          ? 'border-amber-500/40 bg-amber-500/10'
                          : 'border-border bg-card'
                      }`}
                    >
                      <p className="font-medium">{warning.label}</p>
                      <p className="mt-1 text-muted-foreground">{warning.detail}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                  No obvious orientation, aspect, or tag balance warnings.
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {activeView === 'tags' ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-base font-semibold">Tag Frequency</h3>
            <div className="mt-3 overflow-hidden rounded border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-secondary text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Tag</th>
                    <th className="px-3 py-2 font-medium">Count</th>
                    <th className="px-3 py-2 font-medium">Share</th>
                    <th className="px-3 py-2 font-medium">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {tagAnalysis.frequencies.slice(0, 24).map((entry) => (
                    <tr key={entry.tag} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{entry.tag}</td>
                      <td className="px-3 py-2 font-mono">{entry.count}</td>
                      <td className="px-3 py-2 font-mono">{entry.percent}%</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {entry.percent >= TAG_OVERUSED_PERCENT ? 'overused' : entry.count === 1 ? 'rare' : 'stable'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="text-base font-semibold">Caption Health</h3>
              <div className="mt-3 grid gap-2">
                <MetricPill label="captioned" value={`${tagAnalysis.captioned}/${tagAnalysis.totalCaptionable}`} />
                <MetricPill label="missing" value={tagAnalysis.missingCaptionItems.length} />
                <MetricPill label="trigger" value={tagAnalysis.triggerWord || 'not set'} />
                <MetricPill label="trigger present" value={tagAnalysis.triggerWord ? `${tagAnalysis.triggerPresent}/${tagAnalysis.totalCaptionable}` : 'n/a'} />
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold">Trigger Word</h3>
                {tagAnalysis.triggerWord && tagAnalysis.triggerMissingItems.length > 0 ? (
                  <button
                    type="button"
                    onClick={addTriggerToMissingItems}
                    className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-secondary"
                  >
                    Add missing
                  </button>
                ) : null}
              </div>
              <div className="mt-3 grid gap-2">
                <MetricPill label="word" value={tagAnalysis.triggerWord || 'not set'} />
                <MetricPill label="present" value={tagAnalysis.triggerWord ? `${tagAnalysis.triggerPresent}/${tagAnalysis.totalCaptionable}` : 'n/a'} />
                <MetricPill label="missing" value={tagAnalysis.triggerMissingItems.length} />
              </div>
            </div>
            <TagIssueCard
              title="Overused tags"
              entries={tagAnalysis.overused.map((entry) => ({
                label: `${entry.tag} · ${entry.percent}%`,
                actionLabel: 'Remove',
                onAction: () => removeTagFromItems(entry.tag, entry.items),
              }))}
            />
            <TagIssueCard
              title="Rare tags"
              entries={tagAnalysis.rare.map((entry) => ({
                label: `${entry.tag} · 1 asset`,
                actionLabel: 'Remove',
                onAction: () => removeTagFromItems(entry.tag, entry.items),
              }))}
            />
            <TagIssueCard
              title="Inconsistent tags"
              entries={tagAnalysis.inconsistent.map((entry) => ({
                label: `${entry.tag} · ${entry.reason}`,
                actionLabel: 'Remove',
                onAction: () => removeTagFromItems(entry.tag, entry.items),
              }))}
            />
          </div>
        </section>
      ) : null}

      {activeView === 'outliers' ? (
        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Outliers</h3>
              <p className="text-xs text-muted-foreground">Assets that may not fit the target because of tags, orientation, brightness, or weak similarity.</p>
            </div>
            <span className="text-xs text-muted-foreground">{outliers.length} assets</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {outliers.length ? outliers.map((outlier) => (
              <div key={outlier.id} className="rounded-md border border-border bg-background p-3">
                <AnalysisAssetCard
                  item={outlier.item}
                  previewUrl={previewUrls[outlier.item.id]}
                  selected={selectedItemId === outlier.item.id}
                  onSelect={() => setSelectedItemId(outlier.item.id)}
                  onOpenAssetContextMenu={onOpenAssetContextMenu}
                />
                <div className="mt-3 flex flex-wrap gap-1">
                  <MetricPill label="score" value={outlier.score} />
                  {outlier.reasons.map((reason) => (
                    <span key={reason} className="rounded bg-secondary px-2 py-1 text-[10px] uppercase text-muted-foreground">{reason}</span>
                  ))}
                </div>
              </div>
            )) : (
              <div className="col-span-full rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                No obvious outliers detected.
              </div>
            )}
          </div>
        </section>
      ) : null}

      {pendingAnalysisAssets.length > 0 ? (
        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Waiting Assets</h3>
              <p className="text-xs text-muted-foreground">PSD assets join Analysis after preview generation. Video is not part of visual Analysis.</p>
            </div>
            <span className="text-xs text-muted-foreground">{pendingAnalysisAssets.length} assets</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {pendingAnalysisAssets.map((item) => (
              <div key={item.id} className="rounded border border-border bg-background px-3 py-2 text-xs">
                <p className="truncate font-medium">{getItemTitle(item)}</p>
                <p className="mt-1 text-muted-foreground">
                  {item.kind === 'video'
                    ? 'Video asset'
                    : item.previewStatus === 'failed'
                      ? 'Preview unavailable'
                      : 'Waiting for PSD preview'}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}


    </div>
  );
};

const TagIssueCard = ({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ label: string; actionLabel?: string; onAction?: () => void }>;
}) => (
  <div className="rounded-md border border-border bg-card p-4">
    <h3 className="text-base font-semibold">{title}</h3>
    <div className="mt-3 grid gap-2">
      {entries.length ? entries.slice(0, 8).map((entry) => (
        <div key={entry.label} className="flex items-center justify-between gap-3 rounded border border-border bg-background px-3 py-2 text-xs">
          <span className="min-w-0 truncate">{entry.label}</span>
          {entry.onAction && entry.actionLabel ? (
            <button
              type="button"
              onClick={entry.onAction}
              className="shrink-0 rounded border border-border px-2 py-1 font-medium hover:bg-secondary"
            >
              {entry.actionLabel}
            </button>
          ) : null}
        </div>
      )) : (
        <div className="rounded border border-dashed border-border p-4 text-center text-xs text-muted-foreground">No issues detected.</div>
      )}
    </div>
  </div>
);
