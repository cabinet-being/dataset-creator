import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';
import JSZip from 'jszip';

const temp = await mkdtemp(join(tmpdir(), 'project-types-'));
try {
  await build({ input: ['src/lib/datasetAssets.ts', 'src/services/project/explorerFileService.ts', 'src/types/index.ts', 'src/lib/projectProfiles.ts', 'src/lib/workspaceFileAssets.ts', 'src/services/project/projectDirectoryService.ts', 'src/services/project/projectFileService.ts', 'src/services/project/projectLayoutService.ts', 'src/services/project/projectVersionService.ts', 'src/services/project/assetIndexService.ts', 'src/services/export/datasetExportService.ts', 'src/stores/useProjectStore.ts'], platform: 'node', output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' } });
  const { getUniqueExplorerName, deleteExplorerEntry, renameExplorerEntry, copyExplorerEntry, moveExplorerEntries, copyExplorerEntries, duplicateExplorerEntries, ExplorerBatchError } = await import(pathToFileURL(join(temp, 'explorerFileService.mjs')));
  const { createProject, createSourceImage, createEditedAsset } = await import(pathToFileURL(join(temp, 'index.mjs')));
  const { resolveProjectType, PROJECT_TYPE_PROFILES } = await import(pathToFileURL(join(temp, 'projectProfiles.mjs')));
  const { createProjectDirectory, readProjectDirectory, writeProjectDirectoryChanges } = await import(pathToFileURL(join(temp, 'projectDirectoryService.mjs')));
  const { createProjectFileBlob, readProjectFile } = await import(pathToFileURL(join(temp, 'projectFileService.mjs')));
  const { useProjectStore } = await import(pathToFileURL(join(temp, 'useProjectStore.mjs')));
  const { DATASET_MANIFEST_FILE, REQUIRED_PROJECT_DIRECTORIES, readDatasetManifest } = await import(pathToFileURL(join(temp, 'projectLayoutService.mjs')));
  const { createProjectVersion, restoreProjectVersion, listProjectVersions, ProjectVersionRestoreError } = await import(pathToFileURL(join(temp, 'projectVersionService.mjs')));
  const { exportProjectDatasetAsZip } = await import(pathToFileURL(join(temp, 'datasetExportService.mjs')));
  const { indexProjectAssets } = await import(pathToFileURL(join(temp, 'assetIndexService.mjs')));
  const { collectWorkspaceFileAssets } = await import(pathToFileURL(join(temp, 'workspaceFileAssets.mjs')));
  // In-memory File System Access handles exercise the real directory serializer and reader.
  function directory(name = 'test') {
    const entries = new Map();
    return {
      name, entries: async function* () { yield* entries; },
      async getDirectoryHandle(name, options) {
        if (!entries.has(name) && options?.create) entries.set(name, directory(name));
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        return entries.get(name);
      },
      async getFileHandle(name, options) {
        if (!entries.has(name) && options?.create) {
          let contents = '';
          entries.set(name, { name, getFile: async () => new File([contents], name), createWritable: async () => ({ write: async (data) => { contents = data; }, close: async () => {} }) });
        }
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        return entries.get(name);
      },
      async removeEntry(name) { entries.delete(name); },
    };
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
      originalFilePath:'src/shared/original.png',manifestPath:'src/shared/original.png.manifest.json',tags:['source tag']};
    const edited = {...createEditedAsset(source.id,new Blob(['edited pixels'],{type:'image/png'}),32,24),
      imageDataPath:'src/assets/edited.png',manifestPath:'src/assets/edited.png.manifest.json',
      psdData:new Blob(['PSD layers']),psdDataPath:'src/assets/edited.psd'};
    const base = createProject('Move original','character');
    const before = {...base,sourceImages:{[source.id]:source},datasetItems:{[edited.id]:edited},
      dataset:{...base.dataset,assetIds:[source.id],assetOrder:[`image:${source.id}`],captionOverrides:{[`source:${source.id}`]:['keep caption']}}};
    await createProjectDirectory(root,before);
    await root.getDirectoryHandle('Archive',{create:true});
    let moved;
    await moveExplorerEntries(root,[{kind:'file',name:'original.png',path:'Project/src/shared/original.png'}],'Project/Archive',change => {
      moved = {...source,originalFilePath:applyProjectRelativePathMoves(source.originalFilePath,[change]),manifestPath:applyProjectRelativePathMoves(source.manifestPath,[change],true)};
    });
    const after = {...before,sourceImages:{[source.id]:moved}};
    await writeProjectDirectoryChanges(after,before,root);
    const reopened = await readProjectDirectory(root);
    assert.equal(reopened.sourceImages[source.id].originalFilePath,'Archive/original.png');
    assert.equal(reopened.sourceImages[source.id].manifestPath,'Archive/original.png.manifest.json');
    assert.equal(await reopened.sourceImages[source.id].originalFile.text(),'source pixels');
    assert.deepEqual(reopened.sourceImages[source.id].tags,['source tag']);
    assert.deepEqual(reopened.dataset.assetIds,before.dataset.assetIds);
    assert.deepEqual(reopened.dataset.assetOrder,before.dataset.assetOrder);
    assert.deepEqual(reopened.dataset.captionOverrides,before.dataset.captionOverrides);
    assert.equal(reopened.datasetItems[edited.id].sourceImageId,source.id);
    assert.equal(await reopened.datasetItems[edited.id].imageData.text(),'edited pixels');
    assert.equal(await reopened.datasetItems[edited.id].psdData.text(),'PSD layers');
    assert.equal((await indexProjectAssets(root)).discoveredCount,0,'Moving a registered source does not enable discovery of arbitrary files outside shared');
    let returned;
    await moveExplorerEntries(root,[{kind:'file',name:'original.png',path:'Project/Archive/original.png'}],'Project/src/shared',change => {
      returned = {...reopened.sourceImages[source.id],originalFilePath:applyProjectRelativePathMoves(moved.originalFilePath,[change]),manifestPath:applyProjectRelativePathMoves(moved.manifestPath,[change],true)};
    });
    const restored = {...reopened,sourceImages:{[source.id]:returned}};
    await writeProjectDirectoryChanges(restored,reopened,root);
    const final = await readProjectDirectory(root);
    assert.equal(final.sourceImages[source.id].originalFilePath,source.originalFilePath);
    assert.equal(await final.datasetItems[edited.id].psdData.text(),'PSD layers');
    assert.deepEqual(final.dataset.assetIds,[source.id]);
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
    const manifest = await root.getFileHandle('manifest.json');
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
      assert.deepEqual(reopened.sourceImages[source.id].tags,['after']);
      assert.equal(await reopened.sourceImages[source.id].originalFile.text(),await source.originalFile.text());
    }
  }
  const readManifest = async (dir) => JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  const writeManifest = async (dir, manifest) => {
    const stream = await (await dir.getFileHandle('manifest.json')).createWritable();
    await stream.write(JSON.stringify(manifest)); await stream.close();
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
    assert.equal(project.taggingConfig.datasetKeyword, PROJECT_TYPE_PROFILES[type].defaults.datasetKeyword);
    assert.equal(PROJECT_TYPE_PROFILES[type].enabledTools.length, 8);
    assert.ok(PROJECT_TYPE_PROFILES[type].enabledTools.includes('video'));
    const dir = directory();
    await createProjectDirectory(dir, project);
    assert.equal((await readManifest(dir)).project.projectType, type);
    assert.equal((await readProjectDirectory(dir)).projectType, type);
    const blob = await createProjectFileBlob(project);
    const bytes = await blob.arrayBuffer(); // JSZip's Node adapter accepts buffers, browser adapter accepts Files.
    const zip = await JSZip.loadAsync(bytes);
    assert.equal(JSON.parse(await zip.file('manifest.json').async('string')).project.projectType, type);
    assert.equal((await readProjectFile(bytes)).projectType, type);
  }
  const layoutProject = createProject('Structured project', 'character');
  layoutProject.taggingConfig.datasetKeyword = 'trigger';
  layoutProject.dataset.triggerWord = 'trigger';
  const layoutDirectory = directory();
  await createProjectDirectory(layoutDirectory, layoutProject);
  for (const path of REQUIRED_PROJECT_DIRECTORIES) {
    let current = layoutDirectory;
    for (const part of path.split('/')) current = await current.getDirectoryHandle(part);
    assert.ok(current);
  }
  assert.equal((await readDatasetManifest(layoutDirectory)).triggerWord, 'trigger');
  assert.equal((await readDatasetManifest(layoutDirectory)).version, 3);
  const globalDatasetZip = await JSZip.loadAsync(await (await createProjectFileBlob(layoutProject)).arrayBuffer());
  assert.equal(JSON.parse(await globalDatasetZip.file('manifest.json').async('string')).project.datasets, undefined);
  assert.equal(JSON.parse(await globalDatasetZip.file('dataset.json').async('string')).version, 3);
  assert.equal(JSON.parse(await globalDatasetZip.file('dataset.json').async('string')).triggerWord, 'trigger');
  const migrationDirectory = directory();
  await createProjectDirectory(migrationDirectory, createProject('Dataset migration', 'character'));
  const migrationDatasetDirectory = await migrationDirectory.getDirectoryHandle('dataset');
  const migrationImageWriter = await (await migrationDatasetDirectory.getFileHandle('legacy.png', { create: true })).createWritable();
  await migrationImageWriter.write(new Blob(['png'], { type: 'image/png' })); await migrationImageWriter.close();
  const legacyDatasetWriter = await (await migrationDatasetDirectory.getFileHandle('ignored.dataset.json', { create: true })).createWritable();
  await legacyDatasetWriter.write(JSON.stringify({ name: 'Ignored legacy Dataset' })); await legacyDatasetWriter.close();
  const rootDatasetWriter = await (await migrationDirectory.getFileHandle(DATASET_MANIFEST_FILE)).createWritable();
  await rootDatasetWriter.write(JSON.stringify({
    format: 'dataset-creator-dataset', version: 2, name: 'Legacy Dataset', projectType: 'character',
    description: '', triggerWord: 'legacy', imageCount: 0, classCount: 0, classRepeats: {}, updatedAt: new Date().toISOString(),
  })); await rootDatasetWriter.close();
  const migratedProject = await readProjectDirectory(migrationDirectory);
  const migratedDataset = await readDatasetManifest(migrationDirectory);
  assert.equal(migratedDataset.version, 3);
  assert.deepEqual(migratedDataset.assetPaths, ['Project/dataset/legacy.png']);
  assert.equal(migratedProject.dataset.name, 'Legacy Dataset');
  assert.deepEqual(migratedProject.dataset.assetPaths, ['Project/dataset/legacy.png']);
  await layoutDirectory.removeEntry('dataset', { recursive: true });
  await (await layoutDirectory.getDirectoryHandle('src')).removeEntry('assets', { recursive: true });
  await layoutDirectory.removeEntry(DATASET_MANIFEST_FILE);
  await readProjectDirectory(layoutDirectory);
  assert.ok(await layoutDirectory.getDirectoryHandle('dataset'));
  assert.ok(await (await layoutDirectory.getDirectoryHandle('src')).getDirectoryHandle('assets'));
  assert.ok(await layoutDirectory.getFileHandle(DATASET_MANIFEST_FILE));
  const datasetDirectory = await layoutDirectory.getDirectoryHandle('dataset');
  const classDirectory = await datasetDirectory.getDirectoryHandle('3_character', { create: true });
  const imageWritable = await (await classDirectory.getFileHandle('portrait.png', { create: true })).createWritable();
  await imageWritable.write(new Blob(['png'], { type: 'image/png' })); await imageWritable.close();
  const metadataWritable = await (await classDirectory.getFileHandle('portrait.png.manifest.json', { create: true })).createWritable();
  await metadataWritable.write(JSON.stringify({ tags: ['portrait', 'blue hair'] })); await metadataWritable.close();
  const { blob: exportedDataset, count: exportedCount } = await exportProjectDatasetAsZip(layoutDirectory);
  assert.equal(exportedCount, 1);
  const datasetZip = await JSZip.loadAsync(await exportedDataset.arrayBuffer());
  assert.ok(datasetZip.file('3_character/1.png'));
  assert.equal(await datasetZip.file('3_character/1.txt').async('string'), 'trigger, portrait, blue hair\n');
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
  const getLayoutFile = layoutDirectory.getFileHandle;
  let failRestoreWrite = true;
  layoutDirectory.getFileHandle = async (name,options) => {
    if(name==='manifest.json' && options?.create && failRestoreWrite) {failRestoreWrite=false; throw new Error('Write denied once');}
    return getLayoutFile(name,options);
  };
  await assert.rejects(restoreProjectVersion(layoutDirectory,versionOne.id),error=>error instanceof ProjectVersionRestoreError && error.previousRestored);
  layoutDirectory.getFileHandle = getLayoutFile;
  assert.equal(await (await (await layoutDirectory.getFileHandle('current-only.txt')).getFile()).text(),'unsnapshotted current files','A failed restore rolls back current files, including those outside versions');
  assert.ok(await layoutDirectory.getDirectoryHandle('empty-user-folder'),'Rollback retains empty folders');
  assert.equal((await listProjectVersions(layoutDirectory)).currentId,versionThree.id,'Failed restore cannot advance the version pointer');
  await assert.rejects(restoreProjectVersion(layoutDirectory,versionOne.id,async()=>{throw new Error('Restored project cannot open');}),error=>error.previousRestored && /cannot open/.test(error.message));
  assert.ok(await layoutDirectory.getFileHandle('current-only.txt'),'Read validation failure also rolls back before exposing the restored project');
  const snapshots = await (await layoutDirectory.getDirectoryHandle('.git')).getDirectoryHandle('snapshots');
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
  const getBrokenFile=brokenDirectory.getFileHandle;
  brokenDirectory.getFileHandle=async(name,options)=>{
    if(name==='manifest.json' && options?.create) throw new Error('Persistent denial');
    return getBrokenFile(name,options);
  };
  let recoveryPath;
  await assert.rejects(restoreProjectVersion(brokenDirectory,brokenVersion.id),error=>{
    recoveryPath=error.recoveryPath; return error instanceof ProjectVersionRestoreError && !error.previousRestored && Boolean(recoveryPath);
  });
  const recoveryFolder=await (await brokenDirectory.getDirectoryHandle('.git')).getDirectoryHandle('restore-backups');
  const recoveryFile=await (await recoveryFolder.getFileHandle(recoveryPath.split('/').pop())).getFile();
  const recoveryZip=await JSZip.loadAsync(await recoveryFile.arrayBuffer());
  assert.equal(await recoveryZip.file('preserve.txt').async('string'),'recovery bytes','A failed rollback retains a readable recovery archive');
  const privateAssetsDirectory = await (await layoutDirectory.getDirectoryHandle('src')).getDirectoryHandle('assets');
  const privateImageWriter = await (await privateAssetsDirectory.getFileHandle('private.png', { create: true })).createWritable();
  await privateImageWriter.write(new Blob(['png'], { type: 'image/png' })); await privateImageWriter.close();
  assert.equal((await indexProjectAssets(layoutDirectory)).discoveredCount, 0);
  const sharedDirectory = await (await layoutDirectory.getDirectoryHandle('src')).getDirectoryHandle('shared');
  const sharedVideoWriter = await (await sharedDirectory.getFileHandle('shared.webm', { create: true })).createWritable();
  await sharedVideoWriter.write(new Blob(['video'], { type: 'video/webm' })); await sharedVideoWriter.close();
  const privateVideoWriter = await (await privateAssetsDirectory.getFileHandle('private.webm', { create: true })).createWritable();
  await privateVideoWriter.write(new Blob(['video'], { type: 'video/webm' })); await privateVideoWriter.close();
  assert.deepEqual((await collectWorkspaceFileAssets(layoutDirectory)).map((asset) => asset.path), ['Project/src/shared/shared.webm']);
  const missingDatasetManifestDirectory = directory();
  await createProjectDirectory(missingDatasetManifestDirectory, createProject('No metadata', 'character'));
  await missingDatasetManifestDirectory.removeEntry(DATASET_MANIFEST_FILE);
  await assert.rejects(exportProjectDatasetAsZip(missingDatasetManifestDirectory), /missing or invalid/);
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
  await assert.rejects(readProjectDirectory(dir), /selection/);
  await assert.rejects(readProjectDirectory(dir, async () => { throw new DOMException('Canceled', 'AbortError'); }), /Canceled/);
  assert.equal((await readManifest(dir)).project.projectType, undefined);
  let selections = 0;
  assert.equal((await readProjectDirectory(dir, async () => { selections++; return 'style'; })).projectType, 'style');
  await readProjectDirectory(dir, async () => { selections++; return 'concept'; });
  assert.equal(selections, 1);
  assert.deepEqual((await readManifest(dir)).project.customMetadata, { preserved: true });
  const zip = await JSZip.loadAsync(await (await createProjectFileBlob(createProject('Legacy zip', 'character'))).arrayBuffer());
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  delete manifest.project.projectType;
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('unrelated.txt', 'preserve me');
  let bytes = await zip.generateAsync({ type: 'uint8array' });
  let saved;
  const handle = { createWritable: async () => ({ write: async (blob) => { saved = await blob.arrayBuffer(); }, close: async () => {} }) };
  await assert.rejects(readProjectFile(bytes, { selectProjectType: async () => 'concept' }), /writable/);
  await assert.rejects(readProjectFile(bytes, { selectProjectType: async () => 'concept', handle: { createWritable: async () => { throw new Error('Write denied'); } } }), /Write denied/);
  assert.equal((await readProjectFile(bytes, { handle, selectProjectType: async () => 'concept' })).projectType, 'concept');
  assert.equal((await readProjectFile(saved)).projectType, 'concept');
  assert.equal(await (await JSZip.loadAsync(saved)).file('unrelated.txt').async('string'), 'preserve me');
  await assert.rejects(resolveProjectType('invalid', 'Invalid'), /Unsupported/);
  await assert.rejects(resolveProjectType(null, 'Invalid'), /Unsupported/);
  console.log('PASS: project types, global Dataset migration, required layout repair, shared-only indexing, dataset ZIP export, version branches/restoration, and legacy project migration.');
} finally { await rm(temp, { recursive: true, force: true }); }
