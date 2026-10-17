import { inferWorkspaceAspectRatio, type WorkspaceImage } from '../../lib/workspaceImages';
import { isProjectPathIncluded } from '../../lib/projectCategories';
import { getAssetManifestName } from '../project/assetManifestService';
import { isSupportedProjectAsset, resolveProjectAssetKind } from '../project/assetTypeService';
import type { ProjectDirectoryFileHandle, ProjectDirectoryHandle } from '../project/projectDirectoryService';

export type SharedCandidateScan = {
  candidates: WorkspaceImage[];
  skipped: Array<{ path: string; reason: string }>;
  sharedAvailable: boolean;
};

type SharedManifest = { id?: string; sourceImageId?: string; width?: number; height?: number; tags?: string[]; caption?: string; hidden?: boolean; deleted?: boolean };

const isNotFound = (error: unknown) => error instanceof Error && error.name === 'NotFoundError';
const readOptionalFile = async (directory: ProjectDirectoryHandle, name: string): Promise<File | null> => {
  try { return await (await directory.getFileHandle(name)).getFile(); }
  catch (error) { if (isNotFound(error)) return null; throw error; }
};
const readManifest = async (directory: ProjectDirectoryHandle, fileName: string): Promise<SharedManifest | null> => {
  const file = await readOptionalFile(directory, getAssetManifestName(fileName));
  if (!file) return null;
  try { return JSON.parse(await file.text()) as SharedManifest; } catch { return null; }
};
const dimensions = async (file: File, manifest: SharedManifest | null) => {
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
  try { shared = await (await root.getDirectoryHandle('src')).getDirectoryHandle('shared'); }
  catch (error) { if (isNotFound(error)) return { candidates: [], skipped: [], sharedAvailable: false }; throw error; }
  const files = (await collect(shared)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  const candidates: WorkspaceImage[] = [];
  const skipped: SharedCandidateScan['skipped'] = [];
  for (let index = 0; index < files.length; index += 1) {
    options.signal?.throwIfAborted();
    const entry = files[index];
    const path = `Project/src/shared/${entry.path}`;
    if (!isSupportedProjectAsset(entry.handle.name)) { skipped.push({ path, reason: 'unsupported' }); continue; }
    const kind = resolveProjectAssetKind(entry.handle.name, '');
    if (kind === 'video') { skipped.push({ path, reason: 'video' }); continue; }
    if (!isProjectPathIncluded(path, options.excludedCategories ?? [], options.includedCategories ?? [])) { skipped.push({ path, reason: 'category excluded' }); continue; }
    const file = await entry.handle.getFile();
    const manifest = await readManifest(entry.directory, file.name);
    if (manifest?.hidden || manifest?.deleted) { skipped.push({ path, reason: 'excluded' }); continue; }
    const size = await dimensions(file, manifest);
    const stem = file.name.replace(/\.[^.]+$/, '');
    const textCaption = manifest?.caption === undefined && manifest?.tags === undefined ? await readOptionalFile(entry.directory, `${stem}.txt`) : null;
    const tags = manifest?.caption !== undefined ? [manifest.caption] : manifest?.tags ?? (textCaption ? [await textCaption.text()] : []);
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
