import { createSourceImage, type SourceImage } from '../../types';
import { createOperationLogger, shouldLogProgress, type OperationLogger } from '../logging/applicationLog';
import { getImageDimensions } from '../image/imageProcessor';
import type { ProjectDirectoryFileHandle, ProjectDirectoryHandle } from './projectDirectoryService';
import { getProjectAssetMimeType, isInternalProjectFileName, isSupportedProjectAsset, resolveProjectAssetKind } from './assetTypeService';
import { isTriggerMissing, readCaptionFile } from '../caption/captionFileService';
import { snapshotFile } from './fileSnapshotService';
import { hexDigest } from '../analysis/semanticFeatureService';
import { PROJECT_EXPORTS_DIRECTORY, isInternalProjectEntry } from './projectLayoutService';
import {
  getActiveAssetRegistry,
  getAssetPathIndex,
  getRegistryFileName,
  normalizeRegistryPath,
  updateAssetRegistry,
  applyMovesToAssetRecord,
  type AssetRecord,
  type AssetRegistry,
} from './assetRegistryService';

export type ProjectAssetIndexUpdate = {
  sourceImage?: SourceImage;
  assetPath: string;
  /** True when a registry record was created for the file. */
  manifestCreated: boolean;
};

export type ProjectAssetIndexResult = {
  discoveredCount: number;
  indexedCount: number;
  /** Registry records created for files that had none. */
  createdManifestCount: number;
};

export type IndexProjectAssetsOptions = {
  logger?: OperationLogger;
  /** Project-relative files or directories. Undefined indexes the project; an empty array indexes nothing. */
  paths?: string[];
  existingSourceImages?: Record<string, SourceImage>;
  /** Dataset trigger word, stripped from the captions of files inside dataset/. */
  triggerWord?: string;
  onAssetIndexed?: (update: ProjectAssetIndexUpdate) => void | Promise<void>;
  onProgress?: (current: number, total: number) => void;
};

type AssetFileEntry = { directory: ProjectDirectoryHandle; handle: ProjectDirectoryFileHandle; assetPath: string };

const yieldToUi = async () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));

const joinPath = (...parts: string[]): string => parts.filter(Boolean).join('/');

/** Files tracked by the registry: supported assets except captions, which belong to their image. */
const isRegistryFileName = (name: string): boolean =>
  !isInternalProjectFileName(name) && isSupportedProjectAsset(name) && resolveProjectAssetKind(name) !== 'text';

const collectAssetFiles = async (
  directory: ProjectDirectoryHandle,
  relativeDirectory = ''
): Promise<AssetFileEntry[]> => {
  const assets: AssetFileEntry[] = [];

  for await (const [entryName, entry] of directory.entries()) {
    if ('entries' in entry) {
      if (!isInternalProjectEntry(entryName) && !(relativeDirectory === '' && entryName === PROJECT_EXPORTS_DIRECTORY)) {
        assets.push(...await collectAssetFiles(entry, joinPath(relativeDirectory, entryName)));
      }
      continue;
    }
    if (isRegistryFileName(entryName)) {
      assets.push({ directory, handle: entry, assetPath: joinPath(relativeDirectory, entryName) });
    }
  }

  return assets;
};

const normalizeScopePath = (path: string): string => path
  .replace(/\\/g, '/')
  .replace(/^\/+|\/+$/g, '')
  .replace(/^Project(?:\/|$)/, '');

const normalizeScopePaths = (paths: string[]): string[] => {
  const normalized = [...new Set(paths.map(normalizeScopePath).filter(Boolean))].sort((a, b) => a.length - b.length);
  return normalized.filter((path, index) => !normalized.slice(0, index).some(parent => path === parent || path.startsWith(`${parent}/`)));
};

const collectScopedAssetFiles = async (
  root: ProjectDirectoryHandle,
  paths: string[]
): Promise<AssetFileEntry[]> => {
  const assets = new Map<string, AssetFileEntry>();
  for (const assetPath of normalizeScopePaths(paths)) {
    const parts = assetPath.split('/');
    const name = parts.pop();
    if (!name) continue;
    let parent = root;
    try {
      for (const part of parts) parent = await parent.getDirectoryHandle(part);
      try {
        const handle = await parent.getFileHandle(name);
        if (isRegistryFileName(name)) assets.set(assetPath, { directory: parent, handle, assetPath });
      } catch {
        const directory = await parent.getDirectoryHandle(name);
        for (const entry of await collectAssetFiles(directory, assetPath)) assets.set(entry.assetPath, entry);
      }
    } catch {
      // A scoped path may disappear between a completed filesystem operation and indexing.
    }
  }
  return [...assets.values()];
};

