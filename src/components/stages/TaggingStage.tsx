import * as Dialog from '@radix-ui/react-dialog';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Plus, Plug, Sparkles, Upload, X } from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import {
  connectLocalTaggerBundle,
  LocalTaggerBundleSource,
  parseSelectedTagsCsv,
  predictLocalTags,
} from '../../services/tagging/localTaggerService';
import {
  deleteLocalTaggerFileHandle,
  ensureLocalTaggerFileReadPermission,
  getLocalTaggerFileHandle,
} from '../../services/tagging/localTaggerFileSettings';
import {
  getWorkspaceKindBadgeClass,
  toWorkspaceReviewAssets,
  type WorkspaceFileAsset,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { collectWorkspaceFileAssets, generateMissingWorkspacePsdPreviews } from '../../lib/workspaceFileAssets';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { useInspectorPortalRoot } from '../../hooks/useInspectorPortalRoot';
import { orderWorkspaceItemsByDatasetOrder } from '../../lib/datasetAssets';
import { BrickMasonry } from '../ui/BrickMasonry';
import { WorkspacePreviewCard } from '../ui/WorkspacePreviewCard';
import type { Dataset } from '../../types';

type SuggestionDropdownPosition = { top: number; left: number; width: number };
type InsertMode = 'prepend' | 'append' | 'overwrite';

const canAutoTagItem = (item: WorkspaceImage): boolean =>
  item.kind === 'image' || item.kind === 'synthetic';

const canCaptionItem = (item: WorkspaceImage): boolean =>
  item.kind === 'image' || item.kind === 'synthetic' || item.kind === 'psd';

const DATASET_OVERWRITE_CAPTIONS_WARNING =
  'Enable Overwrite captions in Dataset Inspector before editing Dataset captions';

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

const getCurrentTagFragment = (value: string): string => {
  const fragments = value.split(',');
  return fragments[fragments.length - 1]?.trim().toLowerCase() ?? '';
};

const replaceCurrentTagFragment = (value: string, suggestion: string): string => {
  const fragments = value.split(',');
  fragments[fragments.length - 1] = suggestion;
  return fragments.map((fragment) => fragment.trim()).filter(Boolean).join(', ');
};

const INSERT_MODE_LABELS: Record<InsertMode, string> = {
  prepend: 'Prepend',
  append: 'Append',
  overwrite: 'Overwrite',
};

const getCaptionTagClassName = (highlightUnknown: boolean): string =>
  highlightUnknown
    ? 'inline-flex items-center gap-1 rounded border border-amber-500/70 bg-amber-500/20 px-2 py-1 text-xs text-amber-950 dark:text-amber-100'
    : 'inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground';

type TaggingCardProps = {
  item: WorkspaceImage;
  previewUrl?: string;
  onOpen: (itemId: string) => void;
  onSubmit: (itemId: string, value: string) => boolean;
  onRemoveTag: (itemId: string, tag: string) => void;
  suggestions: string[];
  knownTags: Set<string>;
  captionActionsDisabled?: boolean;
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
    knownTags,
    captionActionsDisabled = false,
    onOpenContextMenu,
  }: TaggingCardProps) => {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const dropdownRef = useRef<HTMLDivElement | null>(null);
    const suggestionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const [dropdownPosition, setDropdownPosition] = useState<SuggestionDropdownPosition | null>(null);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const fragment = getCurrentTagFragment(inputValue);
    const displayTags = useMemo(() => normalizeUniqueTags(item.tags ?? []), [item.tags]);
    const displayTagSet = useMemo(() => new Set(displayTags), [displayTags]);
    const filteredSuggestions = useMemo(() => {
      if (!fragment) {
        return [];
      }

      const nextSuggestions: string[] = [];
      const seen = new Set<string>();

      for (const tag of suggestions) {
        if (seen.has(tag) || !tag.includes(fragment) || displayTagSet.has(tag)) {
          continue;
        }

        seen.add(tag);
        nextSuggestions.push(tag);

        if (nextSuggestions.length >= 24) {
          break;
        }
      }

      return nextSuggestions;
    }, [displayTagSet, fragment, suggestions]);
    const hasSuggestions = filteredSuggestions.length > 0;
    const shouldShowDropdown = hasSuggestions && isDropdownOpen;

    useEffect(() => {
      setActiveSuggestionIndex(0);
    }, [inputValue, filteredSuggestions.length]);

    useEffect(() => {
      suggestionButtonRefs.current = suggestionButtonRefs.current.slice(0, filteredSuggestions.length);
    }, [filteredSuggestions.length]);

    useEffect(() => {
      if (!hasSuggestions) {
        setIsDropdownOpen(false);
      }
    }, [hasSuggestions]);

    const updateDropdownPosition = useCallback(() => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) {
        setDropdownPosition(null);
        return;
      }

      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    }, []);

    useEffect(() => {
      if (!shouldShowDropdown) {
        setDropdownPosition(null);
        return;
      }

      updateDropdownPosition();
      window.addEventListener('resize', updateDropdownPosition);
      window.addEventListener('scroll', updateDropdownPosition, true);

      return () => {
        window.removeEventListener('resize', updateDropdownPosition);
        window.removeEventListener('scroll', updateDropdownPosition, true);
      };
    }, [shouldShowDropdown, updateDropdownPosition]);

    useEffect(() => {
      if (!shouldShowDropdown) {
        return;
      }

      const isInsideTagInput = (target: EventTarget | null) =>
        target instanceof Node &&
        (inputRef.current?.contains(target) || dropdownRef.current?.contains(target));

      const handlePointerDown = (event: PointerEvent) => {
        if (!isInsideTagInput(event.target)) {
          setIsDropdownOpen(false);
        }
      };

      const handleFocusIn = (event: FocusEvent) => {
        if (!isInsideTagInput(event.target)) {
          setIsDropdownOpen(false);
        }
      };

      document.addEventListener('pointerdown', handlePointerDown);
      document.addEventListener('focusin', handleFocusIn);

      return () => {
        document.removeEventListener('pointerdown', handlePointerDown);
        document.removeEventListener('focusin', handleFocusIn);
      };
    }, [shouldShowDropdown]);

    const addSuggestion = (tag: string) => {
      if (captionActionsDisabled) {
        return;
      }
      const nextValue = replaceCurrentTagFragment(inputValue, tag);
      setInputValue(nextValue);
      setIsDropdownOpen(false);
      window.requestAnimationFrame(() => {
        if (onSubmit(item.id, nextValue)) {
          setInputValue('');
        }
        inputRef.current?.focus();
      });
    };

    const focusSuggestion = (index: number) => {
      if (!hasSuggestions) {
        return;
      }

      setIsDropdownOpen(true);
      const nextIndex = (index + filteredSuggestions.length) % filteredSuggestions.length;
      setActiveSuggestionIndex(nextIndex);
      window.requestAnimationFrame(() => suggestionButtonRefs.current[nextIndex]?.focus());
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
                <p className="min-w-0 truncate text-sm font-medium text-white">{item.fileName}</p>
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
                    className={getCaptionTagClassName(knownTags.size > 0 && !knownTags.has(tag))}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => onRemoveTag(item.id, tag)}
                      disabled={captionActionsDisabled}
                      className="hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
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

          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(event) => {
                setInputValue(event.target.value);
                setIsDropdownOpen(true);
                window.requestAnimationFrame(updateDropdownPosition);
              }}
              onFocus={() => {
                setIsDropdownOpen(true);
                updateDropdownPosition();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (onSubmit(item.id, inputValue)) {
                    setInputValue('');
                    setIsDropdownOpen(false);
                  }
                }

                if (event.key === 'Escape') {
                  event.preventDefault();
                  setIsDropdownOpen(false);
                  inputRef.current?.blur();
                }

                if (event.key === 'Tab' && hasSuggestions) {
                  event.preventDefault();
                  focusSuggestion(activeSuggestionIndex);
                }

                if (event.key === 'ArrowDown' && hasSuggestions) {
                  event.preventDefault();
                  focusSuggestion(activeSuggestionIndex + 1);
                }

                if (event.key === 'ArrowUp' && hasSuggestions) {
                  event.preventDefault();
                  focusSuggestion(activeSuggestionIndex - 1);
                }
              }}
              placeholder="Add tags with commas, then press Enter"
              disabled={captionActionsDisabled}
              aria-autocomplete="list"
              aria-expanded={shouldShowDropdown}
              aria-controls={`tag-suggestions-${item.id}`}
              aria-activedescendant={
                shouldShowDropdown ? `tag-suggestion-${item.id}-${activeSuggestionIndex}` : undefined
              }
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm disabled:cursor-not-allowed disabled:opacity-50"
            />
            {shouldShowDropdown && dropdownPosition
              ? createPortal(
              <div
                ref={dropdownRef}
                id={`tag-suggestions-${item.id}`}
                role="listbox"
                className="fixed z-[1000] max-h-[9.25rem] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
                style={{
                  top: dropdownPosition.top,
                  left: dropdownPosition.left,
                  width: dropdownPosition.width,
                }}
              >
                {filteredSuggestions.map((tag, index) => (
                  <button
                    key={`${tag}-${index}`}
                    ref={(node) => {
                      suggestionButtonRefs.current[index] = node;
                    }}
                    id={`tag-suggestion-${item.id}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSuggestionIndex}
                    onFocus={() => setActiveSuggestionIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => addSuggestion(tag)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addSuggestion(tag);
                      }

                      if (event.key === 'Escape') {
                        event.preventDefault();
                        inputRef.current?.focus();
                      }

                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        focusSuggestion(index + 1);
                      }

                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        focusSuggestion(index - 1);
                      }

                      if (event.key === 'Tab') {
                        event.preventDefault();
                        focusSuggestion(index + 1);
                      }
                    }}
                    className={`block w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      index === activeSuggestionIndex
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-secondary'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>,
                  document.body
                )
              : null}
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
  knownTags: Set<string>;
  insertMode: InsertMode;
  captionActionsDisabled: boolean;
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
  knownTags,
  insertMode,
  captionActionsDisabled,
  autoCaptionDisabled,
  autoCaptionBusy,
  autoCaptionTitle,
  onTagInputChange,
  onSubmitTags,
  onOpenAutoCaptionDialog,
  onInsertModeChange,
  onRemoveTag,
}: CaptionScopeControlsProps) => (
  <>
    <div className="mb-4">
      <label className="mb-2 block text-xs text-muted-foreground">Add tags</label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitTags();
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={tagInput}
          onChange={(event) => onTagInputChange(event.target.value)}
          placeholder="tag1, tag2"
          list="selected-tag-suggestions"
          disabled={captionActionsDisabled}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={!tagInput.trim() || captionActionsDisabled || scopeItems.length === 0}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          title="Add tags"
          aria-label="Add tags"
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenAutoCaptionDialog}
          disabled={autoCaptionDisabled || captionActionsDisabled || scopeItems.length === 0}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          title={autoCaptionTitle}
          aria-label={autoCaptionTitle}
          aria-busy={autoCaptionBusy}
        >
          <Sparkles size={16} />
        </button>
      </form>
      <datalist id="selected-tag-suggestions">
        {suggestions.slice(0, 200).map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>

    <div className="mb-4">
      <label className="mb-2 block text-xs text-muted-foreground">Insert Mode</label>
      <select
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

    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Tags</h4>
        <span className="text-xs text-muted-foreground">{tags.length}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <span
              key={tag.tag}
              className={getCaptionTagClassName(knownTags.size > 0 && !knownTags.has(tag.tag))}
            >
              {tag.tag}
              {scopeItems.length > 1 ? (
                <span className="opacity-70">{tag.count}/{scopeItems.length}</span>
              ) : null}
              <button
                type="button"
                onClick={() => onRemoveTag(tag.tag)}
                disabled={captionActionsDisabled}
                className="hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
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
    </div>
  </>
);

type TaggingStageProps = {
  selectedItemId?: string | null;
  singleFileMode?: boolean;
  active?: boolean;
  datasetId?: string;
  onUpdateDataset?: (
    updates: Partial<Pick<Dataset, 'assetIds' | 'assetPaths' | 'psdAssetPaths' | 'overwriteCaptions' | 'captionOverrides'>>
  ) => void | Promise<void>;
  onOpenItem?: (itemId: string) => void;
  onOpenAssetContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
};

export const TaggingStage = ({
  selectedItemId: selectedItemIdProp,
  singleFileMode = false,
  active = true,
  datasetId,
  onUpdateDataset,
  onOpenItem,
  onOpenAssetContextMenu,
}: TaggingStageProps = {}) => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const syntheticImagesById = useProjectStore((state) => state.datasetItems);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const updateTaggingConfig = useProjectStore((state) => state.updateTaggingConfig);
  const updateWorkspaceSettings = useProjectStore((state) => state.updateWorkspaceSettings);
  const cleanupStageState = useProjectStore(
    (state) =>
      (state.stageState.clean as
        | { workingEdits?: Record<string, { blob: Blob; previewUrl: string; width: number; height: number }> }
        | undefined) ?? {}
  );
  const initialSelectedItemId = useProjectStore(
    (state) => (state.stageState.tagging as { selectedItemId?: string } | undefined)?.selectedItemId
  );
  const taggingConfig = useProjectStore((state) => state.taggingConfig);
  const datasetsById = useProjectStore((state) => state.datasets);
  const dataset = useProjectStore((state) => (datasetId ? state.datasets[datasetId] : undefined));
  const datasetTriggerWord = useMemo(
    () =>
      dataset?.triggerWord.trim() ||
      Object.values(datasetsById).find((entry) => entry.triggerWord.trim())?.triggerWord.trim() ||
      '',
    [dataset?.triggerWord, datasetsById]
  );
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const { addNotification, taggingModals, setTaggingModal } = useUIStore();
  const projectDirectoryHandle = useUIStore((state) => state.projectDirectoryHandle);
  const setTaggingToolbar = useUIStore((state) => state.setTaggingToolbar);
  const localTagger = useLocalTaggerStore((state) => state.bundle);
  const localTaggerStatus = useLocalTaggerStore((state) => state.status);
  const localTaggerMessage = useLocalTaggerStore((state) => state.message);
  const localTaggerProgress = useLocalTaggerStore((state) => state.progress);
  const autoTaggingProgress = useLocalTaggerStore((state) => state.autoTaggingProgress);
  const setLocalTagger = useLocalTaggerStore((state) => state.setBundle);
  const setLocalTaggerStatus = useLocalTaggerStore((state) => state.setStatus);
  const setLocalTaggerMessage = useLocalTaggerStore((state) => state.setMessage);
  const setLocalTaggerProgress = useLocalTaggerStore((state) => state.setProgress);
  const setAutoTaggingProgress = useLocalTaggerStore((state) => state.setAutoTaggingProgress);
  const disconnectLocalTagger = useLocalTaggerStore((state) => state.disconnect);

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
  const autoConnectSettingsKeyRef = useRef<string | null>(null);
  const savedSuggestionLoadKeyRef = useRef<string | null>(null);
  const autoTaggingRunTokenRef = useRef(0);
  const datasetAssetIds = useMemo(() => new Set(dataset?.assetIds ?? []), [dataset?.assetIds]);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const datasetAssetPaths = useMemo(
    () => new Set([...(dataset?.assetPaths ?? []), ...(dataset?.psdAssetPaths ?? [])]),
    [dataset?.assetPaths, dataset?.psdAssetPaths]
  );
  const sourceImages = useMemo(
    () => Object.values(sourceImagesById).filter((image) => !datasetId || datasetAssetIds.has(image.id)),
    [datasetAssetIds, datasetId, sourceImagesById]
  );
  const syntheticImages = useMemo(
    () =>
      Object.values(syntheticImagesById).filter(
        (image) => !image.deleted && (!datasetId || datasetAssetIds.has(image.sourceImageId))
      ),
    [datasetAssetIds, datasetId, syntheticImagesById]
  );
  const items = useMemo(() => {
    const nextItems = toWorkspaceReviewAssets(
      sourceImages,
      fileAssets,
      cleanupStageState.workingEdits,
      syntheticImages
    ).map((item) => {
      if (!datasetId || !dataset?.overwriteCaptions) {
        return item;
      }
      return {
        ...item,
        tags: (dataset.captionOverrides ?? {})[item.id] ?? item.tags,
      };
    });

    return dataset
      ? orderWorkspaceItemsByDatasetOrder(nextItems, dataset.assetOrder, dataset.assetIds)
      : nextItems;
  }, [cleanupStageState.workingEdits, dataset, datasetId, fileAssets, sourceImages, syntheticImages]);
  const previewUrls = useWorkspacePreviewUrls(items);
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const canUseCaptionScopeItem = useCallback(
    (item: WorkspaceImage) =>
      dataset
        ? canCaptionItem(item)
        : item.kind === 'image' || item.kind === 'synthetic',
    [dataset]
  );
  const captionScopeItems = useMemo(
    () => (selectedItem && canUseCaptionScopeItem(selectedItem)
      ? [selectedItem]
      : selectedItem
        ? []
        : items.filter(canUseCaptionScopeItem)),
    [canUseCaptionScopeItem, items, selectedItem]
  );
  const autoCaptionScopeItems = useMemo(
    () => captionScopeItems.filter(canAutoTagItem),
    [captionScopeItems]
  );
  const captionActionsDisabled = Boolean(dataset && !dataset.overwriteCaptions);

  const canUseDirectoryPicker =
    typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';

  useEffect(() => {
    return () => {
      setTaggingModal({ datasetTags: false, settings: false });
    };
  }, [setTaggingModal]);

  useEffect(() => {
    let canceled = false;

    if (!projectDirectoryHandle) {
      setFileAssets([]);
      return;
    }

    const loadFileAssets = async () => {
      try {
        const assets = await collectWorkspaceFileAssets(
          projectDirectoryHandle,
          datasetId ? [...datasetAssetPaths] : undefined
        );
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
  }, [addNotification, assetPreviewRefreshKey, datasetAssetPaths, datasetId, projectDirectoryHandle]);

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
      console.log('[stage] current stage title rendered: Caption');
      console.log(`[tagging:model] model connected state on entering Stage 7: ${localTaggerStatus}`);
    }

    return () => {
      if (import.meta.env.DEV) {
        console.log(`[tagging:model] model connected state before leaving Stage 7: ${useLocalTaggerStore.getState().status}`);
        console.log('[tagging:model] Stage 7 unmounted without implicit model disconnect');
      }
    };
  }, []);

  const manualTagSuggestions = useMemo(() => {
    const blacklist = new Set(taggingConfig.blacklist);
    const normalizedKeyword = datasetTriggerWord.trim().toLowerCase();

    return normalizeUniqueTags(suggestionTags).filter((tag) => tag !== normalizedKeyword && !blacklist.has(tag));
  }, [suggestionTags, taggingConfig.blacklist, datasetTriggerWord]);
  const knownSuggestionTags = useMemo(() => new Set(normalizeUniqueTags(suggestionTags)), [suggestionTags]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      const keyword = datasetTriggerWord.trim().toLowerCase();
      const keywordInEditableTags = Boolean(
        keyword &&
          items.some((item) => (item.tags ?? []).some((tag) => tag.trim().toLowerCase() === keyword))
      );
      console.log(`[tagging] dataset keyword excluded from Stage 7 tag state: ${!keywordInEditableTags}`);
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
      const captionableItems = targetItems.filter(canUseCaptionScopeItem);
      if (captionableItems.length === 0) {
        return false;
      }

      if (dataset && onUpdateDataset) {
        const latestDataset = useProjectStore.getState().datasets[dataset.id] ?? dataset;
        if (!latestDataset.overwriteCaptions) {
          addNotification('warning', DATASET_OVERWRITE_CAPTIONS_WARNING);
          return false;
        }

        const nextOverrides = { ...(latestDataset.captionOverrides ?? {}) };
        let changedItemCount = 0;
        for (const item of captionableItems) {
          const nextTags = normalizeUniqueTags(resolveTags(item));
          const previousTags = nextOverrides[item.id] ?? item.tags ?? [];
          const changed =
            nextTags.length !== previousTags.length ||
            nextTags.some((tag, tagIndex) => previousTags[tagIndex] !== tag);
          if (changed) {
            nextOverrides[item.id] = nextTags;
            changedItemCount += 1;
          }
        }

        if (changedItemCount === 0) {
          return false;
        }

        await onUpdateDataset({ captionOverrides: nextOverrides });
        return true;
      }

      let changedItemCount = 0;
      for (const item of captionableItems) {
        const nextTags = normalizeUniqueTags(resolveTags(item));
        const previousTags = item.tags ?? [];
        const changed =
          nextTags.length !== previousTags.length ||
          nextTags.some((tag, tagIndex) => previousTags[tagIndex] !== tag);
        if (!changed) {
          continue;
        }

        if (item.kind === 'image') {
          updateSourceImage(item.sourceImageId, { tags: nextTags });
          changedItemCount += 1;
        } else if (item.kind === 'synthetic' && item.syntheticImageId) {
          updateDatasetItem(item.syntheticImageId, { tags: nextTags });
          changedItemCount += 1;
        }
      }

      return changedItemCount > 0;
    },
    [addNotification, canUseCaptionScopeItem, dataset, onUpdateDataset, updateDatasetItem, updateSourceImage]
  );

  const updateWorkspaceImageTags = useCallback(
    (item: WorkspaceImage, tags: string[]) => {
      void persistCaptionTagsForItems([item], () => tags);
    },
    [persistCaptionTagsForItems]
  );

  const applyTagsToItem = useCallback(
    (itemId: string, rawValue: string) => {
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

      void persistCaptionTagsForItems([item], (entry) => buildNextTags(entry.tags, parsedTags));

      return true;
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

  const connectBundleSource = useCallback(
    async (source: LocalTaggerBundleSource) => {
      setLocalTaggerStatus('loading');
      setLocalTagger(null);
      setLocalTaggerProgress('Starting model connection...');
          setLocalTaggerMessage('Validating local caption model...');

      try {
        const connectedBundle = await connectLocalTaggerBundle(source, setLocalTaggerProgress);
        setLocalTagger(connectedBundle);
        setLocalTaggerStatus('ready');
        setLocalTaggerProgress('');
        setLocalTaggerMessage(
          `Ready. Loaded ${connectedBundle.tags.length.toLocaleString()} tags from ${connectedBundle.name}.`
        );
        addNotification('success', `Local caption model ready: ${connectedBundle.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Model validation failed.';
        setLocalTagger(null);
        setLocalTaggerStatus('not-ready');
        setLocalTaggerProgress('');
        setLocalTaggerMessage(message);
        addNotification('error', message);
      }
    },
    [addNotification]
  );

  const connectSavedTaggerFiles = useCallback(
    async (silent = false) => {
      if (!workspaceSettings.localTaggerModelPath || !workspaceSettings.localTaggerTagsPath) {
        if (!silent) {
          setLocalTaggerMessage('Select model.onnx and selected_tags.csv in Settings first.');
        }
        return false;
      }

      const [modelHandle, tagsHandle] = await Promise.all([
        getLocalTaggerFileHandle('model'),
        getLocalTaggerFileHandle('tags'),
      ]);

      if (!modelHandle || !tagsHandle) {
        if (!silent) {
          setLocalTaggerMessage('Saved caption model file names exist, but file access handles are unavailable.');
        }
        return false;
      }

      const [canReadModel, canReadTags] = await Promise.all([
        ensureLocalTaggerFileReadPermission(modelHandle),
        ensureLocalTaggerFileReadPermission(tagsHandle),
      ]);

      if (!canReadModel || !canReadTags) {
        setLocalTaggerStatus('not-ready');
        setLocalTaggerMessage('Browser permission is required to read saved local caption model files.');
        return false;
      }

      await connectBundleSource({
        kind: 'explicit-files',
        name: workspaceSettings.localTaggerModelPath,
        modelFile: await modelHandle.getFile(),
        tagsFile: await tagsHandle.getFile(),
      });
      return true;
    },
    [
      connectBundleSource,
      setLocalTaggerMessage,
      setLocalTaggerStatus,
      workspaceSettings.localTaggerModelPath,
      workspaceSettings.localTaggerTagsPath,
    ]
  );

  useEffect(() => {
    const settingsKey = `${workspaceSettings.localTaggerModelPath ?? ''}|${workspaceSettings.localTaggerTagsPath ?? ''}`;
    if (
      !workspaceSettings.localTaggerModelPath ||
      !workspaceSettings.localTaggerTagsPath ||
      localTagger ||
      localTaggerStatus === 'loading' ||
      localTaggerStatus === 'running' ||
      autoConnectSettingsKeyRef.current === settingsKey
    ) {
      return;
    }

    autoConnectSettingsKeyRef.current = settingsKey;
    void connectSavedTaggerFiles(true);
  }, [
    connectSavedTaggerFiles,
    localTagger,
    localTaggerStatus,
    workspaceSettings.localTaggerModelPath,
    workspaceSettings.localTaggerTagsPath,
  ]);

  useEffect(() => {
    const tagsPath = workspaceSettings.localTaggerTagsPath;
    if (!tagsPath || savedSuggestionLoadKeyRef.current === tagsPath) {
      return;
    }

    savedSuggestionLoadKeyRef.current = tagsPath;
    void (async () => {
      try {
        const tagsHandle = await getLocalTaggerFileHandle('tags');
        if (!tagsHandle) {
          return;
        }

        const canReadTags = await ensureLocalTaggerFileReadPermission(tagsHandle);
        if (!canReadTags) {
          return;
        }

        const csv = await (await tagsHandle.getFile()).text();
        let tags: string[];

        try {
          tags = parseSelectedTagsCsv(csv);
        } catch {
          tags = parseSuggestionCsv(csv);
        }

        setSuggestionTags(tags);
        setSuggestionFileName(tagsHandle.name);
      } catch (error) {
        console.warn('Failed to load saved tags CSV from Settings', error);
      }
    })();
  }, [workspaceSettings.localTaggerTagsPath]);

  const handleConnectModel = useCallback(async () => {
    if (await connectSavedTaggerFiles()) {
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
  }, [canUseDirectoryPicker, connectBundleSource, connectSavedTaggerFiles]);

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
    disconnectLocalTagger();
  }, [disconnectLocalTagger]);

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
        updateWorkspaceSettings({ localTaggerTagsPath: file.name });

        try {
          await deleteLocalTaggerFileHandle('tags');
        } catch (error) {
          console.warn('Failed to clear saved tagger tags handle', error);
        }

        addNotification('success', `Loaded ${tags.length} tag suggestion(s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not read tag suggestions CSV.';
        addNotification('error', message);
      }
    },
    [addNotification, updateWorkspaceSettings]
  );

  const removeTagsFromAllImages = useCallback(
    (tagsToRemove: string[]) => {
      const blocked = new Set(tagsToRemove);
      for (const item of items) {
        const nextTags = (item.tags ?? []).filter((tag) => !blocked.has(tag));
        const changed =
          nextTags.length !== (item.tags ?? []).length ||
          nextTags.some((tag, tagIndex) => item.tags?.[tagIndex] !== tag);

        if (changed) {
          updateWorkspaceImageTags(item, nextTags);
        }
      }
    },
    [items, updateWorkspaceImageTags]
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
    if (parsedTags.length === 0 || captionScopeItems.length === 0 || captionActionsDisabled) {
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
    captionActionsDisabled,
    captionScopeItems,
    persistCaptionTagsForItems,
    selectedTagInput,
  ]);

  const handleRemoveScopeTag = useCallback(
    (tag: string) => {
      if (captionScopeItems.length === 0 || captionActionsDisabled) {
        return;
      }

      const normalizedTag = tag.trim().toLowerCase();
      void persistCaptionTagsForItems(
        captionScopeItems,
        (item) => (item.tags ?? []).filter((entry) => entry.trim().toLowerCase() !== normalizedTag)
      );
    },
    [captionActionsDisabled, captionScopeItems, persistCaptionTagsForItems]
  );

  const handleRunLocalAutoTagging = useCallback(async () => {
    if (dataset && !dataset.overwriteCaptions) {
      autoTaggingRunTokenRef.current += 1;
      setLocalTaggerStatus(localTagger ? 'ready' : 'not-connected');
      setAutoTaggingProgress({ completed: 0, total: 0 });
      addNotification('warning', DATASET_OVERWRITE_CAPTIONS_WARNING);
      return;
    }

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
    setLocalTaggerStatus('running');
    setAutoTaggingProgress({ completed: 0, total: autoCaptionScopeItems.length });

    try {
      let changedItemCount = 0;
      const predictedTagsByItemId = new Map<string, string[]>();

      for (let index = 0; index < autoCaptionScopeItems.length; index += 1) {
        const item = autoCaptionScopeItems[index];
        const latestDataset = dataset ? useProjectStore.getState().datasets[dataset.id] : null;
        if (autoTaggingRunTokenRef.current !== runToken || (latestDataset && !latestDataset.overwriteCaptions)) {
          autoTaggingRunTokenRef.current += 1;
          setAutoTaggingProgress({ completed: 0, total: 0 });
          setLocalTaggerStatus('ready');
          setLocalTaggerMessage('Ready. Auto-caption stopped.');
          return;
        }
        setAutoTaggingProgress({ completed: index, total: autoCaptionScopeItems.length });

        const predictions = await predictLocalTags(
          localTagger,
          item.imageData,
          autoCaptionThreshold,
          autoCaptionMaxTags
        );
        predictedTagsByItemId.set(item.id, predictions.map((prediction) => prediction.tag));

        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      const changed = await persistCaptionTagsForItems(autoCaptionScopeItems, (item) =>
        mergeAutoTags(item.tags ?? [], predictedTagsByItemId.get(item.id) ?? [])
      );
      changedItemCount = changed ? predictedTagsByItemId.size : 0;

      setAutoTaggingProgress({ completed: autoCaptionScopeItems.length, total: autoCaptionScopeItems.length });
      setLocalTaggerStatus('ready');
      setLocalTaggerMessage(`Ready. Last run updated ${changedItemCount} image(s).`);
      addNotification('success', `Auto-caption completed for ${autoCaptionScopeItems.length} image(s)`);
      setAutoCaptionDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime inference failed.';
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
    setAutoTaggingProgress({ completed: 0, total: 0 });
    if (localTagger) {
      setLocalTaggerStatus('ready');
      setLocalTaggerMessage('Ready. Auto-caption canceled.');
    }
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
      knownTags={knownSuggestionTags}
      insertMode={taggingConfig.insertMode}
      captionActionsDisabled={captionActionsDisabled}
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
              alt={selectedItem.fileName}
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

  const captionInspectorControls = captionScopeControls;
  const captionInspectorRoot = useInspectorPortalRoot('caption-inspector-root', active);
  const captionInspectorPortal = captionInspectorRoot && captionInspectorControls
    ? createPortal(captionInspectorControls, captionInspectorRoot)
    : null;
  const inlineCaptionControls = !captionInspectorPortal && captionInspectorControls ? (
    <aside className="rounded-lg border border-border bg-card p-4">
      {captionInspectorControls}
    </aside>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto">
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
                <label className="mb-2 block text-xs text-muted-foreground">Threshold</label>
                <input
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
                <label className="mb-2 block text-xs text-muted-foreground">Max tags</label>
                <input
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
                    autoCaptionScopeItems.length === 0 ||
                    captionActionsDisabled
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
        open={taggingModals.settings}
        onOpenChange={(open) => setTaggingModal({ settings: open })}
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
                      {workspaceSettings.localTaggerModelPath ?? 'No model.onnx selected'}
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-background p-3">
                    <p className="text-xs text-muted-foreground">Settings tags</p>
                    <p className="mt-1 truncate text-sm font-medium">
                      {workspaceSettings.localTaggerTagsPath ?? 'No selected_tags.csv selected'}
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
                      : workspaceSettings.localTaggerTagsPath
                        ? `${workspaceSettings.localTaggerTagsPath} - saved in Settings`
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
          <BrickMasonry
            items={items}
            getKey={(item) => item.id}
            getEstimate={(item) => item.height / Math.max(1, item.width) + 0.85}
            renderItem={(item) => (
              <TaggingCard
                item={item}
                previewUrl={previewUrls[item.id]}
                onOpen={onOpenItem ?? setSelectedItemId}
                onSubmit={applyTagsToItem}
                onRemoveTag={handleRemoveTag}
                suggestions={manualTagSuggestions}
                knownTags={knownSuggestionTags}
                captionActionsDisabled={captionActionsDisabled}
                onOpenContextMenu={onOpenAssetContextMenu}
              />
            )}
          />
        )}
      </div>

    </div>
  );
};
