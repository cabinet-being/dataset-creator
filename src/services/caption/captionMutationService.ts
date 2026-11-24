import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useHistoryStore, captureHistoryEpoch, isHistoryEpochCurrent, runHistoryTransaction } from '../../stores/useHistoryStore';
import { useProjectStore } from '../../stores/useProjectStore';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { invalidateWorkspaceFileAssetCache } from '../../lib/workspaceFileAssets';
import { useUIStore } from '../../stores/useUIStore';
import type { HistoryTransactionWriter } from '../../stores/useHistoryStore';
import {
  getCaptionTriggerForPath,
  isCaptionCarrierName,
  isTriggerMissing,
  listCaptionFiles,
  normalizeTriggerWord,
  parseCaptionFile,
  parseCaptionText,
  readCaptionRaw,
  renderCaptionText,
  validateTriggerWord,
  writeCaptionRaw,
} from './captionFileService';
import { applyCaptionWritesJournaled, type CaptionWrite } from '../project/layoutMigrationService';
import { PROJECT_LAYOUT } from '../project/projectLayoutService';

type CaptionTarget = {
  item: WorkspaceImage;
  before: string[] | undefined;
  after: string[];
  captionTriggerMissingBefore: boolean | undefined;
  /** Exact TXT content before the edit and the content this edit wrote (null = no file). */
  rawBefore: string | null;
  rawAfter: string | null;
  /** False when the image is not on disk yet; the project save writes the TXT of a new asset. */
  onDisk: boolean;
};

const sameTags = (left: string[] | undefined, right: string[]): boolean =>
  left !== undefined && left.length === right.length && left.every((tag, index) => tag === right[index]);

const warn = (message: string) => useUIStore.getState().addNotification('warning', message);

