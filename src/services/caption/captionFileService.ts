import { resolveProjectAssetKind } from '../project/assetTypeService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { PROJECT_LAYOUT } from '../project/projectLayoutService';

/**
 * The caption of an image or PSD is the `<stem>.txt` file next to it. This module is the only owner of that
 * file's format: `dataset/` captions start with the dataset trigger word, every other folder keeps plain tags.
 * Reads never rewrite a file; in-memory tags never contain the leading trigger word.
 */

export type ParsedCaption = { tags: string[]; triggerPresent: boolean };
export type CaptionFile = {
  /** Exact file content, or null when the file does not exist. */
  raw: string | null;
  /** undefined when there is no file; [] for an empty file. */
  tags: string[] | undefined;
  /** False when the trigger word is set but the file does not start with it. */
  triggerPresent: boolean;
};

const getParts = (path: string) => path.split('/').filter(Boolean);
const normalizeKey = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const isMissing = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
};

const toProjectRelative = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  return normalized === 'Project' ? '' : normalized.replace(/^Project\//, '');
};

export const isCaptionCarrierName = (name: string): boolean => {
  const kind = resolveProjectAssetKind(name);
  return kind === 'image' || kind === 'psd';
};

/** `a.png` -> `a.txt`; null for files that cannot carry a caption. */
export const getCaptionFileName = (imageName: string): string | null => {
  if (!isCaptionCarrierName(imageName)) return null;
  const index = imageName.lastIndexOf('.');
  return `${index > 0 ? imageName.slice(0, index) : imageName}.txt`;
};

/** `Project/dataset/a.png` -> `Project/dataset/a.txt` (keeps the prefix style of the input). */
export const getCaptionPathForImage = (imagePath: string): string => {
  const parts = imagePath.split('/');
  const name = parts.pop() ?? '';
  const index = name.lastIndexOf('.');
  parts.push(`${index > 0 ? name.slice(0, index) : name}.txt`);
  return parts.join('/');
};

export const isDatasetCaptionPath = (path: string | undefined): boolean => {
  if (!path) return false;
  const relative = toProjectRelative(path);
  return relative === PROJECT_LAYOUT.datasetDir || relative.startsWith(`${PROJECT_LAYOUT.datasetDir}/`);
};

/** Returns a user-facing message when the trigger word cannot be stored in a caption file. */
export const validateTriggerWord = (value: string): string | null =>
  /[,\n\r]/u.test(value) ? 'The trigger word cannot contain commas or line breaks, because captions are comma-separated.' : null;

export const normalizeTriggerWord = (value: string): string => value.replace(/\s+/gu, ' ').trim();

export const parseCaptionText = (raw: string, trigger = ''): ParsedCaption => {
  const tokens = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/[,\n]/u)
    .map((token) => token.trim())
    .filter(Boolean);
  const key = normalizeKey(trigger);
  if (key && tokens.length > 0 && normalizeKey(tokens[0]) === key) return { tags: tokens.slice(1), triggerPresent: true };
  return { tags: tokens, triggerPresent: !key };
};

/** `[trigger, ...tags]` for files in `dataset/` (trigger undefined elsewhere); '' for an empty caption. */
export const renderCaptionText = (tags: readonly string[], trigger?: string): string => {
  const seen = new Set<string>();
  const values = [trigger ?? '', ...tags]
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = normalizeKey(tag);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return values.length ? `${values.join(', ')}\n` : '';
};

/** The trigger that applies to a file: only captions inside `dataset/` carry it. */
export const getCaptionTriggerForPath = (path: string, trigger: string | undefined): string | undefined => {
  const value = normalizeTriggerWord(trigger ?? '');
  return value && isDatasetCaptionPath(path) ? value : undefined;
};

const getParentDirectory = async (root: ProjectDirectoryHandle, path: string): Promise<{ directory: ProjectDirectoryHandle; name: string }> => {
  const parts = getParts(toProjectRelative(path));
  const name = parts.pop();
  if (!name) throw new Error('Select a file inside the project.');
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part);
  return { directory, name };
};

