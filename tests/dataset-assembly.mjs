import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'dataset-assembly-'));
try {
  await build({
    input: [
      'src/services/caption/captionResolver.ts',
      'src/services/dataset/datasetMembershipResolver.ts',
      'src/services/dataset/sharedCandidateService.ts',
    ],
    platform: 'node',
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const caption = await import(pathToFileURL(join(temp, 'captionResolver.mjs')));
  const membership = await import(pathToFileURL(join(temp, 'datasetMembershipResolver.mjs')));
  const shared = await import(pathToFileURL(join(temp, 'sharedCandidateService.mjs')));

  const dataset = { assetIds: ['outside', 'group'], assetPaths: ['Project/src/shared/direct.png'], psdAssetPaths: [], overwriteCaptions: true, captionOverrides: { 'source:outside': [] }, triggerWord: 'hero' };
  const item = (id, sourceImageId, assetPath, extra = {}) => ({ id, sourceImageId, assetPath, kind: 'image', imageData: new Blob(['x']), tags: ['hero', 'portrait'], ...extra });
  const outside = item('source:outside', 'outside', 'Project/private/outside.png');
  const groupSource = item('source:group', 'group', 'Project/src/shared/group.png');
  const groupCrop = item('edited:crop', 'group', 'Project/.dataset-creator-data/crop.png', { kind: 'edited' });
  const direct = item('asset:Project/src/shared/direct.png', '', 'src/shared/direct.png');
  const excluded = item('source:excluded', 'group', 'Project/src/shared/excluded.png', { excludedFromDataset: true });
  const result = membership.resolveDatasetMembership(dataset, [outside, groupSource, groupCrop, direct, excluded]);
  assert.deepEqual(result.missingAssetIds, []);
  assert.deepEqual(result.missingAssetPaths, []);
  assert.equal(result.members.length, 5);
  assert.equal(result.effective.length, 4);
  assert.equal(caption.resolveDatasetCaption(dataset, outside).source, 'override');
  assert.equal(caption.resolveDatasetCaption(dataset, outside).text, '');
  assert.equal(caption.normalizeCaptionForAnalysis('Hero,  Back view\nCAPTION: ignored', 'hero'), 'back view');

  const file = (name, contents, type = '') => ({ name, getFile: async () => new File([contents], name, { type, lastModified: 7 }) });
  const directory = (entries) => ({
    name: 'folder',
    entries: async function* () { for (const entry of entries) yield entry; },
    getDirectoryHandle: async (name) => { const found = entries.find(([entryName, value]) => entryName === name && 'entries' in value)?.[1]; if (!found) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); return found; },
    getFileHandle: async (name) => { const found = entries.find(([entryName, value]) => entryName === name && !('entries' in value))?.[1]; if (!found) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); return found; },
  });
  const sharedDir = directory([
    ['scene.png', file('scene.png', 'image', 'image/png')],
    ['scene.png.manifest.json', file('scene.png.manifest.json', JSON.stringify({ id: 'scene-id', width: 640, height: 480, caption: 'back view' }), 'application/json')],
    ['clip.mp4', file('clip.mp4', 'video', 'video/mp4')],
  ]);
  const root = directory([['src', directory([['shared', sharedDir]])]]);
  const scan = await shared.scanSharedCandidates(root);
  assert.equal(scan.sharedAvailable, true);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].assetPath, 'Project/src/shared/scene.png');
  assert.deepEqual(scan.candidates[0].tags, ['back view']);
  assert.equal(scan.skipped.some((entry) => entry.reason === 'video'), true);
  console.log('dataset assembly contracts: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
