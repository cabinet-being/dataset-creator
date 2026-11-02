import { usePublishInspectorSelection } from '../../stores/useInspectorSelectionStore';
import { useOperation } from '../../hooks/useOperation';
import { flushProjectSave } from '../../hooks/useProjectSave';
import * as Dialog from '@radix-ui/react-dialog';
import { useId, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { AlertCircle, Plus, Plug, Sparkles, Upload, X } from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import {
  type LocalTaggerBundleSource,
  parseSelectedTagsCsv,
  predictLocalTags,
} from '../../services/tagging/localTaggerService';
import { readLocalTaggerSavedFile } from '../../services/tagging/localTaggerFileSettings';
import { connectLocalTaggerSource, disconnectLocalTaggerConnection, restoreSavedLocalTagger } from '../../services/tagging/localTaggerConnectionService';
import {
  getWorkspaceDisplayName,
  getWorkspaceKindBadgeClass,
  toWorkspaceReviewAssets,
  type WorkspaceFileAsset,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { collectWorkspaceFileAssets, generateMissingWorkspacePsdPreviews } from '../../lib/workspaceFileAssets';
import { isProjectPathIncluded } from '../../lib/projectCategories';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { orderWorkspaceItemsByDatasetOrder } from '../../lib/datasetAssets';
import { AssetGallery } from '../ui/AssetGallery';
import { resolveCurrentScope } from '../../lib/workspaceToolScope';
import { WorkspacePreviewCard } from '../ui/WorkspacePreviewCard';
import { persistCaptionTagsForItems as persistAssetCaptionTags } from '../../services/caption/captionMutationService';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { CaptionEditor } from '../caption/CaptionEditor';

type InsertMode = 'prepend' | 'append' | 'overwrite';

const canAutoTagItem = (item: WorkspaceImage): boolean =>
  item.kind === 'image' || item.kind === 'edited';

const canCaptionItem = (item: WorkspaceImage): boolean =>
  item.kind === 'image' || item.kind === 'edited' || item.kind === 'psd';

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  };

const parseTagInput = (value: string): string[] =>
  value
    .split(/[,;\n\r]+/)
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

const normalizeUniqueTags = (tags: string[]): string[] => {
  const nextTags: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const normalizedTag = tag.trim().toLowerCase();
    if (!normalizedTag || seen.has(normalizedTag)) {
      continue;
    }

    seen.add(normalizedTag);
    nextTags.push(normalizedTag);
  }

  return nextTags;
};

const parseCsvCells = (value: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const nextChar = value[index + 1];

    if (char === '"' && quoted && nextChar === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && (char === ',' || char === '\n' || char === '\r' || char === ';')) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
};

const parseSuggestionCsv = (value: string): string[] =>
  Array.from(
    new Set(
      parseCsvCells(value)
        .flatMap((cell) => parseTagInput(cell))
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));

const INSERT_MODE_LABELS: Record<InsertMode, string> = {
  prepend: 'Prepend',
  append: 'Append',
  overwrite: 'Overwrite',
};

const getCaptionTagClassName = (): string =>
  'inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground';

type TaggingCardProps = {
  item: WorkspaceImage;
  previewUrl?: string;
  onOpen: (itemId: string) => void;
  onSubmit: (itemId: string, value: string) => Promise<boolean>;
  onRemoveTag: (itemId: string, tag: string) => void;
  suggestions: string[];
  onOpenContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
};

