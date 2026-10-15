import JSZip from 'jszip';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { createDatasetFileAssetKey, createDatasetImageAssetKey, normalizeDatasetAssetOrder } from '../../lib/datasetAssets';
import type { Dataset } from '../../types';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { getExplorerParentDirectory, readExplorerFile } from '../project/explorerFileService';
import { getAssetManifestName } from '../project/assetManifestService';
import { getProjectDatasetAssets } from './datasetExportService';
import { convertPsdToPng } from './exportService';
import { resolveAssetCaption } from '../caption/captionResolver';
import { resolveDatasetMembership } from '../dataset/datasetMembershipResolver';

export type ExportScope = 'dataset' | 'workspace' | 'directory';
export type ExportEntry = { imageName: string; textName: string; caption: string; blob: Blob; source: string; conversion?: 'psd' };
export type ExportPlan = { scope: ExportScope; entries: ExportEntry[]; skipped: string[] };
export const renderExportCaption = (tags: string[], trigger: string, blacklist: string[]) => {
  const blocked = new Set(blacklist.map(tag => tag.trim().toLowerCase()));
  const seen = new Set<string>();
  return [trigger, ...tags].map(tag => tag.trim()).filter(tag => {
    const key = tag.toLowerCase();
    if (!key || blocked.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  }).join(', ');
};
const extension = (blob: Blob, name: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' }[blob.type] ?? name.split('.').pop()?.toLowerCase() ?? 'png');

async function readLinkedMetadata(directory: ProjectDirectoryHandle, path: string): Promise<{ tags?: string[]; caption?: string; excludedFromDataset?: boolean }> {
  const parent = await getExplorerParentDirectory(directory, path);
  try { return JSON.parse(await (await (await parent.directory.getFileHandle(getAssetManifestName(parent.name))).getFile()).text()); }
  catch (error) { if (error instanceof Error && error.name === 'NotFoundError') return {}; throw error; }
}

export async function buildExportPlan({ scope, items, dataset, directory, blacklist }: {
  scope: ExportScope; items: WorkspaceImage[]; dataset: Dataset; directory?: ProjectDirectoryHandle; blacklist: string[];
}): Promise<ExportPlan> {
  const plan: ExportPlan = { scope, entries: [], skipped: [] };
  const used = new Set<string>();
  const ordered: { entry: ExportEntry; key: string }[] = [];
  const add = (blob: Blob, source: string, tags: string[], key: string, targetFolder = '', conversion?: 'psd') => {
    const stem = source.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'image';
    let name = stem; let index = 2;
    while (used.has(`${targetFolder}/${name}`.toLowerCase())) name = `${stem}-${index++}`;
    used.add(`${targetFolder}/${name}`.toLowerCase());
    const path = targetFolder ? `${targetFolder}/${name}` : name;
    ordered.push({ key, entry: { blob, source, conversion, imageName: `${path}.${conversion ? 'png' : extension(blob, source)}`, textName: `${path}.txt`, caption: renderExportCaption(tags, dataset.triggerWord, blacklist) } });
  };
  if (scope === 'directory') {
    if (!directory) throw new Error('Open a project folder first.');
    for (const asset of await getProjectDatasetAssets(directory)) {
      if (asset.excludedFromDataset) plan.skipped.push(`${asset.sourcePath} · excluded`);
      else add(asset.file, asset.sourcePath, asset.tags, asset.sourcePath, asset.targetDirectory);
    }
  } else {
    const ids = new Set(dataset.assetIds);
    const paths = new Set([...dataset.assetPaths, ...(dataset.psdAssetPaths ?? [])]);
    const includedPaths = new Set<string>();
    const membership = scope === 'dataset' ? resolveDatasetMembership(dataset, items) : null;
    const selected = scope === 'workspace' ? items : membership!.members;
    const captionFor = (item: WorkspaceImage, tags: string[]) => scope === 'dataset'
      ? resolveAssetCaption({ ...item, tags }, dataset.triggerWord).tags
      : tags;
    for (const item of selected) {
      if (item.assetPath) includedPaths.add(item.assetPath);
      if (item.excludedFromDataset) { plan.skipped.push(`${item.fileName} · excluded`); continue; }
      if (item.kind === 'video') { plan.skipped.push(`${item.fileName} · video; save frames before exporting`); continue; }
      const key = item.assetPath && (item.kind === 'psd' || !ids.has(item.sourceImageId)) ? createDatasetFileAssetKey(item.assetPath) : createDatasetImageAssetKey(item.sourceImageId);
      add(item.kind === 'psd' ? item.psdData ?? item.imageData : item.imageData, item.fileName, captionFor(item, item.tags ?? []), key, '', item.kind === 'psd' ? 'psd' : undefined);
    }
    if (scope === 'dataset') {
      for (const id of membership!.missingAssetIds) throw new Error(`Dataset image is unavailable: ${id}`);
      for (const path of paths) {
        if (includedPaths.has(path)) continue;
        if (!/\.(png|jpe?g|webp|gif|bmp|psd)$/i.test(path)) { plan.skipped.push(`${path} · unsupported image format`); continue; }
        if (!directory) throw new Error('Reconnect the project folder to read linked files.');
        const file = await readExplorerFile(directory, path);
        const metadata = await readLinkedMetadata(directory, path);
        if (metadata.excludedFromDataset) { plan.skipped.push(`${path} · excluded`); continue; }
        const tags = metadata.caption ? metadata.caption.split(',').map(tag => tag.trim()).filter(Boolean) : metadata.tags ?? [];
        add(file, path, resolveAssetCaption({ id: `asset:${path}`, sourceImageId: '', assetPath: path, tags }, dataset.triggerWord).tags, createDatasetFileAssetKey(path), '', /\.psd$/i.test(path) ? 'psd' : undefined);
      }
      const order = new Map(normalizeDatasetAssetOrder(dataset.assetOrder, [...ids], [...paths]).map((key, i) => [key, i]));
      ordered.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
    }
  }
  plan.entries = ordered.map(({ entry }) => entry);
  return plan;
}

async function exportImage(entry: ExportEntry, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const blob = entry.conversion === 'psd' ? await convertPsdToPng({ file: entry.blob, fileName: entry.source }, undefined, signal) : entry.blob;
  signal?.throwIfAborted();
  return blob;
}

export async function exportPlanAsZip(plan: ExportPlan, signal?: AbortSignal, progress?: (done: number, total: number) => void) {
  const zip = new JSZip();
  for (const [index, entry] of plan.entries.entries()) {
    zip.file(entry.imageName, await (await exportImage(entry, signal)).arrayBuffer());
    zip.file(entry.textName, `${entry.caption}\n`);
    progress?.(index + 1, plan.entries.length);
  }
  const blob = await zip.generateAsync({ type: 'blob' }, () => signal?.throwIfAborted());
  signal?.throwIfAborted(); return blob;
}

export async function exportPlanToDirectory(plan: ExportPlan, root: ProjectDirectoryHandle, signal?: AbortSignal, progress?: (done: number, total: number) => void) {
  // Check every filename before creating output files or converting PSDs.
  const destination = async (path: string, create: boolean) => {
    const parts = path.split('/'); const name = parts.pop()!; let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
    return { directory, name };
  };
  for (const entry of plan.entries) for (const path of [entry.imageName, entry.textName]) {
    signal?.throwIfAborted();
    try {
      const { directory, name } = await destination(path, false);
      await directory.getFileHandle(name);
      throw new Error(`Output already exists: ${path}. Choose an empty folder.`);
    } catch (error) { if (!(error instanceof Error && error.name === 'NotFoundError')) throw error; }
  }
  for (const [index, entry] of plan.entries.entries()) {
    const image = await exportImage(entry, signal);
    for (const [path, data] of [[entry.imageName, image], [entry.textName, `${entry.caption}\n`]] as const) {
      signal?.throwIfAborted();
      const { directory, name } = await destination(path, true);
      const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
      try { await writer.write(data); await writer.close(); }
      catch (error) { await (writer as typeof writer & { abort?: () => Promise<void> }).abort?.(); throw error; }
    }
    progress?.(index + 1, plan.entries.length);
  }
}
