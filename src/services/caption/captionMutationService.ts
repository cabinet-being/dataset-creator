import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useHistoryStore, captureHistoryEpoch, isHistoryEpochCurrent } from '../../stores/useHistoryStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { getExplorerParentDirectory } from '../project/explorerFileService';
import { getAssetManifestName } from '../project/assetManifestService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { invalidateWorkspaceFileAssetCache } from '../../lib/workspaceFileAssets';
import { useUIStore } from '../../stores/useUIStore';
import type { HistoryTransactionWriter } from '../../stores/useHistoryStore';

type CaptionTarget = {
  item: WorkspaceImage;
  before: string[] | undefined;
  after: string[];
  manifestBefore?: Record<string, unknown> | null;
};

const sameTags = (left: string[] | undefined, right: string[]): boolean =>
  left !== undefined && left.length === right.length && left.every((tag, index) => tag === right[index]);

const readManifest = async (root: ProjectDirectoryHandle, path: string): Promise<Record<string, unknown> | null> => {
  const parent = await getExplorerParentDirectory(root, path);
  const name = getAssetManifestName(path.split('/').pop() ?? path);
  try { return JSON.parse(await (await parent.directory.getFileHandle(name)).getFile().then((file) => file.text())) as Record<string, unknown>; }
  catch (error) { if (error instanceof Error && error.name === 'NotFoundError') return null; throw error; }
};

const writeManifest = async (root: ProjectDirectoryHandle, path: string, manifest: Record<string, unknown>) => {
  const parent = await getExplorerParentDirectory(root, path);
  const name = getAssetManifestName(path.split('/').pop() ?? path);
  const writer = await (await parent.directory.getFileHandle(name, { create: true })).createWritable();
  try { await writer.write(JSON.stringify(manifest, null, 2)); await writer.close(); }
  catch (error) { await writer.abort?.(); throw error; }
};

export async function persistCaptionTagsForItems(options: {
  items: WorkspaceImage[];
  resolveTags: (item: WorkspaceImage) => string[];
  directory?: ProjectDirectoryHandle | null;
  flush?: () => Promise<void>;
  historyWriter?: HistoryTransactionWriter;
}): Promise<number> {
  const epoch = captureHistoryEpoch();
  const ensureProject = () => { if (!isHistoryEpochCurrent(epoch)) throw new Error('The project changed while saving captions.'); };
  const unique = [...new Map(options.items.map((item) => [item.id, item])).values()];
  const targets: CaptionTarget[] = unique
    .map((item) => ({ item, before: item.tags, after: [...options.resolveTags(item)] }))
    .filter((target) => !sameTags(target.before, target.after));
  if (!targets.length) return 0;
  for (const target of targets) {
    if (!target.item.sourceImageId && target.item.assetPath) {
      if (!options.directory) throw new Error(`Reconnect the project folder to save the caption for ${target.item.fileName}.`);
      target.manifestBefore = await readManifest(options.directory, target.item.assetPath);
      ensureProject();
    }
  }
  const apply = async (restore: boolean) => {
    const store = useProjectStore.getState();
    ensureProject();
    for (const target of targets) {
      ensureProject();
      const tags = restore ? target.before : target.after;
      const item = target.item;
      if (item.kind === 'edited' && item.editedAssetId) store.updateDatasetItem(item.editedAssetId, { tags });
      else if (item.sourceImageId) store.updateSourceImage(item.sourceImageId, { tags });
      else if (item.assetPath && options.directory) {
        const base = target.manifestBefore ?? { id: item.id.replace(/^asset:/, ''), kind: item.kind, assetPath: item.assetPath, fileName: item.fileName };
        const manifest = { ...base };
        if (tags === undefined) delete manifest.tags;
        else manifest.tags = tags;
        await writeManifest(options.directory, item.assetPath, manifest);
        ensureProject();
      }
    }
    if (options.directory && targets.some((target) => !target.item.sourceImageId && target.item.assetPath)) {
      invalidateWorkspaceFileAssetCache(options.directory);
      useUIStore.getState().refreshAssetPreviews();
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