const createFileRecord = (path: string, file: { size: number; lastModified: number; type: string }, sourceImage?: SourceImage, id?: string): AssetRecord => {
  const name = getRegistryFileName(path);
  const kind = resolveProjectAssetKind(name, file.type);
  return {
    id: sourceImage?.id ?? id ?? crypto.randomUUID(),
    path,
    role: 'file',
    fileKind: kind,
    size: file.size,
    mtime: file.lastModified,
    mimeType: file.type || getProjectAssetMimeType(name),
    ...(sourceImage ? { width: sourceImage.width, height: sourceImage.height } : {}),
    fileName: sourceImage?.fileName ?? name,
    originalFileName: sourceImage?.originalFileName ?? name,
    createdAt: (sourceImage?.createdAt ?? new Date()).toISOString(),
  };
};

/**
 * Turns files into app entities and registry records: an image without an entity becomes a Source Image
 * (reusing the id of its registry record), every other new file gets a record. Existing records are not rewritten
 * here; content changes and moves are reconciled when the project opens and by the Explorer path-move pipeline.
 */
export const indexProjectAssets = async (
  root: ProjectDirectoryHandle,
  options: IndexProjectAssetsOptions = {}
): Promise<ProjectAssetIndexResult> => {
  const logger = options.logger ?? createOperationLogger('Index');
  const existingByPath = new Map(
    Object.values(options.existingSourceImages ?? {})
      .filter((source) => source.originalFilePath)
      .map((source) => [normalizeRegistryPath(source.originalFilePath as string), source])
  );
  const existingById = new Map(
    Object.values(options.existingSourceImages ?? {}).map((source) => [source.id, source])
  );
  const registry = getActiveAssetRegistry(root);
  const recordsByPath = registry ? getAssetPathIndex(registry) : new Map<string, AssetRecord>();
  const editedPsdPaths = new Set(registry
    ? Object.values(registry.assets).flatMap((record) => record.edited?.psdPath ? [normalizeRegistryPath(record.edited.psdPath)] : [])
    : []);
  const created: AssetRecord[] = [];
  let indexedCount = 0;
  let createdManifestCount = 0;

  logger.info('Indexing project...');
  const assetFiles = options.paths === undefined
    ? await collectAssetFiles(root)
    : await collectScopedAssetFiles(root, options.paths);
  logger.info(`Discovered ${assetFiles.length} supported file${assetFiles.length !== 1 ? 's' : ''}`);

  const flushRecords = async () => {
    if (!created.length) return;
    const batch = created.splice(0, created.length);
    await updateAssetRegistry(root, (assets) => { for (const record of batch) assets[record.id] = record; });
  };

  for (let index = 0; index < assetFiles.length; index += 1) {
    const { handle, assetPath } = assetFiles[index];
    const record = recordsByPath.get(assetPath);
    const kind = resolveProjectAssetKind(handle.name);
    const existingSource = existingByPath.get(assetPath) ?? (record?.role === 'source' ? existingById.get(record.id) : undefined);
    const isRegisteredEdited = record?.role === 'edited' || editedPsdPaths.has(assetPath);
    let sourceImage: SourceImage | undefined;
    let file: File | undefined;
    let createdRecord = false;
    // A copied file may carry the id of its original; only an id nobody uses is reused.
    const reusableId = record && !existingById.has(record.id) ? record.id : undefined;

    if (kind === 'image' && !existingSource && !isRegisteredEdited) {
      file = await snapshotFile(await handle.getFile());
      const { width, height } = await getImageDimensions(file);
      sourceImage = createSourceImage(file, file.name, width, height, URL.createObjectURL(file));
      if (reusableId) {
        sourceImage.id = reusableId;
        sourceImage.fileName = record?.fileName ?? sourceImage.fileName;
        sourceImage.createdAt = record?.createdAt ? new Date(record.createdAt) : sourceImage.createdAt;
        sourceImage.hidden = record?.hidden;
      }
      sourceImage.originalFileName = record?.originalFileName ?? file.name;
      sourceImage.originalFilePath = assetPath;
      const caption = await readCaptionFile(root, assetPath, options.triggerWord);
      sourceImage.tags = caption.tags;
      sourceImage.captionTriggerMissing = isTriggerMissing(caption);
    }

    if (registry && !record) {
      file ??= await handle.getFile();
      const next = createFileRecord(assetPath, file, sourceImage);
      created.push(next);
      recordsByPath.set(assetPath, next);
      createdRecord = true;
      createdManifestCount += 1;
    }

    if (sourceImage || createdRecord) {
      await options.onAssetIndexed?.({ sourceImage, assetPath, manifestCreated: createdRecord });
    }

    if (sourceImage) {
      existingByPath.set(assetPath, sourceImage);
      existingById.set(sourceImage.id, sourceImage);
    }

    indexedCount += 1;
    const current = index + 1;
    options.onProgress?.(current, assetFiles.length);
    if (shouldLogProgress(current, assetFiles.length)) {
      logger.progress({ current, total: assetFiles.length, label: 'indexed assets' });
    }
    if (created.length >= 200) await flushRecords();
    if (current % 10 === 0) {
      await yieldToUi();
    }
  }
  await flushRecords();

  logger.success(`Project index ready: ${indexedCount} asset${indexedCount !== 1 ? 's' : ''}`);
  return {
    discoveredCount: assetFiles.length,
    indexedCount,
    createdManifestCount,
  };
};