const readRaw = async (root: ProjectDirectoryHandle, captionPath: string): Promise<string | null> => {
  try {
    const { directory, name } = await getParentDirectory(root, captionPath);
    return await (await directory.getFileHandle(name)).getFile().then((file) => file.text());
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

/** Exact current content of the caption of `imagePath`, or null. */
export const readCaptionRaw = (root: ProjectDirectoryHandle, imagePath: string): Promise<string | null> =>
  readRaw(root, getCaptionPathForImage(imagePath));

/** The caption file exists but lacks the trigger word that dataset/ captions start with. */
export const isTriggerMissing = (caption: CaptionFile): boolean => caption.raw !== null && !caption.triggerPresent;

export const parseCaptionFile = (raw: string | null, imagePath: string, trigger?: string): CaptionFile => {
  if (raw === null) return { raw, tags: undefined, triggerPresent: true };
  const parsed = parseCaptionText(raw, getCaptionTriggerForPath(imagePath, trigger) ?? '');
  return { raw, tags: parsed.tags, triggerPresent: parsed.triggerPresent };
};

export const readCaptionFile = async (root: ProjectDirectoryHandle, imagePath: string, trigger?: string): Promise<CaptionFile> =>
  parseCaptionFile(await readCaptionRaw(root, imagePath), imagePath, trigger);

/** Writes exact content; null removes the file. Returns the content now on disk (null when removed). */
export const writeCaptionRaw = async (root: ProjectDirectoryHandle, imagePath: string, raw: string | null): Promise<string | null> => {
  const captionPath = getCaptionPathForImage(imagePath);
  if (raw === null) {
    try {
      const { directory, name } = await getParentDirectory(root, captionPath);
      await directory.removeEntry(name);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return null;
  }
  const { directory, name } = await getParentDirectory(root, captionPath);
  const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try { await writer.write(raw); await writer.close(); }
  catch (error) { await writer.abort?.(); throw error; }
  return raw;
};

/** Renders and writes the caption; undefined tags remove the file. The trigger is applied only inside `dataset/`. */
export const writeCaptionFile = (root: ProjectDirectoryHandle, imagePath: string, tags: readonly string[] | undefined, trigger?: string): Promise<string | null> =>
  writeCaptionRaw(root, imagePath, tags === undefined ? null : renderCaptionText(tags, getCaptionTriggerForPath(imagePath, trigger)));

/** Caption text that a file needs after moving into (`add`) or out of (`remove`) `dataset/`; null when it stays as is. */
export const reconcileCaptionRaw = (raw: string | null, direction: 'add' | 'remove', trigger: string): string | null => {
  const value = normalizeTriggerWord(trigger);
  if (raw === null || !value) return null;
  const parsed = parseCaptionText(raw, value);
  if (direction === 'add') return parsed.triggerPresent ? null : renderCaptionText(parsed.tags, value);
  return parsed.triggerPresent ? renderCaptionText(parsed.tags) : null;
};

const reconcileFile = async (root: ProjectDirectoryHandle, imagePath: string, direction: 'add' | 'remove', trigger: string) => {
  const raw = await readCaptionRaw(root, imagePath);
  const next = reconcileCaptionRaw(raw, direction, trigger);
  if (next !== null) await writeCaptionRaw(root, imagePath, next);
};

const reconcileFolder = async (directory: ProjectDirectoryHandle, path: string, direction: 'add' | 'remove', trigger: string, root: ProjectDirectoryHandle) => {
  for await (const [name, entry] of directory.entries()) {
    const child = `${path}/${name}`;
    if ('entries' in entry) await reconcileFolder(entry as ProjectDirectoryHandle, child, direction, trigger, root);
    else if (isCaptionCarrierName(name)) await reconcileFile(root, child, direction, trigger);
  }
};

/**
 * A file or folder that crossed the `dataset/` boundary gets (or loses) the trigger word in its caption files.
 * Call inside the same exclusive file operation as the move; `move.to` is the new location.
 */
export const reconcileTriggerAfterMove = async (
  root: ProjectDirectoryHandle,
  move: { from: string; to: string },
  trigger: string
): Promise<void> => {
  const intoDataset = isDatasetCaptionPath(move.to);
  if (intoDataset === isDatasetCaptionPath(move.from) || !normalizeTriggerWord(trigger)) return;
  const direction = intoDataset ? 'add' : 'remove';
  const { directory, name } = await getParentDirectory(root, move.to);
  if (isCaptionCarrierName(name)) { await reconcileFile(root, move.to, direction, trigger); return; }
  let folder: ProjectDirectoryHandle;
  try { folder = await directory.getDirectoryHandle(name); }
  catch (error) { if (isMissing(error)) return; throw error; }
  await reconcileFolder(folder, toProjectRelative(move.to), direction, trigger, root);
};

export type CaptionFolderEntry = { path: string; raw: string | null };

/** Every image/PSD under a project-relative folder with its caption file content. */
export const listCaptionFiles = async (root: ProjectDirectoryHandle, folderPath: string): Promise<CaptionFolderEntry[]> => {
  let directory = root;
  const relative = toProjectRelative(folderPath);
  try { for (const part of getParts(relative)) directory = await directory.getDirectoryHandle(part); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const entries: CaptionFolderEntry[] = [];
  const walk = async (current: ProjectDirectoryHandle, path: string) => {
    for await (const [name, entry] of current.entries()) {
      const child = path ? `${path}/${name}` : name;
      if ('entries' in entry) await walk(entry as ProjectDirectoryHandle, child);
      else if (isCaptionCarrierName(name)) entries.push({ path: child, raw: await readCaptionRaw(root, child) });
    }
  };
  await walk(directory, relative);
  return entries;
};
