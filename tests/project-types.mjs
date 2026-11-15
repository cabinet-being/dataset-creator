import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';
import JSZip from 'jszip';

globalThis.Image = class {
  naturalWidth = 1;
  naturalHeight = 1;
  set src(_value) { queueMicrotask(() => this.onload?.()); }
};

const temp = await mkdtemp(join(tmpdir(), 'project-types-'));
try {
  await build({ input: ['src/lib/explorerTreeUpdates.ts', 'src/lib/datasetBoard.ts', 'src/lib/datasetAssets.ts', 'src/services/project/explorerFileService.ts', 'src/services/dataset/datasetFolderService.ts', 'src/types/index.ts', 'src/lib/projectProfiles.ts', 'src/lib/workspaceFileAssets.ts', 'src/services/project/projectDirectoryService.ts', 'src/services/project/projectFileService.ts', 'src/services/project/projectLayoutService.ts', 'src/services/project/projectVersionService.ts', 'src/services/project/layoutMigrationService.ts', 'src/services/project/assetIndexService.ts', 'src/services/export/datasetExportService.ts', 'src/stores/useProjectStore.ts', 'src/stores/useUIStore.ts'], platform: 'node', output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' } });
  const { getUniqueExplorerName, deleteExplorerEntry, renameExplorerEntry, copyExplorerEntry, moveExplorerEntries, copyExplorerEntries, duplicateExplorerEntries, ExplorerBatchError } = await import(pathToFileURL(join(temp, 'explorerFileService.mjs')));
  const { createProject, createSourceImage, createEditedAsset } = await import(pathToFileURL(join(temp, 'index.mjs')));
  const { resolveProjectType, PROJECT_TYPE_PROFILES } = await import(pathToFileURL(join(temp, 'projectProfiles.mjs')));
  const { createProjectDirectory, readProjectDirectory, writeProjectDirectoryChanges, clearProjectDirectory, listProjectDirectoryClearTargets, countProjectDirectoryFiles } = await import(pathToFileURL(join(temp, 'projectDirectoryService.mjs')));
  const { createProjectFileBlob, readProjectFile } = await import(pathToFileURL(join(temp, 'projectFileService.mjs')));
  const { useProjectStore } = await import(pathToFileURL(join(temp, 'useProjectStore.mjs')));
  const { useUIStore } = await import(pathToFileURL(join(temp, 'useUIStore.mjs')));
  const { addItemsToDatasetFolder, removeItemsFromDatasetFolder, reverseDatasetFolderChanges, isProjectDatasetPath } = await import(pathToFileURL(join(temp, 'datasetFolderService.mjs')));
  const { DATASET_MANIFEST_FILE, REQUIRED_PROJECT_DIRECTORIES, readDatasetManifest } = await import(pathToFileURL(join(temp, 'projectLayoutService.mjs')));
  const { createProjectVersion, restoreProjectVersion, listProjectVersions, ProjectVersionRestoreError } = await import(pathToFileURL(join(temp, 'projectVersionService.mjs')));
  const { detectProjectLayout, planLayoutMigration, runLayoutMigration, resumePendingJournals, LayoutMigrationError, detectLegacyRawLayout, planRawMaterialsMove, runRawMaterialsMove, runCaptionTxtMigration } = await import(pathToFileURL(join(temp, 'layoutMigrationService.mjs')));
  const { getProjectVersionLayout } = await import(pathToFileURL(join(temp, 'projectVersionService.mjs')));
  const { exportProjectDatasetAsZip } = await import(pathToFileURL(join(temp, 'datasetExportService.mjs')));
  const { indexProjectAssets } = await import(pathToFileURL(join(temp, 'assetIndexService.mjs')));
  const { sortExplorerNodes, sanitizeExplorerTree, buildEmptyExplorerTree } = await import(pathToFileURL(join(temp, 'explorerTreeUpdates.mjs')));
  const { orderDatasetBoardItems, datasetBoardItems } = await import(pathToFileURL(join(temp, 'datasetBoard.mjs')));
  const { collectWorkspaceFileAssets, updateWorkspaceFileAssetCache } = await import(pathToFileURL(join(temp, 'workspaceFileAssets.mjs')));
  // In-memory File System Access handles exercise the real directory serializer and reader.
  function directory(name = 'test') {
    const entries = new Map();
    return {
      name, entries: async function* () { yield* entries; },
      async getDirectoryHandle(name, options) {
        if (!entries.has(name) && options?.create) entries.set(name, directory(name));
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        if (!('entries' in entries.get(name))) throw new DOMException('Not a directory', 'TypeMismatchError');
        return entries.get(name);
      },
      async getFileHandle(name, options) {
        if (!entries.has(name) && options?.create) {
          let contents = '';
          entries.set(name, { name, getFile: async () => new File([contents], name), createWritable: async () => ({ write: async (data) => { contents = data; }, close: async () => {} }) });
        }
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        if ('entries' in entries.get(name)) throw new DOMException('Not a file', 'TypeMismatchError');
        return entries.get(name);
      },
      async removeEntry(name) { entries.delete(name); },
    };
  }
  {
    const { moveExplorerTreeNodes, replaceExplorerTreeNode } = await import(pathToFileURL(join(temp, 'explorerTreeUpdates.mjs')));
    const untouched = {name:'unrelated',path:'Project/unrelated',kind:'folder',children:[]};
    const tree = {name:'Project',path:'Project',kind:'folder',children:[
      {name:'from',path:'Project/from',kind:'folder',children:[{name:'clip.webm',path:'Project/from/clip.webm',kind:'file'}]},
      {name:'to',path:'Project/to',kind:'folder',children:[]}, untouched,
    ]};
    const move = {from:'Project/from/clip.webm',to:'Project/to/renamed.webm'};
    const moved = moveExplorerTreeNodes(tree,[move]);
    assert.equal(moved.children.find(node=>node.path===untouched.path),untouched,'Unrelated tree branches retain identity');
    assert.equal(moved.children[0].children.length,0);
    assert.equal(moved.children[1].children[0].path,move.to);
    assert.equal(tree.children[0].children.length,1,'Updating the tree does not mutate the previous snapshot');
    const folderMove=moveExplorerTreeNodes(tree,[{from:'Project/from',to:'Project/to/renamed'}]);
    assert.equal(folderMove.children.find(node=>node.path==='Project/to').children[0].children[0].path,'Project/to/renamed/clip.webm');
    assert.equal(replaceExplorerTreeNode(moved,move.to).children[1].children.length,0);

    const root=directory();
    const from=await root.getDirectoryHandle('from',{create:true});
    const to=await root.getDirectoryHandle('to',{create:true});
    const unrelated=await root.getDirectoryHandle('unrelated',{create:true});
    await from.getFileHandle('clip.webm',{create:true});
    const clipManifest=await (await from.getFileHandle('clip.webm.manifest.json',{create:true})).createWritable();
    await clipManifest.write(JSON.stringify({id:'stable-video-id'})); await clipManifest.close();
    const other=await unrelated.getFileHandle('large.webm',{create:true});
    let unrelatedReads=0; let unrelatedListings=0;
    const read=other.getFile; other.getFile=async()=>{unrelatedReads++;return read();};
    const list=unrelated.entries; unrelated.entries=async function*(){unrelatedListings++;yield* list();};
    const before=await collectWorkspaceFileAssets(root);
    await moveExplorerEntries(root,[{path:'Project/from/clip.webm',name:'clip.webm',kind:'file'}],'Project/to');
    unrelatedReads=0; unrelatedListings=0;
    await updateWorkspaceFileAssetCache(root,{moves:[{from:'Project/from/clip.webm',to:'Project/to/clip.webm'}],paths:[]});
    const after=await collectWorkspaceFileAssets(root);
    assert.equal(after.find(asset=>asset.path==='Project/to/clip.webm').file,before.find(asset=>asset.path==='Project/from/clip.webm').file,'Moves preserve cached file snapshots');
    assert.equal(before.find(asset=>asset.path==='Project/from/clip.webm').stableId,'stable-video-id');
    assert.equal(after.find(asset=>asset.path==='Project/to/clip.webm').stableId,'stable-video-id','File-only manifest identity survives path moves');
    await to.getFileHandle('new.webm',{create:true});
    await updateWorkspaceFileAssetCache(root,{moves:[],paths:['Project/to/new.webm']});
    assert.equal((await collectWorkspaceFileAssets(root)).length,3);
    await to.removeEntry('new.webm');
    await updateWorkspaceFileAssetCache(root,{moves:[],paths:['Project/to/new.webm']});
    assert.equal((await collectWorkspaceFileAssets(root)).length,2);
    assert.equal(unrelatedReads,0,'Moves, additions and deletions never reread unrelated file bytes');
    assert.equal(unrelatedListings,0,'Scoped cache updates never enumerate unrelated branches');
  }
  {
    const root = directory();
    await root.getDirectoryHandle('existing',{create:true});
    const getFile = root.getFileHandle;
    root.getFileHandle = async (name, options) => {
      if (name === 'existing') throw new DOMException('A directory has this name', 'TypeMismatchError');
      return getFile(name,options);
    };
    assert.equal(await getUniqueExplorerName(root,'existing'),'existing 2','Native directory collisions are existing entries, not access failures');
  }
  // Committed deletion still updates the UI when sidecar cleanup is denied.
  for (const failedName of ['photo.png', 'photo.png.manifest.json', null]) {
    const root = directory();
    await root.getFileHandle('photo.png',{create:true});
    await root.getFileHandle('photo.png.manifest.json',{create:true});
    const remove = root.removeEntry;
    root.removeEntry = async name => {
      if (name === failedName) throw new Error('permission denied');
      await remove(name);
    };
    let notified = 0;
    const deletion = deleteExplorerEntry(root,'Project/photo.png',false,() => {notified++;});
    if (failedName) await assert.rejects(deletion,failedName.endsWith('manifest.json') ? /Entry deleted, but metadata cleanup failed/ : /permission denied/);
    else await deletion;
    assert.equal(notified,failedName === 'photo.png' ? 0 : 1);
    if (failedName === 'photo.png') assert.ok(await root.getFileHandle('photo.png'));
    else await assert.rejects(root.getFileHandle('photo.png'),{name:'NotFoundError'});
  }
  // A batch failure retains completed files and exposes exactly which paths changed.
  for (const operation of ['move', 'copy', 'duplicate']) {
    const root = directory();
    const source = await root.getDirectoryHandle('from', {create:true});
    const target = await root.getDirectoryHandle('to', {create:true});
    const writer = await (await source.getFileHandle('first.txt', {create:true})).createWritable();
    await writer.write('keep these bytes'); await writer.close();
    const entries = ['first.txt','missing.txt','unattempted.txt'].map(name => ({kind:'file',name,path:`Project/from/${name}`}));
    const notifications = [];
    let failure;
    try {
      if (operation === 'move') await moveExplorerEntries(root, entries, 'Project/to', async change => {
        assert.equal(await (await (await target.getFileHandle('first.txt')).getFile()).text(),'keep these bytes');
        notifications.push(change);
      });
      else if (operation === 'copy') await copyExplorerEntries(root, entries, 'Project/to');
      else await duplicateExplorerEntries(root, entries);
    } catch (error) { failure = error; }
    assert.ok(failure instanceof ExplorerBatchError);
    assert.equal(failure.failedPath,'Project/from/missing.txt');
    const destination = operation === 'duplicate' ? 'Project/from/first 2.txt' : 'Project/to/first.txt';
    assert.deepEqual(failure.completed,[{from:'Project/from/first.txt',to:destination}]);
    assert.match(failure.message,/1 item\(s\) completed/);
    if (operation === 'move') {
      assert.deepEqual(notifications,failure.completed,'Update references before attempting the next entry');
      await assert.rejects(source.getFileHandle('first.txt'),{name:'NotFoundError'});
      const noOp = await moveExplorerEntries(root,[{kind:'file',name:'first.txt',path:destination}],'Project/to');
      assert.deepEqual(noOp,[{from:destination,to:destination}],'A retry in the destination does not rename an already moved file');
    } else {
      assert.equal(await (await (await source.getFileHandle('first.txt')).getFile()).text(),'keep these bytes');
      const copied = operation === 'copy' ? await target.getFileHandle('first.txt') : await source.getFileHandle('first 2.txt');
      assert.equal(await (await copied.getFile()).text(),'keep these bytes');
    }
  }
  for (const nativeMove of [false,true]) {
    const root = directory();
    const source = await root.getDirectoryHandle('from', {create:true});
    const target = await root.getDirectoryHandle('to', {create:true});
    const file = await source.getFileHandle('photo.png', {create:true});
    const writer = await file.createWritable(); await writer.write('original pixels'); await writer.close();
    const sidecar = await source.getFileHandle('photo.png.manifest.json',{create:true});
    const metadataWriter = await sidecar.createWritable();
    await metadataWriter.write(JSON.stringify({id:'keep-id',originalFileName:'photo.png'})); await metadataWriter.close();
    const remove = source.removeEntry;
    source.removeEntry = async name => {
      if (name.endsWith('.manifest.json')) throw new DOMException('Metadata removal denied','NotAllowedError');
      return remove(name);
    };
    if (nativeMove) file.move = async (destination,name) => {
      const stream = await (await destination.getFileHandle(name,{create:true})).createWritable();
      await stream.write(await file.getFile()); await stream.close(); await source.removeEntry('photo.png');
    };
    const updates = [];
    await assert.rejects(moveExplorerEntries(root,[{kind:'file',name:'photo.png',path:'Project/from/photo.png'}],'Project/to',change => {updates.push(change);}), error => {
      assert.ok(error instanceof ExplorerBatchError);
      assert.match(error.message,/File moved.*metadata could not be updated/);
      assert.deepEqual(error.completed,[{from:'Project/from/photo.png',to:'Project/to/photo.png'}]);
      assert.deepEqual(updates,error.completed,'A moved file updates references even when its metadata cleanup fails');
      return true;
    });
    assert.equal(await (await (await target.getFileHandle('photo.png')).getFile()).text(),'original pixels');
    await assert.rejects(source.getFileHandle('photo.png'),{name:'NotFoundError'});
    assert.equal(JSON.parse(await (await (await target.getFileHandle('photo.png.manifest.json')).getFile()).text()).id,'keep-id');
  }
  // Rename must report a committed file change even if sidecar handling fails.
  for (const nativeMove of [false,true]) {
    for (const failureStage of ['write','cleanup']) {
      const root = directory();
      const original = await root.getFileHandle('old.png',{create:true});
      const imageWriter = await original.createWritable(); await imageWriter.write('rename pixels'); await imageWriter.close();
      const manifestWriter = await (await root.getFileHandle('old.png.manifest.json',{create:true})).createWritable();
      await manifestWriter.write(JSON.stringify({id:'stable-id',originalFileName:'old.png'})); await manifestWriter.close();
      const getFile = root.getFileHandle;
      const remove = root.removeEntry;
      let aborted = false;
      if (nativeMove) original.move = async (destination,name) => {
        const stream = await (await destination.getFileHandle(name,{create:true})).createWritable();
        await stream.write(await original.getFile()); await stream.close(); await remove('old.png');
      };
      if (failureStage === 'write') root.getFileHandle = async (name,options) => {
        const handle = await getFile(name,options);
        if (name === 'new.png.manifest.json') handle.createWritable = async () => ({
          write: async () => {throw new Error('sidecar write denied');},
          close: async () => {}, abort: async () => {aborted=true;}
        });
        return handle;
      };
      else root.removeEntry = async name => {
        if (name === 'old.png.manifest.json') throw new Error('sidecar cleanup denied');
        return remove(name);
      };
      const updates = [];
      const committed = nativeMove || failureStage === 'cleanup';
      await assert.rejects(renameExplorerEntry(root,'Project/old.png','file','new.png',change => {updates.push(change);}),error => {
        assert.ok(error instanceof ExplorerBatchError);
        assert.equal(error.completed.length,committed ? 1 : 0);
        assert.equal(updates.length,committed ? 1 : 0);
        if (committed) assert.deepEqual(updates,[{from:'Project/old.png',to:'Project/new.png'}]);
        return true;
      });
      assert.equal(await (await (await getFile(committed ? 'new.png' : 'old.png')).getFile()).text(),'rename pixels');
      await assert.rejects(getFile(committed ? 'old.png' : 'new.png'),{name:'NotFoundError'});
      if (failureStage === 'write') assert.ok(aborted,'Failed streams are aborted before cleanup');
      if (!committed) await assert.rejects(getFile('new.png.manifest.json'),{name:'NotFoundError'});
    }
  }
  {
    const root = directory();
    const writer = await (await root.getFileHandle('old.txt',{create:true})).createWritable();
    await writer.write('original'); await writer.close();
    const metadataWriter = await (await root.getFileHandle('new.txt.manifest.json',{create:true})).createWritable();
    await metadataWriter.write('existing metadata'); await metadataWriter.close();
    await assert.rejects(renameExplorerEntry(root,'Project/old.txt','file','new.txt'),/Metadata.*already exists/);
    assert.equal(await (await (await root.getFileHandle('new.txt.manifest.json')).getFile()).text(),'existing metadata');
    assert.equal(await (await (await root.getFileHandle('old.txt')).getFile()).text(),'original');
    assert.equal(await renameExplorerEntry(root,'Project/old.txt','file','fresh.txt'),'Project/fresh.txt');
    assert.equal(await (await (await root.getFileHandle('fresh.txt')).getFile()).text(),'original');
  }
  // A failed recursive copy cleans only its own destination; cleanup denial is actionable.
  for (const cleanupDenied of [false,true]) {
    const root = directory();
    const source = await root.getDirectoryHandle('source',{create:true});
    for (const name of ['good.txt','bad.txt']) {
      const file = await source.getFileHandle(name,{create:true});
      const stream = await file.createWritable(); await stream.write(name); await stream.close();
      if (name === 'bad.txt') file.getFile = async () => {throw new Error('source read denied');};
    }
    const keepWriter = await (await root.getFileHandle('unrelated.txt',{create:true})).createWritable();
    await keepWriter.write('keep'); await keepWriter.close();
    if (cleanupDenied) {
      const remove = root.removeEntry;
      root.removeEntry = async name => {
        if (name === 'copied') throw new Error('cleanup denied');
        return remove(name);
      };
    }
    await assert.rejects(copyExplorerEntry(root,{path:'Project/source',name:'source',kind:'folder'},'Project','copied'),cleanupDenied ? /original is unchanged.*Project\/copied/ : /source read denied/);
    assert.equal(await (await (await source.getFileHandle('good.txt')).getFile()).text(),'good.txt');
    assert.equal(await (await (await root.getFileHandle('unrelated.txt')).getFile()).text(),'keep');
    if (!cleanupDenied) await assert.rejects(root.getDirectoryHandle('copied'),{name:'NotFoundError'});
    else assert.equal(await (await (await (await root.getDirectoryHandle('copied')).getFileHandle('good.txt')).getFile()).text(),'good.txt');
  }
  // Failed fallback removal rolls back a file copy, but keeps a complete
  // folder recovery copy when recursive deletion may already be partial.
  for (const kind of ['file','folder']) {
    const root = directory();
    const source = await root.getDirectoryHandle('from',{create:true});
    const target = await root.getDirectoryHandle('to',{create:true});
    const name = kind === 'file' ? 'keep.txt' : 'keep';
    const content = kind === 'file' ? source : await source.getDirectoryHandle(name,{create:true});
    const leaf = kind === 'file' ? name : 'child.txt';
    const stream = await (await content.getFileHandle(leaf,{create:true})).createWritable();
    await stream.write('irreplaceable content'); await stream.close();
    const remove = source.removeEntry;
    source.removeEntry = async entry => {
      if (entry === name) {
        if (kind === 'folder') await content.removeEntry(leaf);
        throw new Error('source removal denied');
      }
      return remove(entry);
    };
    const updates = [];
    await assert.rejects(moveExplorerEntries(root,[{kind,name,path:`Project/from/${name}`}],'Project/to',change => updates.push(change)),
      kind === 'file' ? /source removal denied/ : /complete copy is kept at "Project\/to\/keep".*recover/);
    assert.deepEqual(updates,[],'An incomplete folder move must not be announced as successful');
    if (kind === 'file') {
      assert.equal(await (await (await source.getFileHandle(name)).getFile()).text(),'irreplaceable content');
      await assert.rejects(target.getFileHandle(name),{name:'NotFoundError'});
    } else {
      const recovery = await target.getDirectoryHandle(name);
      assert.equal(await (await (await recovery.getFileHandle(leaf)).getFile()).text(),'irreplaceable content');
      await assert.rejects(content.getFileHandle(leaf),{name:'NotFoundError'});
    }
  }
  // Moving a registered source changes location, not membership or edited descendants.
  {
    const { applyProjectRelativePathMoves } = await import(pathToFileURL(join(temp,'datasetAssets.mjs')));
    const root = directory();
    const source = {...createSourceImage(new Blob(['source pixels'],{type:'image/png'}),'original.png',32,24),
      originalFilePath:'inbox/original.png',manifestPath:'inbox/original.png.manifest.json',tags:['source tag']};
    const edited = {...createEditedAsset(source.id,new Blob(['edited pixels'],{type:'image/png'}),32,24),
      imageDataPath:'inbox/edits/edited.png',manifestPath:'inbox/edits/edited.png.manifest.json',
      psdData:new Blob(['PSD layers']),psdDataPath:'inbox/edits/edited.psd'};
    const base = createProject('Move original','character');
    const before = {...base,sourceImages:{[source.id]:source},datasetItems:{[edited.id]:edited},
      dataset:{...base.dataset,assetIds:[source.id],assetOrder:[`image:${source.id}`]}};
    await createProjectDirectory(root,before);
    await root.getDirectoryHandle('Archive',{create:true});
    let moved;
    await moveExplorerEntries(root,[{kind:'file',name:'original.png',path:'Project/inbox/original.png'}],'Project/Archive',change => {
      moved = {...source,originalFilePath:applyProjectRelativePathMoves(source.originalFilePath,[change]),manifestPath:applyProjectRelativePathMoves(source.manifestPath,[change],true)};
    });
    const after = {...before,sourceImages:{[source.id]:moved}};
    await writeProjectDirectoryChanges(after,before,root);
    const reopened = await readProjectDirectory(root);
    assert.equal(reopened.sourceImages[source.id].originalFilePath,'Archive/original.png');
    assert.equal(reopened.sourceImages[source.id].manifestPath,'Archive/original.png.manifest.json');
    assert.equal(await reopened.sourceImages[source.id].originalFile.text(),'source pixels');
    assert.deepEqual(reopened.sourceImages[source.id].tags,['source tag']);
    assert.equal('assetIds' in reopened.dataset,false);
    assert.deepEqual(reopened.dataset.assetOrder,before.dataset.assetOrder);
    assert.equal(reopened.dataset.captionOverrides,undefined,'Current Dataset files do not recreate legacy caption overrides');
    assert.equal(reopened.datasetItems[edited.id].sourceImageId,source.id);
    assert.equal(await reopened.datasetItems[edited.id].imageData.text(),'edited pixels');
    assert.equal(await reopened.datasetItems[edited.id].psdData.text(),'PSD layers');
    const projectIndex = await indexProjectAssets(root,{existingSourceImages:{[source.id]:moved}});
    assert.ok(projectIndex.discoveredCount >= 1,'The project index includes registered assets outside shared');
    let returned;
    await moveExplorerEntries(root,[{kind:'file',name:'original.png',path:'Project/Archive/original.png'}],'Project/inbox',change => {
      returned = {...reopened.sourceImages[source.id],originalFilePath:applyProjectRelativePathMoves(moved.originalFilePath,[change]),manifestPath:applyProjectRelativePathMoves(moved.manifestPath,[change],true)};
    });
    const restored = {...reopened,sourceImages:{[source.id]:returned}};
    await writeProjectDirectoryChanges(restored,reopened,root);
    const final = await readProjectDirectory(root);
    assert.equal(final.sourceImages[source.id].originalFilePath,source.originalFilePath);
    assert.equal(await final.datasetItems[edited.id].psdData.text(),'PSD layers');
    assert.equal('assetIds' in final.dataset,false);
  }
  // A rejected snapshot retains its asset index and drains all parallel writes
  // before allowing the save queue to retry.
  {
    const root = directory();
    const sources = ['first', 'second'].map(name => ({
      ...createSourceImage(new Blob([name], {type:'image/png'}), `${name}.png`, 32, 24),
      originalFilePath:`Archive/${name}.png`, manifestPath:`Archive/${name}.png.manifest.json`, tags:['before'],
    }));
    const before = {...createProject('Before failure','character'),sourceImages:Object.fromEntries(sources.map(source => [source.id,source]))};
    await createProjectDirectory(root,before);
    const manifest = await (await root.getDirectoryHandle('.datasetcreator')).getFileHandle('project.json');
    const originalManifest = await (await manifest.getFile()).text();
    const archive = await root.getDirectoryHandle('Archive');
    const first = await archive.getFileHandle('first.png.manifest.json');
    const second = await archive.getFileHandle('second.png.manifest.json');
    const firstWritable = first.createWritable;
    const secondWritable = second.createWritable;
    let release, started;
    const held = new Promise(resolve => {release = resolve;});
    const pendingWriter = new Promise(resolve => {started = resolve;});
    first.createWritable = async () => {throw new Error('metadata write denied');};
    second.createWritable = async () => {
      started();
      await held;
      return secondWritable();
    };
    const after = {...before,name:'After retry',lastModified:new Date(),sourceImages:Object.fromEntries(sources.map(source => [source.id,{...source,tags:['after']}]))};
    let settled = false;
    const attempt = writeProjectDirectoryChanges(after,before,root);
    const outcome = attempt.then(() => {settled = true;}, error => {settled = true; return error;});
    await pendingWriter;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled,false,'The failed save still owns the lane while another writer is pending');
    assert.equal(await (await manifest.getFile()).text(),originalManifest,'Do not publish metadata without its asset index');
    release();
    assert.match((await outcome).message,/metadata write denied/);
    assert.equal(await (await manifest.getFile()).text(),originalManifest);
    const recovered = await readProjectDirectory(root);
    assert.deepEqual(Object.keys(recovered.sourceImages).sort(),sources.map(source => source.id).sort(),'Registered files outside shared remain discoverable after failure');
    first.createWritable = firstWritable;
    second.createWritable = secondWritable;
    await writeProjectDirectoryChanges(after,before,root);
    const reopened = await readProjectDirectory(root);
    assert.equal(reopened.name,'After retry');
    for (const source of sources) {
      // The TXT next to the image is the caption; saving the project never rewrites it from in-memory tags.
      assert.deepEqual(reopened.sourceImages[source.id].tags,['before']);
      assert.equal(await reopened.sourceImages[source.id].originalFile.text(),await source.originalFile.text());
    }
  }
  const projectJsonHandle = async (dir) => (await dir.getDirectoryHandle('.datasetcreator')).getFileHandle('project.json');
  const readManifest = async (dir) => {
    try { return JSON.parse(await (await dir.getFileHandle('manifest.json')).getFile().then(file => file.text())); }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    return JSON.parse(await (await (await projectJsonHandle(dir)).getFile()).text());
  };
  const writeManifest = async (dir, manifest) => {
    const stream = await (await projectJsonHandle(dir)).createWritable();
    await stream.write(JSON.stringify(manifest)); await stream.close();
  };
  // Turns a v3 project into the previous layout (manifest.json v1/v2) so legacy conversions and migration can be exercised.
  const toLegacyLayout = async (dir, version = 2, mutate = () => {}) => {
    const json = await readManifest(dir);
    const legacy = { format: 'dataset-creator-directory', version, project: json.project };
    delete legacy.project.migrations;
    mutate(legacy);
    const stream = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
    await stream.write(JSON.stringify(legacy)); await stream.close();
    await (await dir.getDirectoryHandle('.datasetcreator')).removeEntry('project.json');
    return legacy;
  };
  for (const type of ['character', 'style', 'concept']) {
    const project = createProject(`Test ${type}`, type);
    assert.equal(project.projectType, type);
    useProjectStore.getState().initializeProject('Store test', type);
    assert.equal(useProjectStore.getState().projectType, type);
    const dataset = useProjectStore.getState().dataset;
    assert.equal(dataset.name, PROJECT_TYPE_PROFILES[type].defaults.datasetName);
    assert.equal(dataset.triggerWord, PROJECT_TYPE_PROFILES[type].defaults.triggerWord);
    useProjectStore.getState().loadProject(project);
    assert.equal(useProjectStore.getState().projectType, type);
    assert.equal('datasetKeyword' in project.taggingConfig, false, 'The trigger word lives only in dataset.triggerWord');
    assert.equal(PROJECT_TYPE_PROFILES[type].enabledTools.length, 9);
    assert.ok(PROJECT_TYPE_PROFILES[type].enabledTools.includes('build'));
    assert.ok(PROJECT_TYPE_PROFILES[type].enabledTools.includes('video'));
    project.buildSession = {
      ...project.buildSession,
      profile:{...project.buildSession.profile,target:42,reviewMode:'uncertain-only'},
      order:['source:stable'],
      records:{'source:stable':{assetId:'source:stable',locator:'Project/inbox/stable.png',decision:'accepted',application:'applied',validation:'valid',revision:'r1',acceptedRevision:'r1',provenance:'manual',updatedAt:'2026-10-21T00:00:00.000Z'}},
    };
    const dir = directory();
    await createProjectDirectory(dir, project);
    assert.equal((await readManifest(dir)).project.projectType, type);
    const reopenedDirectoryProject = await readProjectDirectory(dir);
    assert.equal(reopenedDirectoryProject.projectType, type);
    assert.equal(reopenedDirectoryProject.buildSession.profile.target,42);
    assert.equal(reopenedDirectoryProject.buildSession.records['source:stable'].acceptedRevision,'r1');
    const blob = await createProjectFileBlob(project);
    const bytes = await blob.arrayBuffer(); // JSZip's Node adapter accepts buffers, browser adapter accepts Files.
    const zip = await JSZip.loadAsync(bytes);
    assert.equal(JSON.parse(await zip.file('manifest.json').async('string')).project.projectType, type);
    const reopenedArchiveProject = await readProjectFile(bytes);
    assert.equal(reopenedArchiveProject.projectType, type);
    assert.equal(reopenedArchiveProject.buildSession.profile.reviewMode,'uncertain-only');
  }
  const layoutProject = createProject('Structured project', 'character');
  layoutProject.dataset.triggerWord = 'trigger';
  const layoutDirectory = directory();
  await createProjectDirectory(layoutDirectory, layoutProject);
  for (const path of REQUIRED_PROJECT_DIRECTORIES) {
    let current = layoutDirectory;
    for (const part of path.split('/')) current = await current.getDirectoryHandle(part);
    assert.ok(current);
  }
  assert.equal(await readDatasetManifest(layoutDirectory), null);
  assert.equal((await readManifest(layoutDirectory)).project.dataset.triggerWord, 'trigger');
  const globalDatasetZip = await JSZip.loadAsync(await (await createProjectFileBlob(layoutProject)).arrayBuffer());
  assert.equal(JSON.parse(await globalDatasetZip.file('manifest.json').async('string')).project.datasets, undefined);
  assert.equal(globalDatasetZip.file('dataset.json'), null);
  assert.equal(JSON.parse(await globalDatasetZip.file('manifest.json').async('string')).project.dataset.triggerWord, 'trigger');
  const migrationDirectory = directory();
  const legacySource = {...createSourceImage(new Blob(['legacy source'], { type:'image/png' }), 'legacy.png', 32, 24),
    originalFilePath:'src/shared/legacy.png', manifestPath:'src/shared/legacy.png.manifest.json'};
  const legacyProject = {...createProject('Dataset migration', 'character'), sourceImages:{[legacySource.id]:legacySource}};
  await createProjectDirectory(migrationDirectory, legacyProject);
  await toLegacyLayout(migrationDirectory, 1, legacy => { delete legacy.project.dataset; });
  const migrationDatasetDirectory = await migrationDirectory.getDirectoryHandle('dataset');
  const migrationImageWriter = await (await migrationDatasetDirectory.getFileHandle('legacy.png', { create: true })).createWritable();
  await migrationImageWriter.write(new Blob(['png'], { type: 'image/png' })); await migrationImageWriter.close();
  const legacyDatasetWriter = await (await migrationDatasetDirectory.getFileHandle('ignored.dataset.json', { create: true })).createWritable();
  await legacyDatasetWriter.write(JSON.stringify({ name: 'Ignored legacy Dataset' })); await legacyDatasetWriter.close();
  const rootDatasetWriter = await (await migrationDirectory.getFileHandle(DATASET_MANIFEST_FILE, { create: true })).createWritable();
  await rootDatasetWriter.write(JSON.stringify({
    format: 'dataset-creator-dataset', version: 2, name: 'Legacy Dataset', projectType: 'character',
    description: '', triggerWord: 'legacy', imageCount: 1, classCount: 0, classRepeats: {}, assetIds:[legacySource.id], updatedAt: new Date().toISOString(),
  })); await rootDatasetWriter.close();
  const migratedProject = await readProjectDirectory(migrationDirectory);
  const migratedManifest = await readManifest(migrationDirectory);
  assert.equal(migratedManifest.version, 2);
  assert.equal(migratedManifest.project.datasetMigration.status, 'complete');
  assert.equal(migratedManifest.project.datasetMigration.operations.some(entry => entry.status === 'moved'), true);
  assert.equal(migratedProject.dataset.name, 'Legacy Dataset');
  assert.equal('assetPaths' in migratedProject.dataset, false);
  assert.match(migratedProject.sourceImages[legacySource.id].originalFilePath, /^dataset\/legacy(?: 2)?\.png$/);
  assert.equal(await readDatasetManifest(migrationDirectory), null);
  await assert.rejects(migrationDatasetDirectory.getFileHandle('ignored.dataset.json'), { name:'NotFoundError' });
  await layoutDirectory.removeEntry('dataset', { recursive: true });
  await (await layoutDirectory.getDirectoryHandle('inbox')).removeEntry('edits', { recursive: true });
  await readProjectDirectory(layoutDirectory);
  assert.ok(await layoutDirectory.getDirectoryHandle('dataset'));
  assert.ok(await (await layoutDirectory.getDirectoryHandle('inbox')).getDirectoryHandle('edits'));
  await assert.rejects(layoutDirectory.getFileHandle(DATASET_MANIFEST_FILE), { name: 'NotFoundError' });
  const datasetDirectory = await layoutDirectory.getDirectoryHandle('dataset');
  const classDirectory = await datasetDirectory.getDirectoryHandle('3_character', { create: true });
  const imageWritable = await (await classDirectory.getFileHandle('portrait.png', { create: true })).createWritable();
  await imageWritable.write(new Blob(['png'], { type: 'image/png' })); await imageWritable.close();
  const metadataWritable = await (await classDirectory.getFileHandle('portrait.png.manifest.json', { create: true })).createWritable();
  await metadataWritable.write(JSON.stringify({ tags: ['ignored sidecar tag'] })); await metadataWritable.close();
  const portraitCaption = await (await classDirectory.getFileHandle('portrait.txt', { create: true })).createWritable();
  await portraitCaption.write('trigger, portrait, blue hair\n'); await portraitCaption.close();
  const { blob: exportedDataset, count: exportedCount } = await exportProjectDatasetAsZip(layoutDirectory);
  assert.equal(exportedCount, 1);
  const datasetZip = await JSZip.loadAsync(await exportedDataset.arrayBuffer());
  assert.ok(datasetZip.file('3_character/1.png'));
  assert.equal(await datasetZip.file('3_character/1.txt').async('string'), 'trigger, portrait, blue hair\n');
  {
    const root = directory('physical-dataset');
    const project = createProject('Physical Dataset', 'character');
    await createProjectDirectory(root, project);
    const shared = await root.getDirectoryHandle('inbox');
    const image = await shared.getFileHandle('physical.psd', {create:true});
    const imageWriter = await image.createWritable(); await imageWriter.write(new Blob(['pixels'], {type:'image/vnd.adobe.photoshop'})); await imageWriter.close();
    const captionWriter = await (await shared.getFileHandle('physical.txt', {create:true})).createWritable(); await captionWriter.write('physical caption'); await captionWriter.close();
    useProjectStore.getState().loadProject(project);
    useUIStore.getState().setProjectDirectory({handle:root,name:project.name});
    const item = {id:'asset:physical',sourceImageId:'',kind:'psd',label:'PSD',displayIdentity:'1',fileName:'physical.psd',assetPath:'Project/inbox/physical.psd',imageData:await image.getFile(),psdData:await image.getFile(),width:1,height:1,aspectRatio:'1:1'};
    const added = await addItemsToDatasetFolder(root,[item]);
    assert.equal(added.completed.length,1);
    assert.ok(isProjectDatasetPath(added.completed[0].to));
    const physicalDataset = await root.getDirectoryHandle('dataset');
    assert.equal(await (await (await physicalDataset.getFileHandle('physical.txt')).getFile()).text(),'physical caption','Caption sidecars move with Dataset images');
    await assert.rejects(shared.getFileHandle('physical.psd'),{name:'NotFoundError'});
    const removed = await removeItemsFromDatasetFolder(root,[{...item,assetPath:'Project/dataset/physical.psd'}]);
    assert.equal(removed.completed.length,1);
    assert.equal(await (await (await shared.getFileHandle('physical.psd')).getFile()).text(),'pixels');
  }
  // Migrate old flags into physical moves, preserving identity/captions even
  // if the project-manifest checkpoint fails after the file has moved.
  for (const interrupt of [false,true]) {
    const root=directory();
    const source={...createSourceImage(new Blob(['legacy pixels'],{type:'image/png'}),'legacy.png',32,24),
      originalFilePath:'dataset/legacy.png',manifestPath:'dataset/legacy.png.manifest.json',tags:['legacy caption']};
    const project={...createProject('Legacy exclusions','character'),sourceImages:{[source.id]:source}};
    await createProjectDirectory(root,project);
    await toLegacyLayout(root);
    const archive=await JSZip.loadAsync(await (await createProjectFileBlob({...project,sourceImages:{[source.id]:{...source,originalFile:await source.originalFile.arrayBuffer()}}})).arrayBuffer());
    const archiveMetadata=JSON.parse(await archive.file(source.manifestPath).async('string'));
    archive.file(source.manifestPath,JSON.stringify({...archiveMetadata,excludedFromDataset:true}));
    archive.file('inbox/legacy.png','unrelated archive file');
    const restoredArchive=await readProjectFile(await archive.generateAsync({type:'nodebuffer'}));
    assert.equal(restoredArchive.sourceImages[source.id].originalFilePath,'inbox/legacy 2.png','Old ZIP exclusions are materialized as shared paths too');
    assert.equal(await restoredArchive.sourceImages[source.id].originalFile.text(),'legacy pixels');
    const newArchive=await JSZip.loadAsync(await (await createProjectFileBlob({...restoredArchive,sourceImages:{[source.id]:{...restoredArchive.sourceImages[source.id],originalFile:await restoredArchive.sourceImages[source.id].originalFile.arrayBuffer()}}})).arrayBuffer());
    assert.equal(newArchive.file('dataset/legacy.png'),null);
    assert.equal(await newArchive.file('inbox/legacy 2.png').async('string'),'legacy pixels');
    const data=await root.getDirectoryHandle('dataset');
    const shared=await (await root.getDirectoryHandle('src',{create:true})).getDirectoryHandle('shared',{create:true});
    await shared.getFileHandle('legacy.png',{create:true}); // Existing file must survive the collision.
    const meta=await data.getFileHandle('legacy.png.manifest.json');
    const parsed=JSON.parse(await (await meta.getFile()).text());
    const writer=await meta.createWritable(); await writer.write(JSON.stringify({...parsed,tags:['legacy caption'],excludedFromDataset:true})); await writer.close();
    const captionWriter=await (await data.getFileHandle('legacy.txt',{create:true})).createWritable(); await captionWriter.write('legacy caption'); await captionWriter.close();
    const projectManifest=await root.getFileHandle('manifest.json');
    const writable=projectManifest.createWritable;
    if (interrupt) {
      projectManifest.createWritable=async()=>{throw new Error('checkpoint denied');};
      await assert.rejects(readProjectDirectory(root),/checkpoint denied/);
      projectManifest.createWritable=writable;
    }
    const migrated=await readProjectDirectory(root);
    const moved=migrated.sourceImages[source.id];
    assert.equal(moved.originalFilePath,'src/shared/legacy 2.png');
    assert.equal(await moved.originalFile.text(),'legacy pixels');
    assert.deepEqual(moved.tags,['legacy caption']);
    assert.equal(await (await (await shared.getFileHandle('legacy 2.txt')).getFile()).text(),'legacy caption');
    assert.equal('excludedFromDataset' in moved,false);
    await assert.rejects(data.getFileHandle('legacy.png'),{name:'NotFoundError'});
    assert.equal((await readProjectDirectory(root)).sourceImages[source.id].originalFilePath,moved.originalFilePath,'Migration is idempotent');
    useProjectStore.getState().loadProject(migrated);
    // Node filesystem tests isolate IndexedDB; browser checks exercise the real store.
    const updateSource=useProjectStore.getState().updateSourceImage;
    useProjectStore.setState({updateSourceImage:(id,updates)=>useProjectStore.setState(state=>({sourceImages:{...state.sourceImages,[id]:{...state.sourceImages[id],...updates}}}))});
    useUIStore.getState().setProjectDirectory({handle:root,name:project.name});
    const item={id:`source:${source.id}`,sourceImageId:source.id,kind:'image',fileName:'legacy 2.png',assetPath:'Project/src/shared/legacy 2.png',imageData:moved.originalFile,width:32,height:24,tags:moved.tags,aspectRatio:'1:1'};
    await data.getFileHandle('legacy 2.png',{create:true});
    const added=await addItemsToDatasetFolder(root,[item]);
    assert.equal(added.completed.length,1); assert.notEqual(added.completed[0].to,'Project/dataset/legacy 2.png');
    const reversed=await reverseDatasetFolderChanges(root,added.completed);
    assert.equal(reversed[0].to,item.assetPath,'Undo restores the original filename after a collision');
    const redone=await reverseDatasetFolderChanges(root,reversed);
    assert.equal(redone[0].to,added.completed[0].to,'Redo restores the actual Dataset destination');
    useProjectStore.setState({updateSourceImage:updateSource});
  }
  const versionOne = await createProjectVersion(layoutDirectory, 'v1');
  const addedWritable = await (await datasetDirectory.getFileHandle('later.txt', { create: true })).createWritable();
  await addedWritable.write('later'); await addedWritable.close();
  const versionTwo = await createProjectVersion(layoutDirectory, 'v2');
  assert.equal(versionTwo.parentId, versionOne.id);
  await restoreProjectVersion(layoutDirectory, versionOne.id);
  await assert.rejects((await layoutDirectory.getDirectoryHandle('dataset')).getFileHandle('later.txt'));
  const versionThree = await createProjectVersion(layoutDirectory, 'v1-child');
  assert.equal(versionThree.parentId, versionOne.id);
  const writeRoot = async (root,name,value) => {
    const writer = await (await root.getFileHandle(name,{create:true})).createWritable();
    await writer.write(value); await writer.close();
  };
  await writeRoot(layoutDirectory,'current-only.txt','unsnapshotted current files');
  await layoutDirectory.getDirectoryHandle('empty-user-folder',{create:true});
  const layoutService = await layoutDirectory.getDirectoryHandle('.datasetcreator');
  const getLayoutFile = layoutService.getFileHandle;
  let failRestoreWrite = true;
  layoutService.getFileHandle = async (name,options) => {
    if(name==='project.json' && options?.create && failRestoreWrite) {failRestoreWrite=false; throw new Error('Write denied once');}
    return getLayoutFile(name,options);
  };
  await assert.rejects(restoreProjectVersion(layoutDirectory,versionOne.id),error=>error instanceof ProjectVersionRestoreError && error.previousRestored);
  layoutService.getFileHandle = getLayoutFile;
  assert.equal(await (await (await layoutDirectory.getFileHandle('current-only.txt')).getFile()).text(),'unsnapshotted current files','A failed restore rolls back current files, including those outside versions');
  assert.ok(await layoutDirectory.getDirectoryHandle('empty-user-folder'),'Rollback retains empty folders');
  assert.equal((await listProjectVersions(layoutDirectory)).currentId,versionThree.id,'Failed restore cannot advance the version pointer');
  await assert.rejects(restoreProjectVersion(layoutDirectory,versionOne.id,async()=>{throw new Error('Restored project cannot open');}),error=>error.previousRestored && /cannot open/.test(error.message));
  assert.ok(await layoutDirectory.getFileHandle('current-only.txt'),'Read validation failure also rolls back before exposing the restored project');
  const snapshots = await (await (await layoutDirectory.getDirectoryHandle('.datasetcreator')).getDirectoryHandle('versions')).getDirectoryHandle('snapshots');
  const versionArchive = await (await snapshots.getFileHandle(`${versionOne.id}.zip`)).getFile();
  const invalidArchive = new JSZip(); invalidArchive.file('.git/overwrite.txt','bad');
  await writeRoot(snapshots,`${versionOne.id}.zip`,await invalidArchive.generateAsync({type:'blob'}));
  await assert.rejects(restoreProjectVersion(layoutDirectory,versionOne.id),/invalid project path/);
  assert.ok(await layoutDirectory.getFileHandle('current-only.txt'),'Invalid archive paths are rejected before deleting any current files');
  await writeRoot(snapshots,`${versionOne.id}.zip`,versionArchive);
  const brokenDirectory = directory('recovery-failure');
  await createProjectDirectory(brokenDirectory,createProject('Recovery failure','style'));
  const brokenVersion = await createProjectVersion(brokenDirectory,'before');
  await writeRoot(brokenDirectory,'preserve.txt','recovery bytes');
  const brokenService=await brokenDirectory.getDirectoryHandle('.datasetcreator');
  const getBrokenFile=brokenService.getFileHandle;
  brokenService.getFileHandle=async(name,options)=>{
    if(name==='project.json' && options?.create) throw new Error('Persistent denial');
    return getBrokenFile(name,options);
  };
  let recoveryPath;
  await assert.rejects(restoreProjectVersion(brokenDirectory,brokenVersion.id),error=>{
    recoveryPath=error.recoveryPath; return error instanceof ProjectVersionRestoreError && !error.previousRestored && Boolean(recoveryPath);
  });
  const recoveryFolder=await (await (await (await brokenDirectory.getDirectoryHandle('.datasetcreator')).getDirectoryHandle('backup')).getDirectoryHandle('restore'));
  const recoveryFile=await (await recoveryFolder.getFileHandle(recoveryPath.split('/').pop())).getFile();
  const recoveryZip=await JSZip.loadAsync(await recoveryFile.arrayBuffer());
  assert.equal(await recoveryZip.file('preserve.txt').async('string'),'recovery bytes','A failed rollback retains a readable recovery archive');
  const privateAssetsDirectory = await (await layoutDirectory.getDirectoryHandle('inbox')).getDirectoryHandle('edits');
  const privateImageWriter = await (await privateAssetsDirectory.getFileHandle('private.png', { create: true })).createWritable();
  await privateImageWriter.write(new Blob(['png'], { type: 'image/png' })); await privateImageWriter.close();
  assert.ok((await indexProjectAssets(layoutDirectory)).discoveredCount >= 1,'Indexing covers private and arbitrary project folders');
  const sharedDirectory = await layoutDirectory.getDirectoryHandle('inbox');
  const sharedVideoWriter = await (await sharedDirectory.getFileHandle('shared.webm', { create: true })).createWritable();
  await sharedVideoWriter.write(new Blob(['video'], { type: 'video/webm' })); await sharedVideoWriter.close();
  const privateVideoWriter = await (await privateAssetsDirectory.getFileHandle('private.webm', { create: true })).createWritable();
  await privateVideoWriter.write(new Blob(['video'], { type: 'video/webm' })); await privateVideoWriter.close();
  assert.deepEqual((await collectWorkspaceFileAssets(layoutDirectory)).map((asset) => asset.path).sort(), ['Project/inbox/edits/private.webm','Project/inbox/shared.webm']);
  const scopedDirectory = await layoutDirectory.getDirectoryHandle('scoped', {create:true});
  const selectedHandle = await scopedDirectory.getFileHandle('selected.webm', {create:true});
  const unrelatedHandle = await scopedDirectory.getFileHandle('unrelated.webm', {create:true});
  let selectedReads = 0; let unrelatedReads = 0;
  const readSelected = selectedHandle.getFile; const readUnrelated = unrelatedHandle.getFile;
  selectedHandle.getFile = async () => { selectedReads++; return readSelected(); };
  unrelatedHandle.getFile = async () => { unrelatedReads++; return readUnrelated(); };
  assert.deepEqual(await indexProjectAssets(layoutDirectory,{paths:[]}),{discoveredCount:0,indexedCount:0,createdManifestCount:0},'An empty scope performs no project scan');
  assert.equal((await indexProjectAssets(layoutDirectory,{paths:['Project/scoped/selected.webm']})).discoveredCount,1,'A file scope indexes only that file');
  assert.ok(selectedReads > 0,'The scoped asset is inspected when metadata is missing');
  assert.equal(unrelatedReads,0,'Scoped indexing never reads unrelated asset bytes');
  const missingDatasetManifestDirectory = directory();
  await createProjectDirectory(missingDatasetManifestDirectory, createProject('No metadata', 'character'));
  await missingDatasetManifestDirectory.removeEntry(DATASET_MANIFEST_FILE);
  await assert.rejects(exportProjectDatasetAsZip(missingDatasetManifestDirectory), /contains no images/);
  const missingDatasetDirectory = directory();
  await createProjectDirectory(missingDatasetDirectory, createProject('No dataset directory', 'character'));
  await missingDatasetDirectory.removeEntry('dataset', { recursive: true });
  await assert.rejects(exportProjectDatasetAsZip(missingDatasetDirectory), /no images/);
  const dir = directory();
  await createProjectDirectory(dir, createProject('Legacy', 'character'));
  const legacy = await readManifest(dir);
  delete legacy.project.projectType;
  legacy.project.customMetadata = { preserved: true };
  await writeManifest(dir, legacy);
  const legacyBefore = JSON.stringify(await readManifest(dir));
  let prompts = 0;
  const countPrompt = async () => { prompts++; return 'style'; };
  const openedLegacy = await readProjectDirectory(dir, countPrompt);
  assert.equal(openedLegacy.projectType, 'general', 'A manifest without projectType opens as general');
  assert.equal(prompts, 0, 'A missing projectType does not prompt');
  assert.equal((await readProjectDirectory(dir)).projectType, 'general', 'No resolver is needed');
  assert.equal(JSON.stringify(await readManifest(dir)), legacyBefore, 'Opening does not rewrite the manifest');
  assert.equal((await readManifest(dir)).project.projectType, undefined);
  assert.equal(openedLegacy.targetModel, 'sdxl', 'Missing targetModel defaults to sdxl');
  assert.deepEqual((await readManifest(dir)).project.customMetadata, { preserved: true });
  // Invalid (non-missing) type strings are still rejected.
  const invalidTypeDir = directory();
  await createProjectDirectory(invalidTypeDir, createProject('Bad type', 'character'));
  const badManifest = await readManifest(invalidTypeDir);
  badManifest.project.projectType = 'invalid';
  await writeManifest(invalidTypeDir, badManifest);
  await assert.rejects(readProjectDirectory(invalidTypeDir), /Unsupported project type/);
  // targetModel round-trips and legacy Build minShortSide migrates.
  for (const model of ['sd15', 'sdxl', 'flux']) {
    const modelDir = directory();
    await createProjectDirectory(modelDir, createProject(`Model ${model}`, 'general', model));
    assert.equal((await readManifest(modelDir)).project.targetModel, model, `${model} is written to the directory manifest`);
    assert.equal((await readProjectDirectory(modelDir)).targetModel, model, `${model} round-trips through a directory`);
    const zipped = await readProjectFile(await (await createProjectFileBlob(createProject(`Zip ${model}`, 'general', model))).arrayBuffer());
    assert.equal(zipped.targetModel, model, `${model} round-trips through a zip`);
  }
  for (const [legacyMin, expected] of [[512, 'sd15'], [1024, 'sdxl'], [768, 'sdxl'], [undefined, 'sdxl']]) {
    const migDir = directory();
    await createProjectDirectory(migDir, createProject('Migrate', 'character'));
    const migManifest = await readManifest(migDir);
    delete migManifest.project.targetModel;
    migManifest.project.buildSession = { ...(migManifest.project.buildSession ?? {}), profile: { ...(migManifest.project.buildSession?.profile ?? {}), minShortSide: legacyMin } };
    await writeManifest(migDir, migManifest);
    assert.equal((await readProjectDirectory(migDir)).targetModel, expected, `legacy minShortSide ${legacyMin} -> ${expected}`);
  }
  const zip = await JSZip.loadAsync(await (await createProjectFileBlob(createProject('Legacy zip', 'character'))).arrayBuffer());
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  delete manifest.project.projectType;
  delete manifest.project.targetModel;
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('unrelated.txt', 'preserve me');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  let zipPrompts = 0;
  const openedZip = await readProjectFile(bytes, { selectProjectType: async () => { zipPrompts++; return 'concept'; } });
  assert.equal(openedZip.projectType, 'general', 'A zip without projectType opens as general without a handle');
  assert.equal(openedZip.targetModel, 'sdxl');
  assert.equal(zipPrompts, 0, 'A zip without projectType does not prompt');
  assert.equal((await readProjectFile(bytes)).projectType, 'general');
  const legacyZipManifest = JSON.parse(await zip.file('manifest.json').async('string'));
  legacyZipManifest.project.buildSession = { profile: { minShortSide: 512 } };
  zip.file('manifest.json', JSON.stringify(legacyZipManifest));
  assert.equal((await readProjectFile(await zip.generateAsync({ type: 'uint8array' }))).targetModel, 'sd15', 'Legacy 512 in a zip migrates to sd15');
  legacyZipManifest.project.projectType = 'invalid';
  zip.file('manifest.json', JSON.stringify(legacyZipManifest));
  await assert.rejects(readProjectFile(await zip.generateAsync({ type: 'uint8array' })), /Unsupported project type/);
  assert.ok(PROJECT_TYPE_PROFILES.general, 'general is a project type profile');
  assert.equal(createProject('Default type').projectType, 'general', 'general is the default type');
  assert.equal(createProject('Default model').targetModel, 'sdxl');
  await assert.rejects(resolveProjectType('invalid', 'Invalid'), /Unsupported/);
  await assert.rejects(resolveProjectType(null, 'Invalid'), /Unsupported/);
  const entitySource = await readFile('src/types/entities.ts','utf8');
  const datasetType = entitySource.match(/export interface Dataset \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(datasetType,/assetIds|assetPaths|psdAssetPaths|filePath|parentPath/,'Runtime Dataset contains settings only');
  const explorerSource = await readFile('src/components/workspace/ExplorerTree.tsx','utf8');
  assert.doesNotMatch(explorerSource,/kind:\s*'dataset'|\|\s*'dataset'/,'Explorer has no special Dataset node');
  const storeSource = await readFile('src/stores/useProjectStore.ts','utf8');
  assert.doesNotMatch(storeSource,/addAssetsToDataset:\s*\(|upsertDataset:\s*\(|removeDataset:\s*\(/,'Runtime Dataset membership API was removed');
  await assert.rejects(access('src/services/project/datasetFileService.ts'),'Dataset file runtime service must stay removed');
  // Pure helpers extracted from App: current behavior of explorer tree and Dataset board ordering.
  {
    const node = (name, kind, extra = {}) => ({ name, path: `Project/${name}`, kind, ...extra });
    assert.deepEqual(sortExplorerNodes([node('b.png', 'file'), node('z', 'folder'), node('a.png', 'file'), node('d', 'dataset'), node('a', 'folder')]).map((entry) => entry.name),
      ['a', 'z', 'd', 'a.png', 'b.png'], 'Folders come first, then dataset nodes, then files; names compare with localeCompare');
    const unsorted = [node('b', 'file'), node('a', 'file')];
    sortExplorerNodes(unsorted);
    assert.deepEqual(unsorted.map((entry) => entry.name), ['b', 'a'], 'sortExplorerNodes does not mutate its input');
    assert.deepEqual(buildEmptyExplorerTree('My'), { name: 'My', path: 'Project', kind: 'folder', children: [] });
    assert.equal(buildEmptyExplorerTree('').name, 'Project', 'An empty project name falls back to Project');
    assert.equal(sanitizeExplorerTree(null), null);
    const tree = { name: 'P', path: 'Project', kind: 'folder', children: [
      { name: 'sources', path: 'Project/sources', kind: 'folder', children: [] },
      { name: 'Sources', path: 'sources/x', kind: 'folder' },
      { name: 'dataset', path: 'Project/dataset', kind: 'folder', children: [{ name: 'a.png', path: 'Project/dataset/a.png', kind: 'file' }] },
    ] };
    const clean = sanitizeExplorerTree(tree);
    assert.deepEqual(clean.children.map((entry) => entry.path), ['Project/sources', 'sources/x', 'Project/dataset'], 'Folders named sources are ordinary user folders in a v3 project');
    assert.equal(clean.children[2].children[0].name, 'a.png');
    assert.equal(tree.children.length, 3, 'sanitizeExplorerTree does not mutate its input');
    assert.equal(sanitizeExplorerTree({ name: 'sources', path: 'Project', kind: 'folder' }).name, 'sources', 'The Project root is kept regardless of name');
    assert.equal(sanitizeExplorerTree({ name: 'f', path: 'Project/f', kind: 'file' }).children, undefined, 'Nodes without children stay without children');

    const image = (id, extra = {}) => ({ id, sourceImageId: id, kind: 'image', fileName: `${id}.png`, width: 100, height: 100, ...extra });
    const video = (name, extra = {}) => ({ id: `asset:${name}`, sourceImageId: '', kind: 'video', fileName: name, assetPath: `dataset/${name}`, width: 100, height: 100, ...extra });
    const items = [image('c'), video('b.mp4'), image('a')];
    assert.deepEqual(orderDatasetBoardItems(items, ['image:a', 'image:c'], ['a', 'c']).map((entry) => entry.id), ['a', 'c', 'asset:b.mp4'], 'Explicit order wins; items missing from it (video) are appended in input order');
    assert.deepEqual(orderDatasetBoardItems(items, ['file:dataset/b.mp4', 'image:gone', 'image:c'], ['a', 'c']).map((entry) => entry.id), ['asset:b.mp4', 'c', 'a'], 'Stale keys are ignored and a file key is honored');
    assert.deepEqual(orderDatasetBoardItems([image('a'), image('a')], ['image:a'], ['a']).map((entry) => entry.id), ['a'], 'Items sharing one key collapse to a single entry');
    assert.deepEqual(orderDatasetBoardItems([], ['image:a'], ['a']), []);
    assert.deepEqual(orderDatasetBoardItems(items, undefined, []).map((entry) => entry.id), ['asset:b.mp4', 'c', 'a'], 'Without assetIds only path-backed items are ordered; image items follow in input order');

    const sortable = [image('i10', { fileName: 'img10.png', tags: ['x'], width: 200 }), image('i2', { fileName: 'img2.png', tags: ['x', 'y'], width: 50 }), video('v.mp4', { width: 100 })];
    const names = (mode) => datasetBoardItems(sortable, {}, mode).map((entry) => entry.id);
    assert.deepEqual(names('name'), ['i2', 'i10', 'asset:v.mp4'], 'Name sort is numeric');
    assert.deepEqual(names('type'), ['i2', 'i10', 'asset:v.mp4'], 'Type sort groups image before video');
    assert.deepEqual(names('captioned'), ['i2', 'i10', 'asset:v.mp4'], 'Most tags first');
    assert.deepEqual(names('aspect'), ['i2', 'asset:v.mp4', 'i10'], 'Aspect sort is ascending width/height');
    assert.deepEqual(sortable.map((entry) => entry.id), ['i10', 'i2', 'asset:v.mp4'], 'datasetBoardItems does not mutate its input');
  }
  {
    // Folder takeover safety: real Git repositories survive clearing; version snapshots skip .git/.cache.
    const put = async (root, path, text = 'x') => {
      const parts = path.split('/'); let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await writable.write(text); await writable.close();
    };
    const names = async (root) => { const out = []; for await (const [name] of root.entries()) out.push(name); return out.sort(); };

    const gitRoot = directory();
    await put(gitRoot, '.git/HEAD', 'ref: refs/heads/main'); await put(gitRoot, '.git/objects/ab/cd', 'o');
    await put(gitRoot, 'manifest.json'); await put(gitRoot, 'dataset/a.png'); await put(gitRoot, 'keep.txt');
    assert.deepEqual(await listProjectDirectoryClearTargets(gitRoot), ['manifest.json', 'dataset'], 'A real .git is never listed for deletion');
    await clearProjectDirectory(gitRoot);
    assert.deepEqual(await names(gitRoot), ['.git', 'keep.txt'], 'Clearing keeps a real .git and unrelated files');
    const keptGit = await gitRoot.getDirectoryHandle('.git');
    await keptGit.getFileHandle('HEAD'); await (await keptGit.getDirectoryHandle('objects')).getDirectoryHandle('ab');

    const serviceGit = directory();
    await put(serviceGit, '.git/dataset-creator-versions.json'); await put(serviceGit, '.git/snapshots/v.zip'); await put(serviceGit, '.git/restore-backups/b.zip');
    await put(serviceGit, 'manifest.json');
    assert.deepEqual(await listProjectDirectoryClearTargets(serviceGit), ['manifest.json', '.git'], 'A .git with only version files is listed');
    await clearProjectDirectory(serviceGit);
    assert.deepEqual(await names(serviceGit), [], 'A .git holding only Dataset Creator version files is removed');

    const mixedGit = directory();
    await put(mixedGit, '.git/dataset-creator-versions.json'); await put(mixedGit, '.git/config');
    await clearProjectDirectory(mixedGit);
    assert.deepEqual(await names(mixedGit), ['.git'], 'Any foreign entry makes .git a real repository');

    const countRoot = directory();
    await put(countRoot, '.git/HEAD'); await put(countRoot, 'a.txt'); await put(countRoot, 'sub/b.txt'); await put(countRoot, 'sub/deep/c.txt'); await put(countRoot, 'sub/.git/d.txt');
    assert.equal(await countProjectDirectoryFiles(countRoot), 4, 'Counting skips only the root .git');
    assert.equal(await countProjectDirectoryFiles(directory()), 0);

    const verRoot = directory();
    await put(verRoot, 'manifest.json', JSON.stringify({ format: 'dataset-creator-directory', version: 2, project: { id: 'p', name: 'P' } }));
    await put(verRoot, '.dataset-creator-data/index.json', 'idx1'); await put(verRoot, '.cache/thumb.bin', 'cache'); await put(verRoot, '.git/HEAD', 'ref');
    const snap = await createProjectVersion(verRoot, 'snap');
    const zipFile = await (await (await (await verRoot.getDirectoryHandle('.datasetcreator')).getDirectoryHandle('versions')).getDirectoryHandle('snapshots')).getFileHandle(`${snap.id}.zip`);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await (await zipFile.getFile()).arrayBuffer());
    const zipNames = Object.keys(zip.files);
    assert.ok(zipNames.includes('.dataset-creator-data/index.json'), 'Snapshot contains .dataset-creator-data');
    assert.ok(!zipNames.some((n) => n.startsWith('.cache') || n.startsWith('.git')), 'Snapshot excludes .cache and .git');
    await put(verRoot, '.dataset-creator-data/index.json', 'idx2'); await put(verRoot, '.cache/other.bin', 'c2'); await put(verRoot, 'extra.txt');
    await restoreProjectVersion(verRoot, snap.id);
    const cacheDir = await verRoot.getDirectoryHandle('.cache');
    await cacheDir.getFileHandle('thumb.bin'); await cacheDir.getFileHandle('other.bin');
    await (await verRoot.getDirectoryHandle('.git')).getFileHandle('HEAD');
    assert.equal(await (await (await (await verRoot.getDirectoryHandle('.dataset-creator-data')).getFileHandle('index.json')).getFile()).text(), 'idx1', 'Restore recovers .dataset-creator-data');
    await assert.rejects(verRoot.getFileHandle('extra.txt'), 'Restore removes files absent from the snapshot');
  }
  {
    // Layout v3 migration engine: v2 (manifest.json, .cache, .git service entries) -> .datasetcreator/.
    const put = async (root, path, text = 'x') => {
      const parts = path.split('/'); let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await writable.write(text); await writable.close();
    };
    const files = async (dir, prefix = '') => {
      const out = {};
      for await (const [name, entry] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if ('getFile' in entry) out[path] = await (await entry.getFile()).text();
        else { out[`${path}/`] = ''; Object.assign(out, await files(entry, path)); }
      }
      return out;
    };
    const exists = async (root, path) => {
      const parts = path.split('/'); let dir = root;
      try {
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        try { await dir.getFileHandle(parts.at(-1)); } catch { await dir.getDirectoryHandle(parts.at(-1)); }
        return true;
      } catch { return false; }
    };
    const readJsonAt = async (root, path) => {
      const parts = path.split('/'); let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return JSON.parse(await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text());
    };
    const normalized = (tree) => Object.keys(tree)
      .map((path) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>'))
      .sort();
    const legacyManifest = (extra = {}) => JSON.stringify({
      format: 'dataset-creator-directory', version: 2,
      project: {
        id: 'p1', name: 'Old project', projectType: 'general', currentTool: 'import', workspaceSettings: {},
        taggingConfig: { datasetKeyword: 'trg', threshold: 0.3, maxTags: 10, insertMode: 'append', blacklist: [] },
        dataset: { name: 'D', triggerWord: 'trg', assetOrder: [], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
        sourceImageManifests: {}, editedAssetManifests: {},
        lastModified: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z', ...extra,
      },
    });
    const oldIndex = JSON.stringify({ format: 'dataset-creator-versions', version: 1, currentId: 'old1', versions: [{ id: 'old1', name: 'old', createdAt: '2024-01-01T00:00:00.000Z' }] });
    const makeLegacy = async ({ git = 'service', manifestExtra } = {}) => {
      const root = directory();
      await put(root, 'manifest.json', legacyManifest(manifestExtra));
      await put(root, 'inbox/a.png', 'AAA'); await put(root, 'dataset/b.png', 'BBB'); await put(root, 'dataset/b.txt', 'trg, x');
      await put(root, '.cache/previews/source/s.jpg', 'jpg');
      if (git === 'service' || git === 'real') {
        await put(root, '.git/dataset-creator-versions.json', oldIndex);
        await put(root, '.git/snapshots/old1.zip', 'zipbytes'); await put(root, '.git/restore-backups/r.zip', 'rb');
      }
      if (git === 'real') { await put(root, '.git/HEAD', 'ref: refs/heads/main'); await put(root, '.git/objects/ab/cd', 'o'); }
      if (git === 'file') await put(root, '.git', 'gitdir: /somewhere/else/.git/worktrees/w');
      return root;
    };
    const countSteps = (root, abortAt) => {
      const controller = new AbortController(); let steps = 0; let layoutSteps;
      const captionPhases = ['Rename images that share a file name', 'Update references to renamed images', 'Convert sidecar tags to text captions', 'Record the caption conversion'];
      return { signal: controller.signal, onProgress: (progress) => {
        if (progress.phase === 'Creating a safety snapshot' || progress.phase === 'Finishing old project conversions' || progress.completed >= progress.total) return;
        if (layoutSteps === undefined && captionPhases.includes(progress.phase)) layoutSteps = steps;
        steps += 1; if (steps === abortAt) controller.abort();
      }, steps: () => steps, layoutSteps: () => layoutSteps ?? steps };
    };

    // 1. Full migration of a service-only .git.
    const full = await makeLegacy();
    assert.equal(await detectProjectLayout(full), 'v2');
    const plan = await planLayoutMigration(full);
    assert.equal(plan.fromVersion, 2); assert.ok(plan.snapshotFileCount > 0); assert.ok(plan.changes.length > 0);
    assert.equal(await exists(full, '.datasetcreator/project.json'), false, 'Planning is read-only');
    const report = await runLayoutMigration(full);
    assert.equal(await detectProjectLayout(full), 'v3');
    assert.ok(report.journalId && report.snapshotVersionId && report.keptLegacyData === false);
    const json = await readJsonAt(full, '.datasetcreator/project.json');
    assert.equal(json.format, 'dataset-creator-project'); assert.equal(json.version, 3);
    assert.equal(json.project.name, 'Old project');
    assert.equal(json.project.migrations.layoutV3.id, report.journalId);
    assert.ok(json.project.migrations.layoutV3.completedAt, 'completedAt is written after the last step');
    assert.equal(await exists(full, 'manifest.json'), false);
    assert.equal(await (await (await (await (await (await full.getDirectoryHandle('.datasetcreator')).getDirectoryHandle('backup')).getDirectoryHandle(report.journalId)).getFileHandle('manifest.json')).getFile()).text().then(text => JSON.parse(text).project.id), 'p1', 'manifest.json is kept in the backup');
    assert.equal(await exists(full, '.cache'), false);
    assert.equal(await exists(full, '.datasetcreator/cache/previews/source/s.jpg'), true, '.cache moved into .datasetcreator/cache');
    assert.equal(await exists(full, '.git'), false, 'A .git holding only service entries is removed once empty');
    assert.equal(await exists(full, '.datasetcreator/versions/snapshots/old1.zip'), true);
    assert.equal(await exists(full, '.datasetcreator/backup/restore/r.zip'), true);
    const listed = await listProjectVersions(full);
    assert.ok(listed.versions.some(version => version.id === 'old1'), 'Old versions stay available in the new index');
    assert.ok(listed.versions.some(version => version.id === report.snapshotVersionId), 'The pre-migration snapshot is registered as a version');
    assert.equal(await (await (await (await full.getDirectoryHandle('dataset')).getFileHandle('b.txt')).getFile()).text(), 'trg, x', 'User files are untouched');
    assert.equal((await readProjectDirectory(full)).name, 'Old project', 'The migrated project opens through the v3 reader');
    assert.equal(await getProjectVersionLayout(full, report.snapshotVersionId), 'legacy', 'The pre-migration snapshot is a legacy snapshot');

    // 2. A second run changes nothing.
    const before = await files(full);
    const again = await runLayoutMigration(full);
    assert.deepEqual(again.resumed, []); assert.equal(again.journalId, undefined);
    assert.deepEqual(await files(full), before, 'Re-running the migration on a v3 project changes nothing');
    assert.deepEqual(await resumePendingJournals(full), []);

    // 3. Real .git keeps HEAD and objects; its service entries move out.
    const real = await makeLegacy({ git: 'real' });
    await runLayoutMigration(real);
    assert.equal(await (await (await (await real.getDirectoryHandle('.git')).getFileHandle('HEAD')).getFile()).text(), 'ref: refs/heads/main');
    assert.equal(await exists(real, '.git/objects/ab/cd'), true);
    for (const name of ['dataset-creator-versions.json', 'snapshots', 'restore-backups']) assert.equal(await exists(real, `.git/${name}`), false, `${name} leaves .git`);
    assert.equal(await exists(real, '.datasetcreator/versions/snapshots/old1.zip'), true);
    assert.equal(await detectProjectLayout(real), 'v3');

    // 4. A gitfile is never touched, and versions work with it.
    const gitFile = await makeLegacy({ git: 'file' });
    const gitFileText = 'gitdir: /somewhere/else/.git/worktrees/w';
    const gitFilePlan = await planLayoutMigration(gitFile);
    assert.ok(gitFilePlan.changes.some(change => /left untouched/.test(change)));
    const gitFileReport = await runLayoutMigration(gitFile);
    assert.equal(await (await (await gitFile.getFileHandle('.git')).getFile()).text(), gitFileText, 'A .git file is left as is');
    assert.equal(await detectProjectLayout(gitFile), 'v3');
    const gitFileVersion = await createProjectVersion(gitFile, 'with gitfile');
    await put(gitFile, 'dataset/later.png', 'later');
    await restoreProjectVersion(gitFile, gitFileVersion.id);
    assert.equal(await exists(gitFile, 'dataset/later.png'), false, 'Restore works next to a gitfile');
    assert.equal(await (await (await gitFile.getFileHandle('.git')).getFile()).text(), gitFileText, 'Versions never touch the gitfile');
    assert.ok((await listProjectVersions(gitFile)).versions.some(version => version.id === gitFileReport.snapshotVersionId));
    const gitFileNew = directory();
    await put(gitFileNew, '.git', gitFileText);
    await readProjectDirectory(gitFileNew, async () => 'general');
    assert.equal(await (await (await gitFileNew.getFileHandle('.git')).getFile()).text(), gitFileText, 'Creating a project next to a gitfile does not fail or change it');
    assert.equal(await exists(gitFileNew, '.datasetcreator/project.json'), true);

    // 5. Abort after N steps, then resume: same result as an uninterrupted run.
    const reference = await makeLegacy();
    const referenceRun = countSteps(reference, 0);
    await runLayoutMigration(reference, { signal: referenceRun.signal, onProgress: referenceRun.onProgress });
    const stepCount = referenceRun.steps();
    const layoutStepCount = referenceRun.layoutSteps();
    assert.ok(layoutStepCount < stepCount, 'The caption conversion runs after the layout upgrade');
    assert.ok(stepCount >= 4);
    const referenceTree = normalized(await files(reference));
    for (let abortAt = 1; abortAt < stepCount; abortAt++) {
      const interrupted = await makeLegacy();
      const tracker = countSteps(interrupted, abortAt);
      await assert.rejects(runLayoutMigration(interrupted, { signal: tracker.signal, onProgress: tracker.onProgress }), { name: 'AbortError' }, `abort at step ${abortAt}`);
      if (abortAt < layoutStepCount && await exists(interrupted, '.datasetcreator/project.json')) {
        assert.equal((await readJsonAt(interrupted, '.datasetcreator/project.json')).project.migrations.layoutV3.completedAt, undefined, `completedAt is absent after abort at step ${abortAt}`);
      }
      const resumedIds = await resumePendingJournals(interrupted);
      // Aborting right after the last layout step leaves no journal: the caption conversion has not started yet and simply runs next.
      assert.equal(resumedIds.length, abortAt === layoutStepCount ? 0 : 1, `journal is resumed after abort at step ${abortAt}`);
      await runCaptionTxtMigration(interrupted); // Opening a v3 project resumes journals, then converts captions that are still pending.
      assert.deepEqual(normalized(await files(interrupted)), referenceTree, `resume after abort at step ${abortAt} reaches the same layout`);
      assert.ok((await readJsonAt(interrupted, '.datasetcreator/project.json')).project.migrations.layoutV3.completedAt, 'completedAt appears after the resumed run');
      assert.deepEqual(await resumePendingJournals(interrupted), [], 'A finished journal is not resumed again');
      const manifestBackups = normalized(await files(interrupted)).filter(path => /backup\/<id>\/manifest\.json$/.test(path));
      assert.equal(manifestBackups.length, 1, 'manifest.json is backed up exactly once');
    }
    // runLayoutMigration itself finishes an interrupted upgrade first.
    const viaRun = await makeLegacy();
    const viaTracker = countSteps(viaRun, 2);
    await assert.rejects(runLayoutMigration(viaRun, { signal: viaTracker.signal, onProgress: viaTracker.onProgress }), { name: 'AbortError' });
    const viaResult = await runLayoutMigration(viaRun);
    assert.equal(viaResult.resumed.length, 1);
    await runCaptionTxtMigration(viaRun);
    assert.deepEqual(normalized(await files(viaRun)), referenceTree);

    // 6. A failed safety snapshot leaves the project untouched.
    const failing = await makeLegacy();
    const failingBefore = await files(failing);
    const originalGetDirectory = failing.getDirectoryHandle.bind(failing);
    failing.getDirectoryHandle = async (name, options) => {
      if (name === '.datasetcreator' && options?.create) throw new Error('disk full');
      return originalGetDirectory(name, options);
    };
    await assert.rejects(runLayoutMigration(failing), error => error instanceof LayoutMigrationError && error.kind === 'snapshot-failed' && /not changed/.test(error.message));
    failing.getDirectoryHandle = originalGetDirectory;
    assert.deepEqual(await files(failing), failingBefore, 'Nothing changes when the snapshot cannot be written');
    assert.equal(await detectProjectLayout(failing), 'v2');

    // 7. Unresolved legacy caption data blocks the upgrade before any v3 step.
    const blocked = await makeLegacy({ manifestExtra: { captionMigration: {
      version: 1, status: 'pending', overwriteEnabled: true, legacyOverrides: { 'image:ghost': ['x'] },
      assetSnapshots: {}, applied: [], unresolved: ['image:ghost'], unavailable: [], conflicts: [],
    } } });
    await assert.rejects(runLayoutMigration(blocked), error => error instanceof LayoutMigrationError && error.kind === 'blocked');
    assert.equal(await detectProjectLayout(blocked), 'v2', 'A blocked upgrade stays in the old layout');
    assert.equal(await exists(blocked, '.datasetcreator/project.json'), false);
    assert.equal(await exists(blocked, '.datasetcreator/journal'), false, 'No journal is written for a blocked upgrade');
    assert.equal(await exists(blocked, 'manifest.json'), true);
    assert.equal(await exists(blocked, '.cache/previews/source/s.jpg'), true);
    assert.equal(await exists(blocked, '.git/snapshots/old1.zip'), true);
    assert.equal(await exists(blocked, '.datasetcreator/backup'), false);

    // 8. Snapshots skip service folders and .git; restore never touches them.
    const markers = ['.datasetcreator/cache/c.bin', '.datasetcreator/journal/j.json', '.datasetcreator/backup/keep/b.bin'];
    for (const marker of markers) await put(full, marker, 'marker');
    const snap = await createProjectVersion(full, 'marked');
    const snapZip = await JSZip.loadAsync(await (await (await (await (await (await full.getDirectoryHandle('.datasetcreator')).getDirectoryHandle('versions')).getDirectoryHandle('snapshots')).getFileHandle(`${snap.id}.zip`)).getFile()).arrayBuffer());
    const snapNames = Object.keys(snapZip.files);
    assert.ok(snapNames.includes('.datasetcreator/project.json'), 'Snapshot holds project.json');
    assert.ok(!snapNames.some(name => /^\.datasetcreator\/(cache|journal|versions|backup)(\/|$)/.test(name) || name.split('/')[0] === '.git'), 'Snapshot excludes service folders and .git');
    await put(full, '.datasetcreator/cache/c.bin', 'changed'); await put(full, 'extra.txt', 'removed by restore');
    const versionsBefore = JSON.stringify((await listProjectVersions(full)).versions.map(version => version.id));
    await restoreProjectVersion(full, snap.id);
    assert.equal(await exists(full, 'extra.txt'), false);
    assert.equal(await (await (await (await (await full.getDirectoryHandle('.datasetcreator')).getDirectoryHandle('cache')).getFileHandle('c.bin')).getFile()).text(), 'changed', 'Restore keeps the cache as is');
    for (const marker of markers.slice(1)) assert.equal(await exists(full, marker), true, `${marker} survives restore`);
    assert.equal(await exists(full, '.datasetcreator/versions/snapshots/old1.zip'), true);
    assert.equal(await exists(full, `.datasetcreator/backup/${report.journalId}/manifest.json`), true, 'Migration backups survive restore');
    assert.equal(await exists(full, '.datasetcreator/project.json'), true);
    assert.deepEqual((await listProjectVersions(full)).versions.map(version => version.id).filter(id => JSON.parse(versionsBefore).includes(id)), JSON.parse(versionsBefore));
    // Snapshot ZIPs that contain service paths are rejected before anything is deleted.
    for (const entryName of ['.datasetcreator/cache/x.bin', '.datasetcreator/journal/x.json', '.datasetcreator/versions/index.json', '.datasetcreator/backup/x', '.git/HEAD']) {
      const bad = new JSZip(); bad.file('.datasetcreator/project.json', JSON.stringify(json)); bad.file(entryName, 'bad');
      await put(full, `.datasetcreator/versions/snapshots/${snap.id}.zip`, await bad.generateAsync({ type: 'blob' }));
      await assert.rejects(restoreProjectVersion(full, snap.id), /invalid project path/, entryName);
      assert.equal(await exists(full, 'dataset/b.txt'), true, `${entryName} is rejected before files are deleted`);
    }

    // 9. Restoring the pre-migration (legacy) snapshot brings back v2, which migrates again.
    const roundTrip = await makeLegacy();
    const first = await runLayoutMigration(roundTrip);
    await put(roundTrip, 'dataset/after.png', 'after');
    await restoreProjectVersion(roundTrip, first.snapshotVersionId);
    assert.equal(await detectProjectLayout(roundTrip), 'v2', 'A legacy snapshot restores the old layout');
    assert.equal(await exists(roundTrip, 'dataset/after.png'), false);
    assert.equal(await exists(roundTrip, `.datasetcreator/backup/${first.journalId}/manifest.json`), true, 'Backups survive the legacy restore');
    // Re-upgrading right after the restore (same second) must not collide with the earlier snapshot name.
    const second = await runLayoutMigration(roundTrip);
    assert.notEqual(second.journalId, first.journalId);
    assert.equal(await detectProjectLayout(roundTrip), 'v3');
    assert.ok((await readJsonAt(roundTrip, '.datasetcreator/project.json')).project.migrations.layoutV3.completedAt);
    assert.equal(await exists(roundTrip, 'manifest.json'), false);
    assert.equal((await readProjectDirectory(roundTrip)).name, 'Old project');

    // 10. Old ZIPs carrying .cache entries do not recreate the old cache on restore.
    const oldZip = new JSZip(); oldZip.file('manifest.json', legacyManifest()); oldZip.file('.cache/old.bin', 'stale'); oldZip.file('dataset/z.png', 'z');
    await put(roundTrip, `.datasetcreator/versions/snapshots/${first.snapshotVersionId}.zip`, await oldZip.generateAsync({ type: 'blob' }));
    await restoreProjectVersion(roundTrip, first.snapshotVersionId);
    assert.equal(await exists(roundTrip, '.cache'), false, 'Preserved root names in old ZIPs are not applied');
    assert.equal(await exists(roundTrip, 'dataset/z.png'), true);

    // 11. Raw materials move from src/shared and src/assets to inbox and inbox/edits (v3 project with legacy src).
    const readAt = async (root, path) => {
      const parts = path.split('/'); let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    };
    const makeRaw = async () => {
      const root = directory();
      const project = createProject('Raw move', 'character');
      await createProjectDirectory(root, project);
      await put(root, 'src/shared/a.png', 'AAA');
      await put(root, 'src/shared/a.png.manifest.json', JSON.stringify({ originalFilePath: 'src/shared/a.png', tags: ['t'] }));
      await put(root, 'src/shared/a.txt', 'caption a');
      await put(root, 'src/shared/sub/deep.png', 'DEEP');
      await put(root, 'src/assets/e.png', 'EEE');
      await put(root, 'src/assets/e.png.manifest.json', JSON.stringify({ imageDataPath: 'src/assets/e.png', originalFilePath: 'src/shared/a.png' }));
      await put(root, 'src/assets/e.psd', 'PSD');
      await put(root, 'dataset/d.png', 'DDD');
      await put(root, 'dataset/d.png.manifest.json', JSON.stringify({ originalFilePath: 'src/shared/a.png', imageDataPath: 'dataset/d.png' }));
      const json = await readJsonAt(root, '.datasetcreator/project.json');
      json.project.buildSession = { ...json.project.buildSession, records: { 'source:a': { assetId: 'source:a', locator: 'Project/src/shared/a.png', decision: 'accepted', application: 'applied', validation: 'valid', revision: 'r1', acceptedRevision: 'r1', provenance: 'manual', updatedAt: '2026-10-21T00:00:00.000Z' } } };
      json.project.sourceImageManifests = { 's1': 'src/shared/a.png.manifest.json' };
      json.project.editedAssetManifests = { 'e1': 'src/assets/e.png.manifest.json' };
      json.project.dataset = { ...json.project.dataset, assetOrder: ['file:Project/src/shared/sub/deep.png', 'file:src/assets/e.psd', 'image:s1'] };
      json.project.workspaceSettings = { ...json.project.workspaceSettings, excludedProjectCategories: ['src/shared/sub'], includedProjectCategories: ['Project/src/assets'] };
      await put(root, '.datasetcreator/project.json', JSON.stringify(json, null, 2));
      return root;
    };

    const raw = await makeRaw();
    assert.equal(await detectProjectLayout(raw), 'v3');
    assert.equal(await detectLegacyRawLayout(raw), true, 'A v3 project with src/shared is detected');
    const rawPlan = await planRawMaterialsMove(raw);
    assert.equal(rawPlan.fileCount, 7, 'The plan counts every file under src/shared and src/assets');
    assert.deepEqual(rawPlan.folders, ['src/shared -> inbox', 'src/assets -> inbox/edits']);
    assert.ok(rawPlan.bytes > 0);
    assert.equal(await exists(raw, 'inbox/a.png'), false, 'Planning is read-only');
    const rawReport = await runRawMaterialsMove(raw);
    assert.ok(rawReport.journalId);
    assert.deepEqual(rawReport.collisions, []);
    assert.equal(await readAt(raw, 'inbox/a.png'), 'AAA');
    assert.equal(await readAt(raw, 'inbox/a.txt'), 'caption a', 'The caption .txt travels with its file');
    assert.equal(await readAt(raw, 'inbox/sub/deep.png'), 'DEEP');
    assert.equal(await readAt(raw, 'inbox/edits/e.png'), 'EEE');
    assert.equal(await readAt(raw, 'inbox/edits/e.psd'), 'PSD');
    assert.equal(await exists(raw, 'src'), false, 'Empty src/shared, src/assets and src are removed');
    assert.equal(await detectLegacyRawLayout(raw), false);
    assert.equal((await readJsonAt(raw, 'inbox/a.png.manifest.json')).originalFilePath, 'inbox/a.png', 'Sidecar paths are rewritten');
    assert.equal((await readJsonAt(raw, 'inbox/edits/e.png.manifest.json')).imageDataPath, 'inbox/edits/e.png');
    assert.equal((await readJsonAt(raw, 'inbox/edits/e.png.manifest.json')).originalFilePath, 'inbox/a.png');
    assert.equal((await readJsonAt(raw, 'dataset/d.png.manifest.json')).originalFilePath, 'inbox/a.png', 'Dataset sidecars that point at moved files are rewritten');
    const rawJson = await readJsonAt(raw, '.datasetcreator/project.json');
    assert.equal(rawJson.project.buildSession.records['source:a'].locator, 'Project/inbox/a.png', 'buildSession locators are rewritten');
    assert.equal(rawJson.project.sourceImageManifests.s1, 'inbox/a.png.manifest.json');
    assert.equal(rawJson.project.editedAssetManifests.e1, 'inbox/edits/e.png.manifest.json');
    assert.deepEqual(rawJson.project.dataset.assetOrder, ['file:Project/inbox/sub/deep.png', 'file:inbox/edits/e.psd', 'image:s1'], 'file: asset keys are rewritten, others kept');
    assert.deepEqual(rawJson.project.workspaceSettings.excludedProjectCategories, ['inbox/sub']);
    assert.deepEqual(rawJson.project.workspaceSettings.includedProjectCategories, ['Project/inbox/edits']);
    assert.equal(await readAt(raw, 'dataset/d.png'), 'DDD', 'Dataset files are untouched');
    // A second run changes nothing.
    const rawDone = await files(raw);
    assert.equal(await runRawMaterialsMove(raw), undefined, 'Nothing to move on a project without legacy src');
    assert.deepEqual(await files(raw), rawDone, 'Re-running changes nothing');

    // Name collisions are renamed and reported; folders merge into existing ones.
    const clash = await makeRaw();
    await put(clash, 'inbox/a.png', 'EXISTING-A');
    await put(clash, 'inbox/sub/other.png', 'OTHER');
    const clashReport = await runRawMaterialsMove(clash);
    assert.equal(await readAt(clash, 'inbox/a.png'), 'EXISTING-A', 'An existing destination file is never overwritten');
    assert.ok(clashReport.collisions.length >= 1 && clashReport.collisions.some(entry => entry.from === 'src/shared/a.png' && entry.to === 'inbox/a 2.png'), `Collision is reported: ${JSON.stringify(clashReport.collisions)}`);
    assert.equal(await readAt(clash, 'inbox/a 2.png'), 'AAA');
    assert.equal(await exists(clash, 'inbox/a 2.png.manifest.json'), true, 'The sidecar follows the renamed file');
    assert.equal(await readAt(clash, 'inbox/sub/deep.png'), 'DEEP', 'A folder merges into an existing folder');
    assert.equal(await readAt(clash, 'inbox/sub/other.png'), 'OTHER');
    assert.equal(await exists(clash, 'src'), false);
    const clashJson = await readJsonAt(clash, '.datasetcreator/project.json');
    assert.equal(clashJson.project.buildSession.records['source:a'].locator, 'Project/inbox/a 2.png', 'References follow the renamed file');
    assert.equal(clashJson.project.sourceImageManifests.s1, 'inbox/a 2.png.manifest.json');
    assert.equal((await readJsonAt(clash, 'inbox/a 2.png.manifest.json')).originalFilePath, 'inbox/a 2.png');
    assert.equal((await readJsonAt(clash, 'dataset/d.png.manifest.json')).originalFilePath, 'inbox/a 2.png');

    // Non-empty leftovers survive: only empty src folders are removed.
    const leftover = await makeRaw();
    await put(leftover, 'src/notes/keep.txt', 'user notes');
    await runRawMaterialsMove(leftover);
    assert.equal(await readAt(leftover, 'src/notes/keep.txt'), 'user notes', 'A non-empty src folder is kept');
    assert.equal(await exists(leftover, 'src/shared'), false);
    assert.equal(await exists(leftover, 'src/assets'), false);
    assert.equal(await readAt(leftover, 'inbox/a.png'), 'AAA');

    // Abort after N steps, then resume: same result as an uninterrupted run (also with a collision).
    for (const withClash of [false, true]) {
      const build = async () => { const root = await makeRaw(); if (withClash) await put(root, 'inbox/a.png', 'EXISTING-A'); return root; };
      const rawRef = await build();
      const rawRefRun = countSteps(rawRef, 0);
      await runRawMaterialsMove(rawRef, { signal: rawRefRun.signal, onProgress: rawRefRun.onProgress });
      const rawSteps = rawRefRun.steps();
      assert.ok(rawSteps >= 4);
      const rawRefTree = await files(rawRef);
      const stable = (tree) => {
        const out = Object.fromEntries(Object.entries(tree).filter(([path]) => !path.startsWith('.datasetcreator/journal/') && path !== '.datasetcreator/project.json'));
        const project = JSON.parse(tree['.datasetcreator/project.json']).project;
        out.references = JSON.stringify([project.buildSession.records, project.sourceImageManifests, project.editedAssetManifests, project.dataset.assetOrder, project.workspaceSettings.excludedProjectCategories, project.workspaceSettings.includedProjectCategories]);
        return out;
      };
      for (let abortAt = 1; abortAt < rawSteps; abortAt++) {
        const interrupted = await build();
        const tracker = countSteps(interrupted, abortAt);
        await assert.rejects(runRawMaterialsMove(interrupted, { signal: tracker.signal, onProgress: tracker.onProgress }), { name: 'AbortError' }, `raw abort at step ${abortAt}`);
        const resumedIds = await resumePendingJournals(interrupted);
        assert.equal(resumedIds.length, 1, `raw journal is resumed after abort at step ${abortAt}`);
        assert.deepEqual(stable(await files(interrupted)), stable(rawRefTree), `raw resume after abort at step ${abortAt} reaches the same result (clash=${withClash})`);
        assert.deepEqual(await resumePendingJournals(interrupted), [], 'A finished raw journal is not resumed again');
        assert.equal(await detectLegacyRawLayout(interrupted), false);
      }
    }

    // Full v2 -> v3 migration now ends with inbox/ and no src/.
    const legacyFull = await makeLegacy();
    await put(legacyFull, 'src/assets/edit.png', 'EDIT');
    const legacyReport = await runLayoutMigration(legacyFull);
    assert.equal(await detectProjectLayout(legacyFull), 'v3');
    assert.ok(legacyReport.rawMaterials, 'The v2 upgrade reports the raw materials move');
    assert.equal(await readAt(legacyFull, 'inbox/a.png'), 'AAA');
    assert.equal(await readAt(legacyFull, 'inbox/edits/edit.png'), 'EDIT');
    assert.equal(await exists(legacyFull, 'src'), false, 'No src folder remains after the v2 upgrade');
    assert.equal(await readAt(legacyFull, 'dataset/b.txt'), 'trg, x');
    assert.equal(await detectLegacyRawLayout(legacyFull), false);
  }
  console.log('PASS: project types, global Dataset migration, required layout repair, whole-project indexing, dataset ZIP export, version branches/restoration, and legacy project migration.');
} finally { await rm(temp, { recursive: true, force: true }); }