// ---------------------------------------------------------------------------------------------------------
// Reconciliation of the registry with the folder (runs when a v3 project opens)
// ---------------------------------------------------------------------------------------------------------

/** Files above this size are not hashed: reading a large video in full would stall opening and use much memory. */
export const ASSET_HASH_LIMIT_BYTES = 256 * 1024 * 1024;

export type AssetHasher = (blob: Blob) => Promise<string>;

/** SHA-256 as hex (the helper of the semantic feature service). */
const defaultHasher: AssetHasher = (blob) => hexDigest(blob);

/** SHA-256 of a blob the app holds in memory anyway (a file it just wrote); undefined for very large files or on failure. */
export const hashAssetBlob = async (blob: Blob): Promise<string | undefined> => {
  if (blob.size > ASSET_HASH_LIMIT_BYTES) return undefined;
  try { return await defaultHasher(blob); } catch { return undefined; }
};

export type AssetReconcileOptions = {
  signal?: AbortSignal;
  logger?: OperationLogger;
  onProgress?: (current: number, total: number) => void;
  hash?: AssetHasher;
  hashLimitBytes?: number;
};

export type AssetReconcileReport = {
  registry: AssetRegistry;
  /** True when the registry differs from the one that was read, so it must be written. */
  changed: boolean;
  /** New files that received a record (and a new id). */
  added: AssetRecord[];
  /** Files recognised at a new path (same size, kind and SHA-256 as a record whose file disappeared). */
  rebound: Array<{ id: string; from: string; to: string }>;
  /** Records whose file is gone and has no counterpart; they were dropped from the registry. */
  removed: AssetRecord[];
  /** Files at a registered path with a different size or modification time: same id, hash and previews dropped. */
  modified: AssetRecord[];
  /** Edited records whose source disappeared; they stay as plain files. */
  orphaned: AssetRecord[];
  /** Project-relative moves for every stored reference: Build session, Dataset order, tabs, categories. */
  pathMoves: Array<{ from: string; to: string }>;
};

type WalkedFile = { path: string; name: string; handle: ProjectDirectoryFileHandle; size: number; mtime: number; type: string };

const compareNatural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const isInternalRecordPath = (path: string) => isInternalProjectEntry(path.split('/')[0] ?? '');

const walkProjectFiles = async (
  directory: ProjectDirectoryHandle,
  prefix: string,
  files: WalkedFile[],
  options: AssetReconcileOptions
): Promise<void> => {
  for await (const [name, entry] of directory.entries()) {
    options.signal?.throwIfAborted();
    const path = joinPath(prefix, name);
    if ('entries' in entry) {
      if (isInternalProjectEntry(name) || (prefix === '' && name === PROJECT_EXPORTS_DIRECTORY)) continue;
      await walkProjectFiles(entry, path, files, options);
      continue;
    }
    if (!isRegistryFileName(name)) continue;
    const file = await entry.getFile();
    files.push({ path, name, handle: entry, size: file.size, mtime: file.lastModified, type: file.type });
    if (files.length % 50 === 0) {
      options.onProgress?.(files.length, files.length);
      await yieldToUi();
    }
  }
};