const imageExists = async (root: ProjectDirectoryHandle, path: string): Promise<boolean> => {
  const parts = path.replace(/^Project\//, '').split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return false;
  try {
    let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    const kind = (error as { name?: string } | null)?.name;
    if (kind === 'NotFoundError' || kind === 'TypeMismatchError') return false;
    throw error;
  }
};

export async function persistCaptionTagsForItems(options: {
  items: WorkspaceImage[];
  resolveTags: (item: WorkspaceImage) => string[];
  directory?: ProjectDirectoryHandle | null;
  flush?: () => Promise<void>;
  historyWriter?: HistoryTransactionWriter;
  /** Write the trigger word into captions that lack it even though their tags do not change. */
  repairTrigger?: boolean;
}): Promise<number> {
  const epoch = captureHistoryEpoch();
  const ensureProject = () => { if (!isHistoryEpochCurrent(epoch)) throw new Error('The project changed while saving captions.'); };
  const trigger = useProjectStore.getState().dataset.triggerWord;
  // Videos cannot carry a TXT caption.
  const unique = [...new Map(options.items.filter((item) => item.kind !== 'video').map((item) => [item.id, item])).values()];
  const candidates = unique
    .map((item) => ({ item, before: item.tags, after: [...options.resolveTags(item)] }))
    .filter((target) => !sameTags(target.before, target.after) || (options.repairTrigger && target.item.captionTriggerMissing === true));
  if (!candidates.length) return 0;
  const targets: CaptionTarget[] = [];
  for (const candidate of candidates) {
    const path = candidate.item.assetPath;
    const fileBacked = Boolean(path && isCaptionCarrierName(path.split('/').pop() ?? ''));
    if (!candidate.item.sourceImageId && !candidate.item.editedAssetId && (!path || !fileBacked)) continue;
    if (!candidate.item.sourceImageId && !candidate.item.editedAssetId && !options.directory) {
      throw new Error(`Reconnect the project folder to save the caption for ${candidate.item.fileName}.`);
    }
    const onDisk = Boolean(options.directory && path && fileBacked && await imageExists(options.directory, path));
    ensureProject();
    const rawBefore = onDisk ? await readCaptionRaw(options.directory!, path!) : null;
    ensureProject();
    targets.push({
      ...candidate,
      captionTriggerMissingBefore: candidate.item.captionTriggerMissing,
      rawBefore,
      rawAfter: renderCaptionText(candidate.after, path ? getCaptionTriggerForPath(path, trigger) : undefined),
      onDisk,
    });
  }
  if (!targets.length) return 0;
  const directory = options.directory;
  const apply = async (restore: boolean) => {
    const store = useProjectStore.getState();
    ensureProject();
    const conflicts: string[] = [];
    for (const target of targets) {
      ensureProject();
      let tags = restore ? target.before : target.after;
      let captionTriggerMissing = restore ? target.captionTriggerMissingBefore : false;
      const item = target.item;
      if (target.onDisk && directory && item.assetPath) {
        const expected = restore ? target.rawAfter : target.rawBefore;
        const current = await readCaptionRaw(directory, item.assetPath);
        ensureProject();
        if (current !== expected && !(restore === false && current === target.rawAfter)) {
          // The file was edited outside this history entry; never overwrite it, show what is on disk.
          conflicts.push(item.fileName);
          const onDisk = parseCaptionFile(current, item.assetPath, trigger);
          tags = onDisk.tags;
          captionTriggerMissing = isTriggerMissing(onDisk);
        } else {
          await writeCaptionRaw(directory, item.assetPath, restore ? target.rawBefore : target.rawAfter);
          ensureProject();
        }
      }
      if (item.kind === 'edited' && item.editedAssetId) store.updateDatasetItem(item.editedAssetId, { tags, captionTriggerMissing });
      else if (item.sourceImageId) store.updateSourceImage(item.sourceImageId, { tags, captionTriggerMissing });
    }
    if (directory && targets.some((target) => target.onDisk && !target.item.sourceImageId && !target.item.editedAssetId)) {
      invalidateWorkspaceFileAssetCache(directory);
      useUIStore.getState().refreshAssetPreviews();
    }
    if (conflicts.length) {
      warn(`${conflicts.length === 1 ? `The caption of ${conflicts[0]} was` : `${conflicts.length} captions were`} changed on disk after this edit, so ${restore ? 'undo' : 'redo'} left ${conflicts.length === 1 ? 'it' : 'them'} untouched.`);
    }
    await options.flush?.();
    ensureProject();
  };
  await apply(false);
  (options.historyWriter?.push ?? useHistoryStore.getState().push)({
    label: `Edit ${targets.length} caption${targets.length === 1 ? '' : 's'}`,
    undo: () => apply(true),
    redo: () => apply(false),
  });
  return targets.length;
}

type CaptionBatchOptions = Omit<Parameters<typeof persistCaptionTagsForItems>[0], 'historyWriter' | 'resolveTags'>;

/** Adds (appends) or removes tags, compared case-insensitively, on many captions as one undoable history step. */
export async function applyCaptionTagBatch(options: CaptionBatchOptions & { tags: string[]; mode: 'add' | 'remove' }): Promise<number> {
  const keys = new Set(options.tags.map((tag) => tag.toLocaleLowerCase()));
  const { tags, mode, ...rest } = options;
  const plural = tags.length === 1 ? 'tag' : 'tags';
  return runHistoryTransaction(mode === 'add' ? `Add caption ${plural}` : `Remove caption ${plural}`, (historyWriter) => persistCaptionTagsForItems({
    ...rest, historyWriter,
    resolveTags: (item) => {
      const kept = (item.tags ?? []).filter((value) => !keys.has(value.toLocaleLowerCase()));
      return mode === 'add' ? [...kept, ...tags] : kept;
    },
  }));
}

/** Replaces the caption of each item with `resolveTags(item)` as one undoable history step named `label`. */
export const persistCaptionBatch = (label: string, options: CaptionBatchOptions & { resolveTags: (item: WorkspaceImage) => string[] }): Promise<number> =>
  runHistoryTransaction(label, (historyWriter) => persistCaptionTagsForItems({ ...options, historyWriter }));

export type TriggerRewriteResult = { rewritten: number; skipped: number };

/** What each caption file in dataset/ becomes when its leading trigger word changes (files that lost it manually stay as they are). */
export const planTriggerRewrite = async (root: ProjectDirectoryHandle, oldTrigger: string, newTrigger: string): Promise<{ writes: CaptionWrite[]; skipped: number }> => {
  const oldValue = normalizeTriggerWord(oldTrigger);
  const newValue = normalizeTriggerWord(newTrigger);
  const writes: CaptionWrite[] = [];
  let skipped = 0;
  for (const entry of await listCaptionFiles(root, PROJECT_LAYOUT.datasetDir)) {
    if (entry.raw === null) continue;
    const parsed = parseCaptionText(entry.raw, oldValue);
    if (oldValue && !parsed.triggerPresent) { skipped += 1; continue; }
    const after = renderCaptionText(parsed.tags, newValue || undefined);
    if (after !== entry.raw) writes.push({ path: entry.path, before: entry.raw, after });
  }
  return { writes, skipped };
};

/**
 * Changes the dataset trigger word: rewrites every TXT in dataset/ through one journalled batch, then stores the
 * new word. One history entry undoes the whole change. Call only on an explicit user action (Apply / blur).
 */
export async function rewriteTriggerWord(options: {
  directory: ProjectDirectoryHandle | null | undefined;
  newTrigger: string;
  /** Wraps the file work in the project's exclusive file operation (runProjectFileOperation). */
  runFileOperation?: <T>(action: () => Promise<T>) => Promise<T>;
  historyWriter?: HistoryTransactionWriter;
}): Promise<TriggerRewriteResult> {
  const newValue = normalizeTriggerWord(options.newTrigger);
  const invalid = validateTriggerWord(options.newTrigger);
  if (invalid) throw new Error(invalid);
  const store = useProjectStore.getState();
  const oldValue = normalizeTriggerWord(store.dataset.triggerWord);
  if (newValue === oldValue) return { rewritten: 0, skipped: 0 };
  const epoch = captureHistoryEpoch();
  const ensureProject = () => { if (!isHistoryEpochCurrent(epoch)) throw new Error('The project changed while the trigger word was being updated.'); };
  const run = options.runFileOperation ?? (<T,>(action: () => Promise<T>) => action());
  const directory = options.directory;
  const datasetId = store.dataset.id;
  let rewritten: CaptionWrite[] = [];
  let skipped = 0;
  await run(async () => {
    if (directory) {
      const plan = await planTriggerRewrite(directory, oldValue, newValue);
      skipped = plan.skipped;
      const result = await applyCaptionWritesJournaled(directory, { kind: 'trigger-rewrite', writes: plan.writes, triggerWord: newValue });
      rewritten = plan.writes.filter((write) => !result.conflicts.includes(write.path));
      if (result.conflicts.length) warn(`${result.conflicts.length} caption${result.conflicts.length === 1 ? ' was' : 's were'} changed on disk while the trigger word was updated and left untouched.`);
      invalidateWorkspaceFileAssetCache(directory);
    }
    ensureProject();
    useProjectStore.getState().updateDataset(datasetId, { triggerWord: newValue });
  });
  useUIStore.getState().refreshAssetPreviews();
  const changed = rewritten;
  const applyDirection = (to: 'new' | 'old') => run(async () => {
    ensureProject();
    let conflicts: string[] = [];
    if (directory && changed.length) {
      const writes = changed.map((write) => to === 'old' ? { path: write.path, before: write.after, after: write.before } : write);
      conflicts = (await applyCaptionWritesJournaled(directory, { kind: 'trigger-rewrite', writes, triggerWord: to === 'old' ? oldValue : newValue })).conflicts;
      invalidateWorkspaceFileAssetCache(directory);
    }
    ensureProject();
    useProjectStore.getState().updateDataset(datasetId, { triggerWord: to === 'old' ? oldValue : newValue });
    useUIStore.getState().refreshAssetPreviews();
    if (conflicts.length) warn(`${conflicts.length} caption${conflicts.length === 1 ? ' was' : 's were'} changed on disk after the trigger word update, so ${to === 'old' ? 'undo' : 'redo'} left ${conflicts.length === 1 ? 'it' : 'them'} untouched.`);
  });
  (options.historyWriter?.push ?? useHistoryStore.getState().push)({
    label: oldValue ? `Change trigger word to ${newValue || 'none'}` : `Set trigger word ${newValue}`,
    undo: () => applyDirection('old'),
    redo: () => applyDirection('new'),
  });
  return { rewritten: changed.length, skipped };
}
