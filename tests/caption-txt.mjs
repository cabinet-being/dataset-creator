import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';
import JSZip from 'jszip';

// TXT is the only caption source: format, mutations (with Undo), trigger rewrites, boundary moves, export, import and the sidecar migration.
globalThis.Image = class {
  naturalWidth = 1;
  naturalHeight = 1;
  set src(_value) { queueMicrotask(() => this.onload?.()); }
};
globalThis.window ??= { setTimeout, clearTimeout, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} };

const temp = await mkdtemp(join(tmpdir(), 'caption-txt-'));
try {
  await build({
    input: ['src/services/caption/captionFileService.ts', 'src/services/caption/captionMutationService.ts', 'src/services/project/layoutMigrationService.ts', 'src/services/dataset/datasetFolderService.ts', 'src/services/project/projectDirectoryService.ts', 'src/services/export/datasetExportService.ts', 'src/services/export/exportPlan.ts', 'src/services/import/importService.ts', 'src/stores/useProjectStore.ts', 'src/stores/useUIStore.ts', 'src/stores/useHistoryStore.ts', 'src/types/index.ts'],
    platform: 'node', logLevel: 'silent', output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const load = (name) => import(pathToFileURL(join(temp, `${name}.mjs`)));
  const captions = await load('captionFileService');
  const { persistCaptionTagsForItems, rewriteTriggerWord } = await load('captionMutationService');
  const migration = await load('layoutMigrationService');
  const { addItemsToDatasetFolder, removeItemsFromDatasetFolder, reverseDatasetFolderChanges } = await load('datasetFolderService');
  const { createProjectDirectory } = await load('projectDirectoryService');
  const { buildExportPlan, getExportEntryText, exportPlanAsZip } = await load('exportPlan');
  const { importImageFiles } = await load('importService');
  const { useProjectStore } = await load('useProjectStore');
  const { useUIStore } = await load('useUIStore');
  const { useHistoryStore } = await load('useHistoryStore');
  const { createProject } = await load('index');

  // In-memory File System Access handles (tree, removal, content read back as text).
  const directory = (name = 'root') => {
    const entries = new Map();
    return {
      name, entries: async function* () { yield* entries; },
      async getDirectoryHandle(child, options) {
        if (!entries.has(child) && options?.create) entries.set(child, directory(child));
        if (!entries.has(child)) throw new DOMException('Missing', 'NotFoundError');
        if (!('entries' in entries.get(child))) throw new DOMException('Not a directory', 'TypeMismatchError');
        return entries.get(child);
      },
      async getFileHandle(child, options) {
        if (!entries.has(child) && options?.create) {
          let contents = '';
          const handle = { name: child, writes: 0, getFile: async () => new File([contents], child), createWritable: async () => { handle.writes += 1; return { write: async (data) => { contents = data; }, close: async () => {} }; } };
          entries.set(child, handle);
        }
        if (!entries.has(child)) throw new DOMException('Missing', 'NotFoundError');
        if ('entries' in entries.get(child)) throw new DOMException('Not a file', 'TypeMismatchError');
        return entries.get(child);
      },
      async removeEntry(child) { if (!entries.has(child)) throw new DOMException('Missing', 'NotFoundError'); entries.delete(child); },
    };
  };
  const dirAt = async (root, path, create = false) => {
    let current = root;
    for (const part of path.split('/').filter(Boolean)) current = await current.getDirectoryHandle(part, { create });
    return current;
  };
  const put = async (root, path, data) => {
    const parts = path.split('/'); const name = parts.pop();
    const writer = await (await (await dirAt(root, parts.join('/'), true)).getFileHandle(name, { create: true })).createWritable();
    await writer.write(data); await writer.close();
  };
  const read = async (root, path) => {
    const parts = path.split('/'); const name = parts.pop();
    try { return await (await (await dirAt(root, parts.join('/'))).getFileHandle(name)).getFile().then((file) => file.text()); }
    catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
  };
  const tree = async (root, prefix = '', skip = () => false) => {
    const result = {};
    for await (const [name, entry] of root.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (skip(path)) continue;
      if ('entries' in entry) Object.assign(result, await tree(entry, path, skip));
      else result[path] = await (await entry.getFile()).text();
    }
    return result;
  };
  const png = (text = 'png') => new Blob([text], { type: 'image/png' });
  const setTrigger = (triggerWord) => useProjectStore.setState((state) => ({ dataset: { ...state.dataset, triggerWord } }));
  const notifications = () => useUIStore.getState().notifications.map((entry) => entry.message);

  // 1. Text format: parse / render round trip.
  {
    const { parseCaptionText, renderCaptionText, validateTriggerWord, getCaptionFileName, getCaptionPathForImage, isDatasetCaptionPath, getCaptionTriggerForPath, reconcileCaptionRaw } = captions;
    assert.deepEqual(parseCaptionText('Кіт, Blue Sky\r\nsecond'), { tags: ['Кіт', 'Blue Sky', 'second'], triggerPresent: true }, 'BOM, CRLF and Unicode');
    assert.deepEqual(parseCaptionText('a\rb', ''), { tags: ['a', 'b'], triggerPresent: true }, 'a lone CR is a line break');
    assert.deepEqual(parseCaptionText(''), { tags: [], triggerPresent: true });
    assert.deepEqual(parseCaptionText('', 'T'), { tags: [], triggerPresent: false }, 'an empty file lacks the trigger');
    assert.deepEqual(parseCaptionText(' , ,\n', 'T'), { tags: [], triggerPresent: false });
    assert.deepEqual(parseCaptionText('T\n', 'T'), { tags: [], triggerPresent: true }, 'only the trigger');
    assert.deepEqual(parseCaptionText('t, x', 'T'), { tags: ['x'], triggerPresent: true }, 'trigger is matched case-insensitively');
    assert.deepEqual(parseCaptionText('a, T', 'T'), { tags: ['a', 'T'], triggerPresent: false }, 'a trigger that is not first is a normal tag');
    assert.equal(renderCaptionText([]), '', 'no tags and no trigger is an empty file');
    assert.equal(renderCaptionText([], 'T'), 'T\n');
    assert.equal(renderCaptionText(['a', 'A', ' b ', 'a', ''], 'T'), 'T, a, b\n', 'case-insensitive duplicates and blanks are dropped');
    assert.equal(renderCaptionText(['t', 'x'], 'T'), 'T, x\n', 'a tag equal to the trigger is not repeated');
    assert.equal(renderCaptionText(['x', 'y']), 'x, y\n');
    for (const raw of ['T, a, b\n', 'T\n', '']) assert.equal(renderCaptionText(parseCaptionText(raw, 'T').tags, raw ? 'T' : undefined), raw, `round trip of ${JSON.stringify(raw)}`);
    assert.equal(renderCaptionText(parseCaptionText('T, a\r\nb', 'T').tags, 'T'), 'T, a, b\n', 'rendering normalizes BOM and CRLF');
    assert.notEqual(validateTriggerWord('a, b'), null);
    assert.notEqual(validateTriggerWord('a\nb'), null);
    assert.notEqual(validateTriggerWord('a\rb'), null);
    assert.equal(validateTriggerWord('my style'), null);
    assert.equal(getCaptionFileName('a.PNG'), 'a.txt'); assert.equal(getCaptionFileName('a.psd'), 'a.txt');
    assert.equal(getCaptionFileName('a.txt'), null); assert.equal(getCaptionFileName('clip.mp4'), null);
    assert.equal(getCaptionPathForImage('Project/dataset/a.b.png'), 'Project/dataset/a.b.txt');
    assert.equal(isDatasetCaptionPath('Project/dataset/a.png'), true); assert.equal(isDatasetCaptionPath('dataset/sub/a.png'), true);
    assert.equal(isDatasetCaptionPath('Project/inbox/a.png'), false); assert.equal(isDatasetCaptionPath('Project/dataset-old/a.png'), false);
    assert.equal(getCaptionTriggerForPath('dataset/a.png', '  my   style '), 'my style');
    assert.equal(getCaptionTriggerForPath('inbox/a.png', 'T'), undefined); assert.equal(getCaptionTriggerForPath('dataset/a.png', ' '), undefined);
    assert.equal(reconcileCaptionRaw('x\n', 'add', 'T'), 'T, x\n'); assert.equal(reconcileCaptionRaw('T, x\n', 'add', 'T'), null);
    assert.equal(reconcileCaptionRaw('T, x\n', 'remove', 'T'), 'x\n'); assert.equal(reconcileCaptionRaw('x\n', 'remove', 'T'), null);
    assert.equal(reconcileCaptionRaw(null, 'add', 'T'), null); assert.equal(reconcileCaptionRaw('x', 'add', ''), null);
    assert.equal(reconcileCaptionRaw('T\n', 'remove', 'T'), '', 'removing the trigger from a trigger-only caption leaves an empty file');
  }

  // 2. [] is an empty file, undefined is no file; reading never rewrites.
  {
    const root = directory();
    await put(root, 'inbox/a.png', png());
    await captions.writeCaptionFile(root, 'inbox/a.png', []);
    assert.equal(await read(root, 'inbox/a.txt'), '');
    assert.deepEqual(await captions.readCaptionFile(root, 'inbox/a.png'), { raw: '', tags: [], triggerPresent: true });
    await captions.writeCaptionFile(root, 'inbox/a.png', undefined);
    assert.equal(await read(root, 'inbox/a.txt'), null, 'undefined removes the file');
    assert.deepEqual(await captions.readCaptionFile(root, 'inbox/a.png'), { raw: null, tags: undefined, triggerPresent: true });
    await put(root, 'dataset/b.png', png()); await put(root, 'inbox/c.png', png());
    await captions.writeCaptionFile(root, 'dataset/b.png', []);
    assert.equal(await read(root, 'dataset/b.txt'), '', 'without a trigger word [] is an empty file');
    await captions.writeCaptionFile(root, 'dataset/b.png', [], 'T');
    assert.equal(await read(root, 'dataset/b.txt'), 'T\n', 'in dataset/ an empty caption still carries the trigger');
    await captions.writeCaptionFile(root, 'inbox/c.png', ['x', 'y'], 'T');
    assert.equal(await read(root, 'inbox/c.txt'), 'x, y\n', 'outside dataset/ the trigger is not written');
    await put(root, 'dataset/d.png', png()); await put(root, 'dataset/d.txt', 'no trigger here\r\n');
    const handle = await (await dirAt(root, 'dataset')).getFileHandle('d.txt');
    const dataset = await captions.readCaptionFile(root, 'dataset/d.png', 'T');
    assert.deepEqual({ ...dataset }, { raw: 'no trigger here\r\n', tags: ['no trigger here'], triggerPresent: false });
    assert.equal(captions.isTriggerMissing(dataset), true);
    assert.equal(captions.isTriggerMissing(await captions.readCaptionFile(root, 'dataset/missing.png', 'T')), false, 'no file is not a missing trigger');
    assert.equal(handle.writes, 1, 'only the initial write happened');
    assert.equal(await read(root, 'dataset/d.txt'), 'no trigger here\r\n', 'reading does not repair or normalize the file');
  }

  // 3. persistCaptionTagsForItems writes TXT, Undo restores the raw text and respects outside edits.
  {
    const root = directory();
    await put(root, 'inbox/a.png', png()); await put(root, 'inbox/a.txt', 'old, text\r\n');
    await put(root, 'inbox/new.png', png());
    await put(root, 'dataset/b.png', png()); await put(root, 'dataset/b.txt', 'T, before\n');
    await put(root, 'dataset/missing.png', png());
    useProjectStore.setState({ id: 'caption-txt-project' }); setTrigger('T');
    useHistoryStore.setState({ past: [], future: [] }); useUIStore.setState({ notifications: [] });
    const item = (path, tags) => ({ id: `asset:Project/${path}`, sourceImageId: '', assetPath: `Project/${path}`, fileName: path.split('/').pop(), kind: 'image', tags });
    const items = [item('inbox/a.png', ['old', 'text']), item('inbox/new.png', undefined), item('dataset/b.png', ['before']), item('dataset/missing.png', undefined)];
    const next = { 'asset:Project/inbox/a.png': ['changed'], 'asset:Project/inbox/new.png': ['x', 'X', 'y'], 'asset:Project/dataset/b.png': ['after'], 'asset:Project/dataset/missing.png': [] };
    let flushes = 0;
    assert.equal(await persistCaptionTagsForItems({ items, resolveTags: (entry) => next[entry.id], directory: root, flush: async () => { flushes += 1; } }), 4);
    assert.equal(await read(root, 'inbox/a.txt'), 'changed\n');
    assert.equal(await read(root, 'inbox/new.txt'), 'x, y\n', 'outside dataset/ there is no trigger and duplicates are dropped');
    assert.equal(await read(root, 'dataset/b.txt'), 'T, after\n', 'dataset/ captions start with the trigger');
    assert.equal(await read(root, 'dataset/missing.txt'), 'T\n', 'an empty caption in dataset/ is the trigger alone');
    assert.equal(useHistoryStore.getState().past.length, 1, 'one undo entry for the batch');
    await useHistoryStore.getState().undo();
    assert.equal(await read(root, 'inbox/a.txt'), 'old, text\r\n', 'Undo restores the exact previous bytes');
    assert.equal(await read(root, 'inbox/new.txt'), null, 'Undo removes a file that did not exist before');
    assert.equal(await read(root, 'dataset/b.txt'), 'T, before\n');
    assert.equal(await read(root, 'dataset/missing.txt'), null);
    await useHistoryStore.getState().redo();
    assert.equal(await read(root, 'inbox/new.txt'), 'x, y\n'); assert.equal(await read(root, 'dataset/missing.txt'), 'T\n');
    assert.equal(flushes, 3, 'save runs for edit, undo and redo');
    // An outside edit made after the change is never overwritten by Undo.
    await put(root, 'inbox/a.txt', 'edited elsewhere\n');
    await useHistoryStore.getState().undo();
    assert.equal(await read(root, 'inbox/a.txt'), 'edited elsewhere\n', 'Undo leaves an externally changed file untouched');
    assert.equal(await read(root, 'inbox/new.txt'), null, 'the other files of the entry are still restored');
    assert.equal(await read(root, 'dataset/b.txt'), 'T, before\n');
    assert.ok(notifications().some((message) => /changed on disk/.test(message)), 'the user is told that a file was left alone');
    // Videos cannot carry a caption.
    assert.equal(await persistCaptionTagsForItems({ items: [{ ...item('inbox/clip.mp4', undefined), kind: 'video' }], resolveTags: () => ['x'], directory: root }), 0);
    assert.equal(await read(root, 'inbox/clip.txt'), null);
  }

  // 4. Changing the trigger word rewrites dataset/ captions through a journal and can be undone.
  {
    const root = directory();
    for (const [path, text] of [['dataset/a.txt', 'Old, x\n'], ['dataset/sub/b.txt', 'Old\n'], ['dataset/c.txt', 'x, y\n'], ['dataset/e.txt', 'old, low\r\n'], ['inbox/f.txt', 'Old, z\n']]) {
      await put(root, path.replace(/\.txt$/, '.png'), png()); await put(root, path, text);
    }
    await put(root, 'dataset/d.png', png()); // no caption file
    const project = createProject('Trigger', 'character'); project.dataset = { ...project.dataset, triggerWord: 'Old' };
    useProjectStore.getState().loadProject(project);
    useHistoryStore.setState({ past: [], future: [] }); useUIStore.setState({ notifications: [] });
    const dataset = () => useProjectStore.getState().dataset.triggerWord;
    await assert.rejects(rewriteTriggerWord({ directory: root, newTrigger: 'a, b' }), /comma/i);
    assert.equal(dataset(), 'Old', 'an invalid trigger changes nothing');
    assert.deepEqual(await rewriteTriggerWord({ directory: root, newTrigger: 'Old' }), { rewritten: 0, skipped: 0 }, 'the same trigger is a no-op');
    const result = await rewriteTriggerWord({ directory: root, newTrigger: ' New ' });
    assert.deepEqual(result, { rewritten: 3, skipped: 1 });
    assert.equal(dataset(), 'New');
    assert.equal(await read(root, 'dataset/a.txt'), 'New, x\n');
    assert.equal(await read(root, 'dataset/sub/b.txt'), 'New\n');
    assert.equal(await read(root, 'dataset/e.txt'), 'New, low\n', 'trigger matching is case-insensitive and the file is normalized');
    assert.equal(await read(root, 'dataset/c.txt'), 'x, y\n', 'a caption that lost its trigger is skipped');
    assert.equal(await read(root, 'inbox/f.txt'), 'Old, z\n', 'only dataset/ captions are rewritten');
    assert.equal(await read(root, 'dataset/d.txt'), null, 'images without a caption file stay without one');
    assert.deepEqual(Object.keys(await tree(root, '', (path) => !path.startsWith('.datasetcreator/journal'))).filter((path) => path.endsWith('.json')), [], 'the finished batch leaves no journal behind');
    await useHistoryStore.getState().undo();
    assert.equal(dataset(), 'Old');
    assert.equal(await read(root, 'dataset/a.txt'), 'Old, x\n'); assert.equal(await read(root, 'dataset/e.txt'), 'old, low\r\n', 'Undo restores the original bytes');
    assert.equal(await read(root, 'dataset/c.txt'), 'x, y\n');
    await useHistoryStore.getState().redo();
    assert.equal(dataset(), 'New'); assert.equal(await read(root, 'dataset/sub/b.txt'), 'New\n');
    // A file edited after the rewrite is left alone by Undo.
    await put(root, 'dataset/a.txt', 'New, hand edited\n');
    await useHistoryStore.getState().undo();
    assert.equal(await read(root, 'dataset/a.txt'), 'New, hand edited\n');
    assert.equal(await read(root, 'dataset/sub/b.txt'), 'Old\n');
    assert.ok(notifications().some((message) => /changed on disk/.test(message)));
    // Clearing the trigger removes it from the captions that carry it.
    useProjectStore.getState().loadProject(project);
    await put(root, 'dataset/a.txt', 'Old, x\n'); await put(root, 'dataset/sub/b.txt', 'Old\n');
    const cleared = await rewriteTriggerWord({ directory: root, newTrigger: '' });
    assert.equal(cleared.rewritten, 3);
    assert.equal(await read(root, 'dataset/a.txt'), 'x\n'); assert.equal(await read(root, 'dataset/sub/b.txt'), '');
  }

  // 5. Moving across the dataset/ boundary adds or removes the trigger.
  {
    const root = directory();
    const project = createProject('Boundary', 'character'); project.dataset = { ...project.dataset, triggerWord: 'T' };
    await createProjectDirectory(root, project);
    await put(root, 'inbox/p.png', png('pixels')); await put(root, 'inbox/p.txt', 'plain, caption\n');
    await put(root, 'inbox/q.png', png('pixels')); await put(root, 'inbox/q.txt', 'T, already\n');
    await put(root, 'inbox/r.png', png('pixels')); // no caption
    useProjectStore.getState().loadProject(project);
    // Node has no IndexedDB: keep the store updates in memory only.
    const originalActions = { addSourceImage: useProjectStore.getState().addSourceImage, updateSourceImage: useProjectStore.getState().updateSourceImage };
    useProjectStore.setState({
      addSourceImage: (image) => useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, [image.id]: image } })),
      updateSourceImage: (id, updates) => useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, [id]: { ...state.sourceImages[id], ...updates } } })),
    });
    useUIStore.getState().setProjectDirectory({ handle: root, name: project.name });
    const entry = (path) => ({ id: `asset:Project/${path}`, sourceImageId: '', kind: 'image', label: 'Image', displayIdentity: '1', fileName: path.split('/').pop(), assetPath: `Project/${path}`, imageData: png('pixels'), width: 1, height: 1, aspectRatio: '1:1' });
    const added = await addItemsToDatasetFolder(root, ['inbox/p.png', 'inbox/q.png', 'inbox/r.png'].map(entry));
    assert.equal(added.completed.length, 3);
    assert.equal(await read(root, 'dataset/p.txt'), 'T, plain, caption\n', 'moving into dataset/ adds the trigger');
    assert.equal(await read(root, 'dataset/q.txt'), 'T, already\n', 'an existing trigger is not duplicated');
    assert.equal(await read(root, 'dataset/r.txt'), null, 'no caption file is created for an image without one');
    assert.equal(await read(root, 'inbox/p.txt'), null, 'the TXT moves with the image');
    const removed = await removeItemsFromDatasetFolder(root, ['dataset/p.png', 'dataset/q.png'].map(entry));
    assert.equal(removed.completed.length, 2);
    assert.equal(await read(root, 'inbox/p.txt'), 'plain, caption\n', 'moving out of dataset/ removes the trigger');
    assert.equal(await read(root, 'inbox/q.txt'), 'already\n');
    const redone = await reverseDatasetFolderChanges(root, removed.completed);
    assert.equal(await read(root, 'dataset/p.txt'), 'T, plain, caption\n', 'reversing a move out of dataset/ adds the trigger back');
    const undone = await reverseDatasetFolderChanges(root, redone);
    assert.equal(await read(root, 'inbox/p.txt'), 'plain, caption\n');
    assert.equal(undone.length, 2);
    // A whole folder: every image caption inside is reconciled, other files are left alone.
    await put(root, 'dataset/pack/one.png', png()); await put(root, 'dataset/pack/one.txt', 'x\n');
    await put(root, 'dataset/pack/deep/two.png', png()); await put(root, 'dataset/pack/deep/two.txt', 'T, y\n');
    await put(root, 'dataset/pack/deep/three.png', png()); await put(root, 'dataset/pack/deep/three.txt', '');
    await put(root, 'dataset/pack/notes.txt', 'free text');
    await captions.reconcileTriggerAfterMove(root, { from: 'Project/inbox/pack', to: 'Project/dataset/pack' }, 'T');
    assert.equal(await read(root, 'dataset/pack/one.txt'), 'T, x\n'); assert.equal(await read(root, 'dataset/pack/deep/two.txt'), 'T, y\n');
    assert.equal(await read(root, 'dataset/pack/deep/three.txt'), 'T\n', 'an empty caption becomes the trigger alone');
    assert.equal(await read(root, 'dataset/pack/notes.txt'), 'free text', 'text files without an image are not captions');
    await captions.reconcileTriggerAfterMove(root, { from: 'Project/dataset/pack', to: 'Project/inbox/pack' }, 'T'); // `to` is where the files are now
    assert.equal(await read(root, 'dataset/pack/one.txt'), 'T, x\n', 'a move inside the same side of the boundary does nothing');
    await put(root, 'inbox/pack2/one.png', png()); await put(root, 'inbox/pack2/one.txt', 'T, x, z\n'); await put(root, 'inbox/pack2/deep/two.png', png()); await put(root, 'inbox/pack2/deep/two.txt', 'T\n');
    await captions.reconcileTriggerAfterMove(root, { from: 'Project/dataset/pack2', to: 'Project/inbox/pack2' }, 'T');
    assert.equal(await read(root, 'inbox/pack2/one.txt'), 'x, z\n'); assert.equal(await read(root, 'inbox/pack2/deep/two.txt'), '');
    await captions.reconcileTriggerAfterMove(root, { from: 'Project/inbox/p.png', to: 'Project/dataset/p.png' }, ''); // no trigger configured
    assert.equal(await read(root, 'inbox/p.txt'), 'plain, caption\n', 'without a trigger word nothing is added');
    useProjectStore.setState(originalActions);
  }

  // 5b. A batch of files crossing dataset/ updates paths and the registry once, keeps the trigger, and one Undo reverts the batch.
  {
    const root = directory();
    const project = createProject('Batch', 'character'); project.dataset = { ...project.dataset, triggerWord: 'T' };
    await createProjectDirectory(root, project);
    const names = ['a', 'b', 'c', 'd'];
    for (const name of names) { await put(root, `inbox/${name}.png`, png(name)); await put(root, `inbox/${name}.txt`, `cap-${name}\n`); }
    useProjectStore.getState().loadProject(project);
    const original = { addSourceImage: useProjectStore.getState().addSourceImage, updateSourceImage: useProjectStore.getState().updateSourceImage };
    useProjectStore.setState({
      addSourceImage: (image) => useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, [image.id]: image } })),
      updateSourceImage: (id, updates) => useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, [id]: { ...state.sourceImages[id], ...updates } } })),
    });
    useUIStore.getState().setProjectDirectory({ handle: root, name: project.name });
    const sources = Object.fromEntries(names.map((name) => [`s-${name}`, { id: `s-${name}`, originalFilePath: `inbox/${name}.png`, fileName: `${name}.png` }]));
    useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, ...sources } }));
    const items = () => names.map((name) => ({ id: `asset:${name}`, sourceImageId: `s-${name}`, kind: 'image', label: 'Image', displayIdentity: '1', fileName: `${name}.png`, assetPath: `Project/${useProjectStore.getState().sourceImages[`s-${name}`].originalFilePath}`, imageData: png(name), width: 1, height: 1, aspectRatio: '1:1' }));
    const registryWrites = async () => (await (await dirAt(root, '.datasetcreator')).getFileHandle('assets.json').catch(() => ({ writes: 0 }))).writes;
    const paths = () => names.map((name) => useProjectStore.getState().sourceImages[`s-${name}`].originalFilePath);
    let moveEvents = 0; const onMoves = (event) => { moveEvents += 1; void event; };
    const hadWindow = globalThis.window; globalThis.window ??= {};
    const listeners = []; const originalDispatch = globalThis.window.dispatchEvent; const originalCustomEvent = globalThis.CustomEvent;
    globalThis.window.dispatchEvent = (event) => { listeners.push(event); onMoves(event); return true; };
    globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    try {
      const before = await registryWrites();
      const added = await addItemsToDatasetFolder(root, items());
      assert.equal(added.completed.length, names.length); assert.deepEqual(added.failed, []);
      assert.deepEqual(paths(), names.map((name) => `dataset/${name}.png`), 'every source image path follows the batch');
      assert.equal(moveEvents, 1, 'one path-change notification for the whole batch');
      assert.equal(listeners[0].detail.length, names.length);
      assert.equal(await registryWrites() - before, 1, 'assets.json is written once for the whole batch, not per file');
      for (const name of names) {
        assert.equal(await read(root, `dataset/${name}.txt`), `T, cap-${name}\n`, 'trigger added on the way in');
        assert.equal(await read(root, `inbox/${name}.png`), null);
      }
      // The history entry is one reverse call over the whole batch.
      const undone = await reverseDatasetFolderChanges(root, added.completed);
      assert.equal(undone.length, names.length);
      assert.deepEqual(paths(), names.map((name) => `inbox/${name}.png`), 'one reverse restores every path');
      for (const name of names) {
        assert.equal(await read(root, `inbox/${name}.txt`), `cap-${name}\n`, 'trigger removed again by Undo');
        assert.equal(await read(root, `inbox/${name}.png`), name);
      }
      const redone = await reverseDatasetFolderChanges(root, undone);
      assert.deepEqual(paths(), names.map((name) => `dataset/${name}.png`), 'Redo moves the whole batch again');
      moveEvents = 0;
      const removed = await removeItemsFromDatasetFolder(root, items());
      assert.equal(removed.completed.length, names.length);
      assert.deepEqual(paths(), names.map((name) => `inbox/${name}.png`));
      assert.equal(moveEvents, 1);
      for (const name of names) assert.equal(await read(root, `inbox/${name}.txt`), `cap-${name}\n`, 'trigger removed on the way out');
      await reverseDatasetFolderChanges(root, removed.completed);
      assert.deepEqual(paths(), names.map((name) => `dataset/${name}.png`), 'one reverse puts the batch back into dataset/');
      for (const name of names) assert.equal(await read(root, `dataset/${name}.txt`), `T, cap-${name}\n`);
      void redone;
    } finally {
      if (hadWindow) globalThis.window.dispatchEvent = originalDispatch; else delete globalThis.window;
      if (originalCustomEvent) globalThis.CustomEvent = originalCustomEvent; else delete globalThis.CustomEvent;
      useProjectStore.setState(original);
    }
  }

  // 5c. Removing from dataset/ returns each image to the inbox folder it came from (record origin); a missing, unknown or non-inbox origin means the inbox root.
  {
    const root = directory();
    const project = createProject('Origin', 'character'); project.dataset = { ...project.dataset, triggerWord: 'T' };
    await createProjectDirectory(root, project);
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const name of names) { await put(root, `dataset/${name}.png`, png(name)); await put(root, `dataset/${name}.txt`, `T, cap-${name}\n`); }
    await put(root, 'inbox/day1/keep.png', png('k1')); await put(root, 'inbox/day2/deep/keep.png', png('k2'));
    useProjectStore.getState().loadProject(project);
    const original = { addSourceImage: useProjectStore.getState().addSourceImage, updateSourceImage: useProjectStore.getState().updateSourceImage };
    useProjectStore.setState({
      addSourceImage: (image) => useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, [image.id]: image } })),
      updateSourceImage: (id, updates) => useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, [id]: { ...state.sourceImages[id], ...updates } } })),
    });
    useUIStore.getState().setProjectDirectory({ handle: root, name: project.name });
    const sources = Object.fromEntries(names.map((name) => [`s-${name}`, { id: `s-${name}`, originalFilePath: `dataset/${name}.png`, fileName: `${name}.png` }]));
    useProjectStore.setState((state) => ({ sourceImages: { ...state.sourceImages, ...sources } }));
    const record = (name, origin) => [`source:s-${name}`, { assetId: `source:s-${name}`, decision: 'unreviewed', application: 'idle', validation: 'pending', revision: 'r', updatedAt: 'now', ...(origin ? { origin } : {}) }];
    const session = { ...useProjectStore.getState().buildSession, records: Object.fromEntries([
      record('a', 'Project/inbox/day1'), record('b', 'Project/inbox/day2/deep'), record('c', 'Project/inbox/gone'),
      record('d', 'Project/other/day1'), record('e'), record('g', 'Project/inbox/day1'),
    ]) };
    useProjectStore.setState({ buildSession: session }); // f has no record at all
    const items = (list) => list.map((name) => ({ id: `asset:${name}`, sourceImageId: `s-${name}`, kind: 'image', label: 'Image', displayIdentity: '1', fileName: `${name}.png`, assetPath: `Project/dataset/${name}.png`, imageData: png(name), width: 1, height: 1, aspectRatio: '1:1' }));
    try {
      const removed = await removeItemsFromDatasetFolder(root, items(['a', 'b', 'c', 'd', 'e', 'f']));
      assert.deepEqual(removed.failed, []);
      assert.equal(removed.completed.length, 6, 'several destination folders are processed in one result');
      assert.equal(await read(root, 'inbox/day1/a.png'), 'a', 'known existing origin: back to its folder');
      assert.equal(await read(root, 'inbox/day2/deep/b.png'), 'b', 'a nested origin is used as is');
      for (const name of ['c', 'd', 'e', 'f']) assert.equal(await read(root, `inbox/${name}.png`), name, `${name}: unknown, missing or non-inbox origin goes to the inbox root`);
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(await read(root, `dataset/${name}.png`), null);
      assert.equal(await read(root, 'inbox/day1/a.txt'), 'cap-a\n', 'the trigger word is removed on the way out');
      // A batch with one folder is a single move; an origin equal to the inbox root stays there.
      useProjectStore.setState({ buildSession: { ...useProjectStore.getState().buildSession, records: { ...useProjectStore.getState().buildSession.records, ...Object.fromEntries([record('g', 'Project/inbox')]) } } });
      const single = await removeItemsFromDatasetFolder(root, items(['g']));
      assert.deepEqual(single.failed, []);
      assert.equal(await read(root, 'inbox/g.png'), 'g');
    } finally { useProjectStore.setState(original); }
  }

  // 6. Dataset export copies the TXT byte for byte; images without a TXT get none.
  {
    const root = directory();
    await put(root, 'dataset/a.png', png('A')); await put(root, 'dataset/a.txt', 'T, blocked, tag\r\n');
    await put(root, 'dataset/3_class/b.png', png('B')); await put(root, 'dataset/3_class/b.txt', 'T');
    await put(root, 'dataset/c.png', png('C')); // no TXT
    await put(root, 'dataset/a.png.manifest.json', JSON.stringify({ tags: ['sidecar'] }));
    const plan0 = await buildExportPlan({ scope: 'dataset', items: [], dataset: createProject('Export', 'character').dataset, directory: root, blacklist: [] });
    const blob = await exportPlanAsZip(plan0), count = plan0.entries.length;
    assert.equal(count, 3);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const files = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
    assert.equal(files.filter((name) => name.endsWith('.png')).length, 3);
    assert.equal(files.filter((name) => name.endsWith('.txt')).length, 2, 'the image without a TXT gets no .txt in the export');
    const text = async (name) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await zip.file(name).async('uint8array'));
    const names = files.filter((name) => name.endsWith('.txt'));
    assert.deepEqual((await Promise.all(names.map((name) => text(name)))).sort(), ['T', 'T, blocked, tag\r\n'].sort(), 'TXT content (CRLF included) is exported unchanged');
    assert.ok(names.includes('3_class/b.txt'));
    const dataset = { ...createProject('Export', 'character').dataset, triggerWord: 'T' };
    const plan = await buildExportPlan({ scope: 'dataset', items: [], dataset, directory: root, blacklist: ['blocked', 'T'] });
    assert.equal(plan.entries.length, 3);
    assert.deepEqual(plan.entries.map((entry) => getExportEntryText(entry)).sort((x, y) => String(x).localeCompare(String(y))), [null, 'T', 'T, blocked, tag\r\n'].sort((x, y) => String(x).localeCompare(String(y))), 'no blacklist and no second trigger');
    assert.deepEqual(plan.warnings, ['c.png has no caption file; it is exported without a .txt.']);
  }

  // 7. Import: an image without a txt has tags undefined; a paired txt gives tags.
  {
    // Canvas work is irrelevant here: a canvas that accepts every call is enough for thumbnails, hashes and embeddings.
    const context = new Proxy({}, { get: (_target, key) => key === 'getImageData' ? (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) : () => undefined, set: () => true });
    globalThis.document = { createElement: () => ({ width: 1, height: 1, getContext: () => context, toBlob: (callback) => callback(new Blob(['thumb'], { type: 'image/jpeg' })), toDataURL: () => 'data:image/png;base64,' }) };
    const logger = { info() {}, error(message) { throw new Error(message); }, warning() {}, success() {}, progress() {} };
    const alone = await importImageFiles([new File(['x'], 'plain.png', { type: 'image/png' })], { logger });
    assert.equal(alone.importedImages.length, 1);
    assert.equal(alone.importedImages[0].tags, undefined, 'no txt means no caption, not an empty one');
    const paired = await importImageFiles([new File(['x'], 'cat.png', { type: 'image/png' }), new File(['Кіт, Blue Sky\r\n'], 'cat.txt', { type: 'text/plain' }), new File(['x'], 'empty.png', { type: 'image/png' }), new File([''], 'empty.txt', { type: 'text/plain' })], { logger });
    assert.equal(paired.importedImages.length, 2);
    assert.deepEqual(paired.importedImages.map((image) => image.tags), [['Кіт', 'Blue Sky'], []], 'a paired txt gives the tags (BOM, CRLF and Unicode handled); an empty txt gives an empty caption');
  }

  // 8. Sidecar tags become TXT captions, once.
  {
    const makeV3 = async () => {
      const root = directory();
      const project = createProject('Migration', 'character'); project.dataset = { ...project.dataset, triggerWord: 'T' };
      await createProjectDirectory(root, project);
      const projectJson = async () => JSON.parse(await read(root, '.datasetcreator/project.json'));
      const json = await projectJson(); delete json.project.migrations.captionsTxt; if (!Object.keys(json.project.migrations).length) delete json.project.migrations;
      await put(root, '.datasetcreator/project.json', JSON.stringify(json));
      const sidecar = (path, extra) => put(root, `${path}.manifest.json`, JSON.stringify({ id: path, ...extra }));
      for (const path of ['inbox/a.png', 'dataset/b.png', 'dataset/c.png', 'dataset/d.png', 'dataset/e.png', 'inbox/s.jpg', 'inbox/s.png', 'dataset/f.png']) await put(root, path, png(path));
      await sidecar('inbox/a.png', { tags: ['x', 'y'] }); await put(root, 'inbox/a.txt', 'old text\n');
      await sidecar('dataset/b.png', { tags: ['p'] });
      await put(root, 'dataset/c.txt', 'q\n');
      await sidecar('dataset/e.png', { tags: [] });
      await sidecar('inbox/s.jpg', { tags: ['one'] }); await sidecar('inbox/s.png', { tags: ['two'] });
      await put(root, 'dataset/f.txt', 'T, ready\n');
      return { root, projectJson };
    };
    const journalSkip = (path) => path.startsWith('.datasetcreator/journal/');
    const fixture = await makeV3();
    const { root } = fixture;
    assert.equal(await migration.detectPendingCaptionConversion(root), true);
    const report = await migration.runCaptionTxtMigration(root);
    assert.equal(await read(root, 'inbox/a.txt'), 'x, y\n', 'sidecar tags become the TXT');
    assert.equal(await read(root, `.datasetcreator/backup/${report.journalId}/captions/inbox/a.txt`), 'old text\n', 'the replaced TXT is kept in the backup');
    assert.equal(JSON.parse(await read(root, 'inbox/a.png.manifest.json')).tags, undefined, 'tags leave the sidecar');
    assert.equal(JSON.parse(await read(root, 'inbox/a.png.manifest.json')).id, 'inbox/a.png', 'the rest of the sidecar stays');
    assert.equal(await read(root, 'dataset/b.txt'), 'T, p\n', 'dataset/ captions get the trigger');
    assert.equal(await read(root, 'dataset/c.txt'), 'T, q\n', 'a TXT without sidecar tags only gains the trigger');
    assert.equal(await read(root, `.datasetcreator/backup/${report.journalId}/captions/dataset/c.txt`), 'q\n');
    assert.equal(await read(root, 'dataset/d.txt'), null, 'an image with no caption data gets no file');
    assert.equal(await read(root, 'dataset/e.txt'), 'T\n', 'sidecar tags [] become the trigger alone');
    assert.equal(await read(root, 'dataset/f.txt'), 'T, ready\n', 'a correct caption is not touched');
    assert.equal(await read(root, `.datasetcreator/backup/${report.journalId}/captions/dataset/f.txt`), null);
    assert.equal(await read(root, 'inbox/s.txt'), 'one\n', 's.jpg keeps s.txt');
    assert.deepEqual(report.collisions.map((entry) => entry.from).filter((from) => !from.endsWith('.json')), ['inbox/s.png'], 'a.png/a.jpg share a stem: the second is renamed');
    const renamed = report.collisions.find((entry) => entry.from === 'inbox/s.png').to;
    assert.notEqual(renamed, 'inbox/s.png');
    assert.equal(await read(root, renamed.replace(/\.png$/, '.txt')), 'two\n', 'the renamed image gets its own TXT from its sidecar');
    assert.equal(await read(root, 'inbox/s.png'), null); assert.equal(await read(root, renamed), 'inbox/s.png');
    assert.deepEqual({ converted: report.converted, triggersAdded: report.triggersAdded, backedUp: report.backedUp }, { converted: 5, triggersAdded: 1, backedUp: 2 });
    const json = await fixture.projectJson();
    assert.equal(json.project.migrations.captionsTxt.id, report.journalId); assert.ok(json.project.migrations.captionsTxt.completedAt, 'the completion marker is written');
    assert.equal(await migration.detectPendingCaptionConversion(root), false);
    assert.equal(await migration.runCaptionTxtMigration(root), undefined, 'a marked project is not scanned again');
    // Idempotent even when run again without the marker.
    const projectFiles = (path) => journalSkip(path) || path === '.datasetcreator/project.json' || path.startsWith('.datasetcreator/backup/');
    const settled = await tree(root, '', projectFiles);
    const marked = await fixture.projectJson(); delete marked.project.migrations.captionsTxt; await put(root, '.datasetcreator/project.json', JSON.stringify(marked));
    const again = await migration.runCaptionTxtMigration(root);
    assert.deepEqual({ converted: again.converted, triggersAdded: again.triggersAdded, backedUp: again.backedUp, collisions: again.collisions.length }, { converted: 0, triggersAdded: 0, backedUp: 0, collisions: 0 });
    assert.deepEqual(await tree(root, '', projectFiles), settled, 'a second run changes no project file');
    assert.ok((await fixture.projectJson()).project.migrations.captionsTxt.completedAt);

    // Abort after N steps, then resume: the same result as an uninterrupted run.
    const reference = await makeV3();
    const referenceReport = await migration.runCaptionTxtMigration(reference.root);
    const normalize = async (rootHandle, id) => Object.fromEntries(Object.entries(await tree(rootHandle, '', (path) => journalSkip(path))).map(([path, text]) => [path.replace(id, '<id>'), path === '.datasetcreator/project.json' ? text.replace(/"\d{4}-\d\d-\d\dT[^"]*"/g, '"<time>"').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>') : text]));
    const expected = await normalize(reference.root, referenceReport.journalId);
    let steps = 0; { const counter = await makeV3(); await migration.runCaptionTxtMigration(counter.root, { onProgress: ({ phase, completed, total }) => { if (completed < total) steps += 1; void phase; } }); }
    assert.ok(steps >= 3, 'the conversion is journalled in several steps');
    for (let abortAt = 1; abortAt < steps; abortAt++) {
      const interrupted = await makeV3();
      const controller = new AbortController(); let seen = 0;
      await assert.rejects(migration.runCaptionTxtMigration(interrupted.root, { signal: controller.signal, onProgress: ({ completed, total }) => { if (completed < total) { seen += 1; if (seen === abortAt) controller.abort(); } } }), { name: 'AbortError' }, `abort at step ${abortAt}`);
      assert.equal(await migration.detectPendingCaptionConversion(interrupted.root), true, `still pending after abort at step ${abortAt}`);
      const resumed = await migration.resumePendingJournals(interrupted.root);
      assert.equal(resumed.length, 1, `the journal is resumed after abort at step ${abortAt}`);
      const resumedJournal = resumed[0];
      assert.deepEqual(await normalize(interrupted.root, resumedJournal), expected, `resume after abort at step ${abortAt} reaches the same result`);
      assert.equal(await migration.detectPendingCaptionConversion(interrupted.root), false, 'the marker is written by the resumed run');
      assert.deepEqual(await migration.resumePendingJournals(interrupted.root), [], 'a finished journal is not resumed again');
    }
  }

  console.log('PASS: TXT caption format, [] versus undefined, caption mutations with Undo, trigger rewrite, dataset boundary moves, dataset export, import pairing and sidecar-to-TXT migration.');
} finally { await rm(temp, { recursive: true, force: true }); }
