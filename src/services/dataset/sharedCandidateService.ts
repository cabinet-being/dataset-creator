import { inferWorkspaceAspectRatio, type WorkspaceImage } from '../../lib/workspaceImages';
import { isProjectPathIncluded } from '../../lib/projectCategories';
import { getDirectoryAtPath, PROJECT_LAYOUT } from '../project/projectLayoutService';
import { readCaptionFile } from '../caption/captionFileService';
import { getActiveAssetRegistry, getAssetPathIndex } from '../project/assetRegistryService';
import { isSupportedProjectAsset, resolveProjectAssetKind } from '../project/assetTypeService';
import type { ProjectDirectoryFileHandle, ProjectDirectoryHandle } from '../project/projectDirectoryService';

export type SharedCandidateScan = {
  candidates: WorkspaceImage[];
  skipped: Array<{ path: string; reason: string }>;
  sharedAvailable: boolean;
};

type SharedMetadata = { id: string; sourceImageId?: string; width?: number; height?: number; hidden?: boolean; deleted?: boolean };

const isNotFound = (error: unknown) => error instanceof Error && error.name === 'NotFoundError';
/** Registry record of a file, as the metadata the picker needs (a file the registry does not know yet has none). */
const readMetadata = (root: ProjectDirectoryHandle, path: string): SharedMetadata | null => {
  const registry = getActiveAssetRegistry(root);
  const record = registry ? getAssetPathIndex(registry).get(path) : undefined;
  if (!record) return null;
  return { id: record.id, sourceImageId: record.edited?.sourceImageId, width: record.width, height: record.height, hidden: record.hidden, deleted: record.edited?.deleted };
};
const dimensions = async (file: File, manifest: SharedMetadata | null) => {
  if (manifest?.width && manifest.height) return { width: manifest.width, height: manifest.height };
  if (!file.type.startsWith('image/') || /\.psd$/i.test(file.name)) return { width: 1, height: 1 };
  const bitmap = await createImageBitmap(file);
  try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
};
const collect = async (directory: ProjectDirectoryHandle, relative = ''): Promise<Array<{ directory: ProjectDirectoryHandle; handle: ProjectDirectoryFileHandle; path: string }>> => {
  const result: Array<{ directory: ProjectDirectoryHandle; handle: ProjectDirectoryFileHandle; path: string }> = [];
  for await (const [name, entry] of directory.entries()) {
    if ('entries' in entry) result.push(...await collect(entry, relative ? `${relative}/${name}` : name));
    else result.push({ directory, handle: entry, path: relative ? `${relative}/${name}` : name });
  }
  return result;
};

export async function scanSharedCandidates(root: ProjectDirectoryHandle, options: {
  excludedCategories?: readonly string[];
  includedCategories?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
} = {}): Promise<SharedCandidateScan> {
  let shared: ProjectDirectoryHandle;
  try { shared = await getDirectoryAtPath(root, PROJECT_LAYOUT.rawDir); }
  catch (error) { if (isNotFound(error)) return { candidates: [], skipped: [], sharedAvailable: false }; throw error; }
  const files = (await collect(shared)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  const candidates: WorkspaceImage[] = [];
  const skipped: SharedCandidateScan['skipped'] = [];
  for (let index = 0; index < files.length; index += 1) {
    options.signal?.throwIfAborted();
    const entry = files[index];
    const path = `Project/${PROJECT_LAYOUT.rawDir}/${entry.path}`;
    if (!isSupportedProjectAsset(entry.handle.name)) { skipped.push({ path, reason: 'unsupported' }); continue; }
    const kind = resolveProjectAssetKind(entry.handle.name, '');
    if (kind === 'video') { skipped.push({ path, reason: 'video' }); continue; }
    // Caption .txt files sit next to every image; only images and PSDs are candidates.
    if (kind !== 'image' && kind !== 'psd') { skipped.push({ path, reason: 'unsupported' }); continue; }
    if (!isProjectPathIncluded(path, options.excludedCategories ?? [], options.includedCategories ?? [])) { skipped.push({ path, reason: 'category excluded' }); continue; }
    const file = await entry.handle.getFile();
    const manifest = readMetadata(root, `${PROJECT_LAYOUT.rawDir}/${entry.path}`);
    if (manifest?.hidden || manifest?.deleted) { skipped.push({ path, reason: 'excluded' }); continue; }
    let size: { width: number; height: number };
    try { size = await dimensions(file, manifest); }
    catch { skipped.push({ path, reason: 'could not be decoded' }); continue; }
    const { tags } = await readCaptionFile(root, path);
    const sourceImageId = manifest?.sourceImageId ?? manifest?.id ?? '';
    candidates.push({
      id: sourceImageId ? `source:${sourceImageId}` : `asset:${path}`,
      sourceImageId,
      kind: kind === 'psd' ? 'psd' : 'image',
      label: kind === 'psd' ? 'PSD' : 'Image',
      displayIdentity: String(candidates.length + 1),
      fileName: file.name,
      originalFileName: file.name,
      assetPath: path,
      imageData: file,
      psdData: kind === 'psd' ? file : undefined,
      width: size.width,
      height: size.height,
      tags,
      byteSize: file.size,
      modifiedAt: file.lastModified,
      dimensionsKnown: size.width > 1 || size.height > 1,
      aspectRatio: inferWorkspaceAspectRatio(size.width, size.height),
    });
    options.onProgress?.(index + 1, files.length);
  }
  return { candidates, skipped, sharedAvailable: true };
}
