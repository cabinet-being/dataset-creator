import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'service-boundaries-'));
after(() => rm(temp, { recursive: true, force: true }));
await build({
  input: [
    'src/services/psd/photopeaPreviewQueue.ts',
    'src/services/project/fileSnapshotService.ts',
    'src/services/tagging/localTaggerFileSettings.ts',
    'src/services/tagging/localTaggerConnectionService.ts',
    'src/stores/useLocalTaggerStore.ts',
    'src/services/tagging/wdTagger.ts',
    'src/services/project/assetTypeService.ts',
    'src/services/project/projectPathFilters.ts',
    'src/lib/previewUrlCache.ts',
    'src/lib/fileNameSelection.ts',
  ],
  platform: 'node', transform: { define: { 'import.meta.env.DEV': 'false' } },
  plugins: [{
    name: 'fake-local-tagger-session',
    resolveId(source, importer) {
      if (source === './localTaggerService' && importer?.endsWith('/localTaggerConnectionService.ts')) {
        return '\0fake-local-tagger-session';
      }
    },
    load(id) {
      if (id === '\0fake-local-tagger-session') {
        return 'export const connectLocalTaggerBundle = (...args) => globalThis.__testConnectLocalTaggerBundle(...args);';
      }
    },
  }],
  output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs' },
});
const load = name => import(pathToFileURL(join(temp, `${name}.mjs`)));
const loadFresh = (name, caseName) => import(`${pathToFileURL(join(temp, `${name}.mjs`))}?${caseName}`);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('file snapshots preserve binary data and metadata independently of the source', async () => {
  const { snapshotFile, snapshotFileIfNeeded } = await load('fileSnapshotService');
  const file = new File([new Uint8Array([0, 128, 255])], 'кадр.png', { type: 'image/png', lastModified: 123 });
  const copy = await snapshotFile(file);
  assert.notEqual(copy, file);
  assert.deepEqual([copy.name, copy.type, copy.lastModified], [file.name, file.type, 123]);
  assert.deepEqual(new Uint8Array(await copy.arrayBuffer()), new Uint8Array([0, 128, 255]));
  const blob = new Blob(['plain']);
  assert.equal(await snapshotFileIfNeeded(blob), blob);
  assert.notEqual(await snapshotFileIfNeeded(file), file);
  await assert.rejects(snapshotFile({ arrayBuffer: async () => { throw new Error('File removed'); } }), /File removed/);
});

test('tagger requests read permission only when needed and propagates permission errors', async () => {
  const { ensureLocalTaggerFileReadPermission: ensure } = await load('localTaggerFileSettings');
  assert.equal(await ensure({}), true);
  for (const current of ['granted', 'prompt', 'denied']) {
    for (const requested of ['granted', 'denied']) {
      const calls = [];
      assert.equal(await ensure({
        queryPermission: async descriptor => { calls.push(['query', descriptor]); return current; },
        requestPermission: async descriptor => { calls.push(['request', descriptor]); return requested; },
      }), current === 'granted' || requested === 'granted');
      assert.deepEqual(calls, current === 'granted'
        ? [['query', { mode: 'read' }]]
        : [['query', { mode: 'read' }], ['request', { mode: 'read' }]]);
    }
  }
  await assert.rejects(ensure({ queryPermission: async () => { throw new Error('Disconnected'); }, requestPermission() {} }), /Disconnected/);
});