const getFileHandleAtPath = async (root: ProjectDirectoryHandle, path: string): Promise<ProjectDirectoryFileHandle | undefined> => {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return undefined;
  try {
    let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    return await directory.getFileHandle(name);
  } catch (error) {
    const errorName = (error as { name?: string } | null)?.name;
    if (errorName === 'NotFoundError' || errorName === 'TypeMismatchError') return undefined;
    throw error;
  }
};

/**
 * Compares the registry with the folder and returns the registry that describes it now; nothing is written.
 *
 * - same path, same size and mtime: bound as is;
 * - same path, different size or mtime: same id, `sha256` dropped (the caller drops previews and cached features);
 * - new file: when a record whose file disappeared has the same kind and size, the new file is hashed and, on an
 *   equal SHA-256, takes that record over (several matches: the same file name first, then a stable order);
 * - any other new file: a new id; any record left without a file: removed.
 * A record without a stored hash is never rebound, and only files that have a possible counterpart are hashed.
 */
export const reconcileProjectAssets = async (
  root: ProjectDirectoryHandle,
  registry: AssetRegistry,
  options: AssetReconcileOptions = {}
): Promise<AssetReconcileReport> => {
  const hash = options.hash ?? defaultHasher;
  const hashLimit = options.hashLimitBytes ?? ASSET_HASH_LIMIT_BYTES;
  const records = Object.values(registry.assets);
  const byPath = new Map(records.map((record) => [record.path, record]));

  const walked: WalkedFile[] = [];
  await walkProjectFiles(root, '', walked, options);
  // Records inside service folders (pre-v3 payload data) are not part of the walk; they are checked directly.
  for (const record of records) {
    if (!isInternalRecordPath(record.path)) continue;
    const handle = await getFileHandleAtPath(root, record.path);
    if (!handle) continue;
    const file = await handle.getFile();
    walked.push({ path: record.path, name: handle.name, handle, size: file.size, mtime: file.lastModified, type: file.type });
  }
  options.onProgress?.(walked.length, walked.length);

  const next: Record<string, AssetRecord> = {};
  const modified: AssetRecord[] = [];
  const unmatched: WalkedFile[] = [];
  const present = new Set<string>();
  for (const file of walked) {
    const record = byPath.get(file.path);
    if (!record) { unmatched.push(file); continue; }
    present.add(record.id);
    if (record.size === file.size && record.mtime === file.mtime) {
      next[record.id] = record;
      continue;
    }
    const { sha256: _stale, ...rest } = record;
    void _stale;
    const changed: AssetRecord = { ...rest, size: file.size, mtime: file.mtime, modifiedAt: file.mtime };
    next[record.id] = changed;
    modified.push(changed);
  }

  const missing = records.filter((record) => !present.has(record.id));
  const rebound: AssetReconcileReport['rebound'] = [];
  const claimed = new Set<string>();
  const reboundTo = new Map<string, WalkedFile>();
  if (unmatched.length > 0 && missing.length > 0) {
    const candidatesByKey = new Map<string, AssetRecord[]>();
    for (const record of missing) {
      if (!record.sha256) continue;
      const key = `${record.fileKind}:${record.size}`;
      candidatesByKey.set(key, [...(candidatesByKey.get(key) ?? []), record]);
    }
    const hashed: Array<{ file: WalkedFile; matches: AssetRecord[] }> = [];
    for (const file of [...unmatched].sort((a, b) => compareNatural(a.path, b.path))) {
      options.signal?.throwIfAborted();
      const candidates = candidatesByKey.get(`${resolveProjectAssetKind(file.name, file.type)}:${file.size}`);
      if (!candidates?.length || file.size > hashLimit) continue;
      let digest: string;
      try { digest = await hash(await file.handle.getFile()); } catch { continue; }
      const matches = candidates
        .filter((record) => record.sha256 === digest)
        .sort((a, b) => compareNatural(a.createdAt, b.createdAt) || compareNatural(a.id, b.id));
      if (matches.length) hashed.push({ file, matches });
    }
    const assign = (sameNameOnly: boolean) => {
      for (const { file, matches } of hashed) {
        if (reboundTo.has(file.path)) continue;
        const record = matches.find((candidate) => !claimed.has(candidate.id) && (!sameNameOnly ||
          getRegistryFileName(candidate.path) === file.name || candidate.fileName === file.name));
        if (!record) continue;
        claimed.add(record.id);
        reboundTo.set(file.path, file);
        next[record.id] = {
          ...record,
          path: file.path,
          size: file.size,
          mtime: file.mtime,
          fileName: record.fileName === getRegistryFileName(record.path) ? file.name : record.fileName,
        };
        rebound.push({ id: record.id, from: record.path, to: file.path });
      }
    };
    assign(true);
    assign(false);
  }

  const added: AssetRecord[] = [];
  for (const file of unmatched) {
    if (reboundTo.has(file.path)) continue;
    const record = createFileRecord(file.path, { size: file.size, lastModified: file.mtime, type: file.type });
    next[record.id] = record;
    added.push(record);
  }
  const removed = missing.filter((record) => !claimed.has(record.id));

  // Rebinding moved a file; every record that points at the old path (the PSD of an edited asset) follows it.
  const pathMoves = rebound.map(({ from, to }) => ({ from, to }));
  if (pathMoves.length) {
    for (const [id, record] of Object.entries(next)) next[id] = applyMovesToAssetRecord(record, pathMoves);
  }

  // An edited asset needs its source; without it the file stays in the project as a plain file.
  const orphaned: AssetRecord[] = [];
  for (const [id, record] of Object.entries(next)) {
    if (record.role !== 'edited' || !record.edited) continue;
    if (next[record.edited.sourceImageId]?.role === 'source') continue;
    const { edited: _edited, ...plain } = record;
    void _edited;
    next[id] = { ...plain, role: 'file' };
    orphaned.push(next[id]);
  }

  const nextRegistry: AssetRegistry = { ...registry, assets: next };
  const before = JSON.stringify(Object.keys(registry.assets).sort().map((id) => registry.assets[id]));
  const after = JSON.stringify(Object.keys(next).sort().map((id) => next[id]));
  return { registry: nextRegistry, changed: before !== after, added, rebound, removed, modified, orphaned, pathMoves };
};

