import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';
import { getDirectoryAtExplorerPath, getUniqueExplorerName } from '../project/explorerFileService';
import { frameTimecode } from './types';

export const validateFrameDirectory = (path: string) => {
  const parts = path.split('/');
  if (parts[0] !== 'Project' || parts.slice(1).some((part) => !part || part.startsWith('.') || part.includes('\\'))) throw new Error('Choose a visible directory inside the current project.');
};
export const listFrameDirectories = async (root: ProjectDirectoryHandle) => {
  const paths: string[] = [];
  const visit = async (directory: ProjectDirectoryHandle, path: string) => {
    paths.push(path);
    for await (const [name, handle] of directory.entries()) {
      if (!name.startsWith('.') && 'entries' in handle) await visit(handle, `${path}/${name}`);
    }
  };
  await visit(root, 'Project');
  return paths.sort();
};
let writes: Promise<unknown> = Promise.resolve();
export const saveVideoFrame = (root: ProjectDirectoryHandle, path: string, sourceName: string, timestamp: number, blob: Blob): Promise<string> => {
  const write = async () => {
    validateFrameDirectory(path);
    if (blob.type !== 'image/png' || !blob.size) throw new Error('The frame must be a nonempty PNG image.');
    const directory = await getDirectoryAtExplorerPath(root, path);
    const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'video';
    const name = await getUniqueExplorerName(directory, `${stem}_${frameTimecode(timestamp).replace(/:/g, '-')}_${Math.round(timestamp * 1e6)}.png`);
    const handle = await directory.getFileHandle(name, { create: true });
    try {
      const stream = await handle.createWritable();
      try { await stream.write(blob); await stream.close(); }
      catch (error) {
        const abortable = stream as typeof stream & { abort?: () => Promise<void> };
        await abortable.abort?.().catch(() => {});
        throw error;
      }
    } catch (error) {
      await directory.removeEntry(name).catch(() => {});
      throw error;
    }
    return `${path}/${name}`;
  };
  const result = writes.then(write, write);
  writes = result.catch(() => {});
  return result;
};