test('saved tagger files retain legacy handles and File fallback bytes across reads', async t => {
  const records = new Map();
  let abortNextWrite = false;
  const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  t.after(() => {
    if (previousIndexedDB) Object.defineProperty(globalThis, 'indexedDB', previousIndexedDB);
    else delete globalThis.indexedDB;
  });
  const requestFor = action => {
    const request = {};
    queueMicrotask(() => {
      try { request.result = action(); request.onsuccess?.(); }
      catch (error) { request.error = error; request.onerror?.(); }
    });
    return request;
  };
  const database = {
    transaction: (store, mode) => {
      assert.equal(store, 'taggerFileHandles');
      const transaction = { objectStore: () => ({
        get: key => requestFor(() => records.get(key)),
        put: entry => {
          assert.equal(mode, 'readwrite');
          const request = requestFor(() => entry.id);
          queueMicrotask(() => queueMicrotask(() => {
            if (abortNextWrite) {
              abortNextWrite = false;
              transaction.error = new Error('Transaction aborted');
              transaction.onabort?.();
            } else {
              records.set(entry.id, entry);
              transaction.oncomplete?.();
            }
          }));
          return request;
        },
        delete: key => requestFor(() => records.delete(key)),
      }) };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: { open: () => requestFor(() => database) },
  });

  const settings = await load('localTaggerFileSettings');
  const legacyModel = new File([new Uint8Array([0, 255, 7])], 'model.onnx');
  let permission = 'granted';
  const permissionCalls = [];
  const legacyHandle = {
    name: 'model.onnx',
    queryPermission: async descriptor => { permissionCalls.push(['query', descriptor]); return permission; },
    requestPermission: async descriptor => { permissionCalls.push(['request', descriptor]); permission = 'granted'; return permission; },
    getFile: async () => legacyModel,
  };
  records.set('model', { id: 'model', handle: legacyHandle });
  assert.deepEqual(await settings.getLocalTaggerSavedFileNames(), { model: 'model.onnx', tags: undefined });
  assert.equal(await settings.getLocalTaggerFileHandle('model'), legacyHandle);
  assert.equal(await settings.readLocalTaggerSavedFile('model', false), legacyModel);
  assert.deepEqual(permissionCalls, [['query', { mode: 'read' }]]);

  const tags = new File(['name\nblue_hair\n'], 'selected_tags.csv', { type: 'text/csv', lastModified: 123 });
  abortNextWrite = true;
  await assert.rejects(settings.saveLocalTaggerFile('tags', tags), /Transaction aborted/);
  assert.equal(records.has('tags'), false, 'aborted transaction must not persist the file');
  await settings.saveLocalTaggerFile('tags', tags);
  const saved = records.get('tags');
  assert.equal(saved.id, 'tags');
  assert.equal(saved.name, tags.name);
  assert.equal(saved.handle, undefined);
  assert.equal(await saved.file.text(), 'name\nblue_hair\n');
  assert.deepEqual(await settings.getLocalTaggerSavedFileNames(), { model: 'model.onnx', tags: 'selected_tags.csv' });
  const restored = await settings.readLocalTaggerSavedFile('tags', false);
  assert.equal(restored.name, 'selected_tags.csv');
  assert.equal(restored.lastModified, 123);
  assert.equal(await restored.text(), 'name\nblue_hair\n');
  assert.equal(permissionCalls.length, 1, 'cached File requires no permission prompt');

  permission = 'prompt';
  await assert.rejects(settings.readLocalTaggerSavedFile('model', false), /permission.*Reconnect/i);
  assert.deepEqual(permissionCalls.slice(1), [['query', { mode: 'read' }]], 'silent restore must not request permission');
  assert.equal(await settings.readLocalTaggerSavedFile('model', true), legacyModel);
  assert.deepEqual(permissionCalls.slice(2), [['query', { mode: 'read' }], ['request', { mode: 'read' }]]);
  assert.equal(await settings.getLocalTaggerFileHandle('model'), legacyHandle, 'manual restore keeps the saved handle');
  assert.equal(await settings.readLocalTaggerSavedFile('missing', false), undefined);

  const { useLocalTaggerStore } = await load('useLocalTaggerStore');
  const firstLoad = deferred();
  const seenSources = [];
  const released = [];
  const bundleFor = (source, marker) => ({
    name: source.name, tags: [marker], session: { release: async () => { released.push(marker); } },
  });
  globalThis.__testConnectLocalTaggerBundle = async source => {
    seenSources.push(source);
    await firstLoad.promise;
    return bundleFor(source, 'first');
  };
  t.after(() => { delete globalThis.__testConnectLocalTaggerBundle; });
  const connection = await loadFresh('localTaggerConnectionService', 'singleflight');
  const firstRestore = connection.restoreSavedLocalTagger(false);
  const concurrentRestore = connection.restoreSavedLocalTagger(false);
  assert.equal(concurrentRestore, firstRestore, 'concurrent startup restores share one flight');
  firstLoad.resolve();
  assert.equal(await firstRestore, true);
  assert.equal(seenSources.length, 1);
  assert.equal(useLocalTaggerStore.getState().status, 'ready');
  assert.deepEqual(useLocalTaggerStore.getState().savedFileNames, {
    model: 'model.onnx', tags: 'selected_tags.csv',
  }, 'saved file labels come from file records, independent of a project name');

  const oldLoad = deferred();
  let oldStarted = deferred();
  globalThis.__testConnectLocalTaggerBundle = async source => {
    seenSources.push(source);
    if (source.modelFile === legacyModel) {
      oldStarted.resolve();
      await oldLoad.promise;
      return bundleFor(source, 'stale');
    }
    return bundleFor(source, 'new');
  };
  const selection = await loadFresh('localTaggerConnectionService', 'replacement');
  const pendingRestore = selection.restoreSavedLocalTagger(false);
  await oldStarted.promise;
  const replacement = new File([new Uint8Array([8, 9, 10])], 'model.onnx');
  const selected = selection.saveAndConnectLocalTaggerFile('model', replacement);
  assert.equal(await selected, true, 'same filename selection starts a new connection');
  assert.equal(useLocalTaggerStore.getState().bundle.tags[0], 'new');
  oldLoad.resolve();
  assert.equal(await pendingRestore, false);
  assert.equal(useLocalTaggerStore.getState().bundle.tags[0], 'new', 'late restore cannot overwrite the chosen file');
  assert.deepEqual(released.filter(marker => marker === 'stale'), ['stale']);
  assert.equal(await useLocalTaggerStore.getState().bundle.session.release(), undefined);

  const disconnectLoad = deferred();
  globalThis.__testConnectLocalTaggerBundle = async source => {
    await disconnectLoad.promise;
    return bundleFor(source, 'after-disconnect');
  };
  const pendingConnection = selection.connectLocalTaggerSource({
    kind: 'explicit-files', name: 'model.onnx', modelFile: replacement, tagsFile: tags,
  });
  selection.disconnectLocalTaggerConnection();
  disconnectLoad.resolve();
  assert.equal(await pendingConnection, false);
  assert.equal(useLocalTaggerStore.getState().status, 'not-connected');
  assert.equal(useLocalTaggerStore.getState().bundle, null);
  assert.deepEqual(released.filter(marker => marker === 'after-disconnect'), ['after-disconnect']);

  const deletedHandle = {
    name: 'model.onnx',
    queryPermission: async () => 'granted',
    getFile: async () => { throw new DOMException('Saved file was removed', 'NotFoundError'); },
  };
  await settings.saveLocalTaggerFile('model', deletedHandle);
  const deleted = await loadFresh('localTaggerConnectionService', 'deleted');
  assert.equal(await deleted.restoreSavedLocalTagger(true), false);
  assert.equal(useLocalTaggerStore.getState().status, 'not-ready');
  assert.match(useLocalTaggerStore.getState().message, /choose.*again|reselect|retry/i,
    'deleted saved files need clear recovery guidance');
  await settings.saveLocalTaggerFile('model', replacement);
  globalThis.__testConnectLocalTaggerBundle = async source => bundleFor(source, 'retry');
  assert.equal(await deleted.restoreSavedLocalTagger(true), true, 'a corrected file can be retried');
  assert.equal(useLocalTaggerStore.getState().bundle.tags[0], 'retry');

  const deniedHandle = {
    name: 'model.onnx',
    queryPermission: async () => 'denied',
    requestPermission: async () => 'denied',
    getFile: async () => { throw new Error('must not be read'); },
  };
  await settings.saveLocalTaggerFile('model', deniedHandle);
  const denied = await loadFresh('localTaggerConnectionService', 'denied');
  assert.equal(await denied.restoreSavedLocalTagger(true), false);
  assert.equal(useLocalTaggerStore.getState().bundle, null, 'failed access clears the previous session');
  assert.equal(useLocalTaggerStore.getState().status, 'not-ready');
  assert.match(useLocalTaggerStore.getState().message, /permission.*Reconnect/i);
});

