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
import {
  LEGACY_CACHE_DIRECTORY,
  PROJECT_DATA_DIRECTORY,
  PROJECT_FILE,
  PROJECT_GIT_DIRECTORY,
  PROJECT_LAYOUT,
  PROJECT_MANIFEST_FILE,
  detectProjectLayout,
  type ProjectLayoutVersion,
} from './projectLayoutService';

export { detectProjectLayout };
export type { ProjectLayoutVersion };

const JOURNAL_FORMAT = 'dataset-creator-journal';
const LEGACY_DATA_BACKUP = 'legacy-data';
// Sub-folders that can hold originals/edits an old reader looks up by id; such a folder is never moved.
const LEGACY_DATA_PAYLOAD_DIRECTORIES = ['source-images', 'generated-images'];
const GIT_SERVICE_FILES = ['dataset-creator-versions.json'];

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
};

export type LayoutMigrationErrorKind = 'blocked' | 'snapshot-failed' | 'failed';

export class LayoutMigrationError extends Error {
  constructor(message: string, readonly kind: LayoutMigrationErrorKind) {
    super(message);
    this.name = 'LayoutMigrationError';
  }
}

type JournalStep = {
  id: string;
  type: 'move' | 'write' | 'delete';
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
};

export type LayoutJournal = {
  format: typeof JOURNAL_FORMAT;
  version: 1;
  kind: 'layout-v3';
  id: string;
  fromVersion: 1 | 2;
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
  if (journal?.format !== JOURNAL_FORMAT || journal.kind !== 'layout-v3' || !Array.isArray(journal.steps) || typeof journal.id !== 'string') return undefined;
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

const referencesLegacyData = (paths: Array<string | undefined>) =>
  paths.some((path) => path?.replace(/^Project\//, '').startsWith(`${PROJECT_DATA_DIRECTORY}/`));

const newId = () => crypto.randomUUID();

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
    // C6 moves the *Manifests maps into assets.json; until then they stay in project.json.
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
      ...Object.values(project.sourceImages).flatMap((source) => [source.originalFilePath, source.manifestPath]),
      ...Object.values(project.datasetItems).flatMap((item) => [item.imageDataPath, item.psdDataPath, item.manifestPath]),
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
  return { journalId: id, snapshotVersionId, fromVersion: plan.fromVersion, resumed, keptLegacyData };
};
