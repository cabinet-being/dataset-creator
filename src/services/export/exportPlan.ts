import JSZip from 'jszip';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { Dataset } from '../../types';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { getProjectDatasetAssets } from './datasetExportService';
import { convertPsdToPng } from './exportService';
import { resolveAssetCaption } from '../caption/captionResolver';

export type ExportScope = 'dataset' | 'workspace' | 'directory';
export type ExportEntry = { imageName: string; textName: string; caption: string; blob: Blob; source: string; conversion?: 'psd' };
export type ExportPlan = { scope: ExportScope; entries: ExportEntry[]; skipped: string[]; fingerprint: string };
export type ExportRecoveryJournal = { completedEntryNames: Set<string>; startedEntryNames?: Set<string>; pendingOutputNames?: Set<string>; root?: ProjectDirectoryHandle; fingerprint?: string; onEntryStart?: (imageName: string) => void; onEntryComplete?: (imageName: string) => void };
export const createExportPlanFingerprint = async (scope: ExportScope, entries: ExportEntry[]): Promise<string> => {
  const hex = (digest: ArrayBuffer) => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const compact: unknown[] = [scope];
  for (const entry of entries) {
    const chunkDigests: string[] = [];
    for (let offset = 0; offset < entry.blob.size; offset += 1024 * 1024) {
      const chunk = await entry.blob.slice(offset, offset + 1024 * 1024).arrayBuffer();
      chunkDigests.push(hex(await crypto.subtle.digest('SHA-256', chunk)));
    }
    const metadata = [entry.imageName, entry.textName, entry.caption, entry.source, entry.blob.type, entry.blob.size, entry.conversion ?? ''];
    compact.push([metadata, hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(chunkDigests))))]);
  }
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(compact))));
};
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

export async function buildExportPlan({ scope, items, dataset, directory, blacklist }: {
  scope: ExportScope; items: WorkspaceImage[]; dataset: Dataset; directory?: ProjectDirectoryHandle; blacklist: string[];
}): Promise<ExportPlan> {
  const plan: ExportPlan = { scope, entries: [], skipped: [], fingerprint: '' };
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
  if (scope === 'directory' || scope === 'dataset') {
    if (!directory) throw new Error('Open a project folder first.');
    for (const asset of await getProjectDatasetAssets(directory)) {
      const psd = /\.psd$/i.test(asset.sourcePath);
      add(asset.file, asset.sourcePath, resolveAssetCaption({ id:`asset:${asset.sourcePath}`, sourceImageId:'', assetPath:asset.sourcePath, tags:asset.tags }, dataset.triggerWord).tags,
        asset.sourcePath, asset.targetDirectory, psd ? 'psd' : undefined);
    }
  } else {
    const selected = items;
    for (const item of selected) {
      if (item.kind === 'video') { plan.skipped.push(`${item.fileName} · video; save frames before exporting`); continue; }
      add(item.kind === 'psd' ? item.psdData ?? item.imageData : item.imageData, item.fileName, item.tags ?? [], item.id, '', item.kind === 'psd' ? 'psd' : undefined);
    }
  }
  plan.entries = ordered.map(({ entry }) => entry);
  plan.fingerprint = await createExportPlanFingerprint(scope, plan.entries);
  return plan;
}

async function exportImage(entry: ExportEntry, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const blob = entry.conversion === 'psd' ? await convertPsdToPng({ file: entry.blob, fileName: entry.source }, undefined, signal) : entry.blob;
  signal?.throwIfAborted();
  return blob;
}