const TaggingCard = memo(
  ({
    item,
    previewUrl,
    onOpen,
    onSubmit,
    onRemoveTag,
    suggestions,
    onOpenContextMenu,
  }: TaggingCardProps) => {
    const [inputValue, setInputValue] = useState('');
    const [saving, setSaving] = useState(false);
    const displayTags = useMemo(() => normalizeUniqueTags(item.tags ?? []), [item.tags]);
    const handleKeyDown = async (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (saving) return;
      const advance = event.ctrlKey || event.metaKey;
      const fieldScope = event.currentTarget.closest('[data-dock-view]');
      setSaving(true);
      try {
        if (await onSubmit(item.id, inputValue)) {
          setInputValue('');
          if (advance) {
            const fields = Array.from(fieldScope?.querySelectorAll<HTMLTextAreaElement>('[id^="caption-input-"]') ?? []);
            fields[fields.findIndex((field) => field.id === `caption-input-${item.id}`) + 1]?.focus();
          }
        }
      } finally { setSaving(false); }
    };

    return (
      <div className="overflow-hidden rounded-lg bg-card">
        <WorkspacePreviewCard
          item={item}
          previewUrl={previewUrl}
          className="gallery-masonry-item"
          onClick={() => onOpen(item.id)}
          onOpenContextMenu={onOpenContextMenu}
          footer={
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
              <div className="flex items-end justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-medium text-white">{getWorkspaceDisplayName(item)}</p>
                <span className={getWorkspaceKindBadgeClass(item.kind)}>
                  {item.label}
                </span>
              </div>
            </div>
          }
        />

        <div className="p-3 space-y-3">
          <div className="rounded-md border border-border bg-secondary/40 p-2 h-20 overflow-y-auto">
            <div className="flex flex-wrap gap-2 content-start">
              {displayTags.length > 0 ? (
                displayTags.map((tag) => (
                  <span
                    key={tag}
                    className={getCaptionTagClassName()}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => onRemoveTag(item.id, tag)}
                      className="hover:opacity-70"
                      aria-label={`Remove tag ${tag}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">No tags yet</span>
              )}
            </div>
          </div>

          <div onKeyDown={handleKeyDown}>
            <CaptionEditor
              value={inputValue}
              onChange={setInputValue}
              suggestions={suggestions}
              disabled={saving}
              placeholder="Tags"
              ariaLabel={`Tags for ${getWorkspaceDisplayName(item)}`}
              id={`caption-input-${item.id}`}
            />
          </div>
        </div>
      </div>
    );
  }
);

TaggingCard.displayName = 'TaggingCard';

type CaptionScopeTag = {
  tag: string;
  count: number;
};

type CaptionScopeControlsProps = {
  scopeItems: WorkspaceImage[];
  tags: CaptionScopeTag[];
  tagInput: string;
  suggestions: string[];
  insertMode: InsertMode;
  autoCaptionDisabled: boolean;
  autoCaptionBusy: boolean;
  autoCaptionTitle: string;
  onTagInputChange: (value: string) => void;
  onSubmitTags: () => void;
  onOpenAutoCaptionDialog: () => void;
  onInsertModeChange: (mode: InsertMode) => void;
  onRemoveTag: (tag: string) => void;
};

const CaptionScopeControls = ({
  scopeItems,
  tags,
  tagInput,
  suggestions,
  insertMode,
  autoCaptionDisabled,
  autoCaptionBusy,
  autoCaptionTitle,
  onTagInputChange,
  onSubmitTags,
  onOpenAutoCaptionDialog,
  onInsertModeChange,
  onRemoveTag,
}: CaptionScopeControlsProps) => {
  return (
  <div className="flex flex-wrap items-start gap-3">
    <div className="min-w-0 flex-1">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitTags();
        }}
        className="flex gap-2"
      >
        <div className="min-w-0 flex-1" onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.defaultPrevented && !event.nativeEvent.isComposing && !event.shiftKey) {
            event.preventDefault(); event.stopPropagation(); onSubmitTags();
          }
        }}><CaptionEditor value={tagInput} onChange={onTagInputChange} suggestions={suggestions} ariaLabel="Batch tags" placeholder="Tags" rows={2} /></div>
        <button
          type="submit"
          disabled={!tagInput.trim() || scopeItems.length === 0}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          title="Add tags"
          aria-label="Add tags"
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenAutoCaptionDialog}
          disabled={autoCaptionDisabled || scopeItems.length === 0}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          title={autoCaptionTitle}
          aria-label={autoCaptionTitle}
          aria-busy={autoCaptionBusy}
        >
          <Sparkles size={16} />
        </button>
      </form>

    </div>

    <div>
      <select
        aria-label="Caption insert mode"
        value={insertMode}
        onChange={(event) => onInsertModeChange(event.target.value as InsertMode)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        {(['prepend', 'append', 'overwrite'] as const).map((mode) => (
          <option key={mode} value={mode}>
            {INSERT_MODE_LABELS[mode]}
          </option>
        ))}
      </select>
    </div>

    {insertMode === 'overwrite' && tagInput.trim() && scopeItems.length > 0 && <p role="status" className="w-full text-xs text-muted-foreground">Replace {scopeItems.length} captions · {scopeItems[0].originalFileName ?? scopeItems[0].fileName}: {tagInput}</p>}
    <details className="w-full">
      <summary className="text-xs text-muted-foreground">{tags.length} tags in scope</summary>
      <div className="flex flex-wrap gap-2">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <span
              key={tag.tag}
              className={getCaptionTagClassName()}
            >
              {tag.tag}
              {scopeItems.length > 1 ? (
                <span className="opacity-70">{tag.count}/{scopeItems.length}</span>
              ) : null}
              <button
                type="button"
                onClick={() => onRemoveTag(tag.tag)}
                className="hover:opacity-70"
                aria-label={`Remove tag ${tag.tag}`}
              >
                <X size={12} />
              </button>
            </span>
          ))
        ) : (
          <span className="text-sm text-muted-foreground">No tags yet</span>
        )}
      </div>
    </details>
  </div>
);
}

type TaggingToolProps = {
  viewId?: string;
  selectedItemId?: string | null;
  scopedItemIds?: string[];
  singleFileMode?: boolean;
  active?: boolean;
  datasetId?: string;
  onOpenItem?: (itemId: string) => void;
  onOpenAssetContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
};

export const TaggingTool = ({
  viewId = 'tool:tagging',
  selectedItemId: selectedItemIdProp,
  scopedItemIds,
  singleFileMode = false,
  active = true,
  datasetId,
  onOpenItem,
  onOpenAssetContextMenu,
}: TaggingToolProps = {}) => {
  const controlId = useId();
  const operationRoot = useRef<HTMLDivElement>(null);
  const task = useOperation('Auto-caption', operationRoot, 'tool:tagging');
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const editedAssetsById = useProjectStore((state) => state.datasetItems);
  const updateTaggingConfig = useProjectStore((state) => state.updateTaggingConfig);
  const cleanupToolState = useProjectStore(
    (state) =>
      (state.toolState.clean as
        | { workingEdits?: Record<string, { blob: Blob; previewUrl: string; width: number; height: number }> }
        | undefined) ?? {}
  );
  const initialSelectedItemId = useProjectStore(
    (state) => (state.toolState.tagging as { selectedItemId?: string } | undefined)?.selectedItemId
  );
  const taggingConfig = useProjectStore((state) => state.taggingConfig);
  const dataset = useProjectStore((state) => state.dataset);
  const datasetTriggerWord = useMemo(
    () =>
      dataset.triggerWord.trim(),
    [dataset.triggerWord]
  );
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const { addNotification } = useUIStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectDirectoryHandle = useUIStore((state) => state.projectDirectoryHandle);
  const setTaggingToolbar = useUIStore((state) => state.setTaggingToolbar);
  const localTagger = useLocalTaggerStore((state) => state.bundle);
  const localTaggerStatus = useLocalTaggerStore((state) => state.status);
  const localTaggerMessage = useLocalTaggerStore((state) => state.message);
  const localTaggerProgress = useLocalTaggerStore((state) => state.progress);
  const autoTaggingProgress = useLocalTaggerStore((state) => state.autoTaggingProgress);
  const setLocalTaggerStatus = useLocalTaggerStore((state) => state.setStatus);
  const setLocalTaggerMessage = useLocalTaggerStore((state) => state.setMessage);
  const setAutoTaggingProgress = useLocalTaggerStore((state) => state.setAutoTaggingProgress);
  const savedFileNames = useLocalTaggerStore((state) => state.savedFileNames);

  const [newBlacklistTag, setNewBlacklistTag] = useState('');
  const [suggestionTags, setSuggestionTags] = useState<string[]>([]);
  const [suggestionFileName, setSuggestionFileName] = useState('');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedTagInput, setSelectedTagInput] = useState('');
  const [autoCaptionDialogOpen, setAutoCaptionDialogOpen] = useState(false);
  const [autoCaptionThreshold, setAutoCaptionThreshold] = useState(taggingConfig.threshold);
  const [autoCaptionMaxTags, setAutoCaptionMaxTags] = useState(taggingConfig.maxTags);
  const [fileAssets, setFileAssets] = useState<WorkspaceFileAsset[]>([]);
  const fallbackDirectoryInputRef = useRef<HTMLInputElement | null>(null);
  const suggestionCsvInputRef = useRef<HTMLInputElement | null>(null);
  const autoTaggingRunTokenRef = useRef(0);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const scopedItemIdSet = useMemo(
    () => (scopedItemIds !== undefined ? new Set(scopedItemIds) : null),
    [scopedItemIds]
  );
  const sourceImages = useMemo(
    () => Object.values(sourceImagesById).filter((image) =>
      (datasetId || scopedItemIds !== undefined || isProjectPathIncluded(image.originalFilePath, workspaceSettings.excludedProjectCategories ?? [], workspaceSettings.includedProjectCategories ?? []))
    ),
    [datasetId, scopedItemIds, sourceImagesById, workspaceSettings.excludedProjectCategories, workspaceSettings.includedProjectCategories]
  );
  const editedAssets = useMemo(
    () =>
      Object.values(editedAssetsById).filter((image) => !image.deleted),
    [editedAssetsById]
  );
  const items = useMemo(() => {
    const nextItems = toWorkspaceReviewAssets(
      sourceImages,
      fileAssets,
      cleanupToolState.workingEdits,
      editedAssets
    );

    const datasetItems = datasetId
      ? nextItems.filter((item) => isProjectDatasetPath(item.assetPath))
      : nextItems;
    const orderedItems = dataset
      ? orderWorkspaceItemsByDatasetOrder(datasetItems, dataset.assetOrder)
      : datasetItems;
    return scopedItemIdSet
      ? orderedItems.filter((item) => scopedItemIdSet.has(item.id))
      : orderedItems;
  }, [cleanupToolState.workingEdits, dataset, datasetId, fileAssets, sourceImages, editedAssets, scopedItemIdSet]);
  const previewUrls = useWorkspacePreviewUrls(items);
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const inspectorSelection = useMemo(() => selectedItem ? {
    title: getWorkspaceDisplayName(selectedItem), items: [selectedItem],
    detail: 'Edit the caption in this workspace. Changes use the same caption as export.',
  } : null, [selectedItem]);
  usePublishInspectorSelection(active, viewId, inspectorSelection);
  const canUseCaptionScopeItem = useCallback(
    (item: WorkspaceImage) =>
      dataset
        ? canCaptionItem(item)
        : item.kind === 'image' || item.kind === 'edited',
    [dataset]
  );
  const [galleryScope, setGalleryScope] = useState<WorkspaceImage[] | null>(null);
  const captionScopeItems = useMemo(
    () => (selectedItem && canUseCaptionScopeItem(selectedItem)
      ? [selectedItem]
      : selectedItem
        ? []
        : resolveCurrentScope(items, galleryScope).filter(canUseCaptionScopeItem)),
    [canUseCaptionScopeItem, items, selectedItem, galleryScope]
  );
  const autoCaptionScopeItems = useMemo(
    () => captionScopeItems.filter(canAutoTagItem),
    [captionScopeItems]
  );

  const canUseDirectoryPicker =
    typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';

  useEffect(() => {
    let canceled = false;

    if (!projectDirectoryHandle) {
      setFileAssets([]);
      return;
    }

    const loadFileAssets = async () => {
      try {
        const collectedAssets = await collectWorkspaceFileAssets(
          projectDirectoryHandle,
          undefined
        );
        const assets = datasetId
          ? collectedAssets.filter((asset) => isProjectDatasetPath(asset.path))
          : scopedItemIds !== undefined
            ? collectedAssets
          : collectedAssets.filter((asset) => isProjectPathIncluded(asset.path, workspaceSettings.excludedProjectCategories ?? [], workspaceSettings.includedProjectCategories ?? []));
        const pendingAssets = assets.map((asset) =>
          asset.kind === 'psd' && !asset.previewUrl ? { ...asset, previewStatus: 'queued' as const } : asset
        );
        if (!canceled) {
          setFileAssets(pendingAssets);
          void generateMissingWorkspacePsdPreviews(
            projectDirectoryHandle,
            pendingAssets,
            (path, update) => {
              setFileAssets((currentAssets) =>
                currentAssets.map((asset) => (asset.path === path ? { ...asset, ...update } : asset))
              );
            },
            () => canceled
          );
        }
      } catch (error) {
        if (!canceled) {
          setFileAssets([]);
          addNotification('warning', error instanceof Error ? error.message : 'Unable to read project file assets');
        }
      }
    };

    void loadFileAssets();

    return () => {
      canceled = true;
    };
  }, [addNotification, assetPreviewRefreshKey, datasetId, projectDirectoryHandle, scopedItemIds, workspaceSettings.excludedProjectCategories, workspaceSettings.includedProjectCategories]);

  useEffect(() => {
    if (selectedItemIdProp !== undefined) {
      setSelectedItemId(selectedItemIdProp);
      setSelectedTagInput('');
      return;
    }

    const nextSelectedItemId = selectedItemIdProp ?? initialSelectedItemId;
    if (nextSelectedItemId && nextSelectedItemId !== selectedItemId) {
      setSelectedItemId(nextSelectedItemId);
      setSelectedTagInput('');
    }
  }, [initialSelectedItemId, selectedItemId, selectedItemIdProp]);

  useEffect(() => {
    if (!active) {
      return;
    }
    setTaggingToolbar({ visible: Boolean(selectedItem) });
    return () => setTaggingToolbar({ visible: false });
  }, [active, selectedItem, setTaggingToolbar]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.log('[tool] current tool title rendered: Caption');
      console.log(`[tagging:model] model connected state on entering Caption tool: ${localTaggerStatus}`);
    }

    return () => {
      if (import.meta.env.DEV) {
        console.log(`[tagging:model] model connected state before leaving Caption tool: ${useLocalTaggerStore.getState().status}`);
        console.log('[tagging:model] Caption tool unmounted without implicit model disconnect');
      }
    };
  }, []);

  const manualTagSuggestions = useMemo(() => {
    const blacklist = new Set(taggingConfig.blacklist);
    const normalizedKeyword = datasetTriggerWord.trim().toLowerCase();

    const projectTags = items.flatMap((item) => item.tags ?? []);
    return normalizeUniqueTags([...(localTagger?.tags ?? []), ...suggestionTags, ...projectTags])
      .filter((tag) => tag !== normalizedKeyword && !blacklist.has(tag));
  }, [items, localTagger?.tags, suggestionTags, taggingConfig.blacklist, datasetTriggerWord]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      const keyword = datasetTriggerWord.trim().toLowerCase();
      const keywordInEditableTags = Boolean(
        keyword &&
          items.some((item) => (item.tags ?? []).some((tag) => tag.trim().toLowerCase() === keyword))
      );
      console.log(`[tagging] dataset keyword excluded from Caption tool tag state: ${!keywordInEditableTags}`);
    }
  }, [items, datasetTriggerWord]);

  useEffect(() => {
    if (selectedItemId && !selectedItem) {
      setSelectedItemId(null);
      setSelectedTagInput('');
    }
  }, [selectedItem, selectedItemId]);

  const buildNextTags = useCallback(
    (existingTags: string[] = [], incomingTags: string[], mode: InsertMode = taggingConfig.insertMode) => {
      const blacklist = new Set(taggingConfig.blacklist.map((tag) => tag.trim().toLowerCase()));
      const normalizedKeyword = datasetTriggerWord.trim().toLowerCase();
      const normalizedIncoming = normalizeUniqueTags(incomingTags)
        .filter((tag) => tag !== normalizedKeyword)
        .filter((tag) => !blacklist.has(tag));
      const normalizedExisting = normalizeUniqueTags(existingTags)
        .filter((tag) => tag !== normalizedKeyword)
        .filter((tag) => !blacklist.has(tag));
      const nextTags: string[] = [];
      const seen = new Set<string>();
      const addTag = (tag: string) => {
        if (!tag || seen.has(tag)) {
          return;
        }
        seen.add(tag);
        nextTags.push(tag);
      };

      if (mode === 'prepend' || mode === 'overwrite') {
        normalizedIncoming.forEach(addTag);
      }
      if (mode !== 'overwrite') {
        normalizedExisting.forEach(addTag);
      }
      if (mode === 'append') {
        normalizedIncoming.forEach(addTag);
      }

      return nextTags;
    },
    [datasetTriggerWord, taggingConfig.blacklist, taggingConfig.insertMode]
  );

  const persistCaptionTagsForItems = useCallback(
    async (targetItems: WorkspaceImage[], resolveTags: (item: WorkspaceImage) => string[]) => {
      const targets = targetItems.filter(canUseCaptionScopeItem);
      if (!targets.length) return false;
      try {
        await persistAssetCaptionTags({
          items: targets,
          resolveTags: (item) => normalizeUniqueTags(resolveTags(item)),
          directory: projectDirectoryHandle,
          flush: flushProjectSave,
        });
        return true;
      } catch (reason) { addNotification('error', reason instanceof Error ? reason.message : 'Unable to save captions'); return false; }
    }, [addNotification, canUseCaptionScopeItem, projectDirectoryHandle]
  );

  const updateWorkspaceImageTags = useCallback(
    (item: WorkspaceImage, tags: string[]) => {
      void persistCaptionTagsForItems([item], () => tags);
    },
    [persistCaptionTagsForItems]
  );

  const applyTagsToItem = useCallback(
    async (itemId: string, rawValue: string) => {
      const parsedTags = parseTagInput(rawValue);
      const item = items.find((entry) => entry.id === itemId);
      if (!item) {
        return false;
      }

      const skippedDuplicates: string[] = [];
      const existingTags = new Set((item.tags ?? []).map((tag) => tag.trim().toLowerCase()));
      skippedDuplicates.push(...parsedTags.filter((tag) => existingTags.has(tag)));

      if (import.meta.env.DEV) {
        console.log(`[tagging] raw input string: ${rawValue}`);
        console.log(`[tagging] parsed tag list: ${JSON.stringify(parsedTags)}`);
        console.log(`[tagging] skipped duplicate tags: ${JSON.stringify(skippedDuplicates)}`);
        console.log('[tagging] dataset keyword insertion skipped during manual tagging');
      }

      if (!parsedTags.length) { await flushProjectSave(); return true; }
      return persistCaptionTagsForItems([item], (entry) => buildNextTags(entry.tags, parsedTags));
    },
    [buildNextTags, datasetTriggerWord, items, persistCaptionTagsForItems]
  );

  const mergeAutoTags = useCallback(
    (existingTags: string[] = [], predictedTags: string[]) => {
      if (import.meta.env.DEV) {
        console.log('[tagging] dataset keyword insertion skipped during auto-caption');
      }

      return buildNextTags(existingTags, predictedTags);
    },
    [buildNextTags]
  );

  const connectBundleSource = useCallback(async (source: LocalTaggerBundleSource) => {
    const connected = await connectLocalTaggerSource(source);
    if (connected) addNotification('success', `Local caption model ready: ${source.name}`);
    else addNotification('error', useLocalTaggerStore.getState().message);
  }, [addNotification]);

  useEffect(() => {
    if (!savedFileNames.tags) return;
    let cancelled = false;
    void (async () => {
      try {
        const tagsFile = await readLocalTaggerSavedFile('tags', false);
        if (!tagsFile) return;
        const csv = await tagsFile.text();
        const tags = (() => {
          try { return parseSelectedTagsCsv(csv); }
          catch { return parseSuggestionCsv(csv); }
        })();
        if (!cancelled) {
          setSuggestionTags(tags);
          setSuggestionFileName(tagsFile.name);
        }
      } catch (error) {
        if (!cancelled) console.warn('Failed to load saved tags CSV from Settings', error);
      }
    })();
    return () => { cancelled = true; };
  }, [savedFileNames]);

  const handleConnectModel = useCallback(async () => {
    if (savedFileNames.model && savedFileNames.tags) {
      await restoreSavedLocalTagger(true);
      return;
    }

    if (!window.isSecureContext) {
      setLocalTaggerStatus('not-ready');
      setLocalTaggerMessage(
        'Directory picker access requires a secure context. Use localhost or HTTPS, or try the folder upload fallback.'
      );
    }

    if (canUseDirectoryPicker) {
      try {
        const handle = await (window as DirectoryPickerWindow).showDirectoryPicker?.();

        if (!handle) {
          return;
        }

        await connectBundleSource({ kind: 'directory', name: handle.name, handle });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setLocalTaggerMessage('Model connection canceled.');
          return;
        }

        setLocalTaggerStatus('not-ready');
        setLocalTaggerMessage(error instanceof Error ? error.message : 'Could not open the model folder.');
      }
    }

    fallbackDirectoryInputRef.current?.click();
  }, [canUseDirectoryPicker, connectBundleSource, savedFileNames.model, savedFileNames.tags]);

  const handleFallbackFolderSelected = useCallback(
    async (files: FileList | null) => {
      const selectedFiles = Array.from(files ?? []);
      if (fallbackDirectoryInputRef.current) {
        fallbackDirectoryInputRef.current.value = '';
      }

      if (selectedFiles.length === 0) {
        setLocalTaggerMessage('Model connection canceled.');
        return;
      }

      const firstPath = selectedFiles[0].webkitRelativePath || selectedFiles[0].name;
      const folderName = firstPath.split('/').filter(Boolean)[0] ?? 'Local model';
      await connectBundleSource({ kind: 'files', name: folderName, files: selectedFiles });
    },
    [connectBundleSource]
  );

  const handleDisconnectModel = useCallback(() => {
    disconnectLocalTaggerConnection();
  }, []);

  const handleSuggestionCsvSelected = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (suggestionCsvInputRef.current) {
        suggestionCsvInputRef.current.value = '';
      }

      if (!file) {
        return;
      }

      try {
        const tags = parseSuggestionCsv(await file.text());
        setSuggestionTags(tags);
        setSuggestionFileName(file.name);

        addNotification('success', `Loaded ${tags.length} tag suggestion(s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not read tag suggestions CSV.';
        addNotification('error', message);
      }
    },
    [addNotification]
  );

  const removeTagsFromAllImages = useCallback(
    (tagsToRemove: string[]) => {
      const blocked = new Set(tagsToRemove);
      const targets = items.filter((item) => (item.tags ?? []).some((tag) => blocked.has(tag)));
      if (targets.length) {
        void persistCaptionTagsForItems(targets, (item) => (item.tags ?? []).filter((tag) => !blocked.has(tag)));
      }
    },
    [items, persistCaptionTagsForItems]
  );

  const handleAddBlacklistTags = () => {
    const parsedTags = parseTagInput(newBlacklistTag);
    const nextBlacklist = [...taggingConfig.blacklist];
    const addedTags: string[] = [];

    for (const tag of parsedTags) {
      if (!tag || nextBlacklist.includes(tag)) {
        continue;
      }

      nextBlacklist.push(tag);
      addedTags.push(tag);
    }

    if (addedTags.length === 0) {
      return;
    }

    updateTaggingConfig({
      blacklist: nextBlacklist,
    });
    removeTagsFromAllImages(addedTags);
    setNewBlacklistTag('');
  };

  const handleRemoveBlacklistTag = (tag: string) => {
    updateTaggingConfig({
      blacklist: taggingConfig.blacklist.filter((entry) => entry !== tag),
    });
  };

  const handleSubmitScopeTags = useCallback(() => {
    const parsedTags = parseTagInput(selectedTagInput);
    if (parsedTags.length === 0 || captionScopeItems.length === 0) {
      return;
    }

    void persistCaptionTagsForItems(captionScopeItems, (item) => buildNextTags(item.tags, parsedTags))
      .then((changed) => {
        if (changed) {
          addNotification(
            'success',
            `Updated captions for ${captionScopeItems.length} asset${captionScopeItems.length === 1 ? '' : 's'}`
          );
          setSelectedTagInput('');
        }
      });
  }, [
    addNotification,
    buildNextTags,
    captionScopeItems,
    persistCaptionTagsForItems,
    selectedTagInput,
  ]);

  const handleRemoveScopeTag = useCallback(
    (tag: string) => {
      if (captionScopeItems.length === 0) {
        return;
      }

      const normalizedTag = tag.trim().toLowerCase();
      void persistCaptionTagsForItems(
        captionScopeItems,
        (item) => (item.tags ?? []).filter((entry) => entry.trim().toLowerCase() !== normalizedTag)
      );
    },
    [captionScopeItems, persistCaptionTagsForItems]
  );

  const handleRunLocalAutoTagging = useCallback(async () => {
    if (!localTagger || localTaggerStatus !== 'ready') {
      setLocalTaggerStatus('not-ready');
      setLocalTaggerMessage('Connect and validate a supported model folder before running auto-caption.');
      return;
    }

    if (autoCaptionScopeItems.length === 0) {
      addNotification('warning', 'No image assets available for auto-caption');
      return;
    }

    const runToken = autoTaggingRunTokenRef.current + 1;
    autoTaggingRunTokenRef.current = runToken;
    task.start(() => { autoTaggingRunTokenRef.current += 1; setLocalTaggerMessage('Stopping auto-caption…'); setAutoCaptionDialogOpen(false); }, autoCaptionScopeItems.length);
    setLocalTaggerStatus('running');
    setAutoTaggingProgress({ completed: 0, total: autoCaptionScopeItems.length });

    try {
      let changedItemCount = 0;
      const predictedTagsByItemId = new Map<string, string[]>();

      for (let index = 0; index < autoCaptionScopeItems.length; index += 1) {
        const item = autoCaptionScopeItems[index];
        if (autoTaggingRunTokenRef.current !== runToken) {
          autoTaggingRunTokenRef.current += 1;
          setAutoTaggingProgress({ completed: 0, total: 0 });
          setLocalTaggerStatus('ready');
          setLocalTaggerMessage('Ready. Auto-caption stopped.');
          task.finish('cancelled', 'Captions were not changed.');
          return;
        }
        setAutoTaggingProgress({ completed: index, total: autoCaptionScopeItems.length });
        task.progress(index, autoCaptionScopeItems.length);

        const predictions = await predictLocalTags(
          localTagger,
          item.imageData,
          autoCaptionThreshold,
          autoCaptionMaxTags
        );
        if (autoTaggingRunTokenRef.current !== runToken) { task.finish('cancelled', 'Captions were not changed.'); setLocalTaggerStatus('ready'); setLocalTaggerMessage('Ready. Auto-caption stopped.'); return; }
        predictedTagsByItemId.set(item.id, predictions.map((prediction) => prediction.tag));

        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      if (autoTaggingRunTokenRef.current !== runToken) { task.finish('cancelled', 'Captions were not changed.'); setLocalTaggerStatus('ready'); setLocalTaggerMessage('Ready. Auto-caption stopped.'); return; }
      const changed = await persistCaptionTagsForItems(autoCaptionScopeItems, (item) =>
        mergeAutoTags(item.tags ?? [], predictedTagsByItemId.get(item.id) ?? [])
      );
      changedItemCount = changed ? predictedTagsByItemId.size : 0;
      if (!changed) { task.finish('failed', 'Captions could not be saved. Check the save status and retry.'); setLocalTaggerStatus('ready'); return; }
      task.progress(autoCaptionScopeItems.length, autoCaptionScopeItems.length);
      task.finish('completed', `${changedItemCount} captions updated`);

      setAutoTaggingProgress({ completed: autoCaptionScopeItems.length, total: autoCaptionScopeItems.length });
      setLocalTaggerStatus('ready');
      setLocalTaggerMessage(`Ready. Last run updated ${changedItemCount} image(s).`);
      addNotification('success', `Auto-caption completed for ${autoCaptionScopeItems.length} image(s)`);
      setAutoCaptionDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime inference failed.';
      task.finish('failed', message);
      setLocalTaggerStatus('not-ready');
      setLocalTaggerMessage(message);
      addNotification('error', message);
    }
  }, [
    addNotification,
    autoCaptionMaxTags,
    autoCaptionScopeItems,
    autoCaptionThreshold,
    autoTaggingProgress.completed,
    autoTaggingProgress.total,
    dataset,
    datasetId,
    task,
    localTagger,
    localTaggerStatus,
    mergeAutoTags,
    persistCaptionTagsForItems,
    setAutoTaggingProgress,
    setLocalTaggerMessage,
    setLocalTaggerStatus,
  ]);

  const handleCancelAutoCaption = useCallback(() => {
    autoTaggingRunTokenRef.current += 1;
    if (localTagger) setLocalTaggerMessage('Stopping auto-caption…');
    setAutoCaptionDialogOpen(false);
  }, [
    autoTaggingProgress.completed,
    autoTaggingProgress.total,
    localTagger,
    setAutoTaggingProgress,
    setLocalTaggerMessage,
    setLocalTaggerStatus,
  ]);

  const handleRemoveTag = useCallback(
    (itemId: string, tag: string) => {
      const item = items.find((entry) => entry.id === itemId);
      if (!item?.tags) {
        return;
      }

      const normalizedTag = tag.trim().toLowerCase();
      const nextTags = item.tags.filter((entry) => entry.trim().toLowerCase() !== normalizedTag);
      updateWorkspaceImageTags(item, nextTags);

      if (import.meta.env.DEV) {
        console.log(`[tagging] tag removed: ${tag}`);
        console.log(`[tagging] image id affected: ${itemId}`);
        console.log(`[tagging] resulting tag list for that image: ${JSON.stringify(nextTags)}`);
      }
    },
    [items, updateWorkspaceImageTags]
  );

  const selectedPreviewUrl = selectedItem ? previewUrls[selectedItem.id] : undefined;
  const scopeTags = useMemo<CaptionScopeTag[]>(() => {
    const counts = new Map<string, number>();
    for (const item of captionScopeItems) {
      for (const tag of normalizeUniqueTags(item.tags ?? [])) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts, ([tag, count]) => ({ tag, count }))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
  }, [captionScopeItems]);
  const scopeAutoCaptionDisabled =
    !localTagger ||
    localTaggerStatus !== 'ready' ||
    autoCaptionScopeItems.length === 0;
  const scopeAutoCaptionTitle = autoCaptionScopeItems.length === 0
    ? 'Auto-caption is only available for image assets'
    : localTaggerStatus === 'running'
      ? 'Auto-caption running'
      : 'Auto-caption';
  const captionScopeControls = (
    <CaptionScopeControls
      scopeItems={captionScopeItems}
      tags={scopeTags}
      tagInput={selectedTagInput}
      suggestions={manualTagSuggestions}
      insertMode={taggingConfig.insertMode}
      autoCaptionDisabled={scopeAutoCaptionDisabled}
      autoCaptionBusy={localTaggerStatus === 'running'}
      autoCaptionTitle={scopeAutoCaptionTitle}
      onTagInputChange={setSelectedTagInput}
      onSubmitTags={handleSubmitScopeTags}
      onOpenAutoCaptionDialog={() => {
        setAutoCaptionThreshold(taggingConfig.threshold);
        setAutoCaptionMaxTags(taggingConfig.maxTags);
        setAutoCaptionDialogOpen(true);
      }}
      onInsertModeChange={(mode) => updateTaggingConfig({ insertMode: mode })}
      onRemoveTag={handleRemoveScopeTag}
    />
  );
  const selectedView = selectedItem ? (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="min-h-0 flex-1">
        <div className="relative h-full min-h-0 overflow-hidden rounded-lg bg-black">
          {!singleFileMode ? (
            <button
              type="button"
              onClick={() => {
                setSelectedItemId(null);
                setSelectedTagInput('');
              }}
              className="absolute right-3 top-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-black/65 text-white shadow hover:bg-black/85"
              title="Back to captions"
              aria-label="Back to captions"
            >
              <X size={16} />
            </button>
          ) : null}
          {selectedPreviewUrl ? (
            <img
              src={selectedPreviewUrl}
              alt={getWorkspaceDisplayName(selectedItem)}
              className="h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">
              Preview unavailable
            </div>
          )}
        </div>

      </div>
    </div>
  ) : null;

  const captionInspectorPortal = null;
  const inlineCaptionControls = <div className="rounded-lg border border-border p-3"><div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{captionScopeItems.length} files</span><button type="button" className="rounded border border-border px-2 py-1 text-foreground hover:bg-secondary" onClick={() => setSettingsOpen(true)}>Caption settings</button></div>{captionScopeControls}</div>;

  return (
    <div ref={operationRoot} className="flex h-full min-h-0 flex-col gap-4 overflow-auto">
      {selectedView}
      {inlineCaptionControls}
      {captionInspectorPortal}

      <Dialog.Root
        open={autoCaptionDialogOpen}
        onOpenChange={(open) => {
          if (!open && localTaggerStatus === 'running') {
            handleCancelAutoCaption();
            return;
          }
          setAutoCaptionDialogOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">Auto-caption</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Configure inference for {autoCaptionScopeItems.length} asset{autoCaptionScopeItems.length === 1 ? '' : 's'}.
                </Dialog.Description>
              </div>
              <button
                type="button"
                onClick={handleCancelAutoCaption}
                className="rounded-md p-2 transition-colors hover:bg-secondary"
                aria-label="Close Auto-caption"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold">
                    {localTaggerStatus === 'ready' || localTaggerStatus === 'running'
                      ? localTagger?.name ?? 'Ready'
                      : localTaggerStatus === 'not-ready'
                        ? 'Model not ready'
                        : 'No model connected'}
                  </h4>
                  {localTaggerStatus === 'ready' ? (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-xs text-emerald-500">Ready</span>
                  ) : null}
                  {localTaggerStatus === 'running' ? (
                    <span className="rounded-full bg-primary/15 px-2 py-1 text-xs text-primary">Running</span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{localTaggerMessage}</p>
                {localTagger ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Runtime: {localTagger.runtime.toUpperCase()} | Tags: {localTagger.tags.length.toLocaleString()}
                  </p>
                ) : null}
              </div>

              <div>
                <label htmlFor={`${controlId}-threshold`} className="mb-2 block text-xs text-muted-foreground">Threshold</label>
                <input
                  id={`${controlId}-threshold`}
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={autoCaptionThreshold}
                  onChange={(event) => setAutoCaptionThreshold(parseFloat(event.target.value))}
                  disabled={localTaggerStatus === 'running'}
                  className="w-full"
                />
                <p className="mt-1 text-xs font-mono">{autoCaptionThreshold.toFixed(2)}</p>
              </div>

              <div>
                <label htmlFor={`${controlId}-max-tags`} className="mb-2 block text-xs text-muted-foreground">Max tags</label>
                <input
                  id={`${controlId}-max-tags`}
                  type="number"
                  min="1"
                  max="50"
                  value={autoCaptionMaxTags}
                  onChange={(event) => setAutoCaptionMaxTags(Math.max(1, parseInt(event.target.value || '1', 10)))}
                  disabled={localTaggerStatus === 'running'}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>

              {localTaggerStatus === 'running' ? (
                <div>
                  <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>Progress</span>
                    <span>{autoTaggingProgress.completed} / {autoTaggingProgress.total}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{
                        width: `${autoTaggingProgress.total > 0
                          ? Math.round((autoTaggingProgress.completed / autoTaggingProgress.total) * 100)
                          : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancelAutoCaption}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleRunLocalAutoTagging()}
                  disabled={
                    localTaggerStatus === 'running' ||
                    !localTagger ||
                    localTaggerStatus !== 'ready' ||
                    autoCaptionScopeItems.length === 0
                  }
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Sparkles size={16} />
                  Auto-caption
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[min(840px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">Caption Settings</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Configure the local model, blacklist, and manual tag suggestions.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md p-2 transition-colors hover:bg-secondary"
                  aria-label="Close Caption Settings"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>

            <div className="space-y-5">
              <section className="rounded-lg border border-border bg-secondary/20 p-4">
                <h3 className="mb-3 text-sm font-semibold">Auto-caption Model</h3>
                <div className="mb-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-md border border-border bg-background p-3">
                    <p className="text-xs text-muted-foreground">Settings model</p>
                    <p className="mt-1 truncate text-sm font-medium">
                      {savedFileNames.model ?? 'No model.onnx selected'}
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-background p-3">
                    <p className="text-xs text-muted-foreground">Settings tags</p>
                    <p className="mt-1 truncate text-sm font-medium">
                      {savedFileNames.tags ?? 'No selected_tags.csv selected'}
                    </p>
                  </div>
                </div>
                <div className="mt-4 rounded-md border border-border bg-background p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold">
                      {localTaggerStatus === 'ready' || localTaggerStatus === 'running'
                        ? localTagger?.name ?? 'Ready'
                        : localTaggerStatus === 'not-ready'
                          ? 'Model not ready'
                          : 'No model connected'}
                    </h4>
                    {localTaggerStatus === 'ready' ? (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-xs text-emerald-500">
                        Ready
                      </span>
                    ) : null}
                    {localTaggerStatus === 'running' ? (
                      <span className="rounded-full bg-primary/15 px-2 py-1 text-xs text-primary">
                        Running
                      </span>
                    ) : null}
                    {localTaggerStatus === 'not-ready' ? (
                      <span className="rounded-full bg-destructive/15 px-2 py-1 text-xs text-destructive">
                        Not ready
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-2 text-sm text-muted-foreground">{localTaggerMessage}</p>
                  {localTaggerProgress ? (
                    <p className="mt-1 text-xs text-muted-foreground">{localTaggerProgress}</p>
                  ) : null}
                  {localTagger ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Runtime: {localTagger.runtime.toUpperCase()} | Tags:{' '}
                      {localTagger.tags.length.toLocaleString()} | Input:{' '}
                      {localTagger.inputWidth}x{localTagger.inputHeight} {localTagger.layout.toUpperCase()}
                    </p>
                  ) : null}
                  {!canUseDirectoryPicker ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Directory picker unavailable; folder upload fallback is used when supported.
                    </p>
                  ) : null}
                  {localTaggerStatus === 'running' ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Auto-caption {autoTaggingProgress.completed} of {autoTaggingProgress.total} images...
                    </p>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {localTagger ? (
                    <button
                      type="button"
                      onClick={handleDisconnectModel}
                      disabled={localTaggerStatus === 'running'}
                      className="inline-flex items-center gap-2 rounded-md bg-secondary px-4 py-2 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <X size={16} />
                      Disconnect model
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleConnectModel()}
                      disabled={localTaggerStatus === 'loading' || localTaggerStatus === 'running'}
                      className="inline-flex items-center gap-2 rounded-md bg-secondary px-4 py-2 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Plug size={16} />
                      Connect model
                    </button>
                  )}
                </div>
              </section>

              <section className="rounded-lg border border-border bg-secondary/20 p-4">
                <h3 className="mb-3 text-sm font-semibold">Blacklist</h3>
                <input
                  type="text"
                  aria-label="Tags to block"
                  value={newBlacklistTag}
                  onChange={(event) => setNewBlacklistTag(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddBlacklistTags();
                    }
                  }}
                  placeholder="tag_to_block, another_tag"
                  className="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <div className="flex flex-wrap gap-2">
                  {taggingConfig.blacklist.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleRemoveBlacklistTag(tag)}
                      className="inline-flex items-center gap-1 rounded bg-destructive/15 px-2 py-1 text-xs text-destructive hover:bg-destructive/25"
                    >
                      {tag}
                      <X size={12} />
                    </button>
                  ))}
                </div>
              </section>

              <section className="rounded-lg border border-border bg-secondary/20 p-4">
                <h3 className="mb-3 text-sm font-semibold">Manual Tag Suggestions</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => suggestionCsvInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-md bg-secondary px-4 py-2 text-sm transition-colors hover:bg-muted"
                  >
                    <Upload size={16} />
                    Load CSV
                  </button>
                  <span className="text-sm text-muted-foreground">
                    {suggestionFileName
                      ? `${suggestionFileName} - ${suggestionTags.length} suggestions`
                      : 'No CSV loaded'}
                  </span>
                </div>
              </section>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <input
        ref={(node) => {
          fallbackDirectoryInputRef.current = node;
          node?.setAttribute('webkitdirectory', '');
          node?.setAttribute('directory', '');
        }}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void handleFallbackFolderSelected(event.target.files)}
        aria-hidden="true"
      />
      <input
        ref={suggestionCsvInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => void handleSuggestionCsvSelected(event.target.files)}
        aria-hidden="true"
      />

      <div className={selectedItem ? 'hidden' : undefined}>
        {items.length === 0 || (singleFileMode && !selectedItem) ? (
          <div className="py-12 text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">
              {singleFileMode ? 'Selected asset is no longer available.' : 'No assets to tag.'}
            </p>
          </div>
        ) : (
          <AssetGallery
            active={active}
            onScopeChange={setGalleryScope}
            items={items}
            renderItem={(item) => (
              <TaggingCard
                item={item}
                previewUrl={previewUrls[item.id]}
                onOpen={onOpenItem ?? setSelectedItemId}
                onSubmit={applyTagsToItem}
                onRemoveTag={handleRemoveTag}
                suggestions={manualTagSuggestions}
                onOpenContextMenu={onOpenAssetContextMenu}
              />
            )}
          />
        )}
      </div>

    </div>
  );
};
