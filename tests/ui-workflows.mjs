import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';
import JSZip from 'jszip';

const temp = await mkdtemp(join(tmpdir(), 'ui-workflows-'));
try {
  await build({ input: ['src/lib/projectCategories.ts', 'src/lib/datasetAssets.ts', 'src/services/project/saveSession.ts', 'src/stores/useDocumentStateStore.ts', 'src/lib/assetActions.ts', 'src/services/project/projectDirectoryService.ts', 'src/services/caption/captionMutationService.ts', 'src/services/caption/captionFileService.ts', 'src/lib/commandRegistry.ts', 'src/lib/keyboard.ts', 'src/lib/captionEditor.ts', 'src/lib/legacyStorageCleanup.ts', 'src/services/project/saveQueue.ts', 'src/services/export/exportPlan.ts', 'src/services/export/exportService.ts', 'src/services/import/importService.ts', 'src/stores/useOperationStore.ts', 'src/stores/useHistoryStore.ts', 'src/stores/useProjectStore.ts', 'src/next/board/captionEntries.ts', 'src/services/export/exportResize.ts', 'src/next/board/toolOverlays.tsx'], platform: 'node', output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs' } });
  const module = name => import(pathToFileURL(join(temp, `${name}.mjs`)));
  {
    const { cleanupLegacyStorage } = await module('legacyStorageCleanup');
    const store = new Map([['dataset-creator-ui-mode', 'next'], ['dataset-creator-workspace-v2', '{}'], ['dataset-creator-workspace-layout', '{}'], ['dataset-creator-docking-v1', '{}'],
      ['dataset-creator-density', 'compact'], ['dataset-creator-workspace-tab', 'x'], ['review-view:p:v', '{}'], ['dataset-creator-theme', 'dark'],
      ['dataset-creator-shortcuts-v1', JSON.stringify({ singles: false, bindings: { a: 'b' } })]]);
    const keyed = { get length() { return store.size; }, key: index => [...store.keys()][index] ?? null, getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
    cleanupLegacyStorage(keyed);
    assert.deepEqual([...store.keys()].sort(), ['dataset-creator-shortcuts-v1', 'dataset-creator-theme'], 'old interface keys are removed, the theme and shortcuts stay');
    assert.deepEqual(JSON.parse(store.get('dataset-creator-shortcuts-v1')), { singles: false }, 'only bindings are dropped from the shortcut preferences');
    assert.doesNotThrow(() => cleanupLegacyStorage(keyed), 'a second run changes nothing');
    assert.doesNotThrow(() => cleanupLegacyStorage({ length: 0, key: () => null, getItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }));
  }
  const { getCaptionFragmentAtSelection, replaceCaptionFragment, getCaptionSuggestionMatches } = await module('captionEditor');
  assert.deepEqual(getCaptionFragmentAtSelection('cat, blue bird, dog', 9), {start:5,end:14,text:'blue bird'});
  assert.deepEqual(getCaptionFragmentAtSelection('cat, , dog', 5), {start:5,end:5,text:''});
  assert.deepEqual(getCaptionFragmentAtSelection(', cat', 0), {start:0,end:0,text:''});
  assert.deepEqual(replaceCaptionFragment('portrait, blu, smile', 12, 12, 'blue_eyes'), {value:'portrait, blue_eyes, smile',caret:19});
  assert.deepEqual(replaceCaptionFragment('cat, blue bird, dog', 5, 14, 'blue_bird'), {value:'cat, blue_bird, dog',caret:14});
  assert.deepEqual(replaceCaptionFragment('cat, blu', 8, 8, 'blue_eyes'), {value:'cat, blue_eyes',caret:14});
  assert.deepEqual(replaceCaptionFragment('cat\n blu\n dog', 7, 7, 'blue_eyes'), {value:'cat\n blue_eyes\n dog',caret:14});
  assert.deepEqual(getCaptionSuggestionMatches('blue bird', ['Blue_Bird','blue bird','bluebird','light blue bird','blue sky'], 'cat, BLUE_BIRD'), ['light blue bird']);
  assert.deepEqual(getCaptionSuggestionMatches('blu', ['light blue','blue sky','blue bird'], 'cat'), ['blue bird','blue sky','light blue']);
  assert.deepEqual(getCaptionSuggestionMatches('blue', ['blue_eyes'], 'cat\nblue eyes'), []);
  const { isProjectPathIncluded } = await module('projectCategories');
  assert.equal(isProjectPathIncluded('Project/people/a.png',['Project/people']),false);
  assert.equal(isProjectPathIncluded('Project/people-old/a.png',['Project/people']),true,'Category prefixes stop at path boundaries');
  assert.equal(isProjectPathIncluded('Project/people/nested/a.png',['Project/people/nested']),false);
  assert.equal(isProjectPathIncluded('Project/people/keep/a.png',['Project/people'],['Project/people/keep']),true,'A more specific include overrides an excluded parent');
  assert.equal(isProjectPathIncluded('Project/people/keep/private/a.png',['Project/people'],['Project/people/keep']),true);
  const { applyProjectRelativePathMoves } = await module('datasetAssets');
  const assetMove = [{from:'Project/inbox/image.png',to:'Project/inbox/renamed.png'}];
  assert.equal(applyProjectRelativePathMoves('inbox/image.png',assetMove),'inbox/renamed.png');
  assert.equal(applyProjectRelativePathMoves('inbox/image.png.manifest.json',assetMove,true),'inbox/renamed.png.manifest.json','Sidecars follow their asset filename even though they are not child paths');
  assert.equal(applyProjectRelativePathMoves('inbox/image.png.manifest.json',assetMove),'inbox/image.png.manifest.json','Unrelated ordinary paths do not follow a filename prefix');
  assert.equal(applyProjectRelativePathMoves('inbox/images.png.manifest.json',assetMove,true),'inbox/images.png.manifest.json');
  assert.equal(applyProjectRelativePathMoves('Project/inbox/folder/image.png.manifest.json',[{from:'Project/inbox/folder',to:'Project/inbox/renamed'}],true),'inbox/renamed/image.png.manifest.json');
  assert.equal(applyProjectRelativePathMoves(undefined,assetMove,true),undefined);
  const { useDocumentStateStore, checkDirtyDocuments } = await module('useDocumentStateStore');
  const documentStore = useDocumentStateStore.getState();
  let firstDirty = false;
  const firstCheck = async () => firstDirty;
  const unregisterFirst = documentStore.register('one', { dirty: false, check: firstCheck });
  const unregisterSecond = documentStore.register('two', { dirty: true, check: async () => true });
  assert.deepEqual(await checkDirtyDocuments(['one']), [], 'A dirty neighbouring editor cannot affect closing this document');
  firstDirty = true;
  assert.deepEqual(await checkDirtyDocuments(['one', 'two']), ['one', 'two'], 'Close queries current editor state instead of trusting a stale badge');
  documentStore.changed('one', firstCheck, true);
  assert.equal(useDocumentStateStore.getState().documents.one.dirty, true);
  const newCheck = async () => false;
  const unregisterReplacement = documentStore.register('one', {dirty:false, check:newCheck});
  unregisterFirst(); documentStore.changed('one', firstCheck, true);
  assert.equal(useDocumentStateStore.getState().documents.one.dirty, false, 'Unmount and callbacks from an older editor do not clear or dirty its replacement');
  let releaseDocumentCheck;
  const unregisterDelayed = documentStore.register('delayed', {dirty:false, check:() => new Promise(resolve => {releaseDocumentCheck=resolve;})});
  const pendingDocumentCheck = checkDirtyDocuments(['delayed']);
  unregisterDelayed(); releaseDocumentCheck(false);
  await assert.rejects(pendingDocumentCheck, /editor changed/i, 'Closing cannot use the response from a replaced editor');
  const unregisterUnavailable = documentStore.register('unavailable', {dirty:false, check:async () => {throw new Error('Editor did not respond');}});
  await assert.rejects(checkDirtyDocuments(['unavailable']), /did not respond/, 'An unresponsive iframe cannot be assumed saved');
  unregisterReplacement(); unregisterSecond(); unregisterUnavailable();
  const { createCommandRegistry } = await module('commandRegistry');
  const commands = createCommandRegistry(); let activeDocument = 'first'; let saves = []; let busy = false;
  let changes = 0; const unsubscribeCommands = commands.subscribe(() => changes++);
  const removeFirst = commands.register(() => [{ id: 'document.save', label: 'Save first', active: activeDocument === 'first', disabled: busy, reason: busy ? 'Writing' : undefined, run: () => saves.push('first') }]);
  const removeSecond = commands.register(() => [{ id: 'document.save', label: 'Save second', active: activeDocument === 'second', run: () => saves.push('second') }]);
  commands.run('document.save'); assert.deepEqual(saves, ['first']);
  const firstSnapshot = commands.snapshot('document.save');
  busy = true; commands.changed(); assert.throws(() => commands.run('document.save'), /Writing/);
  assert.notEqual(commands.snapshot('document.save'), firstSnapshot);
  activeDocument = 'second'; commands.changed(); commands.run('document.save');
  removeFirst(); assert.equal(commands.find('document.save').label, 'Save second', 'Unmounting a hidden editor does not remove the active editor command');
  assert.deepEqual(saves, ['first', 'second']); assert.equal(commands.commands().length, 1);
  removeSecond(); assert.throws(() => commands.run('document.save'), /unavailable/); assert.ok(changes >= 6);
  unsubscribeCommands();
  const { matchesShortcut, captureShortcut } = await module('keyboard');
  const { createSaveQueue } = await module('saveQueue');
  const { buildExportPlan, getExportEntryText, exportPlanAsZip, exportPlanToDirectory, renderExportCaption } = await module('exportPlan');
  const { convertPsdToPng } = await module('exportService');
  const { useOperationStore, isOperationRunning } = await module('useOperationStore');
  const { useHistoryStore } = await module('useHistoryStore');
  const { useProjectStore } = await module('useProjectStore');
  const { importImageFiles, getImportPairKey, summarizeImportPairPaths, createImportBatcher } = await module('importService');
  assert.equal(getImportPairKey('animals/Cat.PNG'),getImportPairKey('animals/Cat.TxT'));
  assert.notEqual(getImportPairKey('animals/cat.png'),getImportPairKey('portraits/cat.txt'),'Caption pairs cannot cross folders');
  const { parseCaptionText } = await module('captionFileService');
  assert.deepEqual(parseCaptionText('\uFEFFКіт, Blue Sky\r\nsecond line').tags,['Кіт','Blue Sky','second line'],'Caption import preserves Unicode and case, and treats line breaks as separators');
  assert.deepEqual(summarizeImportPairPaths(['animals/cat.png','animals/cat.jpg','animals/cat.txt','portraits/cat.png','notes.txt','dup/dog.txt','dup/DOG.TXT','dup/dog.webp']),
    {pairedImages:2,imagesWithoutCaption:1,standaloneTextFiles:1,captionConflicts:1,errors:0},'Pair summaries respect folders, multiple image formats and conflicts');
  {
    // Import batcher: flush at size, after the interval (controlled clock), once at the end, never empty.
    const realNow = Date.now; let clock = 1000; Date.now = () => clock;
    try {
      const flushed = [];
      const bySize = createImportBatcher(items => { flushed.push([...items]); }, 3, 250);
      await bySize.flush(); assert.deepEqual(flushed, [], 'flushing nothing does not call the callback');
      await bySize.add(1); await bySize.add(2); assert.deepEqual(flushed, [], 'below size and interval nothing flushes');
      await bySize.add(3); assert.deepEqual(flushed, [[1, 2, 3]], 'flush at size');
      await bySize.add(4); await bySize.flush(); assert.deepEqual(flushed, [[1, 2, 3], [4]], 'final flush sends the remainder');
      await bySize.flush(); assert.equal(flushed.length, 2, 'a second final flush is a no-op, no empty batch');
      const byTime = []; const timed = createImportBatcher(items => { byTime.push([...items]); }, 100, 250);
      await timed.add('a'); clock += 100; await timed.add('b'); assert.deepEqual(byTime, [], 'before the interval nothing flushes');
      clock += 150; await timed.add('c'); assert.deepEqual(byTime, [['a', 'b', 'c']], 'flush once the interval elapsed');
      clock += 1000; await timed.flush(); assert.equal(byTime.length, 1, 'no empty flush after an interval with nothing pending');
      await timed.add('d'); await timed.flush(); assert.deepEqual(byTime[1], ['d']);
      // Items added while an async flush is running land in the next batch, none are lost or duplicated.
      const order = []; let release; const gate = new Promise(resolve => { release = resolve; });
      const slow = createImportBatcher(async items => { order.push(items.join('')); if (items[0] === 'x') await gate; }, 2, 250);
      await slow.add('x'); const second = slow.add('y'); await Promise.resolve();
      await slow.add('z'); release(); await second; await slow.flush();
      assert.equal(order.join('|').replaceAll('|', ''), 'xyz', 'every item is flushed exactly once, in order');
    } finally { Date.now = realNow; }
  }
  let cancelled = 0;
  const operations = useOperationStore.getState();
  operations.start({ id: 'test', viewId: 'tool:import', label: 'Import', cancel: () => cancelled++, total: 3 });
  operations.update('test', { completed: 1 }); operations.cancel('test'); operations.cancel('test');
  assert.equal(cancelled, 1); assert.ok(isOperationRunning(useOperationStore.getState().entries[0]));
  assert.equal(useOperationStore.getState().entries[0].status, 'cancelling');
  operations.dismiss('test'); assert.equal(useOperationStore.getState().entries.length, 1);
  operations.finish('test', 'cancelled'); operations.update('test', { completed: 3 });
  assert.equal(useOperationStore.getState().entries[0].completed, 1);
  operations.dismiss('test'); assert.equal(useOperationStore.getState().entries.length, 0);
  useProjectStore.setState({ id: 'history-test' });
  let historyValue = 1;
  useHistoryStore.getState().push({ label: 'One change', undo: () => { historyValue = 0; }, redo: () => { historyValue = 1; } });
  await useHistoryStore.getState().undo(); assert.equal(historyValue, 0);
  await useHistoryStore.getState().redo(); assert.equal(historyValue, 1);
  let finishUndo;
  useHistoryStore.getState().push({ label: 'Slow undo', undo: () => new Promise(resolve => { finishUndo = resolve; }), redo: () => {} });
  const undoPending = useHistoryStore.getState().undo();
  useHistoryStore.getState().push({ label: 'New edit', undo: () => {}, redo: () => {} });
  finishUndo(); await undoPending;
  assert.equal(useHistoryStore.getState().past.at(-1).label, 'New edit');
  assert.equal(useHistoryStore.getState().future.length, 0);
  useProjectStore.setState({ id: 'another-project' }); assert.equal(useHistoryStore.getState().past.length, 0);
  const stoppedImport = new AbortController(); stoppedImport.abort();
  await assert.rejects(importImageFiles([new File(['x'], 'x.png')], { signal: stoppedImport.signal, logger: { info() {}, error() {}, warning() {}, success() {}, progress() {} } }), { name: 'AbortError' });
  const event = (values = {}) => ({ key: 'd', code: 'KeyD', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, getModifierState: () => false, ...values });
  assert.ok(matchesShortcut(event({ key: 'в' }), 'D'), 'physical shortcuts work in Ukrainian layout');
  assert.ok(matchesShortcut(event({ key: 'л', code: 'KeyK', ctrlKey: true }), 'Mod+K'));
  assert.ok(matchesShortcut(event({ key: 'k', code: 'KeyK', metaKey: true }), 'Mod+K'));
  assert.equal(matchesShortcut(event({ isComposing: true }), 'D'), false);
  assert.equal(matchesShortcut(event({ getModifierState: key => key === 'AltGraph' }), 'D'), false);
  assert.equal(matchesShortcut(event({ ctrlKey: true }), 'D'), false);
  assert.equal(matchesShortcut(event({ shiftKey: true }), 'D'), false);
  assert.equal(captureShortcut(event({ key: 'в', ctrlKey: true })), 'Mod+D');
  assert.ok(matchesShortcut(event({ key: ' ', code: 'Space' }), 'Space'));

  // A failed write must keep the old baseline, then retry the latest snapshot.
  const writes = []; const states = []; let fail = true;
  const queue = createSaveQueue('initial', async (value, previous) => { writes.push([value, previous]); if (fail) throw new Error('Write denied'); }, state => states.push(state));
  queue.enqueue('first');
  await assert.rejects(queue.flush(), /Write denied/);
  assert.equal(states.at(-1).status, 'error'); assert.ok(queue.isDirty());
  queue.enqueue('latest'); fail = false; await queue.flush();
  assert.deepEqual(writes, [['first', 'initial'], ['latest', 'initial']]);
  assert.equal(queue.isDirty(), false); assert.equal(states.at(-1).status, 'saved');
  let release; const serialized = [];
  const concurrent = createSaveQueue(0, async (value, previous) => { serialized.push([value, previous]); if (value === 1) await new Promise(resolve => { release = resolve; }); }, () => {});
  concurrent.enqueue(1); const firstFlush = concurrent.flush();
  concurrent.enqueue(2); const nextFlush = concurrent.flush();
  assert.equal(firstFlush, nextFlush); release(); await firstFlush;
  assert.deepEqual(serialized, [[1, 0], [2, 1]]);
  concurrent.stop(); concurrent.enqueue(3); await concurrent.flush(); assert.equal(serialized.length, 2);

  const fileEvents = []; let releaseFileWrite; let releaseFileMutation;
  const fileQueue = createSaveQueue(0, async snapshot => {
    fileEvents.push(`save ${snapshot}`);
    if (snapshot === 1) await new Promise(resolve => {releaseFileWrite = resolve;});
  }, () => {});
  fileQueue.enqueue(1); const pendingSave = fileQueue.flush();
  const pendingMutation = fileQueue.runExclusive(async () => {
    fileEvents.push('rename started');
    await new Promise(resolve => {releaseFileMutation = resolve;});
    fileEvents.push('rename finished'); fileQueue.enqueue(3);
  });
  releaseFileWrite(); await pendingSave;
  while (!releaseFileMutation) await new Promise(resolve => setTimeout(resolve, 0));
  fileQueue.enqueue(2); const saveDuringMutation = fileQueue.flush();
  assert.deepEqual(fileEvents, ['save 1', 'rename started'], 'Autosave cannot write halfway through a file move');
  assert.ok(fileQueue.isDirty(), 'Pending file operations guard page unload');
  releaseFileMutation(); await Promise.all([pendingMutation,saveDuringMutation]);
  assert.deepEqual(fileEvents, ['save 1', 'rename started', 'rename finished', 'save 3'], 'Only the latest state with updated paths is saved after the move');
  await assert.rejects(fileQueue.runExclusive(async () => {fileQueue.enqueue(4); throw new Error('Partial move failed');}), /Partial move failed/);
  assert.equal(fileEvents.at(-1), 'save 4', 'References updated before a partial failure still persist');
  fileQueue.enqueue(5); await fileQueue.flush(); assert.equal(fileEvents.at(-1), 'save 5', 'An operation failure does not poison later saves');
  fileQueue.stop();
  await assert.rejects(fileQueue.runExclusive(async () => assert.fail('Stopped queue must not mutate files')), /project changed/);

  const { createSaveSession } = await module('saveSession');
  const observable = initial => {
    let value = initial; const listeners = new Set();
    return {get:()=>value,set:next=>{value=next; for(const listener of listeners) listener(next);},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  };
  const sessionProject = observable({id:'A',name:'first'});
  const sessionDirectory = observable(undefined);
  const sessionWrites = []; const sessionStates = []; let finishOldWrite;
  const savingSession = createSaveSession({
    getProject:sessionProject.get,subscribeProject:sessionProject.subscribe,
    getDirectory:sessionDirectory.get,subscribeDirectory:sessionDirectory.subscribe,
    write:async(snapshot,previous,directory)=>{
      sessionWrites.push([snapshot.id,snapshot.name,previous.name,directory]);
      if(snapshot.name==='held') await new Promise(resolve=>{finishOldWrite=resolve;});
    },
    changed:state=>sessionStates.push(state),delay:10000,
  });
  sessionDirectory.set('folder-A');
  sessionProject.set({id:'A',name:'held'}); const oldSessionSave=savingSession.flush();
  sessionDirectory.set(undefined); sessionProject.set({id:'B',name:'second'}); sessionDirectory.set('folder-B');
  sessionProject.set({id:'B',name:'indexed immediately'}); await savingSession.flush();
  assert.deepEqual(sessionWrites,[['A','held','first','folder-A'],['B','indexed immediately','second','folder-B']], 'A new folder captures immediate index edits before a React effect can run');
  const stateCount=sessionStates.length; finishOldWrite(); await oldSessionSave;
  assert.equal(sessionStates.length,stateCount,'A completed old write cannot overwrite the new session status');
  sessionProject.set({id:'unexpected-project',name:'must not leak'}); await savingSession.flush();
  assert.equal(sessionWrites.length,2,'Changing project identity without a folder handshake disconnects writes');
  await assert.rejects(savingSession.runExclusive(async()=>assert.fail('No folder session')), /Open a project directory/);
  sessionDirectory.set('folder-C');
  sessionProject.set({id:'unexpected-project',name:'third'}); await savingSession.flush();
  assert.deepEqual(sessionWrites.at(-1),['unexpected-project','third','must not leak','folder-C']);
  savingSession.dispose(); sessionProject.set({id:'unexpected-project',name:'after disposal'}); await savingSession.flush();
  assert.equal(sessionWrites.length,3,'Disposal unsubscribes project changes and clears scheduled saves');

  function directory(name = 'test') {
    const entries = new Map();
    return { name, files: entries, entries: async function* () { yield* entries; },
      async getDirectoryHandle(name, options) {
        if (!entries.has(name) && options?.create) entries.set(name, directory(name));
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        return entries.get(name);
      },
      async getFileHandle(name, options) {
        if (!entries.has(name) && options?.create) {
          let data = '';
          entries.set(name, { name, getFile: async () => new File([data], name, { type: data.type }), createWritable: async () => ({ write: async value => { data = value; }, close: async () => {} }) });
        }
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        return entries.get(name);
      },
      async removeEntry(name) { if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError'); entries.delete(name); },
    };
  }
  const write = async (dir, name, data) => { const stream = await (await dir.getFileHandle(name, { create: true })).createWritable(); await stream.write(data); await stream.close(); };
  const bytes = async (dir, name) => { const parts = name.split('/'); const file = parts.pop(); for (const part of parts) dir = await dir.getDirectoryHandle(part); return new Uint8Array(await (await (await dir.getFileHandle(file)).getFile()).arrayBuffer()); };
  const readJson = async (dir, name) => JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  const { persistCaptionTagsForItems } = await module('captionMutationService');
  const captionDirectory = directory('caption-project');
  const captionAssets = await captionDirectory.getDirectoryHandle('assets', {create:true});
  await write(captionAssets, 'one.psd', new Blob(['one']));
  await write(captionAssets, 'one.txt', 'old\n');
  await write(captionAssets, 'one.psd.manifest.json', JSON.stringify({id:'one',custom:true}));
  await write(captionAssets, 'two.psd', new Blob(['two']));
  await write(captionAssets, 'two.psd.manifest.json', JSON.stringify({id:'two'}));
  const captionItems = [
    {id:'asset:Project/assets/one.psd',sourceImageId:'',assetPath:'Project/assets/one.psd',fileName:'one.psd',kind:'psd',tags:['old']},
    {id:'asset:Project/assets/two.psd',sourceImageId:'',assetPath:'Project/assets/two.psd',fileName:'two.psd',kind:'psd',tags:undefined},
  ];
  useProjectStore.setState({id:'caption-test'}); useHistoryStore.setState({past:[],future:[]});
  const readText = async (dir, name) => (await (await dir.getFileHandle(name)).getFile()).text();
  const captionMissing = async name => { try { await captionAssets.getFileHandle(name); return false; } catch (error) { if (error.name === 'NotFoundError') return true; throw error; } };
  let captionFlushes = 0;
  await persistCaptionTagsForItems({items:captionItems,resolveTags:item => item.id.includes('one') ? ['new'] : [],directory:captionDirectory,flush:async()=>{captionFlushes++;}});
  assert.equal(await readText(captionAssets,'one.txt'),'new\n','The TXT next to the file is the caption');
  assert.equal(await readText(captionAssets,'two.txt'),'','An explicit empty caption is an empty file, not a missing one');
  assert.equal('tags' in await readJson(captionAssets,'one.psd.manifest.json'),false,'The sidecar no longer stores tags');
  assert.equal(useHistoryStore.getState().past.length,1,'A multi-asset caption edit creates one undo entry');
  await useHistoryStore.getState().undo();
  assert.equal(await readText(captionAssets,'one.txt'),'old\n');
  assert.equal(await captionMissing('two.txt'),true,'Undo restores a previously missing caption file');
  await useHistoryStore.getState().redo();
  assert.equal(await readText(captionAssets,'two.txt'),'');
  assert.equal(captionFlushes,3,'Save runs for edit, undo and redo');
  {
    // applyCaptionTagBatch / persistCaptionBatch: one undo step each; tags compare case-insensitively; a missing caption (undefined) is not an empty one ([]).
    const { applyCaptionTagBatch, persistCaptionBatch } = await module('captionMutationService');
    const batchDirectory = directory('caption-batch'); const batchAssets = await batchDirectory.getDirectoryHandle('assets', { create: true });
    for (const name of ['a', 'b', 'c']) await write(batchAssets, `${name}.psd`, new Blob([name]));
    await write(batchAssets, 'a.txt', 'Red, blue\n'); await write(batchAssets, 'b.txt', '');
    const frame = (name, tags) => ({ id: `asset:Project/assets/${name}.psd`, sourceImageId: '', assetPath: `Project/assets/${name}.psd`, fileName: `${name}.psd`, kind: 'psd', tags });
    const batchItems = [frame('a', ['Red', 'blue']), frame('b', []), frame('c', undefined)];
    const read = async name => { try { return await readText(batchAssets, name); } catch (error) { if (error.name === 'NotFoundError') return null; throw error; } };
    const restored = async () => { assert.equal(await read('a.txt'), 'Red, blue\n'); assert.equal(await read('b.txt'), ''); assert.equal(await read('c.txt'), null, 'a caption that was missing is missing again'); };
    useProjectStore.setState({ id: 'caption-batch-test' }); useHistoryStore.setState({ past: [], future: [] });
    const flushes = []; const flush = async () => { flushes.push(1); };
    const last = () => useHistoryStore.getState().past.at(-1);

    assert.equal(await applyCaptionTagBatch({ items: batchItems, tags: ['BLUE', 'new'], mode: 'add', directory: batchDirectory, flush }), 3);
    assert.equal(await read('a.txt'), 'Red, BLUE, new\n', 'add drops the same tag in another case, then appends the given spelling');
    assert.equal(await read('b.txt'), 'BLUE, new\n', 'an empty caption receives the tags');
    assert.equal(await read('c.txt'), 'BLUE, new\n', 'a missing caption becomes a caption file');
    assert.equal(useHistoryStore.getState().past.length, 1, 'the whole batch is one undo step'); assert.equal(last().label, 'Add caption tags');
    await useHistoryStore.getState().undo(); await restored(); assert.equal(useHistoryStore.getState().past.length, 0);
    await useHistoryStore.getState().redo(); assert.equal(await read('c.txt'), 'BLUE, new\n');
    await useHistoryStore.getState().undo(); await restored();

    assert.equal(await applyCaptionTagBatch({ items: batchItems, tags: ['red'], mode: 'add', directory: batchDirectory, flush }), 3);
    assert.equal(await read('a.txt'), 'blue, red\n', 'adding an existing tag moves it to the end with the new spelling'); assert.equal(last().label, 'Add caption tag', 'singular label for one tag');
    await useHistoryStore.getState().undo(); await restored();

    // Remove ignores case, leaves other tags, touches nothing when there is nothing to remove, and does not count unchanged captions.
    assert.equal(await applyCaptionTagBatch({ items: [batchItems[0], batchItems[1]], tags: ['RED'], mode: 'remove', directory: batchDirectory, flush }), 1, 'the [] caption has nothing to remove and is not rewritten');
    assert.equal(await read('a.txt'), 'blue\n'); assert.equal(await read('b.txt'), ''); assert.equal(last().label, 'Remove caption tag');
    await useHistoryStore.getState().undo(); await restored();
    const before = useHistoryStore.getState().past.length;
    assert.equal(await applyCaptionTagBatch({ items: [batchItems[0], batchItems[1]], tags: ['absent'], mode: 'remove', directory: batchDirectory, flush }), 0);
    assert.equal(useHistoryStore.getState().past.length, before, 'removing a tag nobody has adds no undo step'); await restored();
    assert.equal(await applyCaptionTagBatch({ items: [batchItems[0]], tags: ['Red', 'BLUE'], mode: 'remove', directory: batchDirectory, flush }), 1);
    assert.equal(await read('a.txt'), '', 'removing every tag leaves an empty caption file, not a missing one'); assert.equal(last().label, 'Remove caption tags');
    await useHistoryStore.getState().undo(); await restored();

    // Missing versus empty: removing from a missing caption writes an empty caption file (the service compares undefined with []), which the Board avoids by only passing frames that have the tag.
    assert.equal(await applyCaptionTagBatch({ items: [batchItems[2]], tags: ['x'], mode: 'remove', directory: batchDirectory, flush }), 1);
    assert.equal(await read('c.txt'), '', 'undefined -> [] counts as a change');
    await useHistoryStore.getState().undo(); await restored();

    const written = await persistCaptionBatch('Auto-caption', { items: batchItems, resolveTags: item => item.fileName === 'a.psd' ? item.tags : ['model', 'tags'], directory: batchDirectory, flush });
    assert.equal(written, 2, 'a caption that does not change is not written'); assert.equal(last().label, 'Auto-caption');
    assert.equal(await read('a.txt'), 'Red, blue\n'); assert.equal(await read('b.txt'), 'model, tags\n'); assert.equal(await read('c.txt'), 'model, tags\n');
    await useHistoryStore.getState().undo(); await restored();
    assert.equal(await persistCaptionBatch('Edit caption', { items: [batchItems[1]], resolveTags: () => [], directory: batchDirectory, flush }), 0, '[] over [] is no change');
    assert.equal(await persistCaptionBatch('Edit caption', { items: [batchItems[2]], resolveTags: () => [], directory: batchDirectory, flush }), 1, '[] over a missing caption creates an empty caption');
    assert.equal(await read('c.txt'), ''); assert.equal(last().label, 'Edit caption');
    await useHistoryStore.getState().undo(); await restored();
    assert.ok(flushes.length > 0, 'saves are flushed');
    useHistoryStore.setState({ past: [], future: [] });
  }
  const { writeProjectDirectoryChanges, readProjectDirectory, createProjectDirectory } = await module('projectDirectoryService');
  const projectDirectory = directory('snapshot-project');
  const initialProject = useProjectStore.getState();
  const savedDataset = { ...initialProject.dataset, triggerWord: 'first' };
  const projectOne = { ...initialProject, dataset: savedDataset };
  await writeProjectDirectoryChanges(projectOne, undefined, projectDirectory);
  const readProjectManifest = async () => JSON.parse(await (await (await (await projectDirectory.getDirectoryHandle('.datasetcreator')).getFileHandle('project.json')).getFile()).text());
  assert.equal((await readProjectManifest()).project.dataset.triggerWord, 'first');
  const projectTwo = { ...projectOne, dataset: { ...savedDataset, triggerWord:'latest' } };
  const manifestHandle = await (await projectDirectory.getDirectoryHandle('.datasetcreator')).getFileHandle('project.json');
  const createManifestWritable = manifestHandle.createWritable;
  manifestHandle.createWritable = async () => { throw new Error('Manifest write denied'); };
  const projectStatuses = [];
  const projectQueue = createSaveQueue(projectOne, (snapshot, previous) => writeProjectDirectoryChanges(snapshot, previous, projectDirectory), state => projectStatuses.push(state));
  projectQueue.enqueue(projectTwo);
  await assert.rejects(projectQueue.flush(), /Manifest write denied/);
  assert.equal(projectStatuses.at(-1).status, 'error');
  assert.ok(projectQueue.isDirty(), 'Project cannot report saved when its manifest failed');
  manifestHandle.createWritable = createManifestWritable;
  await projectQueue.flush();
  assert.equal((await readProjectManifest()).project.dataset.triggerWord, 'latest');
  assert.equal(projectStatuses.at(-1).status, 'saved');
  projectQueue.enqueue(projectOne); await projectQueue.flush();
  assert.equal((await readProjectManifest()).project.dataset.triggerWord, 'first', 'Restoring settings updates the project manifest');
  const reopened = await readProjectDirectory(projectDirectory);
  assert.equal(reopened.dataset.filePath, undefined);
  await writeProjectDirectoryChanges({...reopened, dataset:{...reopened.dataset,triggerWord:'after reopening'}}, reopened, projectDirectory);
  assert.equal((await readProjectManifest()).project.dataset.triggerWord, 'after reopening');
  const createdDirectory = directory('created-project');
  await createProjectDirectory(createdDirectory, projectOne);
  const reopenedCreated = await readProjectDirectory(createdDirectory);
  assert.equal(reopenedCreated.dataset.triggerWord, 'first');
  await assert.rejects(createdDirectory.getFileHandle('dataset.json'), { name:'NotFoundError' });
  const dataset = { id: 'dataset', name: 'Test', assetIds: ['a', 'b'], assetPaths: [], psdAssetPaths: [], assetOrder: ['image:b', 'image:a'], triggerWord: 'Trigger' };
  const a = { id: 'source:a', sourceImageId: 'a', kind: 'image', fileName: 'same.png', imageData: new Blob(['PNG contents'], { type: 'image/png' }), tags: ['replacement', 'blocked'] };
  const b = { id: 'source:b', sourceImageId: 'b', kind: 'image', fileName: 'same.jpg', imageData: new Blob(['JPEG contents'], { type: 'image/jpeg' }), tags: ['blue', 'BLUE'] };
  const excluded = { ...a, id: 'source:c', sourceImageId: 'c', excludedFromDataset: true };
  const exportProject = directory('export-project'); const exportDataset = await exportProject.getDirectoryHandle('dataset',{create:true});
  const captionTexts = { 'same.png': 'Trigger, replacement, blocked\n', 'same.jpg': 'Trigger, blue, BLUE\r\n', 'excluded.png': 'Trigger, replacement, blocked\n' };
  await write(exportDataset,'same.png',a.imageData); await write(exportDataset,'same.txt',captionTexts['same.png']);
  const exportSub = await exportDataset.getDirectoryHandle('sub',{create:true}); // a.png and a.jpg beside each other would share one TXT
  await write(exportSub,'same.jpg',b.imageData); await write(exportSub,'same.txt',captionTexts['same.jpg']);
  await write(exportDataset,'excluded.png',excluded.imageData); await write(exportDataset,'excluded.txt',captionTexts['excluded.png']);
  const args = { scope: 'dataset', items: [a, b, excluded], dataset, directory:exportProject, blacklist: [' blocked '] };
  assert.equal(renderExportCaption(['Tag', 'tag', 'blocked', ''], 'Trigger', ['blocked']), 'Trigger, Tag');
  const plan = await buildExportPlan(args);
  assert.deepEqual(plan.entries.map(entry => entry.imageName), ['excluded.png', 'same.png', 'sub/same.jpg']);
  assert.deepEqual(plan.entries.map(entry => entry.caption), ['Trigger, replacement, blocked', 'Trigger, replacement, blocked', 'Trigger, blue, BLUE'], 'Dataset captions are the TXT as it is: blacklist and trigger are not applied again');
  assert.deepEqual(plan.entries.map(entry => entry.textContent), [captionTexts['excluded.png'], captionTexts['same.png'], captionTexts['same.jpg']], 'Dataset export keeps TXT bytes (including CRLF)');
  assert.deepEqual(plan.warnings, []);
  // Mutating source captions after preview cannot silently change the output.
  a.tags = ['changed after preview'];
  const zip = await JSZip.loadAsync(await (await exportPlanAsZip(plan)).arrayBuffer());
  const target = directory(); const progress = [];
  await exportPlanToDirectory(plan, target, undefined, (done, total) => progress.push([done, total]));
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(Object.keys(zip.files).sort(), ['excluded.png', 'excluded.txt', 'same.png', 'same.txt', 'sub/', 'sub/same.jpg', 'sub/same.txt']);
  for (const entry of plan.entries) {
    assert.deepEqual(await zip.file(entry.imageName).async('uint8array'), new Uint8Array(await entry.blob.arrayBuffer()));
    assert.equal(await zip.file(entry.textName).async('string'), entry.textContent);
    for (const name of [entry.imageName, entry.textName]) assert.deepEqual(await bytes(target, name), await zip.file(name).async('uint8array'));
  }
  const workspace = await buildExportPlan({ ...args, scope: 'workspace' });
  assert.equal(workspace.entries[0].caption, 'Trigger, changed after preview', 'Dataset and workspace export read the same asset-owned caption');
  assert.equal(workspace.skipped.length, 0, 'Explicit exports do not use legacy flags');
  assert.equal((await buildExportPlan({ ...args, dataset: { ...dataset, assetIds: ['missing'] } })).entries.length,3,'Legacy membership cannot add or remove physical Dataset files');
  const collision = directory(); await write(collision, 'same.png', 'Keep me');
  await assert.rejects(exportPlanToDirectory(plan, collision), /already exists/);
  assert.equal(collision.files.size, 1, 'Preflight must not write earlier files before discovering a collision');
  assert.equal(new TextDecoder().decode(await bytes(collision, 'same.png')), 'Keep me');
  const denied = { ...directory(), getFileHandle: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } };
  await assert.rejects(exportPlanToDirectory(plan, denied), /Permission denied/);
  const abort = new AbortController(); abort.abort();
  const empty = directory();
  await assert.rejects(exportPlanAsZip(plan, abort.signal), { name: 'AbortError' });
  await assert.rejects(exportPlanToDirectory(plan, empty, abort.signal), { name: 'AbortError' });
  assert.equal(empty.files.size, 0);
  const partial = directory(); const stop = new AbortController();
  const completedEntries = new Set();
  const recoveryJournal = {completedEntryNames:completedEntries, root:partial, fingerprint:plan.fingerprint};
  await assert.rejects(exportPlanToDirectory(plan, partial, stop.signal, () => stop.abort(), recoveryJournal), { name: 'AbortError' });
  assert.equal(partial.files.size, 2, 'Cancellation retains one completed image/caption pair');
  assert.deepEqual([...completedEntries],[plan.entries[0].imageName]);
  await exportPlanToDirectory(plan, partial, undefined, undefined, recoveryJournal);
  assert.equal(partial.files.size,5,'A verified recovery journal skips completed pairs and writes only the remainder (sub/ is one top-level folder)');
  const flaky = directory(); const flakyJournal = { completedEntryNames:new Set(), startedEntryNames:new Set() };
  const flakyText = plan.entries[0].textName; const flakyGetFileHandle = flaky.getFileHandle.bind(flaky); let failOnce = true;
  flaky.getFileHandle = async (name, options) => {
    const handle = await flakyGetFileHandle(name, options);
    if (name !== flakyText || !options?.create) return handle;
    const realWritable = handle.createWritable;
    return { ...handle, createWritable: async () => { const writer = await realWritable(); return { write: async value => { if (failOnce) { failOnce = false; throw new Error('simulated TXT failure'); } await writer.write(value); }, close: () => writer.close(), abort: async () => { flaky.files.delete(name); } }; } };
  };
  await assert.rejects(exportPlanToDirectory(plan, flaky, undefined, undefined, flakyJournal), /simulated TXT failure/);
  assert.equal(flakyJournal.startedEntryNames.has(plan.entries[0].imageName), true, 'A failed half-pair remains marked for safe retry');
  let imageRewriteCount = 0;
  const flakyImage = await flaky.getFileHandle(plan.entries[0].imageName); const flakyImageWriter = flakyImage.createWritable;
  flakyImage.createWritable = async () => { imageRewriteCount += 1; return flakyImageWriter(); };
  await exportPlanToDirectory(plan, flaky, undefined, undefined, flakyJournal);
  assert.equal(imageRewriteCount, 0, 'Retry preserves the image half that already succeeded');
  assert.equal(await (await flaky.getFileHandle(flakyText)).getFile().then(file => file.text()), `${plan.entries[0].caption}\n`);
  const eager = directory(); const eagerJournal = { completedEntryNames:new Set(), startedEntryNames:new Set(), pendingOutputNames:new Set() };
  const eagerText = plan.entries[0].textName; const eagerGet = eager.getFileHandle.bind(eager); let failEagerOnce = true;
  eager.getFileHandle = async (name, options) => { const handle = await eagerGet(name, options); if (name !== eagerText || !options?.create) return handle; const writable = handle.createWritable; return { ...handle, createWritable: async () => { const writer = await writable(); return { write: async value => { if (failEagerOnce) { failEagerOnce = false; throw new Error('eager placeholder failure'); } await writer.write(value); }, close: () => writer.close(), abort: async () => {} }; } }; };
  await assert.rejects(exportPlanToDirectory(plan, eager, undefined, undefined, eagerJournal), /eager placeholder failure/);
  assert.equal((await (await eager.getFileHandle(eagerText)).getFile()).size, 0, 'Simulated File System Access API leaves an eagerly created empty placeholder');
  await exportPlanToDirectory(plan, eager, undefined, undefined, eagerJournal);
  assert.equal(await (await eager.getFileHandle(eagerText)).getFile().then(file => file.text()), `${plan.entries[0].caption}\n`, 'Journal-owned empty placeholder is safely replaced on retry');
  const changedStarted = directory(); const changedJournal = { completedEntryNames:new Set(), startedEntryNames:new Set([plan.entries[0].imageName]) };
  await write(changedStarted, plan.entries[0].imageName, new Blob(['WRONG'], {type:'image/png'}));
  await assert.rejects(exportPlanToDirectory(plan, changedStarted, undefined, undefined, changedJournal), /does not match/);
  const recoveredImageName = plan.entries[0].imageName;
  partial.files.delete(plan.entries[0].textName);
  await exportPlanToDirectory(plan, partial, undefined, undefined, recoveryJournal);
  assert.equal(await (await partial.getFileHandle(plan.entries[0].textName)).getFile().then(file => file.text()), `${plan.entries[0].caption}\n`, 'Recovery repairs the missing half of a verified pair');
  partial.files.delete(plan.entries[0].textName);
  const repairAbort = new AbortController();
  const partialGetFileHandle = partial.getFileHandle.bind(partial);
  partial.getFileHandle = async (name, options) => { const handle = await partialGetFileHandle(name, options); if (name !== plan.entries[0].textName || !options?.create) return handle; const writable = handle.createWritable; return { ...handle, createWritable: async () => { const writer = await writable(); return { write: async value => { await writer.write(value); repairAbort.abort(); }, close: () => writer.close(), abort: async () => { partial.files.delete(name); } }; } }; };
  const abortingRecovery = { ...recoveryJournal };
  await assert.rejects(exportPlanToDirectory(plan, partial, repairAbort.signal, undefined, abortingRecovery), {name:'AbortError'});
  const cleanupRoot = directory(); let abortCleanup = false;
  const cleanupGet = cleanupRoot.getFileHandle.bind(cleanupRoot);
  cleanupRoot.getFileHandle = async (name, options) => { const handle = await cleanupGet(name, options); if (!options?.create) return handle; return { ...handle, createWritable: async () => ({ write: async () => { throw new Error('writer failed'); }, close: async () => {}, abort: async () => { abortCleanup = true; } }) }; };
  await assert.rejects(exportPlanToDirectory(plan, cleanupRoot), /writer failed/);
  assert.equal(abortCleanup, true, 'A failed write aborts its writer before propagating the error');
  const wrongRecovery = directory();
  await write(wrongRecovery, recoveredImageName, new Blob([new Uint8Array(plan.entries[0].blob.size).fill(0)]));
  await write(wrongRecovery, plan.entries[0].textName, `${plan.entries[0].caption}\n`);
  const wrongJournal = new Set([recoveredImageName]);
  await assert.rejects(exportPlanToDirectory(plan, wrongRecovery, undefined, undefined, {completedEntryNames:wrongJournal}), /does not match/);
  const wrongTextRecovery = directory();
  await write(wrongTextRecovery, recoveredImageName, plan.entries[0].blob);
  await write(wrongTextRecovery, plan.entries[0].textName, 'unrelated caption\n');
  await assert.rejects(exportPlanToDirectory(plan, wrongTextRecovery, undefined, undefined, {completedEntryNames:new Set([recoveredImageName])}), /does not match/);
  await assert.rejects(exportPlanToDirectory(plan, wrongRecovery, undefined, undefined, recoveryJournal), /different destination folder/);
  const equalSizeA = await buildExportPlan({ ...args, scope:'workspace', items:[{...a, imageData:new Blob(['AAAA'],{type:'image/png'})}] });
  const equalSizeB = await buildExportPlan({ ...args, scope:'workspace', items:[{...a, imageData:new Blob(['BBBB'],{type:'image/png'})}] });
  assert.notEqual(equalSizeA.fingerprint, equalSizeB.fingerprint, 'Equal-size byte changes produce a different fingerprint');

  const root = directory(); const data = await root.getDirectoryHandle('dataset', { create: true });
  await write(data, 'linked.jpg', new Blob(['linked'], { type: 'image/jpeg' }));
  await write(data, 'linked.txt', 'Trigger, disk tags\n');
  await write(data, 'document.psd', new Blob(['psd']));
  const linkedDataset = { ...dataset, assetIds: [], assetPaths: ['Project/dataset/linked.jpg', 'Project/dataset/document.psd'], assetOrder: ['file:Project/dataset/document.psd', 'file:Project/dataset/linked.jpg'] };
  const linked = await buildExportPlan({ ...args, dataset: linkedDataset, directory: root });
  assert.equal(linked.entries[0].imageName, 'document.png');
  assert.equal(linked.entries[0].conversion, 'psd');
  assert.equal(linked.entries[1].caption, 'Trigger, disk tags');
  assert.equal(linked.entries[1].textContent, 'Trigger, disk tags\n');
  assert.equal(linked.entries[0].textContent, null, 'An image without a TXT has no caption file to export');
  assert.deepEqual(linked.warnings, ['document.psd has no caption file; it is exported without a .txt.']);
  assert.deepEqual(linked.entries.map(entry => getExportEntryText(entry)), [null, 'Trigger, disk tags\n'], 'No empty or invented .txt is written for a missing caption');
  const physical = await buildExportPlan({ ...args, scope: 'directory', directory: root });
  assert.equal(physical.entries.find(entry => entry.source === 'linked.jpg').caption, 'Trigger, disk tags');
  await write(data, 'linked.jpg.manifest.json', JSON.stringify({ excludedFromDataset: true }));
  const filtered = await buildExportPlan({ ...args, scope: 'directory', directory: root });
  assert.equal(filtered.entries.length, 2, 'Physical folder membership overrides stale exclusion metadata'); assert.equal(filtered.skipped.length, 0);
  await write(data, 'linked.jpg.manifest.json', 'broken JSON');
  assert.equal((await buildExportPlan({ ...args, scope: 'directory', directory: root })).entries.length, 2, 'Dataset export reads TXT files only, so a broken sidecar cannot affect it');
  await assert.rejects(buildExportPlan({ ...args, scope: 'directory', directory: { getDirectoryHandle: async () => { throw new DOMException('Read denied', 'NotAllowedError'); } } }), /Read denied/);

  // Stage 4 of the next UI: caption entries, batch caption tag edits, export resize and the video destination folder.
  {
    const { getCaptionState, idsBetween, planProposalApply } = await module('captionEntries');
    assert.equal(getCaptionState({ tags: undefined }), 'missing'); assert.equal(getCaptionState({}), 'missing');
    assert.equal(getCaptionState({ tags: [] }), 'empty', '[] is an empty caption, not a missing one'); assert.equal(getCaptionState({ tags: ['a'] }), 'tagged');
    const ids = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(idsBetween(ids, 'b', 'd'), ['b', 'c', 'd']); assert.deepEqual(idsBetween(ids, 'd', 'b'), ['b', 'c', 'd'], 'a backwards range keeps list order');
    assert.deepEqual(idsBetween(ids, 'c', 'c'), ['c']); assert.deepEqual(idsBetween(ids, null, 'c'), ['c'], 'no anchor selects the target only');
    assert.deepEqual(idsBetween(ids, 'zzz', 'c'), ['c'], 'an anchor that left the list selects the target only'); assert.deepEqual(idsBetween(ids, 'a', 'zzz'), [], 'an unknown target selects nothing');
    assert.deepEqual(idsBetween([], null, 'a'), []);
    const frames = [{ id: 'tagged', tags: ['old'] }, { id: 'empty', tags: [] }, { id: 'missing' }, { id: 'none-suggested', tags: undefined }, { id: 'trigger-only' }];
    const suggestions = { tagged: ['new1', 'new2'], empty: ['e1'], missing: ['m1', 'M2'], 'trigger-only': ['Hero'], 'none-suggested': [] };
    const proposal = item => suggestions[item.id] ?? [];
    assert.deepEqual(planProposalApply(frames, proposal, false).map(entry => [entry.item.id, entry.tags]), [['empty', ['e1']], ['missing', ['m1', 'M2']], ['trigger-only', ['Hero']]],
      'without overwrite a frame with a caption is skipped; [] and a missing caption count as no caption; no suggestion means no entry');
    assert.deepEqual(planProposalApply(frames, proposal, true).map(entry => entry.item.id), ['tagged', 'empty', 'missing', 'trigger-only'], 'overwrite replaces existing captions too');
    assert.deepEqual(planProposalApply(frames, proposal, true, ' hero ').find(entry => entry.item.id === 'trigger-only'), undefined, 'a suggestion that is only the trigger word is dropped (case and spaces ignored)');
    assert.deepEqual(planProposalApply(frames, () => ['Hero', 'x'], true, 'hero').map(entry => entry.tags), [['x'], ['x'], ['x'], ['x'], ['x']], 'the trigger word is never part of the tags');
    assert.deepEqual(planProposalApply([], proposal, true), []);

    const { resolveExportResize, canResizeExportImage, describeExportResize } = await module('exportResize');
    const longest = side => ({ kind: 'longest', side });
    assert.deepEqual(resolveExportResize(200, 100, longest(100)), { width: 100, height: 50 });
    assert.deepEqual(resolveExportResize(100, 200, longest(100)), { width: 50, height: 100 });
    assert.deepEqual(resolveExportResize(1000, 333, longest(100)), { width: 100, height: 33 });
    assert.deepEqual(resolveExportResize(1, 1000, longest(10)), { width: 1, height: 10 }, 'a side never rounds below one pixel');
    assert.equal(resolveExportResize(100, 100, longest(100)), null, 'an image that already fits is unchanged'); assert.equal(resolveExportResize(50, 80, longest(100)), null, 'no upscaling');
    assert.equal(resolveExportResize(300, 100, longest(1000)), null);
    for (const side of [0, -5, Number.NaN]) assert.equal(resolveExportResize(200, 100, longest(side)), null, `side ${side} resizes nothing`);
    for (const [w, h] of [[0, 10], [10, 0], [-1, 5], [Number.NaN, 5]]) assert.equal(resolveExportResize(w, h, longest(5)), null, `size ${w}x${h} is ignored`);
    const bucket = model => ({ kind: 'bucket', model });
    assert.deepEqual(resolveExportResize(1024, 1024, bucket('sd15')), { width: 512, height: 512 });
    assert.deepEqual(resolveExportResize(800, 600, bucket('sd15')), { width: 576, height: 432 }, '4:3 fits the 576x448 bucket');
    assert.deepEqual(resolveExportResize(600, 800, bucket('sd15')), { width: 432, height: 576 }, 'portrait fits the 448x576 bucket');
    assert.equal(resolveExportResize(512, 512, bucket('sd15')), null); assert.equal(resolveExportResize(400, 300, bucket('sd15')), null, 'smaller than its bucket stays as it is');
    assert.deepEqual(resolveExportResize(3000, 3000, bucket('sdxl')), { width: 1024, height: 1024 });
    assert.deepEqual(resolveExportResize(2688, 1536, bucket('flux')), { width: 1344, height: 768 }, 'a wide frame picks the 1344x768 bucket');
    assert.equal(resolveExportResize(2000, 2000, bucket('nope')), null, 'an unknown model resizes nothing');
    assert.equal(describeExportResize(longest(768)), 'longest side 768px'); assert.equal(describeExportResize(bucket('sd15')), 'SD 1.5 buckets');
    for (const name of ['a.png', 'A.PNG', 'dir/x.jpg', 'x.JPEG', 'x.webp']) assert.equal(canResizeExportImage(name), true, name);
    for (const name of ['x.gif', 'x.bmp', 'x.psd', 'x', 'x.png.bak', 'x.constructor', 'x.toString', '']) assert.equal(canResizeExportImage(name), false, `"${name}"`);

    // Fingerprint: the oracle below is the formula from before resize existed.
    const { createExportPlanFingerprint } = await module('exportPlan');
    const hex = digest => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const sha = async data => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
    const entry = { imageName: 'a.png', textName: 'a.txt', caption: 'x', blob: new Blob(['PNG'], { type: 'image/png' }), source: 'a.png', textContent: 'x\n' };
    const legacy = async (scope, entries) => {
      const compact = [scope];
      for (const item of entries) compact.push([[item.imageName, item.textName, item.caption, item.source, item.blob.type, item.blob.size, item.conversion ?? '', ...(item.textContent === undefined ? [] : [item.textContent])], await sha(JSON.stringify([await sha(await item.blob.arrayBuffer())]))]);
      return sha(JSON.stringify(compact));
    };
    const plain = await createExportPlanFingerprint('dataset', [entry]);
    assert.equal(plain, await legacy('dataset', [entry]), 'a plan without resize keeps the fingerprint it had before');
    assert.equal(await createExportPlanFingerprint('dataset', [entry], undefined), plain);
    const resized = await createExportPlanFingerprint('dataset', [entry], longest(1024));
    assert.notEqual(resized, plain, 'resize changes the fingerprint');
    assert.equal(resized, await createExportPlanFingerprint('dataset', [entry], longest(1024)), 'the same resize is stable');
    assert.notEqual(resized, await createExportPlanFingerprint('dataset', [entry], longest(512)), 'another side is another plan');
    assert.notEqual(await createExportPlanFingerprint('dataset', [entry], bucket('sd15')), await createExportPlanFingerprint('dataset', [entry], bucket('sdxl')), 'another model is another plan');
    const planArgs = { scope: 'workspace', dataset: { ...dataset, triggerWord: '' }, blacklist: [], items: [
      { id: 'source:p', sourceImageId: 'p', kind: 'image', fileName: 'p.png', imageData: new Blob(['P'], { type: 'image/png' }), tags: ['t'] },
      { id: 'source:g', sourceImageId: 'g', kind: 'image', fileName: 'g.gif', imageData: new Blob(['G'], { type: 'image/gif' }), tags: ['t'] }] };
    const unresized = await buildExportPlan(planArgs);
    const withResize = await buildExportPlan({ ...planArgs, resize: longest(256) });
    assert.equal('resize' in unresized, false, 'no resize key without the option'); assert.deepEqual(withResize.resize, longest(256));
    assert.notEqual(withResize.fingerprint, unresized.fingerprint);
    assert.deepEqual(unresized.warnings, []); assert.deepEqual(withResize.warnings, ['g.gif is exported without resizing: only PNG, JPEG and WebP can be resized.'], 'only formats that cannot be resized are warned about');

    const { videoFramesDestination } = await module('toolOverlays');
    assert.equal(videoFramesDestination('clip.mp4'), 'Project/inbox/clip'); assert.equal(videoFramesDestination('My Holiday.v2.webm'), 'Project/inbox/My Holiday.v2');
    assert.equal(videoFramesDestination('.hidden.mp4'), 'Project/inbox/hidden', 'a leading dot would make a hidden folder'); assert.equal(videoFramesDestination('...mov'), 'Project/inbox/video');
    assert.equal(videoFramesDestination('a/b\\c:d*e?f"g<h>i|j.mp4'), 'Project/inbox/a_b_c_d_e_f_g_h_i_j', 'characters that are not allowed in a name become underscores');
    assert.equal(videoFramesDestination('bad\u0001name.mp4'), 'Project/inbox/bad_name');
    assert.equal(videoFramesDestination(''), 'Project/inbox/video'); assert.equal(videoFramesDestination('.mp4'), 'Project/inbox/video', 'an empty name falls back to "video"');
    assert.equal(videoFramesDestination('   .mp4'), 'Project/inbox/video'); assert.equal(videoFramesDestination('  spaced name .mov'), 'Project/inbox/spaced name');
    assert.equal(videoFramesDestination('Клип.mp4'), 'Project/inbox/Клип', 'Unicode names are kept'); assert.equal(videoFramesDestination('no-extension'), 'Project/inbox/no-extension');
    assert.equal(videoFramesDestination(`${'x'.repeat(200)}.mp4`).split('/').pop().length, 80, 'long names are cut to 80 characters');
  }

  // Exercise the Photopea protocol and cancellation without an external service.
  const messages = new Set(); let iframe; let removed = false; const posted = [];
  globalThis.window = { setTimeout, clearTimeout, addEventListener: (_, callback) => messages.add(callback), removeEventListener: (_, callback) => messages.delete(callback) };
  globalThis.document = { createElement: () => (iframe = { style: {}, contentWindow: { postMessage: (...args) => posted.push(args) }, remove: () => { removed = true; } }), body: { appendChild() {} } };
  const psdAbort = new AbortController(); const conversion = convertPsdToPng({ fileName: 'test.psd', file: new Blob(['psd']) }, undefined, psdAbort.signal);
  psdAbort.abort(); await assert.rejects(conversion, { name: 'AbortError' }); assert.ok(removed); assert.equal(messages.size, 0);
  const completed = convertPsdToPng({ fileName: 'test.psd', file: new Blob(['psd']) });
  const send = data => [...messages].forEach(callback => callback({ source: iframe.contentWindow, origin: 'https://www.photopea.com', data }));
  send('done'); await Promise.resolve(); send('done');
  const png = new Uint8Array([137, 80, 78, 71]); send(png.buffer);
  assert.deepEqual(new Uint8Array(await (await completed).arrayBuffer()), png);
  assert.equal(messages.size, 0); assert.ok(posted.some(args => typeof args[0] === 'string' && args[0].includes('saveToOE')));
  console.log('PASS: workspace history identifiers and URL cleanup, keyboard layouts, save failure/retry/serialization, ZIP/folder preview parity, captions/scopes/order, PSD conversion protocol/cancel, collisions, permission errors and export cancellation.');
} finally { await rm(temp, { recursive: true, force: true }); }
