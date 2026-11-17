import {
  createLayoutV3ProjectJson,
  readLegacyProjectManifest,
  readProjectDirectory,
  type LayoutV3Migration,
  type LegacyProjectManifest,
  type ProjectDirectoryFileHandle,
  type ProjectDirectoryHandle,
} from './projectDirectoryService';
import {
  LEGACY_VERSION_INDEX_PATH,
  RESTORE_BACKUP_DIRECTORY,
  VERSION_SNAPSHOT_DIRECTORY,
  createProjectVersion,
  listProjectVersions,
  isSnapshotExcludedPath,
} from './projectVersionService';
import { getUniqueExplorerName } from './explorerFileService';
import {
  getCaptionPathForImage,
  getCaptionTriggerForPath,
  isCaptionCarrierName,
  normalizeTriggerWord,
  parseCaptionText,
  readCaptionRaw,
  reconcileCaptionRaw,
  renderCaptionText,
  writeCaptionRaw,
} from '../caption/captionFileService';
import { getProjectAssetMimeType, resolveProjectAssetKind } from './assetTypeService';
import { ASSET_MANIFEST_SUFFIX, getAssetManifestName } from './assetManifestService';
import { isLegacyProjectRootPath } from './projectPathFilters';
import {
  applyMovesToAssetRecord,
  createEmptyAssetRegistry,
  normalizeRegistryPath,
  parseAssetRegistry,
  serializeAssetRegistry,
  statProjectFile,
  type AssetRecord,
} from './assetRegistryService';
import { invalidateProjectJsonMigrations } from './projectJsonMigrationsCache';
import { applyBuildSessionPathMoves, normalizeBuildSession } from '../build/buildSessionService';
import { applyProjectRelativePathMoves, type ExplorerPathMove } from '../../lib/datasetAssets';
import type { AspectRatio, AugmentationConfig, CropFrame, ImageType } from '../../types';
import {
  LEGACY_ASSETS_DIRECTORY,
  LEGACY_CACHE_DIRECTORY,
  LEGACY_SHARED_DIRECTORY,
  LEGACY_SOURCE_DIRECTORY,
  PROJECT_ASSETS_FILE,
  PROJECT_DATA_DIRECTORY,
  PROJECT_FILE,
  PROJECT_GIT_DIRECTORY,
  PROJECT_LAYOUT,
  PROJECT_MANIFEST_FILE,
  detectProjectLayout,
  isInternalProjectEntry,
  type ProjectLayoutVersion,
} from './projectLayoutService';

export { detectProjectLayout };
export type { ProjectLayoutVersion };

const JOURNAL_FORMAT = 'dataset-creator-journal';
const LEGACY_DATA_BACKUP = 'legacy-data';
// Sub-folders that can hold originals/edits an old reader looks up by id; such a folder is never moved.
const LEGACY_DATA_PAYLOAD_DIRECTORIES = ['source-images', 'generated-images'];
const GIT_SERVICE_FILES = ['dataset-creator-versions.json'];
const JOURNAL_KINDS: LayoutJournal['kind'][] = ['layout-v3', 'raw-inbox', 'trigger-rewrite', 'captions-txt', 'assets-registry'];
const EXPORTS_DIRECTORY = 'exports';

export type LayoutMigrationProgress = { phase: string; completed: number; total: number };
export type LayoutMigrationOptions = {
  onProgress?: (progress: LayoutMigrationProgress) => void;
  signal?: AbortSignal;
};

export type LayoutMigrationPlan = {
  fromVersion: 1 | 2;
  /** Human-readable list of what the upgrade changes. */
  changes: string[];
  /** Conditions that may stop the upgrade after the old conversions have been retried. */
  warnings: string[];
  snapshotFileCount: number;
  snapshotBytes: number;
  /** An interrupted earlier upgrade will be finished first. */
  pendingJournals: number;
};

export type LayoutMigrationReport = {
  journalId?: string;
  snapshotVersionId?: string;
  fromVersion?: 1 | 2;
  /** Journals of interrupted upgrades that were finished before anything else. */
  resumed: string[];
  keptLegacyData: boolean;
  /** Set when raw materials moved from `src/` to `inbox/` during this run. */
  rawMaterials?: RawMaterialsReport;
  /** Sidecar tags moved into TXT captions during this run. */
  captions?: CaptionTxtReport;
  /** Sidecars folded into the asset registry during this run. */
  assets?: AssetsRegistryReport;
};

export type RawMaterialsReport = {
  journalId: string;
  /** Project-relative folder moves plus every file or folder renamed because of a name collision. */
  pathMoves: Array<{ from: string; to: string }>;
  collisions: Array<{ from: string; to: string }>;
};

export type RawMaterialsPlan = {
  fileCount: number;
  bytes: number;
  folders: string[];
};

export type LayoutMigrationErrorKind = 'blocked' | 'snapshot-failed' | 'failed';

export class LayoutMigrationError extends Error {
  constructor(message: string, readonly kind: LayoutMigrationErrorKind) {
    super(message);
    this.name = 'LayoutMigrationError';
  }
}

/** One caption file change: exact content before and after (null = no file). `path` is the project-relative image path. */
export type CaptionWrite = { path: string; before: string | null; after: string | null };

type JournalStep = {
  id: string;
  type: 'move' | 'write' | 'delete' | 'raw-move' | 'rewrite-paths' | 'caption-writes' | 'project-trigger' | 'caption-collisions' | 'captions-txt' | 'captions-marker' | 'assets-fold' | 'assets-sidecars' | 'assets-marker';
  description: string;
  done: boolean;
  /** move: source and destination project-relative paths. */
  from?: string;
  to?: string;
  /** write/delete: target path. */
  path?: string;
  /** write: file content. */
  content?: string;
  /** delete: keep a copy in `.datasetcreator/backup/<id>/` first. */
  backup?: boolean;
  /** delete: remove a directory only when it has no entries (never a file). */
  ifEmpty?: boolean;
  /** raw-move: a file or folder that had to be renamed because the destination name was taken. */
  renames?: Array<{ from: string; to: string }>;
  /** raw-move: set when the step began, so a re-run knows it continues an interrupted attempt. */
  started?: boolean;
  /** caption-writes: caption files to change. */
  writes?: CaptionWrite[];
  /** caption-writes: files that changed on disk since the plan was made and were left untouched. */
  conflicts?: string[];
  /** project-trigger: the trigger word stored in project.json. */
  trigger?: string;
  /** assets-fold: sidecars folded into assets.json; assets-sidecars moves exactly these into the backup. */
  sidecars?: string[];
  /** assets-fold: records written to assets.json. */
  records?: number;
  /** captions-txt: what the conversion did. */
  stats?: { converted: number; triggersAdded: number; backedUp: number };
};

export type LayoutJournal = {
  format: typeof JOURNAL_FORMAT;
  version: 1;
  kind: 'layout-v3' | 'raw-inbox' | 'trigger-rewrite' | 'captions-txt' | 'assets-registry';
  id: string;
  fromVersion: 1 | 2 | 3;
  createdAt: string;
  snapshotVersionId?: string;
  steps: JournalStep[];
  completedAt?: string;
};

type FsEntry =
  | { kind: 'file'; handle: ProjectDirectoryFileHandle }
  | { kind: 'directory'; handle: ProjectDirectoryHandle };

const getParts = (path: string) => path.split('/').filter(Boolean);
const parentOf = (path: string) => getParts(path).slice(0, -1).join('/');
const nameOf = (path: string) => getParts(path).pop() ?? '';
const join = (...parts: string[]) => parts.flatMap(getParts).join('/');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isMissing = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
};
const abortError = () => new DOMException('Project upgrade canceled', 'AbortError');
const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };

const getDirectory = async (root: ProjectDirectoryHandle, path: string, create = false) => {
  let directory = root;
  for (const part of getParts(path)) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
};

