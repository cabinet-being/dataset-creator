import type { AspectRatio, AugmentationConfig, CropFrame, ImageType } from '../../types';
import { applyProjectRelativePathMoves, type ExplorerPathMove } from '../../lib/datasetAssets';
import { PROJECT_ASSETS_FILE, PROJECT_ASSETS_FORMAT } from './projectLayoutService';
import type { ProjectAssetKind } from './assetTypeService';
import type { ProjectDirectoryHandle } from './projectDirectoryService';

/**
 * `.datasetcreator/assets.json` is the only per-file metadata store of a v3 project. A record keeps the
 * stable id of a file while its path changes; size/mtime tell whether the content changed since the last
 * session and `sha256` (filled in the background) lets a file that was moved outside the app be recognised.
 */
export type AssetRole = 'source' | 'edited' | 'file';

export type EditedAssetRecord = {
  sourceImageId: string;
  psdPath?: string;
  type: ImageType;
  cropFrame?: CropFrame;
  augmentationConfig?: AugmentationConfig;
  cleanupOverlayId?: string;
  aspectRatio: AspectRatio;
  deleted: boolean;
  deletedAt?: string;
  exportOrder?: number;
};

export type AssetRecord = {
  id: string;
  /** Project-relative path (no `Project/` prefix). */
  path: string;
  role: AssetRole;
  fileKind: ProjectAssetKind;
  size: number;
  mtime: number;
  sha256?: string;
  mimeType: string;
  width?: number;
  height?: number;
  fileName: string;
  originalFileName?: string;
  createdAt: string;
  hidden?: boolean;
  /** Modification time (ms) of the content when it last changed outside the app; feeds the Build revision. */
  modifiedAt?: number;
  edited?: EditedAssetRecord;
  /** Caption tags of an asset still kept in the pre-v3 payload folder, which the TXT conversion never touched. */
  legacyTags?: string[];
};

export type AssetRegistry = {
  format: typeof PROJECT_ASSETS_FORMAT;
  version: 1;
  assets: Record<string, AssetRecord>;
};

export const createEmptyAssetRegistry = (): AssetRegistry => ({ format: PROJECT_ASSETS_FORMAT, version: 1, assets: {} });

const ROLES: AssetRole[] = ['source', 'edited', 'file'];

export const normalizeRegistryPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/^Project(?:\/|$)/, '');

export const getRegistryFileName = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';

const toExplorerMoves = (moves: ExplorerPathMove[]): ExplorerPathMove[] =>
  moves.map((move) => ({
    from: move.from.startsWith('Project/') ? move.from : `Project/${move.from}`,
    to: move.to.startsWith('Project/') ? move.to : `Project/${move.to}`,
  }));

/** Applies renames/moves to the path of a record (and to the PSD it points at). The result is the same object when nothing moved. */
export const applyMovesToAssetRecord = (record: AssetRecord, moves: ExplorerPathMove[]): AssetRecord => {
  if (moves.length === 0) return record;
  const explorerMoves = toExplorerMoves(moves);
  const path = applyProjectRelativePathMoves(record.path, explorerMoves) ?? record.path;
  const psdPath = record.edited?.psdPath ? applyProjectRelativePathMoves(record.edited.psdPath, explorerMoves) : record.edited?.psdPath;
  if (path === record.path && psdPath === record.edited?.psdPath) return record;
  const previousName = getRegistryFileName(record.path);
  const nextName = getRegistryFileName(path);
  return {
    ...record,
    path,
    fileName: record.fileName === previousName ? nextName : record.fileName,
    ...(record.edited ? { edited: { ...record.edited, psdPath } } : {}),
  };
};

const isRecordLike = (value: unknown): value is AssetRecord => {
  const record = value as Partial<AssetRecord> | null;
  return typeof record === 'object' && record !== null && typeof record.id === 'string' && typeof record.path === 'string' &&
    ROLES.includes(record.role as AssetRole) && typeof record.fileKind === 'string' &&
    typeof record.size === 'number' && typeof record.mtime === 'number';
};

export const parseAssetRegistry = (text: string): AssetRegistry => {
  let json: Partial<AssetRegistry>;
  try { json = JSON.parse(text) as Partial<AssetRegistry>; }
  catch { throw new Error(`Unable to read ${PROJECT_ASSETS_FILE}: invalid JSON. Restore it from a project version or remove it to rebuild the registry.`); }
  if (json?.format !== PROJECT_ASSETS_FORMAT || json.version !== 1 || typeof json.assets !== 'object' || json.assets === null) {
    throw new Error(`${PROJECT_ASSETS_FILE} is not a supported asset registry.`);
  }
  const assets: Record<string, AssetRecord> = {};
  for (const [key, value] of Object.entries(json.assets)) {
    if (!isRecordLike(value)) continue;
    assets[key] = { ...value, id: value.id || key, path: normalizeRegistryPath(value.path) };
  }
  return { format: PROJECT_ASSETS_FORMAT, version: 1, assets };
};

/** Stable text: records sorted by id, so an unchanged registry always produces identical bytes. */
export const serializeAssetRegistry = (registry: AssetRegistry): string => {
  const assets = Object.fromEntries(Object.keys(registry.assets).sort().map((id) => [id, registry.assets[id]]));
  return JSON.stringify({ format: PROJECT_ASSETS_FORMAT, version: 1, assets }, null, 2);
};

const pathIndexes = new WeakMap<AssetRegistry, Map<string, AssetRecord>>();