test('WD tag CSV preserves score order, identifies categories and rejects malformed rows', async () => {
  const { parseSelectedTagCsv, parseSelectedTagRows, packImageChannels, filterTagPredictions } = await load('wdTagger');
  const parsed = parseSelectedTagCsv('tag_id,name,category\n0,questionable,9\n1,blue_hair,0\n2,"original character",4\n');
  assert.equal(parsed.hasCategories, true);
  assert.deepEqual(parsed.rows, [
    { name: 'questionable', category: 'rating' },
    { name: 'blue_hair', category: 'general' },
    { name: 'original_character', category: 'character' },
  ]);
  assert.deepEqual(parseSelectedTagRows('name\nfirst\nsecond\n').map(({ name }) => name), ['first', 'second']);
  assert.throws(() => parseSelectedTagCsv('name,category\nok,0\nmissing-category\n'), /row 3 has 1 fields/);
  assert.throws(() => parseSelectedTagCsv('name\n"unfinished\n'), /unterminated quoted field/);
  assert.throws(() => parseSelectedTagCsv('name,category\nok,wat\n'), /invalid category/);

  const rgba = new Uint8Array([12, 34, 56, 255, 90, 80, 70, 255]);
  assert.deepEqual([...packImageChannels(rgba, 2, 'nhwc', 'bgr')], [56, 34, 12, 70, 80, 90]);
  assert.deepEqual([...packImageChannels(rgba, 2, 'nchw', 'bgr')], [56, 70, 34, 80, 12, 90]);
  const predictions = [
    { tag: 'rating', score: 0.99 }, { tag: 'general', score: 0.4 }, { tag: 'character', score: 0.8 },
  ];
  assert.deepEqual(filterTagPredictions(predictions, ['rating', 'general', 'character'], 0.35, 5), [predictions[1]]);
  assert.deepEqual(filterTagPredictions(predictions, ['rating', 'general', 'character'], 0.35, 5, { includeRatings: true, characterThreshold: 0.75 }).map(({ tag }) => tag), ['rating', 'character', 'general']);
});