const getEntry = async (root: ProjectDirectoryHandle, path: string): Promise<FsEntry | undefined> => {
  let parent: ProjectDirectoryHandle;
  try { parent = await getDirectory(root, parentOf(path)); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  const name = nameOf(path);
  try { return { kind: 'directory', handle: await parent.getDirectoryHandle(name) }; } catch (error) { if (!isMissing(error)) throw error; }
  try { return { kind: 'file', handle: await parent.getFileHandle(name) }; } catch (error) { if (!isMissing(error)) throw error; }
  return undefined;
};

const listEntries = async (directory: ProjectDirectoryHandle) => {
  const entries: Array<[string, ProjectDirectoryHandle | ProjectDirectoryFileHandle]> = [];
  for await (const entry of directory.entries()) entries.push(entry);
  return entries;
};

const writeAt = async (root: ProjectDirectoryHandle, path: string, value: Blob | string) => {
  if (path === PROJECT_FILE) invalidateProjectJsonMigrations(root);
  const handle = await (await getDirectory(root, parentOf(path), true)).getFileHandle(nameOf(path), { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(value);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
};

const readTextAt = async (root: ProjectDirectoryHandle, path: string): Promise<string | undefined> => {
  const entry = await getEntry(root, path);
  return entry?.kind === 'file' ? (await entry.handle.getFile()).text() : undefined;
};

const removeAt = async (root: ProjectDirectoryHandle, path: string) => {
  try {
    await (await getDirectory(root, parentOf(path))).removeEntry(nameOf(path), { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
};

/**
 * Copies a file or folder without overwriting. A destination that already holds different data
 * keeps it; the source copy is stored under `conflictPath` so nothing is lost when the source is removed.
 */
const mergeCopy = async (root: ProjectDirectoryHandle, from: string, to: string, conflictPath: string): Promise<void> => {
  const source = await getEntry(root, from);
  if (!source) return;
  if (source.kind === 'file') {
    const file = await source.handle.getFile();
    const existing = await getEntry(root, to);
    if (!existing) { await writeAt(root, to, file); return; }
    if (existing.kind === 'file' && (await existing.handle.getFile()).size === file.size) return;
    await writeAt(root, conflictPath, file);
    return;
  }
  await getDirectory(root, to, true);
  for (const [name] of await listEntries(source.handle)) {
    await mergeCopy(root, join(from, name), join(to, name), join(conflictPath, name));
  }
};

const journalPath = (id: string) => `${PROJECT_LAYOUT.journalDir}/${id}.json`;
const backupPath = (id: string, path: string) => `${PROJECT_LAYOUT.backupDir}/${id}/${path}`;
const conflictsPath = (id: string, path: string) => `${PROJECT_LAYOUT.backupDir}/${id}/conflicts/${path}`;

const writeJournal = (root: ProjectDirectoryHandle, journal: LayoutJournal) =>
  writeAt(root, journalPath(journal.id), JSON.stringify(journal, null, 2));

/** Runs one journal step. Every branch first inspects the current state, so a step interrupted anywhere can simply run again. */
const executeStep = async (root: ProjectDirectoryHandle, journal: LayoutJournal, step: JournalStep): Promise<void> => {
  if (step.type === 'write') {
    if (!step.path || step.content === undefined) throw new Error(`Journal step ${step.id} is incomplete.`);
    if (await readTextAt(root, step.path) !== step.content) await writeAt(root, step.path, step.content);
    return;
  }
  if (step.type === 'raw-move') {
    if (!step.from || !step.to) throw new Error(`Journal step ${step.id} is incomplete.`);
    await moveRawTree(root, journal, step);
    return;
  }
  if (step.type === 'rewrite-paths') {
    await rewriteMovedPaths(root, getRawPathMoves(journal));
    return;
  }
  if (step.type === 'caption-writes') { await applyCaptionWrites(root, step); return; }
  if (step.type === 'project-trigger') { await setProjectTrigger(root, step.trigger ?? ''); return; }
  if (step.type === 'caption-collisions') { await resolveStemCollisions(root, journal, step); return; }
  if (step.type === 'captions-txt') { await convertSidecarCaptions(root, journal, step); return; }
  if (step.type === 'captions-marker') { await markCaptionsConverted(root, journal.id); return; }
  if (step.type === 'assets-fold') { await foldSidecarsIntoRegistry(root, step); return; }
  if (step.type === 'assets-sidecars') { await moveSidecarsToBackup(root, journal); return; }
  if (step.type === 'assets-marker') { await markAssetsRegistry(root, journal.id); return; }
  if (step.type === 'move') {
    if (!step.from || !step.to) throw new Error(`Journal step ${step.id} is incomplete.`);
    if (!await getEntry(root, step.from)) return; // Already moved, or never existed.
    await mergeCopy(root, step.from, step.to, conflictsPath(journal.id, step.from));
    await removeAt(root, step.from);
    if (await getEntry(root, step.from)) throw new Error(`Could not remove ${step.from} after moving it.`);
    return;
  }
  if (!step.path) throw new Error(`Journal step ${step.id} is incomplete.`);
  const entry = await getEntry(root, step.path);
  if (!entry) return;
  if (step.ifEmpty && (entry.kind === 'file' || (await listEntries(entry.handle)).length > 0)) return;
  if (step.backup) await mergeCopy(root, step.path, backupPath(journal.id, step.path), conflictsPath(journal.id, step.path));
  await removeAt(root, step.path);
};

const runJournal = async (
  root: ProjectDirectoryHandle,
  journal: LayoutJournal,
  options: LayoutMigrationOptions,
  phase = 'Upgrading project layout'
) => {
  const total = journal.steps.length;
  for (const step of journal.steps) {
    if (step.done) continue;
    throwIfAborted(options.signal);
    options.onProgress?.({ phase: step.description || phase, completed: journal.steps.filter((entry) => entry.done).length, total });
    try {
      await executeStep(root, journal, step);
    } catch (error) {
      throw new LayoutMigrationError(
        `Project upgrade stopped at "${step.description}": ${errorMessage(error)}. Your files are safe; open the project again to continue the upgrade.`,
        'failed'
      );
    }
    step.done = true;
    await writeJournal(root, journal);
  }
  journal.completedAt = new Date().toISOString();
  await stampLayoutCompletion(root, journal);
  await writeJournal(root, journal);
  options.onProgress?.({ phase, completed: total, total });
};

/** Records the real completion time in project.json (only for the migration that wrote it). */
const stampLayoutCompletion = async (root: ProjectDirectoryHandle, journal: LayoutJournal) => {
  const text = await readTextAt(root, PROJECT_FILE);
  if (text === undefined) return;
  const json = JSON.parse(text) as { project?: { migrations?: { layoutV3?: LayoutV3Migration } } };
  const layout = json.project?.migrations?.layoutV3;
  if (!layout || layout.id !== journal.id || layout.completedAt) return;
  layout.completedAt = journal.completedAt;
  await writeAt(root, PROJECT_FILE, JSON.stringify(json, null, 2));
};

const parseJournal = (name: string, text: string): LayoutJournal | undefined => {
  let journal: LayoutJournal;
  try { journal = JSON.parse(text) as LayoutJournal; } catch { throw new LayoutMigrationError(`The upgrade journal ${name} is unreadable. Restore the pre-upgrade version from the Versions panel or contact support.`, 'failed'); }
  if (journal?.format !== JOURNAL_FORMAT || (!JOURNAL_KINDS.includes(journal.kind)) || !Array.isArray(journal.steps) || typeof journal.id !== 'string') return undefined;
  return journal;
};

/** Finishes interrupted v3 upgrades (journals without `completedAt`). Returns the journal ids that were resumed. */
export const resumePendingJournals = async (root: ProjectDirectoryHandle, options: LayoutMigrationOptions = {}): Promise<string[]> => {
  const directory = await getDirectory(root, PROJECT_LAYOUT.journalDir).catch((error) => { if (isMissing(error)) return undefined; throw error; });
  if (!directory) return [];
  const resumed: string[] = [];
  for (const [name, entry] of await listEntries(directory)) {
    if (!('getFile' in entry) || !name.endsWith('.json')) continue;
    const journal = parseJournal(name, await (await entry.getFile()).text());
    if (!journal || journal.completedAt) continue;
    await runJournal(root, journal, options, 'Finishing the interrupted project upgrade');
    resumed.push(journal.id);
  }
  return resumed;
};

const countPendingJournals = async (root: ProjectDirectoryHandle): Promise<number> => {
  const directory = await getDirectory(root, PROJECT_LAYOUT.journalDir).catch((error) => { if (isMissing(error)) return undefined; throw error; });
  if (!directory) return 0;
  let count = 0;
  for (const [name, entry] of await listEntries(directory)) {
    if (!('getFile' in entry) || !name.endsWith('.json')) continue;
    const journal = parseJournal(name, await (await entry.getFile()).text());
    if (journal && !journal.completedAt) count += 1;
  }
  return count;
};

const measureSnapshot = async (root: ProjectDirectoryHandle) => {
  let files = 0;
  let bytes = 0;
  const walk = async (directory: ProjectDirectoryHandle, prefix: string) => {
    for (const [name, entry] of await listEntries(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (isSnapshotExcludedPath(path)) continue;
      if ('getDirectoryHandle' in entry) await walk(entry, path);
      else { files += 1; bytes += (await (entry as ProjectDirectoryFileHandle).getFile()).size; }
    }
  };
  await walk(root, '');
  return { files, bytes };
};

const hasLegacyPayload = async (root: ProjectDirectoryHandle): Promise<boolean> => {
  const entry = await getEntry(root, PROJECT_DATA_DIRECTORY);
  if (entry?.kind !== 'directory') return false;
  const names = (await listEntries(entry.handle)).map(([name]) => name);
  return LEGACY_DATA_PAYLOAD_DIRECTORIES.some((name) => names.includes(name));
};

type GitServiceState = { present: string[]; isDirectory: boolean; isFile: boolean };

const readGitServiceState = async (root: ProjectDirectoryHandle): Promise<GitServiceState> => {
  let entry: FsEntry | undefined;
  try { entry = await getEntry(root, PROJECT_GIT_DIRECTORY); }
  // An unreadable .git is treated as a real repository and left alone.
  catch { return { present: [], isDirectory: false, isFile: true }; }
  if (!entry) return { present: [], isDirectory: false, isFile: false };
  if (entry.kind === 'file') return { present: [], isDirectory: false, isFile: true };
  const serviceNames = new Set([...GIT_SERVICE_FILES, 'snapshots', 'restore-backups']);
  return { present: (await listEntries(entry.handle)).map(([name]) => name).filter((name) => serviceNames.has(name)), isDirectory: true, isFile: false };
};

/** Read-only description of the upgrade for the confirmation dialog. */
export const planLayoutMigration = async (root: ProjectDirectoryHandle): Promise<LayoutMigrationPlan> => {
  if (await detectProjectLayout(root) !== 'v2') throw new Error('Only a project in the previous layout can be upgraded.');
  const manifest = await readLegacyProjectManifest(root);
  const fromVersion: 1 | 2 = manifest.version === 1 ? 1 : 2;
  const changes = [`Project settings move from ${PROJECT_MANIFEST_FILE} to ${PROJECT_FILE} (new project format, version 3).`];
  const warnings: string[] = [];
  if (fromVersion === 1) changes.unshift('The old Dataset file is converted first: Dataset membership becomes the dataset/ folder.');
  const status = manifest.project?.datasetMigration?.status;
  if (status === 'running' || status === 'partial') warnings.push(`An earlier Dataset conversion is ${status}; it is retried first. If it cannot finish, the upgrade stops before the new layout is applied.`);
  if (manifest.project?.captionMigration?.status === 'pending') warnings.push('Some legacy caption overrides are still unresolved; the upgrade stops if they stay unresolved.');
  if (await getEntry(root, LEGACY_CACHE_DIRECTORY)) changes.push(`The preview cache moves from ${LEGACY_CACHE_DIRECTORY} to ${PROJECT_LAYOUT.cacheDir}.`);
  const git = await readGitServiceState(root);
  if (git.present.length) {
    changes.push(`Version history moves out of ${PROJECT_GIT_DIRECTORY} into ${PROJECT_LAYOUT.versionsDir}.`);
    changes.push(`${PROJECT_GIT_DIRECTORY} is removed only if nothing else is left in it; a real Git repository is never touched.`);
  } else if (git.isFile || git.isDirectory) changes.push(`${PROJECT_GIT_DIRECTORY} is left untouched.`);
  if (await getEntry(root, PROJECT_DATA_DIRECTORY)) {
    changes.push(await hasLegacyPayload(root)
      ? `${PROJECT_DATA_DIRECTORY} still holds project data, so it stays where it is.`
      : `Leftover ${PROJECT_DATA_DIRECTORY} files are moved into ${PROJECT_LAYOUT.backupDir}/<id>/${LEGACY_DATA_BACKUP} unless the project still uses them.`);
  }
  if (await getEntry(root, LEGACY_SHARED_DIRECTORY) || await getEntry(root, LEGACY_ASSETS_DIRECTORY)) {
    changes.push(`Raw materials move from ${LEGACY_SHARED_DIRECTORY} to ${PROJECT_LAYOUT.rawDir}/ and from ${LEGACY_ASSETS_DIRECTORY} to ${PROJECT_LAYOUT.generatedDir}/; files whose names are taken get a numbered name and every such rename is reported.`);
  }
  changes.push(`Originals of every replaced file are kept in ${PROJECT_LAYOUT.backupDir}/<id>/.`);
  const { files, bytes } = await measureSnapshot(root);
  return {
    fromVersion,
    changes: changes.filter(Boolean),
    warnings,
    snapshotFileCount: files,
    snapshotBytes: bytes,
    pendingJournals: await countPendingJournals(root),
  };
};

/** Reasons the old conversions leave the project unfit for the new layout (empty when it can proceed). */
export const getLayoutMigrationBlockers = (manifest: Pick<LegacyProjectManifest['project'], 'datasetMigration' | 'captionMigration'>): string[] => {
  const blockers: string[] = [];
  const dataset = manifest.datasetMigration;
  if (dataset && dataset.status !== 'complete') {
    blockers.push(`The old Dataset conversion is ${dataset.status}${dataset.conflicts.length ? ` with ${dataset.conflicts.length} unresolved file${dataset.conflicts.length === 1 ? '' : 's'}` : ''}.`);
  }
  const caption = manifest.captionMigration;
  if (caption?.status === 'pending') {
    blockers.push(`The old caption conversion has ${caption.unresolved.length} unresolved caption${caption.unresolved.length === 1 ? '' : 's'}.`);
  }
  return blockers;
};


const stemOf = (name: string) => name.replace(/\.[^./]+$/, '');
const isOwnerKind = (name: string) => { const kind = resolveProjectAssetKind(name); return kind === 'image' || kind === 'psd'; };

const newId = () => crypto.randomUUID();

/**
 * Moves one folder into another (`src/shared` -> `inbox`). Sidecars (`*.manifest.json`, caption `.txt`) travel with
 * their file; a name already taken at the destination is resolved with getUniqueExplorerName and recorded in
 * the step so the path rewrite and the report know about it. Safe to run again after an interruption.
 */
const moveRawTree = async (root: ProjectDirectoryHandle, journal: LayoutJournal, step: JournalStep): Promise<void> => {
  const resumed = Boolean(step.started);
  if (!resumed) { step.started = true; await writeJournal(root, journal); }
  step.renames ??= [];
  const record = async (from: string, to: string) => {
    if (step.renames!.some((entry) => entry.from === from)) return;
    step.renames!.push({ from, to });
    await writeJournal(root, journal);
  };
  const recorded = (from: string) => step.renames!.find((entry) => entry.from === from)?.to;

  const moveFile = async (from: string, to: string) => {
    const entry = await getEntry(root, from);
    if (entry?.kind !== 'file') return;
    await writeAt(root, to, await entry.handle.getFile());
    await removeAt(root, from);
  };

  /** True when an interrupted earlier attempt already wrote this exact file to the destination. */
  const alreadyCopied = async (from: string, to: string) => {
    if (!resumed) return false;
    const [source, target] = await Promise.all([getEntry(root, from), getEntry(root, to)]);
    if (source?.kind !== 'file' || target?.kind !== 'file') return false;
    const [a, b] = await Promise.all([source.handle.getFile(), target.handle.getFile()]);
    if (a.size !== b.size) return false;
    const [left, right] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
    return new Uint8Array(left).every((value, index) => value === new Uint8Array(right)[index]);
  };

  const moveDirectory = async (fromDir: string, toDir: string): Promise<void> => {
    const source = await getEntry(root, fromDir);
    if (source?.kind !== 'directory') return;
    const destination = await getDirectory(root, toDir, true);
    const entries = await listEntries(source.handle);
    const files = entries.filter(([, handle]) => 'getFile' in handle).map(([name]) => name);
    const directories = entries.filter(([, handle]) => 'getDirectoryHandle' in handle).map(([name]) => name);
    const ownerOf = (name: string): string | undefined => {
      if (name.endsWith(ASSET_MANIFEST_SUFFIX)) {
        const base = name.slice(0, -ASSET_MANIFEST_SUFFIX.length);
        return files.includes(base) ? base : undefined;
      }
      if (name.toLowerCase().endsWith('.txt')) {
        const stem = stemOf(name).toLowerCase();
        return files.find((candidate) => candidate !== name && isOwnerKind(candidate) && stemOf(candidate).toLowerCase() === stem);
      }
      return undefined;
    };
    const sidecars = new Map<string, string[]>();
    const owned = new Set<string>();
    for (const name of files) {
      const owner = ownerOf(name);
      if (!owner) continue;
      owned.add(name);
      sidecars.set(owner, [...(sidecars.get(owner) ?? []), name]);
    }
    // A sidecar whose file moved in an earlier attempt follows that file's recorded (renamed) name.
    const followMovedOwner = (dir: string, name: string): string => {
      if (name.endsWith(ASSET_MANIFEST_SUFFIX)) {
        const moved = recorded(join(dir, name.slice(0, -ASSET_MANIFEST_SUFFIX.length)));
        return moved ? getAssetManifestName(nameOf(moved)) : name;
      }
      if (name.toLowerCase().endsWith('.txt')) {
        const stem = stemOf(name).toLowerCase();
        const moved = step.renames!.find((entry) => parentOf(entry.from) === dir && isOwnerKind(nameOf(entry.from)) && stemOf(nameOf(entry.from)).toLowerCase() === stem);
        return moved ? `${stemOf(nameOf(moved.to))}.txt` : name;
      }
      return name;
    };
    const sidecarTarget = (name: string, finalOwner: string) =>
      name.endsWith(ASSET_MANIFEST_SUFFIX) ? getAssetManifestName(finalOwner) : `${stemOf(finalOwner)}.txt`;

    const place = async (name: string, finalName: string, from: string, to: string) => {
      if (finalName !== name) await record(from, to);
      if (await alreadyCopied(from, to)) { await removeAt(root, from); return; }
      await moveFile(from, to);
    };

    for (const name of files.filter((entry) => !owned.has(entry))) {
      const from = join(fromDir, name);
      const known = recorded(from);
      let finalName = known ? nameOf(known) : name;
      if (!known) {
        const preferred = followMovedOwner(fromDir, name);
        const duplicate = await alreadyCopied(from, join(toDir, preferred));
        finalName = duplicate ? preferred : await getUniqueExplorerName(destination, preferred);
      }
      await place(name, finalName, from, join(toDir, finalName));
      for (const sidecar of sidecars.get(name) ?? []) {
        const sidecarFrom = join(fromDir, sidecar);
        const wanted = sidecarTarget(sidecar, finalName);
        const sidecarFinal = await alreadyCopied(sidecarFrom, join(toDir, wanted)) ? wanted : await getUniqueExplorerName(destination, wanted);
        await place(sidecar, sidecarFinal, sidecarFrom, join(toDir, sidecarFinal));
      }
    }
    for (const name of directories) {
      const from = join(fromDir, name);
      const known = recorded(from);
      let finalName = known ? nameOf(known) : name;
      if (!known) {
        const existing = await getEntry(root, join(toDir, name));
        if (existing?.kind === 'file') finalName = await getUniqueExplorerName(destination, name);
      }
      if (finalName !== name) await record(from, join(toDir, finalName));
      await moveDirectory(from, join(toDir, finalName));
    }
    const left = await getEntry(root, fromDir);
    if (left?.kind === 'directory' && (await listEntries(left.handle)).length === 0) await removeAt(root, fromDir);
  };

  await moveDirectory(step.from!, step.to!);
};

const RAW_STEP_SOURCES: Array<{ id: string; from: string; to: string }> = [
  { id: 'raw-shared', from: LEGACY_SHARED_DIRECTORY, to: PROJECT_LAYOUT.rawDir },
  { id: 'raw-assets', from: LEGACY_ASSETS_DIRECTORY, to: PROJECT_LAYOUT.generatedDir },
];

/** Moves for the path rewrite: collision renames first (most specific), then the folder prefixes. */
const getRawPathMoves = (journal: LayoutJournal): ExplorerPathMove[] => {
  const toExplorer = (path: string) => `Project/${path}`;
  const renames = journal.steps.flatMap((step) => step.type === 'raw-move' || step.type === 'caption-collisions' ? step.renames ?? [] : []);
  const folders = journal.steps.filter((step) => step.type === 'raw-move' && step.from && step.to).map((step) => ({ from: step.from!, to: step.to! }));
  return [...renames, ...folders].map((move) => ({ from: toExplorer(move.from), to: toExplorer(move.to) }));
};

const movePath = (path: string, moves: ExplorerPathMove[]): string => {
  const hadPrefix = path.startsWith('Project/');
  const moved = applyProjectRelativePathMoves(path, moves) ?? path;
  return hadPrefix ? `Project/${moved}` : moved;
};

const movePathMap = (paths: Record<string, string> | undefined, moves: ExplorerPathMove[]) =>
  paths ? Object.fromEntries(Object.entries(paths).map(([id, path]) => [id, applyProjectRelativePathMoves(path, moves, true) ?? path])) : paths;

/** Rewrites every stored reference to a moved path: project.json, per-asset manifests. Applying it twice changes nothing. */
const rewriteMovedPaths = async (root: ProjectDirectoryHandle, moves: ExplorerPathMove[]): Promise<void> => {
  const text = await readTextAt(root, PROJECT_FILE);
  if (text !== undefined) {
    const json = JSON.parse(text) as { project?: Record<string, any> };
    const project = json.project;
    if (project) {
      if (project.buildSession) project.buildSession = applyBuildSessionPathMoves(normalizeBuildSession(project.buildSession), moves);
      if (project.sourceImageManifests) project.sourceImageManifests = movePathMap(project.sourceImageManifests, moves);
      if (project.editedAssetManifests) project.editedAssetManifests = movePathMap(project.editedAssetManifests, moves);
      if (Array.isArray(project.dataset?.assetOrder)) {
        project.dataset.assetOrder = project.dataset.assetOrder.map((key: unknown) =>
          typeof key === 'string' && key.startsWith('file:') ? `file:${movePath(key.slice('file:'.length), moves)}` : key);
      }
      const settings = project.workspaceSettings;
      for (const key of ['excludedProjectCategories', 'includedProjectCategories']) {
        if (Array.isArray(settings?.[key])) settings[key] = settings[key].map((path: unknown) => typeof path === 'string' ? movePath(path, moves) : path);
      }
      const next = JSON.stringify(json, null, 2);
      if (next !== text) await writeAt(root, PROJECT_FILE, next);
    }
  }
  const registryText = await readTextAt(root, PROJECT_ASSETS_FILE);
  if (registryText !== undefined) {
    const registry = parseAssetRegistry(registryText);
    let changed = false;
    for (const [id, record] of Object.entries(registry.assets)) {
      const moved = applyMovesToAssetRecord(record, moves);
      if (moved !== record) { registry.assets[id] = moved; changed = true; }
    }
    if (changed) await writeAt(root, PROJECT_ASSETS_FILE, serializeAssetRegistry(registry));
  }
  const rewriteManifests = async (directoryPath: string) => {
    const entry = await getEntry(root, directoryPath);
    if (entry?.kind !== 'directory') return;
    for (const [name, child] of await listEntries(entry.handle)) {
      const path = join(directoryPath, name);
      if ('getDirectoryHandle' in child) { await rewriteManifests(path); continue; }
      if (!name.endsWith(ASSET_MANIFEST_SUFFIX)) continue;
      const manifestText = await (child as ProjectDirectoryFileHandle).getFile().then((file) => file.text());
      let manifest: Record<string, unknown>;
      try { manifest = JSON.parse(manifestText) as Record<string, unknown>; } catch { continue; }
      let changed = false;
      for (const field of ['originalFilePath', 'imageDataPath', 'psdDataPath']) {
        const value = manifest[field];
        if (typeof value !== 'string') continue;
        const moved = movePath(value, moves);
        if (moved !== value) { manifest[field] = moved; changed = true; }
      }
      if (changed) await writeAt(root, path, JSON.stringify(manifest, null, 2));
    }
  };
  for (const [name, child] of await listEntries(root)) {
    if ('getDirectoryHandle' in child && !isInternalProjectEntry(name) && name !== EXPORTS_DIRECTORY) await rewriteManifests(name);
  }
};

const applyCaptionWrites = async (root: ProjectDirectoryHandle, step: JournalStep): Promise<void> => {
  step.conflicts ??= [];
  for (const write of step.writes ?? []) {
    const current = await readCaptionRaw(root, write.path);
    if (current === write.after) continue;
    // Never overwrite a file somebody edited after the plan was made.
    if (current !== write.before) { if (!step.conflicts.includes(write.path)) step.conflicts.push(write.path); continue; }
    await writeCaptionRaw(root, write.path, write.after);
  }
};

/** Sets the trigger word in project.json (a legacy project keeps it in manifest.json, which the normal save writes). */
const setProjectTrigger = async (root: ProjectDirectoryHandle, trigger: string): Promise<void> => {
  const text = await readTextAt(root, PROJECT_FILE);
  if (text === undefined) return;
  const json = JSON.parse(text) as { project?: { dataset?: { triggerWord?: string } } };
  if (!json.project?.dataset || json.project.dataset.triggerWord === trigger) return;
  json.project.dataset.triggerWord = trigger;
  await writeAt(root, PROJECT_FILE, JSON.stringify(json, null, 2));
};

const markCaptionsConverted = async (root: ProjectDirectoryHandle, id: string): Promise<void> => {
  const text = await readTextAt(root, PROJECT_FILE);
  if (text === undefined) return;
  const json = JSON.parse(text) as { project?: { migrations?: Record<string, unknown> } };
  if (!json.project) return;
  json.project.migrations = { ...json.project.migrations, captionsTxt: { id, completedAt: new Date().toISOString() } };
  await writeAt(root, PROJECT_FILE, JSON.stringify(json, null, 2));
};

/**
 * Applies caption file changes (trigger word rewrite and its undo) through a journal, so an interruption is
 * finished the next time the project opens. Returns the files that were left alone because they changed meanwhile.
 */
export const applyCaptionWritesJournaled = async (
  root: ProjectDirectoryHandle,
  options: { kind: 'trigger-rewrite'; writes: CaptionWrite[]; triggerWord: string } & LayoutMigrationOptions
): Promise<{ conflicts: string[] }> => {
  const id = newId();
  const steps: Omit<JournalStep, 'done'>[] = [
    { id: 'caption-writes', type: 'caption-writes', writes: options.writes, description: 'Rewrite the trigger word in captions' },
    { id: 'project-trigger', type: 'project-trigger', trigger: options.triggerWord, description: 'Store the trigger word' },
  ];
  const journal: LayoutJournal = {
    format: JOURNAL_FORMAT, version: 1, kind: options.kind, id, fromVersion: 3,
    createdAt: new Date().toISOString(), steps: steps.map((step) => ({ ...step, done: false })),
  };
  await writeJournal(root, journal);
  await runJournal(root, journal, options, 'Updating the trigger word');
  const conflicts = journal.steps.flatMap((step) => step.conflicts ?? []);
  // The batch is complete; its journal only matters while an interrupted run could still need finishing.
  await removeAt(root, journalPath(id));
  return { conflicts };
};

/**
 * `a.png` and `a.jpg` in one folder would share `a.txt`. The first (by name) keeps it; every other image is
 * renamed with getUniqueExplorerName together with its sidecar, and the rename is recorded for the path rewrite and the report.
 */
const resolveStemCollisions = async (root: ProjectDirectoryHandle, journal: LayoutJournal, step: JournalStep): Promise<void> => {
  step.renames ??= [];
  const recorded = (from: string) => step.renames!.find((entry) => entry.from === from)?.to;
  const move = async (from: string, to: string) => {
    const entry = await getEntry(root, from);
    if (entry?.kind !== 'file') return;
    await writeAt(root, to, await entry.handle.getFile());
    await removeAt(root, from);
  };
  const walk = async (directoryPath: string, directory: ProjectDirectoryHandle): Promise<void> => {
    const entries = await listEntries(directory);
    const groups = new Map<string, string[]>();
    for (const [name, entry] of entries) {
      if (!('getFile' in entry) || !isOwnerKind(name)) continue;
      const key = stemOf(name).toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }
    for (const names of groups.values()) {
      if (names.length < 2) continue;
      for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).slice(1)) {
        const from = join(directoryPath, name);
        const known = recorded(from);
        const finalName = known ? nameOf(known) : await getUniqueExplorerName(directory, name);
        const to = join(directoryPath, finalName);
        if (!known) {
          step.renames!.push({ from, to }, { from: getAssetManifestName(from), to: getAssetManifestName(to) });
          await writeJournal(root, journal);
        }
        await move(getAssetManifestName(from), getAssetManifestName(to));
        await move(from, to);
      }
    }
    for (const [name, entry] of entries) {
      if ('getDirectoryHandle' in entry && !(directoryPath === '' && name === EXPORTS_DIRECTORY) && !isInternalProjectEntry(name)) {
        await walk(join(directoryPath, name), entry);
      }
    }
  };
  await walk('', root);
};

type SidecarCaption = { tags: string[] | undefined; manifest: Record<string, unknown> };

const readSidecarCaption = async (directory: ProjectDirectoryHandle, imageName: string): Promise<SidecarCaption | undefined> => {
  let text: string;
  try { text = await (await directory.getFileHandle(getAssetManifestName(imageName))).getFile().then((file) => file.text()); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(text) as Record<string, unknown>; } catch { return undefined; }
  const tags = Array.isArray(manifest.tags)
    ? manifest.tags.filter((tag): tag is string => typeof tag === 'string')
    : typeof manifest.caption === 'string' ? parseCaptionText(manifest.caption).tags : undefined;
  return { tags, manifest };
};

/**
 * Sidecar `tags` become the TXT caption (with the trigger word first inside dataset/); a replaced TXT is kept in
 * `.datasetcreator/backup/<id>/captions/`. Images without sidecar tags keep their TXT, and inside dataset/ it
 * gains the trigger word when missing. Safe to run again: every file is compared with what it should become.
 */
const convertSidecarCaptions = async (root: ProjectDirectoryHandle, journal: LayoutJournal, step: JournalStep): Promise<void> => {
  const stats = step.stats ??= { converted: 0, triggersAdded: 0, backedUp: 0 };
  const projectText = await readTextAt(root, PROJECT_FILE);
  const trigger = normalizeTriggerWord(projectText ? (JSON.parse(projectText) as { project?: { dataset?: { triggerWord?: string } } }).project?.dataset?.triggerWord ?? '' : '');
  const backup = async (imagePath: string, previous: string) => {
    const target = backupPath(journal.id, `captions/${getCaptionPathForImage(imagePath)}`);
    if (await getEntry(root, target)) return;
    await writeAt(root, target, previous);
    stats.backedUp += 1;
  };
  const convert = async (directory: ProjectDirectoryHandle, imagePath: string, name: string) => {
    const sidecar = await readSidecarCaption(directory, name);
    const current = await readCaptionRaw(root, imagePath);
    const fileTrigger = getCaptionTriggerForPath(imagePath, trigger);
    if (sidecar?.tags !== undefined) {
      const desired = renderCaptionText(sidecar.tags, fileTrigger);
      const parsed = current === null ? undefined : parseCaptionText(current, fileTrigger ?? '');
      const equivalent = parsed !== undefined && parsed.triggerPresent && parsed.tags.length === sidecar.tags.length
        && parsed.tags.every((tag, index) => tag === sidecar.tags![index]);
      if (current !== desired && !equivalent) {
        if (current !== null) await backup(imagePath, current);
        await writeCaptionRaw(root, imagePath, desired);
        stats.converted += 1;
      }
      const { tags: _tags, caption: _caption, ...rest } = sidecar.manifest;
      await writeAt(root, join(parentOf(imagePath), getAssetManifestName(name)), JSON.stringify(rest, null, 2));
      return;
    }
    if (fileTrigger && current !== null) {
      const next = reconcileCaptionRaw(current, 'add', fileTrigger);
      if (next !== null) {
        await backup(imagePath, current);
        await writeCaptionRaw(root, imagePath, next);
        stats.triggersAdded += 1;
      }
    }
  };
  const walk = async (directoryPath: string, directory: ProjectDirectoryHandle): Promise<void> => {
    const entries = await listEntries(directory);
    for (const [name, entry] of entries) {
      if ('getFile' in entry) {
        if (isCaptionCarrierName(name)) await convert(directory, join(directoryPath, name), name);
      } else if (!(directoryPath === '' && name === EXPORTS_DIRECTORY) && !isInternalProjectEntry(name)) {
        await walk(join(directoryPath, name), entry as ProjectDirectoryHandle);
      }
    }
  };
  await walk('', root);
};

export type CaptionTxtReport = {
  journalId: string;
  converted: number;
  triggersAdded: number;
  backedUp: number;
  /** Images renamed because another image in the folder shares their file name stem (`a.png`, `a.jpg`). */
  collisions: Array<{ from: string; to: string }>;
  pathMoves: Array<{ from: string; to: string }>;
};

/** v3 project whose sidecar tags have not been moved into TXT captions yet. */
export const detectPendingCaptionConversion = async (root: ProjectDirectoryHandle): Promise<boolean> => {
  if (await detectProjectLayout(root) !== 'v3') return false;
  const text = await readTextAt(root, PROJECT_FILE);
  if (text === undefined) return false;
  return !(JSON.parse(text) as { project?: { migrations?: { captionsTxt?: unknown } } }).project?.migrations?.captionsTxt;
};

/** Moves sidecar tags into TXT captions and adds the trigger word to dataset/ captions. Returns undefined when nothing was pending. */
export const runCaptionTxtMigration = async (root: ProjectDirectoryHandle, options: LayoutMigrationOptions = {}): Promise<CaptionTxtReport | undefined> => {
  if (!await detectPendingCaptionConversion(root)) return undefined;
  throwIfAborted(options.signal);
  const id = newId();
  const steps: Omit<JournalStep, 'done'>[] = [
    { id: 'caption-collisions', type: 'caption-collisions', description: 'Rename images that share a file name' },
    { id: 'caption-rewrite', type: 'rewrite-paths', description: 'Update references to renamed images' },
    { id: 'captions-txt', type: 'captions-txt', description: 'Convert sidecar tags to text captions' },
    { id: 'captions-marker', type: 'captions-marker', description: 'Record the caption conversion' },
  ];
  const journal: LayoutJournal = {
    format: JOURNAL_FORMAT, version: 1, kind: 'captions-txt', id, fromVersion: 3,
    createdAt: new Date().toISOString(), steps: steps.map((step) => ({ ...step, done: false })),
  };
  await writeJournal(root, journal);
  await runJournal(root, journal, options, 'Converting captions to text files');
  const collisions = journal.steps.flatMap((step) => step.type === 'caption-collisions' ? step.renames ?? [] : []).filter((entry) => isOwnerKind(nameOf(entry.from)));
  const stats = journal.steps.find((step) => step.type === 'captions-txt')?.stats ?? { converted: 0, triggersAdded: 0, backedUp: 0 };
  return {
    journalId: id,
    ...stats,
    collisions,
    pathMoves: getRawPathMoves(journal).map((move) => ({ from: move.from.replace(/^Project\//, ''), to: move.to.replace(/^Project\//, '') })),
  };
};

// ---------------------------------------------------------------------------------------------------------
// Sidecars -> .datasetcreator/assets.json
// ---------------------------------------------------------------------------------------------------------

export type AssetsRegistryReport = { journalId: string; records: number; sidecars: number };

const stripProjectPrefix = (path: string) => normalizeRegistryPath(path);

const asString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Every sidecar of the project: `<file>.manifest.json` found in the tree and the manifests listed in project.json. */
const discoverSidecars = async (root: ProjectDirectoryHandle): Promise<Map<string, 'source' | 'edited' | undefined>> => {
  const found = new Map<string, 'source' | 'edited' | undefined>();
  const walk = async (directoryPath: string, directory: ProjectDirectoryHandle) => {
    for (const [name, entry] of await listEntries(directory)) {
      if ('getFile' in entry) {
        if (name.endsWith(ASSET_MANIFEST_SUFFIX)) found.set(join(directoryPath, name), undefined);
      } else if (!(directoryPath === '' && name === EXPORTS_DIRECTORY) && !isInternalProjectEntry(name)) {
        await walk(join(directoryPath, name), entry as ProjectDirectoryHandle);
      }
    }
  };
  await walk('', root);
  const text = await readTextAt(root, PROJECT_FILE);
  const project = text ? (JSON.parse(text) as { project?: Record<string, unknown> }).project : undefined;
  const listed = (value: unknown, role: 'source' | 'edited') => {
    if (typeof value !== 'object' || value === null) return;
    for (const path of Object.values(value as Record<string, unknown>)) {
      if (typeof path !== 'string') continue;
      const relative = stripProjectPrefix(path);
      // The oldest layouts (`sources/`, `synthetic/`) were never read by the previous version either.
      if (!isLegacyProjectRootPath(relative)) found.set(relative, role);
    }
  };
  listed(project?.sourceImageManifests, 'source');
  listed(project?.editedAssetManifests, 'edited');
  return found;
};

const recordFromSidecar = async (
  root: ProjectDirectoryHandle,
  sidecarPath: string,
  hint: 'source' | 'edited' | undefined,
  manifest: Record<string, unknown>
): Promise<AssetRecord | undefined> => {
  const name = nameOf(sidecarPath);
  const field = (key: string) => { const value = asString(manifest[key]); return value ? stripProjectPrefix(value) : undefined; };
  const directory = parentOf(sidecarPath);
  const isEdited = hint === 'edited' || (hint === undefined && asString(manifest.sourceImageId) !== undefined && (manifest.imageFileName !== undefined || manifest.imageDataPath !== undefined));
  const isSource = !isEdited && (hint === 'source' || asString(manifest.originalFileNameOnDisk) !== undefined);
  const beside = name.endsWith(ASSET_MANIFEST_SUFFIX) ? join(directory, name.slice(0, -ASSET_MANIFEST_SUFFIX.length)) : undefined;
  const candidates = isEdited
    ? [beside, field('imageDataPath'), asString(manifest.imageFileName) ? join(directory, manifest.imageFileName as string) : undefined]
    : isSource
      ? [beside, field('originalFilePath'), asString(manifest.originalFileNameOnDisk) ? join(directory, manifest.originalFileNameOnDisk as string) : undefined]
      : [beside, field('assetPath'), field('originalFilePath')];
  let path: string | undefined;
  let stat: Awaited<ReturnType<typeof statProjectFile>>;
  for (const candidate of candidates) {
    if (!candidate) continue;
    stat = await statProjectFile(root, candidate);
    if (stat) { path = candidate; break; }
  }
  if (!path || !stat) return undefined;
  const fileName = nameOf(path);
  const id = asString(manifest.id) ?? newId();
  const mimeType = asString(manifest.mimeType) ?? (getProjectAssetMimeType(fileName) || stat.type);
  const createdAt = asString(manifest.createdAt) && !Number.isNaN(Date.parse(manifest.createdAt as string)) ? manifest.createdAt as string : new Date(stat.mtime).toISOString();
  const legacyTags = path.startsWith(`${PROJECT_DATA_DIRECTORY}/`) && Array.isArray(manifest.tags)
    ? manifest.tags.filter((tag): tag is string => typeof tag === 'string')
    : undefined;
  const base: AssetRecord = {
    id,
    path,
    role: isEdited ? 'edited' : isSource ? 'source' : 'file',
    fileKind: resolveProjectAssetKind(fileName, mimeType),
    size: stat.size,
    mtime: stat.mtime,
    mimeType,
    ...(asNumber(manifest.width) !== undefined ? { width: asNumber(manifest.width) } : {}),
    ...(asNumber(manifest.height) !== undefined ? { height: asNumber(manifest.height) } : {}),
    fileName: isEdited ? fileName : asString(manifest.fileName) ?? fileName,
    ...(asString(manifest.originalFileName) ? { originalFileName: asString(manifest.originalFileName) } : {}),
    createdAt,
    ...(manifest.hidden === true ? { hidden: true } : {}),
    ...(legacyTags ? { legacyTags } : {}),
  };
  if (!isEdited) return base;
  const psdPath = field('psdDataPath');
  const deletedAt = asString(manifest.deletedAt);
  return {
    ...base,
    edited: {
      sourceImageId: asString(manifest.sourceImageId) ?? '',
      ...(psdPath ? { psdPath } : {}),
      type: (asString(manifest.type) as ImageType | undefined) ?? 'cleaned',
      ...(manifest.cropFrame ? { cropFrame: manifest.cropFrame as CropFrame } : {}),
      ...(manifest.augmentationConfig ? { augmentationConfig: manifest.augmentationConfig as AugmentationConfig } : {}),
      ...(asString(manifest.cleanupOverlayId) ? { cleanupOverlayId: asString(manifest.cleanupOverlayId) } : {}),
      aspectRatio: (asString(manifest.aspectRatio) as AspectRatio | undefined) ?? '1:1',
      deleted: manifest.deleted === true,
      ...(deletedAt ? { deletedAt } : {}),
      ...(asNumber(manifest.exportOrder) !== undefined ? { exportOrder: asNumber(manifest.exportOrder) } : {}),
    },
  };
};

/**
 * Builds assets.json from every sidecar. Records already in assets.json (an interrupted earlier run) win by id, so
 * a repeat never changes ids. The sidecars themselves stay where they are until this registry is written.
 */
const foldSidecarsIntoRegistry = async (root: ProjectDirectoryHandle, step: JournalStep): Promise<void> => {
  const sidecars = await discoverSidecars(root);
  const existingText = await readTextAt(root, PROJECT_ASSETS_FILE);
  const registry = existingText !== undefined ? parseAssetRegistry(existingText) : createEmptyAssetRegistry();
  const paths = new Set(Object.values(registry.assets).map((record) => record.path));
  for (const [sidecarPath, hint] of [...sidecars].sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = await readTextAt(root, sidecarPath);
    if (text === undefined) continue;
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
    const record = await recordFromSidecar(root, sidecarPath, hint, manifest);
    if (!record) continue;
    // A record already registered for this id or path (an interrupted earlier run, or a copied sidecar) is kept as it is;
    // a file left without a record is registered with a new id when the project opens.
    if (registry.assets[record.id] || paths.has(record.path)) continue;
    paths.add(record.path);
    registry.assets[record.id] = record;
  }
  // The PSD of an edited asset is a file of its own.
  for (const record of Object.values({ ...registry.assets })) {
    const psdPath = record.edited?.psdPath;
    if (!psdPath || paths.has(psdPath)) continue;
    const stat = await statProjectFile(root, psdPath);
    if (!stat) continue;
    const id = newId();
    paths.add(psdPath);
    registry.assets[id] = {
      id, path: psdPath, role: 'file', fileKind: 'psd', size: stat.size, mtime: stat.mtime,
      mimeType: 'image/vnd.adobe.photoshop', fileName: nameOf(psdPath), createdAt: record.createdAt,
    };
  }
  const text = serializeAssetRegistry(registry);
  if (existingText === undefined || serializeAssetRegistry(parseAssetRegistry(existingText)) !== text) await writeAt(root, PROJECT_ASSETS_FILE, text);
  step.sidecars = [...sidecars.keys()];
  step.records = Object.keys(registry.assets).length;
};

/** Moves the folded sidecars out of the working folders (into the journal backup) after assets.json was written. */
const moveSidecarsToBackup = async (root: ProjectDirectoryHandle, journal: LayoutJournal): Promise<void> => {
  const fold = journal.steps.find((step) => step.type === 'assets-fold');
  if (!fold?.done) throw new Error('The asset registry was not written; the sidecars were left in place.');
  for (const path of fold.sidecars ?? []) {
    if (!await getEntry(root, path)) continue;
    await mergeCopy(root, path, backupPath(journal.id, `sidecars/${path}`), conflictsPath(journal.id, path));
    await removeAt(root, path);
    if (await getEntry(root, path)) throw new Error(`Could not remove ${path} after backing it up.`);
  }
};

/** Drops the sidecar path maps from project.json and records that the registry owns the per-file data. */
const markAssetsRegistry = async (root: ProjectDirectoryHandle, id: string): Promise<void> => {
  const text = await readTextAt(root, PROJECT_FILE);
  if (text === undefined) return;
  const json = JSON.parse(text) as { project?: Record<string, unknown> & { migrations?: Record<string, unknown> } };
  if (!json.project) return;
  for (const key of ['sourceImageManifests', 'editedAssetManifests', 'datasetItemManifests']) delete json.project[key];
  json.project.migrations = { ...json.project.migrations, assetsRegistry: { id, completedAt: new Date().toISOString() } };
  await writeAt(root, PROJECT_FILE, JSON.stringify(json, null, 2));
};

/** v3 project whose per-file data still sits in sidecars (no `migrations.assetsRegistry` marker). */
export const detectPendingAssetsRegistryMigration = async (root: ProjectDirectoryHandle): Promise<boolean> => {
  if (await detectProjectLayout(root) !== 'v3') return false;
  const text = await readTextAt(root, PROJECT_FILE);
  if (text === undefined) return false;
  return !(JSON.parse(text) as { project?: { migrations?: { assetsRegistry?: unknown } } }).project?.migrations?.assetsRegistry;
};

/**
 * Folds every `*.manifest.json` (and the manifest lists of project.json) into `.datasetcreator/assets.json`, then moves
 * the sidecars into `.datasetcreator/backup/<id>/sidecars/` and removes the lists. The sidecars leave the working folders
 * only after assets.json was written; every step is journaled and safe to repeat. Returns undefined when nothing was pending.
 */
export const runAssetsRegistryMigration = async (root: ProjectDirectoryHandle, options: LayoutMigrationOptions = {}): Promise<AssetsRegistryReport | undefined> => {
  if (!await detectPendingAssetsRegistryMigration(root)) return undefined;
  throwIfAborted(options.signal);
  const id = newId();
  const steps: Omit<JournalStep, 'done'>[] = [
    { id: 'assets-fold', type: 'assets-fold', description: 'Collect file records into the asset registry' },
    { id: 'assets-sidecars', type: 'assets-sidecars', description: 'Move the old per-file metadata files into the backup' },
    { id: 'assets-marker', type: 'assets-marker', description: 'Record the asset registry conversion' },
  ];
  const journal: LayoutJournal = {
    format: JOURNAL_FORMAT, version: 1, kind: 'assets-registry', id, fromVersion: 3,
    createdAt: new Date().toISOString(), steps: steps.map((step) => ({ ...step, done: false })),
  };
  await writeJournal(root, journal);
  await runJournal(root, journal, options, 'Moving file metadata into the asset registry');
  const fold = journal.steps.find((step) => step.type === 'assets-fold');
  return { journalId: id, records: fold?.records ?? 0, sidecars: fold?.sidecars?.length ?? 0 };
};

/** v3 project whose raw materials still sit in `src/shared` / `src/assets`. */
export const detectLegacyRawLayout = async (root: ProjectDirectoryHandle): Promise<boolean> => {
  if (await detectProjectLayout(root) !== 'v3') return false;
  const [shared, assets] = await Promise.all([getEntry(root, LEGACY_SHARED_DIRECTORY), getEntry(root, LEGACY_ASSETS_DIRECTORY)]);
  return Boolean(shared || assets);
};

/** Read-only description of the raw-materials move for the confirmation dialog. */
export const planRawMaterialsMove = async (root: ProjectDirectoryHandle): Promise<RawMaterialsPlan> => {
  let fileCount = 0;
  let bytes = 0;
  const folders: string[] = [];
  const walk = async (directory: ProjectDirectoryHandle) => {
    for (const [, entry] of await listEntries(directory)) {
      if ('getDirectoryHandle' in entry) await walk(entry);
      else { fileCount += 1; bytes += (await (entry as ProjectDirectoryFileHandle).getFile()).size; }
    }
  };
  for (const source of RAW_STEP_SOURCES) {
    const entry = await getEntry(root, source.from);
    if (entry?.kind !== 'directory') continue;
    folders.push(`${source.from} -> ${source.to}`);
    await walk(entry.handle);
  }
  return { fileCount, bytes, folders };
};

/**
 * Moves `src/shared` to `inbox/` and `src/assets` to `inbox/edits/` of an already-v3 project through its own
 * journal, rewrites stored references, then removes `src/shared`, `src/assets` and `src` if they are empty.
 */
export const runRawMaterialsMove = async (root: ProjectDirectoryHandle, options: LayoutMigrationOptions = {}): Promise<RawMaterialsReport | undefined> => {
  if (!await detectLegacyRawLayout(root)) return undefined;
  throwIfAborted(options.signal);
  const id = newId();
  const steps: Omit<JournalStep, 'done'>[] = [
    ...RAW_STEP_SOURCES.map((source) => ({ id: source.id, type: 'raw-move' as const, from: source.from, to: source.to, description: `Move ${source.from} to ${source.to}` })),
    { id: 'raw-rewrite', type: 'rewrite-paths', description: 'Update references to the moved files' },
    { id: 'raw-clean-shared', type: 'delete', path: LEGACY_SHARED_DIRECTORY, ifEmpty: true, description: `Remove the empty ${LEGACY_SHARED_DIRECTORY} folder` },
    { id: 'raw-clean-assets', type: 'delete', path: LEGACY_ASSETS_DIRECTORY, ifEmpty: true, description: `Remove the empty ${LEGACY_ASSETS_DIRECTORY} folder` },
    { id: 'raw-clean-src', type: 'delete', path: LEGACY_SOURCE_DIRECTORY, ifEmpty: true, description: `Remove the empty ${LEGACY_SOURCE_DIRECTORY} folder` },
  ];
  const journal: LayoutJournal = {
    format: JOURNAL_FORMAT, version: 1, kind: 'raw-inbox', id, fromVersion: 3,
    createdAt: new Date().toISOString(), steps: steps.map((step) => ({ ...step, done: false })),
  };
  await getDirectory(root, PROJECT_LAYOUT.rawDir, true);
  await writeJournal(root, journal);
  await runJournal(root, journal, options, 'Moving raw materials to inbox');
  return summarizeRawJournal(journal);
};

const summarizeRawJournal = (journal: LayoutJournal): RawMaterialsReport => {
  const pathMoves = getRawPathMoves(journal).map((move) => ({ from: move.from.replace(/^Project\//, ''), to: move.to.replace(/^Project\//, '') }));
  const collisions = journal.steps.flatMap((step) => step.type === 'raw-move' ? step.renames ?? [] : []);
  return { journalId: journal.id, pathMoves, collisions };
};

const referencesLegacyData = (paths: Array<string | undefined>) =>
  paths.some((path) => path?.replace(/^Project\//, '').startsWith(`${PROJECT_DATA_DIRECTORY}/`));

/**
 * Upgrades a v2 project in place. Order: finish interrupted journals, snapshot (abort without changes
 * if it cannot be written), run the old conversions through the v2 reader, then apply the journalled v3 steps.
 */
export const runLayoutMigration = async (root: ProjectDirectoryHandle, options: LayoutMigrationOptions = {}): Promise<LayoutMigrationReport> => {
  const { onProgress, signal } = options;
  const resumed = await resumePendingJournals(root, options);
  const layout = await detectProjectLayout(root);
  if (layout === 'v3') return { resumed, keptLegacyData: false };
  if (layout !== 'v2') throw new LayoutMigrationError('This folder is not a Dataset Creator project.', 'failed');
  throwIfAborted(signal);

  const plan = await planLayoutMigration(root);
  onProgress?.({ phase: 'Creating a safety snapshot', completed: 0, total: 1 });
  let snapshotVersionId: string;
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    // Names are unique per project; a restore-then-upgrade within the same second needs a suffix.
    const taken = new Set((await listProjectVersions(root)).versions.map((version) => version.name));
    let name = `Before project upgrade ${stamp}`;
    for (let n = 2; taken.has(name); n += 1) name = `Before project upgrade ${stamp} (${n})`;
    snapshotVersionId = (await createProjectVersion(root, name)).id;
  } catch (error) {
    throw new LayoutMigrationError(
      `The safety snapshot could not be written, so the project was not changed: ${errorMessage(error)}. Free disk space or check folder permissions, then try again.`,
      'snapshot-failed'
    );
  }
  throwIfAborted(signal);

  onProgress?.({ phase: 'Finishing old project conversions', completed: 0, total: 1 });
  let project;
  try {
    project = await readProjectDirectory(root);
  } catch (error) {
    throw new LayoutMigrationError(`The old project data could not be converted: ${errorMessage(error)}. The safety snapshot was kept.`, 'failed');
  }
  const manifest = await readLegacyProjectManifest(root);
  const blockers = getLayoutMigrationBlockers(manifest.project);
  if (blockers.length) {
    throw new LayoutMigrationError(
      `The project cannot be upgraded yet. ${blockers.join(' ')} Choose "Open without upgrading", resolve them, then open the project again to upgrade.`,
      'blocked'
    );
  }
  throwIfAborted(signal);

  const id = newId();
  const layoutV3: LayoutV3Migration = { id, fromVersion: plan.fromVersion };
  const steps: Omit<JournalStep, 'done'>[] = [
    // project.json still lists the sidecars; the asset registry migration that follows folds them into assets.json.
    { id: 'project-json', type: 'write', path: PROJECT_FILE, content: JSON.stringify(createLayoutV3ProjectJson(manifest, project, layoutV3), null, 2), description: `Write ${PROJECT_FILE}` },
    { id: 'manifest-json', type: 'delete', path: PROJECT_MANIFEST_FILE, backup: true, description: `Retire ${PROJECT_MANIFEST_FILE}` },
  ];
  if (await getEntry(root, LEGACY_CACHE_DIRECTORY)) {
    steps.push({ id: 'cache', type: 'move', from: LEGACY_CACHE_DIRECTORY, to: PROJECT_LAYOUT.cacheDir, description: `Move ${LEGACY_CACHE_DIRECTORY} to ${PROJECT_LAYOUT.cacheDir}` });
  }
  const git = await readGitServiceState(root);
  if (git.isDirectory) {
    const gitPath = (name: string) => `${PROJECT_GIT_DIRECTORY}/${name}`;
    if (git.present.includes('snapshots')) steps.push({ id: 'git-snapshots', type: 'move', from: gitPath('snapshots'), to: VERSION_SNAPSHOT_DIRECTORY, description: 'Move saved versions out of .git' });
    if (git.present.includes('restore-backups')) steps.push({ id: 'git-restore-backups', type: 'move', from: gitPath('restore-backups'), to: RESTORE_BACKUP_DIRECTORY, description: 'Move restore backups out of .git' });
    // The snapshot above already merged the old index into versions/index.json; the old file is backed up, then removed.
    if (git.present.includes(GIT_SERVICE_FILES[0])) steps.push({ id: 'git-index', type: 'delete', path: LEGACY_VERSION_INDEX_PATH, backup: true, description: 'Retire the old version index in .git' });
    steps.push({ id: 'git-empty', type: 'delete', path: PROJECT_GIT_DIRECTORY, ifEmpty: true, description: 'Remove .git if it is empty' });
  }
  const dataEntry = await getEntry(root, PROJECT_DATA_DIRECTORY);
  let keptLegacyData = false;
  if (dataEntry) {
    const stillUsed = await hasLegacyPayload(root) || referencesLegacyData([
      ...Object.values(project.sourceImages).map((source) => source.originalFilePath),
      ...Object.values(project.datasetItems).flatMap((item) => [item.imageDataPath, item.psdDataPath]),
      ...Object.values(manifest.project.sourceImageManifests ?? {}),
      ...Object.values(manifest.project.editedAssetManifests ?? {}),
    ]);
    const empty = dataEntry.kind === 'directory' && (await listEntries(dataEntry.handle)).length === 0;
    if (stillUsed) keptLegacyData = true;
    else if (empty) steps.push({ id: 'legacy-data', type: 'delete', path: PROJECT_DATA_DIRECTORY, ifEmpty: true, description: `Remove the empty ${PROJECT_DATA_DIRECTORY} folder` });
    else steps.push({ id: 'legacy-data', type: 'move', from: PROJECT_DATA_DIRECTORY, to: backupPath(id, LEGACY_DATA_BACKUP), description: `Move ${PROJECT_DATA_DIRECTORY} into the upgrade backup` });
  }

  const journal: LayoutJournal = {
    format: JOURNAL_FORMAT, version: 1, kind: 'layout-v3', id, fromVersion: plan.fromVersion,
    createdAt: new Date().toISOString(), snapshotVersionId, steps: steps.map((step) => ({ ...step, done: false })),
  };
  await writeJournal(root, journal);
  await runJournal(root, journal, options);
  const rawMaterials = await runRawMaterialsMove(root, options);
  const captions = await runCaptionTxtMigration(root, options);
  const assets = await runAssetsRegistryMigration(root, options);
  return { journalId: id, snapshotVersionId, fromVersion: plan.fromVersion, resumed, keptLegacyData, rawMaterials, captions, assets };
};