// ---------------------------------------------------------------------------------------------------------
// Background hashing
// ---------------------------------------------------------------------------------------------------------

export type AssetHashOptions = {
  isCancelled?: () => boolean;
  hash?: AssetHasher;
  hashLimitBytes?: number;
  /** Records are saved in batches; this many hashes (or about two seconds) per write. */
  batchSize?: number;
};

/**
 * Fills `sha256` for records that do not have one yet, one file at a time with a yield between files, so the
 * UI stays responsive and a large project is not read in one burst. A file that changed or vanished meanwhile is
 * skipped; results are merged into the registry in batches. Returns the number of hashes stored.
 */
export const fillAssetHashes = async (root: ProjectDirectoryHandle, options: AssetHashOptions = {}): Promise<number> => {
  const registry = getActiveAssetRegistry(root);
  if (!registry) return 0;
  const hash = options.hash ?? defaultHasher;
  const limit = options.hashLimitBytes ?? ASSET_HASH_LIMIT_BYTES;
  const batchSize = options.batchSize ?? 25;
  const pending = Object.values(registry.assets)
    .filter((record) => !record.sha256 && record.size <= limit)
    .sort((a, b) => compareNatural(a.path, b.path));
  let stored = 0;
  let batch: Array<{ id: string; size: number; mtime: number; sha256: string }> = [];
  let lastFlush = Date.now();
  const flush = async () => {
    if (!batch.length) return;
    const results = batch;
    batch = [];
    lastFlush = Date.now();
    await updateAssetRegistry(root, (assets) => {
      for (const result of results) {
        const record = assets[result.id];
        // Skip a record whose file changed (or was replaced) while it was being hashed.
        if (!record || record.sha256 || record.size !== result.size || record.mtime !== result.mtime) continue;
        assets[result.id] = { ...record, sha256: result.sha256 };
        stored += 1;
      }
    });
  };
  for (const record of pending) {
    if (options.isCancelled?.()) break;
    try {
      const handle = await getFileHandleAtPath(root, record.path);
      if (!handle) continue;
      const file = await handle.getFile();
      if (file.size !== record.size || file.lastModified !== record.mtime) continue;
      const sha256 = await hash(file);
      if (options.isCancelled?.()) break;
      batch.push({ id: record.id, size: file.size, mtime: file.lastModified, sha256 });
    } catch {
      continue;
    }
    if (batch.length >= batchSize || Date.now() - lastFlush > 2000) await flush();
    await yieldToUi();
  }
  if (!options.isCancelled?.()) await flush();
  return stored;
};
