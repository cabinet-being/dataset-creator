import * as Dialog from '@radix-ui/react-dialog';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Plug, Sparkles, Upload, X } from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import {
  connectLocalTaggerBundle,
  LocalTaggerBundleSource,
  predictLocalTags,
} from '../../services/tagging/localTaggerService';
import {
  toWorkspaceImages,
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameStyle,
  type WorkspaceImage,
} from '../../lib/workspaceImages';

type PreviewMap = Record<string, string>;
type PreviewCacheEntry = { blob: Blob; url: string };
type SuggestionDropdownPosition = { top: number; left: number; width: number };
type InsertMode = 'prepend' | 'append' | 'overwrite';

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  };

const parseTagInput = (value: string): string[] =>
  value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

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

const TAGGING_TOOL_COMMAND_EVENT = 'dataset-creator-tagging-command';

type TaggingCardProps = {
  item: WorkspaceImage;
  previewUrl?: string;
  inputValue: string;
  onInputChange: (itemId: string, value: string) => void;
  onSubmit: (itemId: string, value: string) => void;
  onRemoveTag: (itemId: string, tag: string) => void;
  suggestions: string[];
};

const TaggingCard = memo(
  ({
    item,
    previewUrl,
    inputValue,
    onInputChange,
    onSubmit,
    onRemoveTag,
    suggestions,
  }: TaggingCardProps) => {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const dropdownRef = useRef<HTMLDivElement | null>(null);
    const suggestionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const [dropdownPosition, setDropdownPosition] = useState<SuggestionDropdownPosition | null>(null);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const fragment = getCurrentTagFragment(inputValue);
    const filteredSuggestions = fragment
      ? suggestions
          .filter((tag) => tag.includes(fragment) && !(item.tags ?? []).includes(tag))
          .slice(0, 24)
      : [];
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
      const nextValue = replaceCurrentTagFragment(inputValue, tag);
      onInputChange(item.id, nextValue);
      setIsDropdownOpen(false);
      window.requestAnimationFrame(() => {
        onSubmit(item.id, nextValue);
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
      <div
        className={`gallery-masonry-item rounded-lg overflow-hidden bg-card ${getWorkspaceKindFrameClass(item.kind)}`}
        style={{
          contentVisibility: 'auto',
          containIntrinsicSize: '420px',
          ...getWorkspaceKindFrameStyle(item.kind),
        }}
      >
        <div className="relative min-h-[12rem] bg-black overflow-hidden flex items-center justify-center">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={`Image ${item.id}`}
              className="w-full h-auto object-contain"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
              Preview unavailable
            </div>
          )}

          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
            <div className="flex items-end justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-white">Image #{item.displayIdentity}</p>
              <span className={getWorkspaceKindBadgeClass(item.kind)}>
                {item.label}
              </span>
            </div>
          </div>
        </div>

        <div className="p-3 space-y-3">
          <div className="rounded-md border border-border bg-secondary/40 p-2 h-20 overflow-y-auto">
            <div className="flex flex-wrap gap-2 content-start">
              {item.tags && item.tags.length > 0 ? (
                item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-primary text-primary-foreground rounded text-xs"
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

          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(event) => {
                onInputChange(item.id, event.target.value);
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
                  onSubmit(item.id, inputValue);
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
              aria-autocomplete="list"
              aria-expanded={shouldShowDropdown}
              aria-controls={`tag-suggestions-${item.id}`}
              aria-activedescendant={
                shouldShowDropdown ? `tag-suggestion-${item.id}-${activeSuggestionIndex}` : undefined
              }
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
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
                    key={tag}
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

export const TaggingStage = () => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const syntheticImagesById = useProjectStore((state) => state.datasetItems);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const updateTaggingConfig = useProjectStore((state) => state.updateTaggingConfig);
  const cleanupStageState = useProjectStore(
    (state) =>
      (state.stageState.clean as
        | { workingEdits?: Record<string, { blob: Blob; previewUrl: string; width: number; height: number }> }
        | undefined) ?? {}
  );
  const taggingConfig = useProjectStore((state) => state.taggingConfig);
  const { addNotification } = useUIStore();
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

  const [tagInputs, setTagInputs] = useState<Record<string, string>>({});
  const [newBlacklistTag, setNewBlacklistTag] = useState('');
  const [globalTagsToAdd, setGlobalTagsToAdd] = useState('');
  const [isDatasetTagsOpen, setIsDatasetTagsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [suggestionTags, setSuggestionTags] = useState<string[]>([]);
  const [suggestionFileName, setSuggestionFileName] = useState('');
  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const previewCacheRef = useRef<Record<string, PreviewCacheEntry>>({});
  const fallbackDirectoryInputRef = useRef<HTMLInputElement | null>(null);
  const suggestionCsvInputRef = useRef<HTMLInputElement | null>(null);
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const syntheticImages = useMemo(
    () =>
      Object.values(syntheticImagesById)
        .filter((item) => !item.deleted)
        .sort((left, right) => (left.exportOrder ?? 0) - (right.exportOrder ?? 0)),
    [syntheticImagesById]
  );
  const items = useMemo(
    () => toWorkspaceImages(sourceImages, syntheticImages, cleanupStageState.workingEdits),
    [cleanupStageState.workingEdits, sourceImages, syntheticImages]
  );

  const canUseDirectoryPicker =
    typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';

  useEffect(() => {
    const handleTaggingCommand = (event: Event) => {
      const command = (event as CustomEvent<'datasetTags' | 'settings'>).detail;
      if (command === 'datasetTags') {
        setIsDatasetTagsOpen(true);
      }
      if (command === 'settings') {
        setIsSettingsOpen(true);
      }
    };

    window.addEventListener(TAGGING_TOOL_COMMAND_EVENT, handleTaggingCommand);
    return () => window.removeEventListener(TAGGING_TOOL_COMMAND_EVENT, handleTaggingCommand);
  }, []);

  useEffect(() => {
    setPreviewUrls((previous) => {
      const next: PreviewMap = {};
      const activeIds = new Set(items.map((item) => item.id));
      let validThumbnailCount = 0;

      for (const item of items) {
        const cached = previewCacheRef.current[item.id];

        if (cached && cached.blob === item.imageData) {
          next[item.id] = cached.url;
          validThumbnailCount++;
          continue;
        }

        if (cached) {
          URL.revokeObjectURL(cached.url);
        }

        try {
          const url = URL.createObjectURL(item.imageData);
          previewCacheRef.current[item.id] = { blob: item.imageData, url };
          next[item.id] = url;
          validThumbnailCount++;
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn(`[tagging] failed preview generation: ${item.id}`, error);
          }
        }
      }

      for (const [id, cached] of Object.entries(previewCacheRef.current)) {
        if (activeIds.has(id)) {
          continue;
        }
        URL.revokeObjectURL(cached.url);
        delete previewCacheRef.current[id];
      }

      if (import.meta.env.DEV) {
        console.log(`[tagging] gallery item count: ${items.length}`);
        console.log(`[tagging] cards with valid thumbnail source: ${validThumbnailCount}`);
      }

      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      const changed =
        previousKeys.length !== nextKeys.length ||
        nextKeys.some((id) => previous[id] !== next[id]);

      return changed ? next : previous;
    });
  }, [items]);

  useEffect(() => {
    return () => {
      Object.values(previewCacheRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
      previewCacheRef.current = {};
    };
  }, []);

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

  const summary = useMemo(() => {
    const taggedCount = items.filter((item) => (item.tags?.length ?? 0) > 0).length;
    const untaggedCount = items.length - taggedCount;
    const frequencies = new Map<string, number>();

    for (const item of items) {
      for (const tag of item.tags ?? []) {
        frequencies.set(tag, (frequencies.get(tag) ?? 0) + 1);
      }
    }

    const topTags = Array.from(frequencies.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12);

    if (import.meta.env.DEV) {
      console.log(`[tagging] tagged image count: ${taggedCount}`);
      console.log(`[tagging] untagged image count: ${untaggedCount}`);
      console.log(`[tagging] tag frequency map size: ${frequencies.size}`);
    }

    return { taggedCount, untaggedCount, topTags, uniqueTagCount: frequencies.size };
  }, [items]);

  const manualTagSuggestions = useMemo(() => {
    const blacklist = new Set(taggingConfig.blacklist);
    const normalizedKeyword = taggingConfig.datasetKeyword.trim().toLowerCase();

    return suggestionTags.filter((tag) => tag !== normalizedKeyword && !blacklist.has(tag));
  }, [suggestionTags, taggingConfig.blacklist, taggingConfig.datasetKeyword]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      const keyword = taggingConfig.datasetKeyword.trim().toLowerCase();
      const keywordInEditableTags = Boolean(
        keyword &&
          items.some((item) => (item.tags ?? []).some((tag) => tag.trim().toLowerCase() === keyword))
      );
      console.log(`[tagging] dataset keyword excluded from Stage 7 tag state: ${!keywordInEditableTags}`);
    }
  }, [items, taggingConfig.datasetKeyword]);

  const updateWorkspaceImageTags = useCallback(
    (item: WorkspaceImage, tags: string[]) => {
      if (item.kind === 'source') {
        updateSourceImage(item.sourceImageId, { tags });
        return;
      }

      updateDatasetItem(item.id.replace(/^synthetic:/, ''), { tags });
    },
    [updateDatasetItem, updateSourceImage]
  );

  const applyTagsToItem = useCallback(
    (itemId: string, rawValue: string) => {
      const parsedTags = parseTagInput(rawValue);
      const item = items.find((entry) => entry.id === itemId);
      if (!item) {
        return;
      }

      const existingTags = new Set(item.tags ?? []);
      const nextTags = [...(item.tags ?? [])];
      const skippedDuplicates: string[] = [];
      const normalizedKeyword = taggingConfig.datasetKeyword.trim().toLowerCase();

      for (const tag of parsedTags) {
        if (tag === normalizedKeyword || taggingConfig.blacklist.includes(tag) || existingTags.has(tag)) {
          if (existingTags.has(tag)) {
            skippedDuplicates.push(tag);
          }
          continue;
        }

        existingTags.add(tag);
        nextTags.push(tag);
      }

      if (import.meta.env.DEV) {
        console.log(`[tagging] raw input string: ${rawValue}`);
        console.log(`[tagging] parsed tag list: ${JSON.stringify(parsedTags)}`);
        console.log(`[tagging] skipped duplicate tags: ${JSON.stringify(skippedDuplicates)}`);
        console.log('[tagging] dataset keyword insertion skipped during manual tagging');
      }

      const previousTags = item.tags ?? [];
      const changed =
        nextTags.length !== previousTags.length ||
        nextTags.some((tag, tagIndex) => previousTags[tagIndex] !== tag);

      if (changed) {
        updateWorkspaceImageTags(item, nextTags);
      }

      setTagInputs((previous) => ({ ...previous, [itemId]: '' }));
    },
    [items, taggingConfig.blacklist, taggingConfig.datasetKeyword, updateWorkspaceImageTags]
  );

  const mergeAutoTags = useCallback(
    (existingTags: string[] = [], predictedTags: string[]) => {
      const blacklist = new Set(taggingConfig.blacklist.map((tag) => tag.toLowerCase()));
      const normalizedKeyword = taggingConfig.datasetKeyword.trim().toLowerCase();
      const normalizedPredictions = predictedTags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .filter((tag) => tag !== normalizedKeyword)
        .filter((tag) => !blacklist.has(tag));
      const normalizedExisting = existingTags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .filter((tag) => tag !== normalizedKeyword)
        .filter((tag) => !blacklist.has(tag));
      const nextTags: string[] = [];
      const seen = new Set<string>();

      const addTag = (tag: string) => {
        if (!tag || seen.has(tag) || blacklist.has(tag)) {
          return;
        }

        seen.add(tag);
        nextTags.push(tag);
      };

      if (taggingConfig.insertMode === 'prepend' || taggingConfig.insertMode === 'overwrite') {
        normalizedPredictions.forEach(addTag);
      }

      if (taggingConfig.insertMode !== 'overwrite') {
        normalizedExisting.forEach(addTag);
      }

      if (taggingConfig.insertMode === 'append') {
        normalizedPredictions.forEach(addTag);
      }

      if (import.meta.env.DEV) {
        console.log('[tagging] dataset keyword insertion skipped during auto-tagging');
      }

      return nextTags;
    },
    [
      taggingConfig.blacklist,
      taggingConfig.datasetKeyword,
      taggingConfig.insertMode,
    ]
  );

  const connectBundleSource = useCallback(
    async (source: LocalTaggerBundleSource) => {
      setLocalTaggerStatus('loading');
      setLocalTagger(null);
      setLocalTaggerProgress('Starting model connection...');
      setLocalTaggerMessage('Validating local tagger bundle...');

      try {
        const connectedBundle = await connectLocalTaggerBundle(source, setLocalTaggerProgress);
        setLocalTagger(connectedBundle);
        setLocalTaggerStatus('ready');
        setLocalTaggerProgress('');
        setLocalTaggerMessage(
          `Ready. Loaded ${connectedBundle.tags.length.toLocaleString()} tags from ${connectedBundle.name}.`
        );
        addNotification('success', `Local tagger ready: ${connectedBundle.name}`);
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

  const handleConnectModel = useCallback(async () => {
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
  }, [canUseDirectoryPicker, connectBundleSource]);

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

  const handleAddGlobalTags = () => {
    const normalizedKeyword = taggingConfig.datasetKeyword.trim().toLowerCase();
    const parsedTags = parseTagInput(globalTagsToAdd).filter((tag) => tag !== normalizedKeyword);
    if (parsedTags.length === 0) {
      addNotification('warning', 'No eligible bulk tags to add');
      return;
    }

    for (const item of items) {
      const blacklist = new Set(taggingConfig.blacklist);
      const normalizedExisting = (item.tags ?? [])
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .filter((tag) => tag !== normalizedKeyword)
        .filter((tag) => !blacklist.has(tag));
      const normalizedBulkTags = parsedTags.filter((tag) => !blacklist.has(tag));
      const nextTags: string[] = [];
      const seen = new Set<string>();

      const addTag = (tag: string) => {
        if (!tag || seen.has(tag)) {
          return;
        }
        seen.add(tag);
        nextTags.push(tag);
      };

      if (taggingConfig.insertMode === 'prepend' || taggingConfig.insertMode === 'overwrite') {
        normalizedBulkTags.forEach(addTag);
      }

      if (taggingConfig.insertMode !== 'overwrite') {
        normalizedExisting.forEach(addTag);
      }

      if (taggingConfig.insertMode === 'append') {
        normalizedBulkTags.forEach(addTag);
      }

      const previousTags = item.tags ?? [];
      const changed =
        nextTags.length !== previousTags.length ||
        nextTags.some((tag, tagIndex) => previousTags[tagIndex] !== tag);

      if (changed) {
        updateWorkspaceImageTags(item, nextTags);
      }
    }

    addNotification('success', `Added ${parsedTags.length} caption tag(s) across the current workspace`);
    if (import.meta.env.DEV) {
      console.log('[tagging] dataset keyword insertion skipped during bulk add');
      console.log(`[tagging] shared insert mode: ${taggingConfig.insertMode}`);
    }
    setGlobalTagsToAdd('');
  };

  const handleRunLocalAutoTagging = useCallback(async () => {
    if (!localTagger || localTaggerStatus !== 'ready') {
      setLocalTaggerStatus('not-ready');
      setLocalTaggerMessage('Connect and validate a supported model folder before running auto-tagging.');
      return;
    }

    setLocalTaggerStatus('running');
    setAutoTaggingProgress({ completed: 0, total: items.length });

    try {
      let changedItemCount = 0;

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        setAutoTaggingProgress({ completed: index, total: items.length });

        const predictions = await predictLocalTags(
          localTagger,
          item.imageData,
          taggingConfig.threshold,
          taggingConfig.maxTags
        );
        const nextTags = mergeAutoTags(
          item.tags ?? [],
          predictions.map((prediction) => prediction.tag)
        );
        const previousTags = item.tags ?? [];
        const changed =
          nextTags.length !== previousTags.length ||
          nextTags.some((tag, tagIndex) => previousTags[tagIndex] !== tag);

        if (changed) {
          updateWorkspaceImageTags(item, nextTags);
          changedItemCount += 1;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      setAutoTaggingProgress({ completed: items.length, total: items.length });
      setLocalTaggerStatus('ready');
      setLocalTaggerMessage(`Ready. Last run updated ${changedItemCount} image(s).`);
      addNotification('success', `Auto-tagging completed for ${items.length} image(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime inference failed.';
      setLocalTaggerStatus('not-ready');
      setLocalTaggerMessage(message);
      addNotification('error', message);
    }
  }, [
    addNotification,
    items,
    localTagger,
    localTaggerStatus,
    mergeAutoTags,
    taggingConfig.maxTags,
    taggingConfig.threshold,
    updateWorkspaceImageTags,
  ]);

  const handleRemoveTag = useCallback(
    (itemId: string, tag: string) => {
      const item = items.find((entry) => entry.id === itemId);
      if (!item?.tags) {
        return;
      }

      const nextTags = item.tags.filter((entry) => entry !== tag);
      updateWorkspaceImageTags(item, nextTags);

      if (import.meta.env.DEV) {
        console.log(`[tagging] tag removed: ${tag}`);
        console.log(`[tagging] image id affected: ${itemId}`);
        console.log(`[tagging] resulting tag list for that image: ${JSON.stringify(nextTags)}`);
      }
    },
    [items, updateWorkspaceImageTags]
  );

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground">No images to tag.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1">Tagged Images</p>
          <p className="text-2xl font-bold">{summary.taggedCount}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1">Untagged Images</p>
          <p className="text-2xl font-bold">{summary.untaggedCount}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1">Unique Tags</p>
          <p className="text-2xl font-bold">{summary.uniqueTagCount}</p>
        </div>
      </div>

      <Dialog.Root open={isDatasetTagsOpen} onOpenChange={setIsDatasetTagsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(760px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">Dataset Tags</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Manage shared tag actions for the current workspace.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md p-2 transition-colors hover:bg-secondary"
                  aria-label="Close Dataset Tags"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs text-muted-foreground">Keyword</label>
                <input
                  type="text"
                  value={taggingConfig.datasetKeyword}
                  onChange={(event) =>
                    updateTaggingConfig({ datasetKeyword: event.target.value })
                  }
                  placeholder="my_dataset"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-[1fr_12rem]">
                <div>
                  <label className="mb-2 block text-xs text-muted-foreground">Bulk tags</label>
                  <textarea
                    value={globalTagsToAdd}
                    onChange={(event) => setGlobalTagsToAdd(event.target.value)}
                    placeholder="tag1, tag2, tag3"
                    className="min-h-28 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs text-muted-foreground">Insert mode</label>
                  <select
                    value={taggingConfig.insertMode}
                    onChange={(event) =>
                      updateTaggingConfig({
                        insertMode: event.target.value as InsertMode,
                      })
                    }
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    {(['prepend', 'append', 'overwrite'] as const).map((mode) => (
                      <option key={mode} value={mode}>
                        {INSERT_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleAddGlobalTags}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Apply to All {items.length} Images
                </button>
                <button
                  type="button"
                  onClick={() => void handleRunLocalAutoTagging()}
                  disabled={!localTagger || localTaggerStatus !== 'ready'}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Sparkles size={16} />
                  Run auto-tagging
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(840px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">Tagging Settings</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Configure the local model, blacklist, and manual tag suggestions.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md p-2 transition-colors hover:bg-secondary"
                  aria-label="Close Tagging Settings"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>

            <div className="space-y-5">
              <section className="rounded-lg border border-border bg-secondary/20 p-4">
                <h3 className="mb-3 text-sm font-semibold">Auto Tagger</h3>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs text-muted-foreground">Threshold</label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={taggingConfig.threshold}
                      onChange={(event) =>
                        updateTaggingConfig({ threshold: parseFloat(event.target.value) })
                      }
                      className="w-full"
                    />
                    <p className="mt-1 text-xs font-mono">{taggingConfig.threshold.toFixed(2)}</p>
                  </div>

                  <div>
                    <label className="mb-2 block text-xs text-muted-foreground">Max auto tags</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={taggingConfig.maxTags}
                      onChange={(event) =>
                        updateTaggingConfig({ maxTags: Math.max(1, parseInt(event.target.value || '1', 10)) })
                      }
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
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
                      Auto-tagging {autoTaggingProgress.completed} of {autoTaggingProgress.total} images...
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

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-lg font-semibold">Tag Frequency Overview</h3>
            <p className="text-sm text-muted-foreground">
              Most repeated tags across Source and Synthetic images.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {summary.topTags.length > 0 ? (
            summary.topTags.map(([tag, count]) => (
              <span
                key={tag}
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary text-foreground text-sm"
              >
                <span>{tag}</span>
                <span className="text-xs text-muted-foreground">{count}</span>
              </span>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">No tags assigned yet</span>
          )}
        </div>
      </div>

      <div>
        <div className="gallery-masonry">
          {items.map((item) => (
            <TaggingCard
              key={item.id}
              item={item}
              previewUrl={previewUrls[item.id]}
              inputValue={tagInputs[item.id] ?? ''}
              onInputChange={(itemId, value) =>
                setTagInputs((previous) => ({ ...previous, [itemId]: value }))
              }
              onSubmit={(itemId, value) => applyTagsToItem(itemId, value)}
              onRemoveTag={handleRemoveTag}
              suggestions={manualTagSuggestions}
            />
          ))}
        </div>
      </div>

    </div>
  );
};