test('asset classification handles uppercase extensions, MIME-only files and internal metadata', async () => {
  const { resolveProjectAssetKind: kind, isSupportedProjectAsset: supported, getProjectAssetMimeType: mime } = await load('assetTypeService');
  for (const [name, type, expected] of [
    ['PHOTO.PNG', '', 'image'], ['edit.PSD', 'image/vnd.adobe.photoshop', 'psd'],
    ['clip.WEBM', '', 'video'], ['caption.TXT', '', 'text'], ['data.JSON', '', 'json'],
    ['download', 'image/jpeg', 'image'], ['download', 'video/mp4', 'video'],
    ['download', 'text/plain', 'text'], ['archive.zip', '', 'unknown'],
  ]) assert.equal(kind(name, type), expected, name);
  assert.equal(supported('photo.png.manifest.json'), false);
  assert.equal(supported('caption.txt'), true);
  assert.equal(supported('archive.zip'), false);
  assert.equal(mime('PHOTO.JPEG', 'application/octet-stream'), 'image/jpeg');
  assert.equal(mime('clip.mp4', 'video/mp4'), 'video/mp4');
});

test('legacy filtering affects root folders only, including Windows paths', async () => {
  const { getProjectPathParts, isLegacyProjectRootPath, filterLegacyProjectAssetPaths } = await load('projectPathFilters');
  assert.deepEqual(getProjectPathParts('PROJECT\\src\\shared\\a.png'), ['src', 'shared', 'a.png']);
  const paths = ['Project/SOURCES/a.png', 'synthetic/a.png', 'Project/src/sources/a.png', 'Project/inbox/a.png'];
  assert.deepEqual(filterLegacyProjectAssetPaths(paths), paths.slice(2));
  assert.equal(isLegacyProjectRootPath('Project'), false);
  assert.equal(isLegacyProjectRootPath(''), false);
  assert.deepEqual(filterLegacyProjectAssetPaths(), []);
});

