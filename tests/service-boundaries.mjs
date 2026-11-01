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
    'src/services/tagging/wdTagger.ts',
    'src/services/project/assetTypeService.ts',
    'src/services/project/projectPathFilters.ts',
    'src/lib/previewUrlCache.ts',
    'src/lib/fileNameSelection.ts',
  ],
  platform: 'node', transform: { define: { 'import.meta.env.DEV': 'false' } },
  output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs' },
});
const load = name => import(pathToFileURL(join(temp, `${name}.mjs`)));

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
  const paths = ['Project/SOURCES/a.png', 'synthetic/a.png', 'Project/src/sources/a.png', 'Project/src/shared/a.png'];
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