/** Path -> record lookup for an immutable registry snapshot (cached per snapshot). */
export const getAssetPathIndex = (registry: AssetRegistry): Map<string, AssetRecord> => {
  let index = pathIndexes.get(registry);
  if (!index) {
    index = new Map(Object.values(registry.assets).map((record) => [record.path, record]));
    pathIndexes.set(registry, index);
  }
  return index;
};

type RegistryState = { registry: AssetRegistry; baseline: string | undefined; queue: Promise<unknown> };
const states = new WeakMap<ProjectDirectoryHandle, RegistryState>();

const isMissing = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
};

const getParts = (path: string) => path.split('/').filter(Boolean);

const getDirectory = async (root: ProjectDirectoryHandle, parts: string[], create = false) => {
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
};

/** Size and modification time of a project file, or undefined when it does not exist. */
export const statProjectFile = async (root: ProjectDirectoryHandle, path: string): Promise<{ size: number; mtime: number; type: string } | undefined> => {
  const parts = getParts(normalizeRegistryPath(path));
  const name = parts.pop();
  if (!name) return undefined;
  try {
    const file = await (await (await getDirectory(root, parts)).getFileHandle(name)).getFile();
    return { size: file.size, mtime: file.lastModified, type: file.type };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** Reads assets.json (an empty registry when absent) and makes it the live registry of this root. */
export const loadAssetRegistry = async (root: ProjectDirectoryHandle): Promise<AssetRegistry> => {
  let registry: AssetRegistry | undefined;
  try {
    const parts = getParts(PROJECT_ASSETS_FILE);
    const name = parts.pop()!;
    const text = await (await (await getDirectory(root, parts)).getFileHandle(name)).getFile().then((file) => file.text());
    registry = parseAssetRegistry(text);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const loaded = registry ?? createEmptyAssetRegistry();
  states.set(root, { registry: loaded, baseline: registry ? serializeAssetRegistry(registry) : undefined, queue: Promise.resolve() });
  return loaded;
};

/** The live registry, or undefined when this root is not a v3 project (a legacy project keeps its sidecars). */
export const getActiveAssetRegistry = (root: ProjectDirectoryHandle | undefined): AssetRegistry | undefined =>
  root ? states.get(root)?.registry : undefined;

const writeRegistryFile = async (root: ProjectDirectoryHandle, text: string) => {
  const parts = getParts(PROJECT_ASSETS_FILE);
  const name = parts.pop()!;
  const handle = await (await getDirectory(root, parts, true)).getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* Keep the original write failure. */ }
    throw error;
  }
};

/** Writes the registry only when it differs from the last saved one; the baseline advances after a successful write. */
export const commitAssetRegistry = async (root: ProjectDirectoryHandle, next: AssetRegistry): Promise<boolean> => {
  const state = states.get(root) ?? { registry: next, baseline: undefined, queue: Promise.resolve() };
  states.set(root, state);
  const text = serializeAssetRegistry(next);
  if (text === state.baseline) {
    state.registry = next;
    return false;
  }
  await writeRegistryFile(root, text);
  state.baseline = text;
  state.registry = next;
  return true;
};

/** Serialised read-modify-write of the live registry. No-op (false) for a root without a live registry. */
export const updateAssetRegistry = (
  root: ProjectDirectoryHandle,
  mutate: (assets: Record<string, AssetRecord>) => void | Promise<void>
): Promise<boolean> => {
  const state = states.get(root);
  if (!state) return Promise.resolve(false);
  const run = async () => {
    const assets = { ...state.registry.assets };
    await mutate(assets);
    return commitAssetRegistry(root, { format: PROJECT_ASSETS_FORMAT, version: 1, assets });
  };
  const result = state.queue.then(run, run);
  state.queue = result.catch(() => undefined);
  return result;
};

/** Registers or replaces records (by id); a record that moved off another record's path takes that path over. */
export const upsertAssetRecords = (root: ProjectDirectoryHandle, records: AssetRecord[]): Promise<boolean> =>
  records.length === 0 ? Promise.resolve(false) : updateAssetRegistry(root, (assets) => {
    for (const record of records) {
      for (const other of Object.values(assets)) {
        if (other.id !== record.id && other.path === record.path && other.role === 'file') delete assets[other.id];
      }
      assets[record.id] = record;
    }
  });

export const removeAssetRecords = (root: ProjectDirectoryHandle, ids: string[]): Promise<boolean> =>
  ids.length === 0 ? Promise.resolve(false) : updateAssetRegistry(root, (assets) => { for (const id of ids) delete assets[id]; });

/**
 * Explorer renames/moves keep the id: the registry follows the same moves as the Build session and tabs,
 * and the size/mtime fingerprint is refreshed (a copy-based move changes the modification time).
 */
export const moveAssetRegistryPaths = (root: ProjectDirectoryHandle, moves: ExplorerPathMove[]): Promise<boolean> =>
  moves.length === 0 ? Promise.resolve(false) : updateAssetRegistry(root, async (assets) => {
    for (const [id, record] of Object.entries(assets)) {
      const moved = applyMovesToAssetRecord(record, moves);
      if (moved === record) continue;
      const stat = await statProjectFile(root, moved.path);
      assets[id] = stat ? { ...moved, size: stat.size, mtime: stat.mtime } : moved;
    }
  });

/** Drops the records of deleted files and folders. */
export const removeAssetRegistryPaths = (root: ProjectDirectoryHandle, paths: string[]): Promise<boolean> => {
  const deleted = paths.map(normalizeRegistryPath).filter(Boolean);
  return deleted.length === 0 ? Promise.resolve(false) : updateAssetRegistry(root, (assets) => {
    for (const [id, record] of Object.entries(assets)) {
      if (deleted.some((path) => record.path === path || record.path.startsWith(`${path}/`))) delete assets[id];
    }
  });
};
