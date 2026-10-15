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
      'src/services/dataset/coverageService.ts',
      'src/services/dataset/datasetAssemblyService.ts',
      'src/services/caption/captionMigrationService.ts',
    ],
    platform: 'node',
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const caption = await import(pathToFileURL(join(temp, 'captionResolver.mjs')));
  const membership = await import(pathToFileURL(join(temp, 'datasetMembershipResolver.mjs')));
  const shared = await import(pathToFileURL(join(temp, 'sharedCandidateService.mjs')));
  const coverage = await import(pathToFileURL(join(temp, 'coverageService.mjs')));
  const assembly = await import(pathToFileURL(join(temp, 'datasetAssemblyService.mjs')));
  const migration = await import(pathToFileURL(join(temp, 'captionMigrationService.mjs')));

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

  const vector = (...values) => new Float32Array(values);
  const feature = (hash, image, caption, contexts = []) => ({ imageHash: hash, image: vector(...image), text: vector(...image), caption, contexts });
  const assemblyItem = (path, semantic, quality = 1) => ({ item: item(`asset:${path}`, '', path), feature: semantic, caption: semantic.caption, quality });
  const baseline = assemblyItem('Project/private/front.png', feature('front', [1, 0], 'front portrait', ['front', 'portrait']));
  const back = assemblyItem('Project/src/shared/back.png', feature('back', [0, 1], 'back view', ['back', 'view']));
  const backDuplicate = assemblyItem('Project/src/shared/z-back-copy.png', feature('back', [0, 1], 'duplicate words', ['duplicate']));
  const similarFront = assemblyItem('Project/src/shared/front-2.png', feature('front-2', [0.99, 0.01], 'front portrait', ['front', 'portrait']));
  const metrics = coverage.measureCoverage([assembly.coverageAsset?.(baseline) ?? { key: 'front', feature: baseline.feature }], [{ key: 'front', feature: baseline.feature }, { key: 'back', feature: back.feature }]);
  assert.ok(metrics.total > 0 && metrics.total < 1);
  const datasetForAssembly = { ...dataset, id: 'global' };
  const plan = await assembly.assembleDataset({ projectId: 'project', projectType: 'character', dataset: datasetForAssembly, baseline: [baseline], candidates: [similarFront, backDuplicate, back], mode: { kind: 'limit', limit: 2 } });
  assert.equal(plan.selected[0].path, 'Project/src/shared/back.png', 'a missing view should beat a near-duplicate portrait');
  assert.deepEqual(plan.rejectedDuplicates, ['src/shared/z-back-copy.png']);
  assert.ok(plan.after.total > plan.before.total);
  const sourceRecord = { outside: { id:'outside', originalFilePath:'private/outside.png', tags:['original'] }, group: { id:'group', originalFilePath:'src/shared/group.png', tags:['source'] } };
  const editedRecord = { crop: { id:'crop', sourceImageId:'group', imageDataPath:'src/shared/crop.png', tags:['crop'], deleted:false } };
  const migratedCaptions = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:true,captionOverrides:{'source:outside':[], 'source:group':['shared override'], 'edited:crop':['crop override'], 'asset:Project/src/shared/direct.png':['path override']}},
    dataset:{...dataset,triggerWord:'hero'}, sourceImages:sourceRecord, datasetItems:editedRecord,
    pathAssets:[{path:'Project/src/shared/direct.png',tags:['path']}],
  });
  assert.deepEqual(migratedCaptions.sourceImages.outside.tags, [], 'an explicit empty override stays empty');
  assert.deepEqual(migratedCaptions.sourceImages.group.tags, ['shared override']);
  assert.deepEqual(migratedCaptions.datasetItems.crop.tags, ['crop override']);
  assert.deepEqual(migratedCaptions.pathCaptions['Project/src/shared/direct.png'], ['path override']);
  assert.equal(migratedCaptions.report.status, 'complete');
  const disabledMigration = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:false,captionOverrides:{'source:outside':['disabled']}}, dataset:{...dataset,triggerWord:'hero'}, sourceImages:sourceRecord, datasetItems:editedRecord,
  });
  assert.deepEqual(disabledMigration.sourceImages.outside.tags, ['original'], 'disabled overrides remain archival only');
  assert.deepEqual(disabledMigration.report.legacyOverrides, {'source:outside':['disabled']});
  console.log('dataset assembly contracts: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