async function blobsEqual(left: Blob, right: Blob, signal?: AbortSignal) {
  if (left.size !== right.size) return false;
  for (let offset = 0; offset < left.size; offset += 64 * 1024) {
    signal?.throwIfAborted();
    const [a, b] = await Promise.all([
      left.slice(offset, offset + 64 * 1024).arrayBuffer(),
      right.slice(offset, offset + 64 * 1024).arrayBuffer(),
    ]);
    const first = new Uint8Array(a), second = new Uint8Array(b);
    if (first.some((byte, index) => byte !== second[index])) return false;
  }
  return true;
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

export async function exportPlanToDirectory(
  plan: ExportPlan,
  root: ProjectDirectoryHandle,
  signal?: AbortSignal,
  progress?: (done: number, total: number) => void,
  recovery?: ExportRecoveryJournal
) {
  if (recovery) {
    if (recovery.fingerprint && recovery.fingerprint !== plan.fingerprint) throw new Error('Recovery journal belongs to a different export plan.');
    if (recovery.root && recovery.root !== root) {
      const sameEntry = await recovery.root.isSameEntry?.(root);
      if (!sameEntry) throw new Error('Recovery journal belongs to a different destination folder.');
    }
    recovery.root = root; recovery.fingerprint = plan.fingerprint;
  }
  // Check every filename before creating output files or converting PSDs.
  const destination = async (path: string, create: boolean) => {
    const parts = path.split('/'); const name = parts.pop()!; let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
    return { directory, name };
  };
  const existing = async (path: string) => {
    try { const { directory, name } = await destination(path, false); return await (await directory.getFileHandle(name)).getFile(); }
    catch (error) { if (error instanceof Error && error.name === 'NotFoundError') return undefined; throw error; }
  };
  const writeOutput = async (path: string, data: Blob | string) => {
    signal?.throwIfAborted();
    const { directory, name } = await destination(path, true);
    recovery?.pendingOutputNames?.add(path);
    const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
    try { await writer.write(data); signal?.throwIfAborted(); await writer.close(); recovery?.pendingOutputNames?.delete(path); }
    catch (error) { try { await (writer as typeof writer & { abort?: () => Promise<void> }).abort?.(); } catch { /* preserve the write or cancellation error */ } throw error; }
  };
  for (const entry of plan.entries) {
    signal?.throwIfAborted();
    const recovering = recovery?.completedEntryNames.has(entry.imageName) || recovery?.startedEntryNames?.has(entry.imageName);
    if (recovering) {
      const expectedImage = await exportImage(entry, signal);
      const actualImage = await existing(entry.imageName);
      if (actualImage && !(recovery?.pendingOutputNames?.has(entry.imageName) && actualImage.size === 0) && !(await blobsEqual(actualImage, expectedImage, signal))) throw new Error(`Recovery output does not match this plan: ${entry.imageName}.`);
      const actualText = await existing(entry.textName);
      if (actualText && !(recovery?.pendingOutputNames?.has(entry.textName) && actualText.size === 0) && await actualText.text() !== `${entry.caption}\n`) throw new Error(`Recovery output does not match this plan: ${entry.textName}.`);
      continue;
    }
    for (const path of [entry.imageName, entry.textName]) {
    signal?.throwIfAborted();
    try {
      const { directory, name } = await destination(path, false);
      await directory.getFileHandle(name);
      throw new Error(`Output already exists: ${path}. Choose an empty folder.`);
    } catch (error) { if (!(error instanceof Error && error.name === 'NotFoundError')) throw error; }
    }
  }
  for (const [index, entry] of plan.entries.entries()) {
    const recovering = recovery?.completedEntryNames.has(entry.imageName) || recovery?.startedEntryNames?.has(entry.imageName);
    if (recovering) {
      signal?.throwIfAborted();
      const expectedImage = await exportImage(entry, signal);
      const currentImage = await existing(entry.imageName);
      if (!currentImage || (recovery?.pendingOutputNames?.has(entry.imageName) && currentImage.size === 0)) await writeOutput(entry.imageName, expectedImage);
      const currentText = await existing(entry.textName);
      if (!currentText || (recovery?.pendingOutputNames?.has(entry.textName) && currentText.size === 0)) await writeOutput(entry.textName, `${entry.caption}\n`);
      recovery?.startedEntryNames?.delete(entry.imageName);
      recovery?.completedEntryNames.add(entry.imageName);
      recovery?.onEntryComplete?.(entry.imageName);
      progress?.(index + 1, plan.entries.length); continue;
    }
    signal?.throwIfAborted();
    recovery?.startedEntryNames?.add(entry.imageName);
    recovery?.onEntryStart?.(entry.imageName);
    const image = await exportImage(entry, signal);
    await writeOutput(entry.imageName, image);
    await writeOutput(entry.textName, `${entry.caption}\n`);
    signal?.throwIfAborted();
    recovery?.startedEntryNames?.delete(entry.imageName);
    recovery?.completedEntryNames.add(entry.imageName);
    recovery?.onEntryComplete?.(entry.imageName);
    progress?.(index + 1, plan.entries.length);
  }
}
