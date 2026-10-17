import type { ProjectDirectoryHandle } from './projectDirectoryService';
import { getAssetManifestName } from './assetManifestService';
import { getDirectoryAtExplorerPath, getExplorerFileKind, getExplorerParentDirectory, getUniqueExplorerName, moveExplorerEntries, type ExplorerPathChange } from './explorerFileService';

type Entry = ExplorerPathChange & { completed: boolean };
const JOURNAL = 'dataset-exclusions.json';
const missing = (error: unknown) => error instanceof Error && error.name === 'NotFoundError';

export async function clearLegacyExclusionAtPath(root: ProjectDirectoryHandle, path: string): Promise<void> {
  const { directory, name } = await getExplorerParentDirectory(root, path);
  let folder: ProjectDirectoryHandle | undefined;
  try { folder = await directory.getDirectoryHandle(name); }
  catch (error) { if (!missing(error) && !(error instanceof Error && error.name === 'TypeMismatchError')) throw error; }
  if (folder) {
    for await (const [child] of folder.entries()) await clearLegacyExclusionAtPath(root,`${path}/${child}`);
    return;
  }
  if (!['image','psd'].includes(getExplorerFileKind(name))) return;
  let handle;
  try { handle = await directory.getFileHandle(getAssetManifestName(name)); }
  catch (error) { if (missing(error)) return; throw error; }
  const metadata = JSON.parse(await (await handle.getFile()).text());
  if (!('excludedFromDataset' in metadata)) return;
  delete metadata.excludedFromDataset;
  const writer = await handle.createWritable();
  try { await writer.write(JSON.stringify(metadata,null,2)); await writer.close(); }
  catch (error) { await writer.abort?.(); throw error; }
}

// Old exclusion flags are converted once into actual moves. The inert journal
// survives a crash between the filesystem move and the project manifest update.
export async function migrateLegacyDatasetExclusions(root: ProjectDirectoryHandle, checkpoint: (moves: ExplorerPathChange[]) => Promise<void>, resumeOnly = false): Promise<void> {
  const recovery = await root.getDirectoryHandle('.dataset-creator-data', {create:true});
  let entries: Entry[] = [];
  try { entries = JSON.parse(await (await (await recovery.getFileHandle(JOURNAL)).getFile()).text()); }
  catch (error) { if (!missing(error)) throw error; }
  const writeJournal = async () => {
    const writer = await (await recovery.getFileHandle(JOURNAL,{create:true})).createWritable();
    try { await writer.write(JSON.stringify(entries)); await writer.close(); }
    catch (error) { await writer.abort?.(); throw error; }
  };
  const exists = async (path: string) => {
    try { const {directory,name}=await getExplorerParentDirectory(root,path); await directory.getFileHandle(name); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  };
  const resume = async (entry: Entry) => {
    if (!entry.completed) {
      const sourceExists = await exists(entry.from);
      const targetExists = await exists(entry.to);
      if (sourceExists && targetExists) throw new Error(`Cannot resume Dataset migration: both ${entry.from} and ${entry.to} exist. Recovery details are saved in ${JOURNAL}.`);
      if (!sourceExists && !targetExists) throw new Error(`Cannot resume Dataset migration: ${entry.from} and ${entry.to} are missing.`);
      if (sourceExists) {
        // Reserve the exact planned name; a collision must never overwrite data.
        const destination = entry.to.slice(0,entry.to.lastIndexOf('/'));
        const [change] = await moveExplorerEntries(root,[{path:entry.from,name:entry.to.split('/').pop()!,kind:'file'}],destination,
          async change => { entry.to=change.to; entry.completed=true; await writeJournal(); });
        entry.to=change.to;
      }
      entry.completed=true;
      await writeJournal();
    }
    await checkpoint([entry]);
    const {directory,name}=await getExplorerParentDirectory(root,entry.to);
    const metadataHandle=await directory.getFileHandle(getAssetManifestName(name));
    const metadata=JSON.parse(await (await metadataHandle.getFile()).text());
    delete metadata.excludedFromDataset;
    const writer=await metadataHandle.createWritable();
    try { await writer.write(JSON.stringify(metadata,null,2)); await writer.close(); }
    catch (error) { await writer.abort?.(); throw error; }
    entries=entries.filter(value=>value!==entry);
    await writeJournal();
  };
  for (const entry of [...entries]) await resume(entry);
  if (resumeOnly) return;
  const scan = async (directory: ProjectDirectoryHandle, path: string): Promise<void> => {
    const children=[];
    for await (const child of directory.entries()) children.push(child);
    for (const [name,handle] of children) {
      if ('entries' in handle) { await scan(handle,`${path}/${name}`); continue; }
      if (!['image','psd'].includes(getExplorerFileKind(name))) continue;
      let metadata: {excludedFromDataset?:boolean};
      try { metadata=JSON.parse(await (await (await directory.getFileHandle(getAssetManifestName(name))).getFile()).text()); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (!metadata.excludedFromDataset) continue;
      const shared=await getDirectoryAtExplorerPath(root,'Project/src/shared');
      const to=`Project/src/shared/${await getUniqueExplorerName(shared,name)}`;
      const entry={from:`${path}/${name}`,to,completed:false};
      entries.push(entry); await writeJournal(); await resume(entry);
    }
  };
  await scan(await root.getDirectoryHandle('dataset'),'Project/dataset');
}
