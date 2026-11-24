import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createProject, createSourceImage, type ProjectState } from '../src/types';
import { readProjectDirectory, writeProjectDirectoryChanges, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import { applyProjectRelativePathMoves } from '../src/lib/datasetAssets';
import { moveAssetRegistryPaths } from '../src/services/project/assetRegistryService';
import { renameExplorerEntry } from '../src/services/project/explorerFileService';
import { createSaveQueue } from '../src/services/project/saveQueue';
import { createSaveSession } from '../src/services/project/saveSession';
import { createProjectVersion, restoreProjectVersion } from '../src/services/project/projectVersionService';
import { toWorkspaceImages } from '../src/lib/workspaceImages';
import { buildExportPlan, exportPlanAsZip, exportPlanToDirectory } from '../src/services/export/exportPlan';
import { readCaptionFile, writeCaptionFile } from '../src/services/caption/captionFileService';
import JSZip from 'jszip';
import { checkDatasetFolder } from './dataset-folder-checks';
import '../src/index.css';

const KEY = 'dataset-creator-persistence-fixture';
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const imageBlob = async (color: string, mime = 'image/png') => {
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
  canvas.getContext('2d')!.fillStyle = color; canvas.getContext('2d')!.fillRect(0, 0, 32, 24);
  return new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), mime));
};
const getFixture = async (create = false) => {
  let name = localStorage.getItem(KEY);
  if (create || !name) { name = `dataset-creator-check-${crypto.randomUUID()}`; localStorage.setItem(KEY, name); }
  return await (await navigator.storage.getDirectory()).getDirectoryHandle(name, {create}) as unknown as ProjectDirectoryHandle;
};
async function verify(directory: ProjectDirectoryHandle) {
  const project = await readProjectDirectory(directory);
  const sources = Object.values(project.sourceImages);
  assert(sources.length === 2, `Expected 2 reopened images, got ${sources.length}`);
  assert(sources.every(source => source.originalFile.size > 0), 'Image bytes must survive reopening');
  assert(sources.every(source => source.tags?.length === 1 && !source.captionTriggerMissing), 'Tags come from the TXT without the leading trigger word');
  assert(project.dataset.triggerWord === 'fixture-trigger', 'Latest trigger must survive reopening');
  assert(!('assetIds' in project.dataset), 'Runtime Dataset must not restore legacy membership');
  assert(sources.every(source => source.originalFilePath?.startsWith('dataset/')), 'Dataset membership must come from physical paths');
  assert(JSON.stringify(project.dataset.assetOrder) === JSON.stringify(['file:Project/dataset/blue.jpg','file:Project/dataset/amber.png']), 'Dataset order must survive reopening');
  const plan = await buildExportPlan({scope:'dataset', items:toWorkspaceImages(sources, []), dataset:project.dataset, directory, blacklist:[]});
  assert(plan.entries.length === 2, 'Reopened Dataset must export both images');
  assert(plan.entries.some(entry => entry.caption === 'fixture-trigger, override'), 'Physical caption was lost');
  const result = await exportPlanAsZip(plan);
  const archive = await JSZip.loadAsync(await result.arrayBuffer());
  const output = await directory.getDirectoryHandle(`export-${crypto.randomUUID()}`, {create:true});
  await exportPlanToDirectory(plan, output);
  const sameBytes = (first: Uint8Array, second: Uint8Array) => first.length === second.length && first.every((value,index)=>value===second[index]);
  for (const entry of plan.entries) {
    assert(entry.textContent === `${entry.caption}\n` && await archive.file(entry.textName)?.async('string') === entry.textContent, 'ZIP caption differs from the TXT on disk');
    const image = await archive.file(entry.imageName)?.async('uint8array');
    const original = new Uint8Array(await entry.blob.arrayBuffer());
    assert(image && sameBytes(image,original), 'ZIP image differs from reopened file');
    const diskImage = await (await output.getFileHandle(entry.imageName)).getFile();
    assert(sameBytes(new Uint8Array(await diskImage.arrayBuffer()), original), 'Directory image differs from reopened file');
    const diskCaption = await (await output.getFileHandle(entry.textName)).getFile();
    assert(await diskCaption.text() === entry.textContent, 'Directory caption differs from the TXT on disk');
  }
  return `PASS: reopened ${sources.length} physical Dataset images with final captions/order and byte-identical ZIP/directory contents`;
}
async function verifyVersions(directory: ProjectDirectoryHandle) {
  const observable = <T,>(initial:T) => {
    let value=initial; const listeners=new Set<(value:T)=>void>();
    return {get:()=>value,set:(next:T)=>{value=next;listeners.forEach(listener=>listener(next));},subscribe:(listener:(value:T)=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
  };
  const initial=await readProjectDirectory(directory);
  const project=observable(initial); const folder=observable<ProjectDirectoryHandle|undefined>(directory);
  const session=createSaveSession({getProject:project.get,subscribeProject:project.subscribe,getDirectory:folder.get,subscribeDirectory:folder.subscribe,write:writeProjectDirectoryChanges,changed:()=>{}});
  try {
    const version=await session.runExclusive(()=>createProjectVersion(directory,`fixture-${crypto.randomUUID()}`));
    project.set({...initial,name:'After snapshot',dataset:{...initial.dataset,triggerWord:'changed-after-version'}});
    await session.flush();
    assert((await readProjectDirectory(directory)).dataset.triggerWord==='changed-after-version','Pre-restore edit was not written');
    await session.runExclusive(async()=>{
      let restored!:ProjectState;
      await restoreProjectVersion(directory,version.id,async()=>{restored=await readProjectDirectory(directory);});
      folder.set(undefined); project.set(restored); folder.set(directory);
    });
    assert(project.get().id===initial.id && project.get().name===initial.name,'Restoring the same project id kept stale metadata');
    assert((await readProjectDirectory(directory)).dataset.triggerWord===initial.dataset.triggerWord,'Old autosave overwrote the restored Dataset');
    project.set({...project.get(),name:'Edited after restore'}); await session.flush();
    assert((await readProjectDirectory(directory)).name==='Edited after restore','The restored session cannot save new edits');
    return `PASS: version restore retained original Dataset, discarded the old save baseline, and saved a later edit; ${await verify(directory)}`;
  } finally {session.dispose();}
}
function Harness() {
  const [busy,setBusy] = useState(false);
  const [messages,setMessages] = useState<string[]>([]);
  const add = (message: string) => setMessages(previous => [...previous,message]);
  const run = (task: () => Promise<void>) => { setBusy(true); setMessages([]); void task().catch(error=>add(`FAIL: ${error.message}`)).finally(()=>setBusy(false)); };
  const write = async () => {
    const directory = await getFixture(true);
    const first = createSourceImage(await imageBlob('#edac40'),'amber.png',32,24);
    const second = createSourceImage(await imageBlob('#476c94','image/jpeg'),'blue.jpg',32,24);
    first.tags = ['original']; second.tags = ['override'];
    first.originalFilePath = 'dataset/amber.png';
    second.originalFilePath = 'dataset/blue.jpg';
    const initial: ProjectState = {...createProject('Persistence fixture','character'), sourceImages:{[first.id]:first,[second.id]:second}};
    await writeProjectDirectoryChanges(initial, undefined, directory);
    // The TXT next to each image is the caption: inside dataset/ it starts with the trigger word saved below.
    await writeCaptionFile(directory, 'dataset/amber.png', ['original'], 'fixture-trigger');
    await writeCaptionFile(directory, 'dataset/blue.jpg', ['override'], 'fixture-trigger');
    add('Created PNG and JPEG files with TXT captions in isolated browser storage');
    let release!: () => void;
    let activeWrites = 0; let peakWrites = 0;
    const queue = createSaveQueue(initial, async (snapshot, previous) => {
      activeWrites++; peakWrites = Math.max(peakWrites,activeWrites);
      try {
        if (snapshot.dataset.triggerWord === 'draft') await new Promise<void>(resolve=>{release=resolve;});
        await writeProjectDirectoryChanges(snapshot,previous,directory);
      } finally {activeWrites--;}
    }, state=>add(`Save: ${state.status}`));
    const draft = {...initial,dataset:{...initial.dataset,triggerWord:'draft'}};
    queue.enqueue(draft); const pending = queue.flush();
    const final = {...draft,dataset:{...draft.dataset,triggerWord:'fixture-trigger',assetOrder:['file:Project/dataset/blue.jpg','file:Project/dataset/amber.png']}};
    queue.enqueue(final); release(); await pending;
    assert(peakWrites === 1 && !queue.isDirty(),'Writes overlapped or latest snapshot was not saved');
    add('PASS: queued edits wrote sequentially and saved the latest snapshot');
    add(await verify(directory));
    const beforeImageRename = await readProjectDirectory(directory);
    const imageToRename = Object.values(beforeImageRename.sourceImages).find(source => source.mimeType === 'image/png')!;
    assert(imageToRename?.originalFilePath, 'Fixture needs persisted image paths');
    const imageQueue = createSaveQueue(beforeImageRename, (snapshot, previous) => writeProjectDirectoryChanges(snapshot, previous, directory), () => {});
    await imageQueue.runExclusive(() => renameExplorerEntry(directory, `Project/${imageToRename.originalFilePath}`, 'file', 'renamed-source.png', change => {
      const moved = {...imageToRename, fileName:'renamed-source.png', originalFileName:'renamed-source.png',
        originalFilePath:applyProjectRelativePathMoves(imageToRename.originalFilePath,[change])};
      imageQueue.enqueue({...beforeImageRename,sourceImages:{...beforeImageRename.sourceImages,[moved.id]:moved}});
    }));
    await moveAssetRegistryPaths(directory, [{from:`Project/${imageToRename.originalFilePath}`,to:'Project/dataset/renamed-source.png'}]);
    const afterImageRename = await readProjectDirectory(directory);
    const renamedImage = afterImageRename.sourceImages[imageToRename.id];
    assert(renamedImage.originalFilePath?.endsWith('/renamed-source.png'), 'Image path was not retained');
    const datasetDirectory = await directory.getDirectoryHandle('dataset');
    for await (const [name] of datasetDirectory.entries()) assert(!name.endsWith('.manifest.json'), `A sidecar appeared in dataset/: ${name}`);
    const renamedCaption = await readCaptionFile(directory, 'dataset/renamed-source.png', 'fixture-trigger');
    assert(renamedCaption.raw === 'fixture-trigger, original\n' && renamedCaption.triggerPresent, 'The TXT did not follow the image rename');
    assert((await readCaptionFile(directory, 'dataset/amber.png')).raw === null, 'Renaming left the old TXT behind');
    imageQueue.stop();
    add('PASS: image rename retained source identity through the registry without any sidecar');
    add(await verify(directory));
    add('Reload this page, then use Reopen saved fixture');
  };
  return <main className="min-h-screen space-y-4 bg-background p-5 text-foreground">
    <h1 className="text-xl font-semibold">Project persistence checks</h1>
    <p>Synthetic images in an isolated browser filesystem folder. This does not access your project folders.</p>
    <div className="flex gap-3"><button disabled={busy} className="rounded border px-3 py-2" onClick={()=>run(write)}>Write fixture</button>
    <button disabled={busy} className="rounded border px-3 py-2" onClick={()=>run(async()=>add(await verify(await getFixture())))}>Reopen saved fixture</button>
    <button disabled={busy} className="rounded border px-3 py-2" onClick={()=>run(async()=>add(await verifyVersions(await getFixture())))}>Check version restore</button>
    <button disabled={busy} className="rounded border px-3 py-2" onClick={()=>run(async()=>add(await checkDatasetFolder()))}>Run Dataset folder regressions</button></div>
    <p role="status">{busy ? 'Running' : 'Idle'}</p>
    <ol>{messages.map((message,index)=><li key={index}>{message}</li>)}</ol>
  </main>;
}
const root = createRoot(document.getElementById('root')!); root.render(<Harness/>);
import.meta.hot?.dispose(()=>root.unmount());