test('rename selects the filename stem without hiding dotfiles or removing compound suffixes', async () => {
  const { selectFileNameStem } = await load('fileNameSelection');
  for (const [value, expected] of [['image.png', [0, 5]], ['archive.tar.gz', [0, 11]], ['.env', 'all'], ['README', 'all'], ['', 'all']]) {
    let selected;
    selectFileNameStem({ value, select: () => { selected = 'all'; }, setSelectionRange: (...range) => { selected = range; } });
    assert.deepEqual(selected, expected, value);
  }
});

test('preview URL cache reuses identical blobs, revokes replacements and prunes only inactive IDs', async t => {
  const { getCachedPreviewUrl: get, pruneCachedPreviewUrls: prune } = await load('previewUrlCache');
  const revoked = []; let next = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:test-${++next}`);
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  try {
    const blob = new Blob(['one']);
    const first = get('a', blob);
    assert.equal(get('a', blob), first);
    const second = get('a', new Blob(['two']));
    assert.notEqual(second, first);
    assert.deepEqual(revoked, [first]);
    const other = get('b', blob);
    prune(new Set(['a']));
    assert.deepEqual(revoked, [first, other]);
    prune(new Set()); prune(new Set());
    assert.deepEqual(revoked, [first, other, second]);
  } finally { prune(new Set()); }
});

test('Photopea preview requests deduplicate, run FIFO, time out and permit retry', async t => {
  const preview = await load('photopeaPreviewQueue');
  const timers = new Map(); let timerId = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  globalThis.window = { setTimeout: (fn, delay) => { assert.equal(delay, 90_000); timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) };
  let notifications = 0;
  const unsubscribe = preview.subscribeToPhotopeaPsdPreviewQueue(() => notifications++);
  try {
    const blob = new Blob(['psd']);
    const a = preview.requestPhotopeaPsdPreview(blob, 'a.psd');
    assert.equal(preview.requestPhotopeaPsdPreview(blob, 'a.psd'), a);
    const b = preview.requestPhotopeaPsdPreview(blob, 'b.psd');
    assert.equal(notifications, 2);
    const first = preview.takePhotopeaPsdPreviewJob();
    const second = preview.takePhotopeaPsdPreviewJob();
    assert.equal(first.path, 'a.psd'); assert.equal(second.path, 'b.psd');
    assert.equal(preview.takePhotopeaPsdPreviewJob(), undefined);
    preview.startPhotopeaPsdPreviewJobTimeout(first);
    preview.startPhotopeaPsdPreviewJobTimeout(first);
    assert.equal(timers.size, 1);
    const image = new Blob(['png']);
    preview.completePhotopeaPsdPreviewJob(first, image);
    preview.completePhotopeaPsdPreviewJob(first, undefined);
    assert.equal(await a, image); assert.equal(timers.size, 0);
    let timedOut = 0; second.onTimeout = () => timedOut++;
    preview.startPhotopeaPsdPreviewJobTimeout(second);
    [...timers.values()][0]();
    assert.equal(await b, undefined); assert.equal(timedOut, 1);
    assert.equal(timers.size, 0);
    const retry = preview.requestPhotopeaPsdPreview(blob, 'b.psd');
    assert.notEqual(retry, b);
    preview.completePhotopeaPsdPreviewJob(preview.takePhotopeaPsdPreviewJob(), image);
    assert.equal(await retry, image);
    unsubscribe(); const count = notifications;
    const final = preview.requestPhotopeaPsdPreview(blob, 'c.psd');
    preview.completePhotopeaPsdPreviewJob(preview.takePhotopeaPsdPreviewJob(), undefined);
    await final; assert.equal(notifications, count);
  } finally { unsubscribe(); }
});
