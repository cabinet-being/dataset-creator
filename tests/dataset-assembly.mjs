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
      'src/services/analysis/semanticFeatureService.ts',
      'src/services/caption/captionMigrationService.ts',
      'src/services/build/buildSessionService.ts',
      'src/services/build/buildTransformService.ts',
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
  const buildSession = await import(pathToFileURL(join(temp, 'buildSessionService.mjs')));
  const buildTransform = await import(pathToFileURL(join(temp, 'buildTransformService.mjs')));

  const dataset = { assetIds: ['outside', 'group'], assetPaths: ['Project/src/shared/direct.png'], psdAssetPaths: [], overwriteCaptions: true, captionOverrides: { 'source:outside': [] }, triggerWord: 'hero' };
  const item = (id, sourceImageId, assetPath, extra = {}) => ({ id, sourceImageId, assetPath, kind: 'image', imageData: new Blob(['x']), tags: ['hero', 'portrait'], ...extra });
  {
    const first = item('source:first','first','Project/src/shared/first.png',{byteSize:10,modifiedAt:1});
    const second = item('source:second','second','Project/src/shared/second.png',{byteSize:20,modifiedAt:2,tags:undefined});
    let session = buildSession.reconcileBuildSession(buildSession.createBuildSession(),[first,second],'2026-10-21T00:00:00.000Z');
    assert.deepEqual(session.order,['source:first','source:second']);
    session = buildSession.updateBuildDecision(session,'source:first','accepted',{application:'applied',validation:'valid',acceptedRevision:session.records['source:first'].revision});
    const arriving = item('source:arriving','arriving','Project/src/shared/arriving.png',{byteSize:30,modifiedAt:3});
    session = buildSession.reconcileBuildSession({...session,cursor:1},[arriving,second,first]);
    assert.deepEqual(session.order,['source:first','source:second','source:arriving'],'Background arrivals append without reordering reviewed work');
    assert.equal(session.cursor,1);
    const edited = {...first,tags:['changed']};
    session = buildSession.reconcileBuildSession(session,[edited,second,arriving]);
    assert.equal(session.records['source:first'].validation,'stale','A changed accepted revision returns to review');
    const transformAccepted = buildSession.updateBuildDecision(buildSession.reconcileBuildSession(buildSession.createBuildSession(),[first]),'source:first','accepted',{application:'applied',validation:'valid'});
    const changedProfile = {...transformAccepted,profile:{...transformAccepted.profile,transform:{mode:'crop',width:512,height:512,allowUpscale:false}}};
    assert.equal(buildSession.reconcileBuildSession(changedProfile,[first]).records['source:first'].validation,'stale','Changing the output recipe invalidates an accepted revision');
    const moved = buildSession.applyBuildSessionPathMoves(session,[{from:'Project/src/shared',to:'Project/renamed'}]);
    assert.equal(moved.records['source:first'].locator,'Project/renamed/first.png');
    const restored = buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(moved)));
    assert.equal(restored.records['source:first'].decision,'accepted');
    assert.deepEqual(buildSession.selectBuildQueue({...restored,filter:'unresolved'},[edited,second,arriving]).map(buildSession.getBuildAssetId),['source:first','source:second','source:arriving']);
  }
  {
    const source = item('source:frame','frame','Project/src/shared/frame.png',{byteSize:100,modifiedAt:1,tags:['original']});
    const recipe = {mode:'crop',width:512,height:512,allowUpscale:false,crop:{x:0.25,y:0,width:0.5,height:1}};
    const captionEdit = {...source,tags:['revised']};
    assert.equal(await buildTransform.getBuildImageDigest(source.imageData),await buildTransform.getBuildImageDigest(captionEdit.imageData));
    assert.notEqual(await buildTransform.getBuildImageDigest(new Blob(['a'])),await buildTransform.getBuildImageDigest(new Blob(['b'])),'Equal-sized content replacements receive a different output identity');
    assert.throws(() => buildSession.assertBuildSourceCurrent(source,source,recipe,false),/project changed/,'A→B→A session changes are rejected even when the project id matches');
    assert.throws(() => buildSession.assertBuildSourceCurrent(source,{...source,imageData:new Blob(['x'])},recipe,true),/source changed/,'Equal-sized Blob replacement is rejected before mutation');
    const outputId = buildTransform.createBuildOutputAssetId(source.id,buildSession.getBuildContentRevision(source,recipe),recipe);
    assert.equal(outputId,buildTransform.createBuildOutputAssetId(source.id,buildSession.getBuildContentRevision(captionEdit,recipe),recipe),'Caption edits reuse the bitmap');
    assert.notEqual(outputId,buildTransform.createBuildOutputAssetId(source.id,buildSession.getBuildContentRevision({...source,byteSize:101},recipe),recipe),'Content changes replace the bitmap');
    assert.deepEqual(buildTransform.getBuildTransformGeometry(1200,800,recipe),{sourceX:300,sourceY:100,sourceWidth:600,sourceHeight:600,outputWidth:512,outputHeight:512});
    assert.deepEqual(buildTransform.getBuildTransformGeometry(300,200,{...recipe,crop:{x:0,y:0,width:1,height:1}}),{sourceX:50,sourceY:0,sourceWidth:200,sourceHeight:200,outputWidth:200,outputHeight:200},'No-upscale crop uses source-sized output');
    const output = item(`edited:${outputId}`,'frame',`Project/dataset/${outputId}.png`,{kind:'edited',editedAssetId:outputId,byteSize:500,modifiedAt:2,tags:['original']});
    const startingSession = buildSession.createBuildSession();
    let session = buildSession.reconcileBuildSession({...startingSession,profile:{...startingSession.profile,transform:recipe}},[source]);
    const outputRevision = buildSession.getBuildAssetRevision(output,output.tags,recipe);
    session = buildSession.updateBuildDecision(session,source.id,'accepted',{application:'applied',validation:'valid',acceptedRevision:session.records[source.id].revision,outputAssetId:`edited:${outputId}`,outputRevision,transform:recipe});
    session = buildSession.reconcileBuildSession(session,[source],undefined,[source,output]);
    assert.equal(buildSession.getBuildCounts(session,[source,output]).ready,1);
    const erased = {...output,tags:[]};
    assert.equal(buildSession.getBuildCounts(session,[source,erased]).ready,0,'An erased output caption cannot remain ready');
    const stale = buildSession.reconcileBuildSession(session,[source],undefined,[source,erased]);
    assert.equal(stale.records[source.id].validation,'stale');
    assert.deepEqual(buildSession.selectBuildQueue({...stale,filter:'unresolved'},[source]).map(buildSession.getBuildAssetId),[source.id]);
    const changedBytes = {...output,byteSize:501};
    assert.equal(buildSession.getBuildCounts(session,[source,changedBytes]).ready,0,'Changed output bytes invalidate readiness');
    const second = item('source:next','next','Project/src/shared/next.png');
    const third = item('source:last','last','Project/src/shared/last.png');
    assert.equal(buildSession.nextBuildCursor([source,second,third],[second,third],0,source.id),0,'The next item stays selected after filtered removal');
    assert.equal(buildSession.nextBuildCursor([source,second,third],[source,second],2,third.id),1,'The last item falls back to the remaining tail');
    assert.equal(buildSession.nextBuildCursor([source],[],0,source.id),0);
  }
  const outside = item('source:outside', 'outside', 'Project/dataset/outside.png');
  const groupSource = item('source:group', 'group', 'Project/dataset/group.png');
  const groupCrop = item('edited:crop', 'group', 'Project/dataset/crop.png', { kind: 'edited' });
  const direct = item('asset:Project/dataset/direct.png', '', 'dataset/direct.png');
  const excluded = item('source:excluded', 'group', 'Project/dataset/excluded.png', { excludedFromDataset: true });
  const result = membership.resolveDatasetMembership(dataset, [outside, groupSource, groupCrop, direct, excluded]);
  assert.deepEqual(result.missingAssetIds, []);
  assert.deepEqual(result.missingAssetPaths, []);
  assert.equal(result.members.length, 5);
  assert.equal(result.effective.length, 5, 'Every physical Dataset image contributes to the baseline despite stale exclusion flags');
  assert.equal(caption.resolveLegacyDatasetCaption(dataset, outside).source, 'override');
  assert.equal(caption.resolveLegacyDatasetCaption(dataset, outside).text, '');
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
  const plan = await assembly.assembleDataset({ projectId: 'project', projectType: 'character', dataset: datasetForAssembly, baseline: [baseline], candidates: [similarFront, backDuplicate, back], mode: { kind: 'max-new', maxNew: 2 } });
  assert.equal(plan.selected[0].path, 'Project/src/shared/back.png', 'a missing view should beat a near-duplicate portrait');
  assert.deepEqual(plan.rejectedDuplicates.sort(), ['src/shared/front-2.png','src/shared/z-back-copy.png']);
  assert.equal(plan.duplicatePairs.find(pair => pair.rejected === 'src/shared/front-2.png')?.kind, 'near');
  assert.ok(plan.funnel.evaluated >= plan.funnel.eligible, 'all eligible candidates are evaluated before a selection');
  assert.ok(plan.after.total > plan.before.total);
  assert.ok(plan.selected.every((step,index) => index === 0 || step.coverage.total >= plan.selected[index-1].coverage.total), 'coverage must be monotonic');
  const totalPlan = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,baseline:[baseline],candidates:[back],mode:{kind:'total',target:2}});
  assert.equal(totalPlan.selected.length,1); assert.equal(totalPlan.stoppedBecause,'target-reached'); assert.equal(totalPlan.shortfall,0);
  const shortPlan = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,baseline:[baseline],candidates:[back],mode:{kind:'range',min:4,max:6}});
  assert.equal(shortPlan.shortfall,2); assert.equal(shortPlan.stoppedBecause,'insufficient-pool');
  const textBait = assemblyItem('Project/src/shared/text-bait.png', feature('bait',[0.999,0.001],'perfect requested caption',['front']));
  const textPlan = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,baseline:[baseline],candidates:[textBait,back],mode:{kind:'max-new',maxNew:2},target:'perfect requested caption'});
  assert.equal(textPlan.selected.some(step => step.path.endsWith('text-bait.png')),false,'caption relevance cannot bypass visual near-duplicate rejection');
  const fingerprintA = await assembly.createAssemblyFingerprint(datasetForAssembly,[baseline,back],{target:'one',mode:{kind:'auto'},pinnedKeys:new Set()});
  const fingerprintB = await assembly.createAssemblyFingerprint(datasetForAssembly,[baseline,back],{target:'one',mode:{kind:'auto'},pinnedKeys:new Set(['src/shared/back.png'])});
  assert.notEqual(fingerprintA,fingerprintB,'pins invalidate an assembly preview');

  // Signal weights must not change when the first caption enters the selection.
  const blank = assemblyItem('blank.png', feature('blank', [1, 0], ''));
  const topics = [0, 1, 2].map(index => assemblyItem(`topic-${index}.png`, {
    ...feature(`topic-${index}`, [1, 0], `topic-${index}`, [`topic-${index}`]),
    text: vector(...[0, 1, 2].map(value => Number(value === index))),
  }));
  const fixedUniverse = coverage.createCoverageUniverse([blank, ...topics].map(assembly.coverageAsset));
  let previousCoverage = coverage.measureCoverage([], fixedUniverse);
  assert.equal(previousCoverage.text, 0, 'An available but uncovered text signal is zero, not missing');
  const selectedCoverage = [];
  for (const asset of [blank, ...topics]) {
    selectedCoverage.push(assembly.coverageAsset(asset));
    const next = coverage.measureCoverage(selectedCoverage, fixedUniverse);
    assert.ok(next.total >= previousCoverage.total, 'Adding the first caption cannot lower coverage');
    previousCoverage = next;
  }
  assert.ok(Math.abs(previousCoverage.total - 1) < 1e-6);

  // A text bonus must not select a saturated candidate and hide useful ones.
  const targetBaseline = [0, 1, 2].map(index => assemblyItem(`base-${index}.png`,
    feature(`base-${index}`, [1, 0, 0], 'target', ['target'])));
  const bait = assemblyItem('a-bait.png', feature('bait-near', [0.984, Math.sqrt(1 - 0.984 ** 2), 0], 'target', ['target']));
  const useful = assemblyItem('b-useful.png', feature('useful', [0.9, 0, Math.sqrt(0.19)], ''));
  // Match the actual text encoder rather than the image-vector test shortcut.
  const { encodeCaptionText } = await import(pathToFileURL(join(temp, 'semanticFeatureService.mjs')));
  for (const asset of [...targetBaseline, bait, useful]) asset.feature.text = encodeCaptionText(asset.caption);
  for (const mode of [{kind:'auto'}, {kind:'max-new',maxNew:3}, {kind:'range',min:3,max:6}]) {
    const result = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,
      baseline:targetBaseline,candidates:[bait,useful],mode,target:'target'});
    assert.equal(result.selected[0]?.path, 'b-useful.png', 'Saturation must consider every eligible candidate');
    assert.ok(result.after.total > result.before.total);
  }
  const forcedTarget = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,
    baseline:targetBaseline,candidates:[bait,useful],mode:{kind:'total',target:5},target:'target'});
  assert.equal(forcedTarget.selected.length, 2, 'A requested total still fills beyond the saturation threshold');
  const pinnedLowGain = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,
    baseline:targetBaseline,candidates:[bait],mode:{kind:'auto'},pinnedKeys:new Set(['a-bait.png'])});
  assert.equal(pinnedLowGain.selected.length, 1, 'A pinned eligible item bypasses saturation');
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
  assert.deepEqual(migratedCaptions.report.assetSnapshots['source:outside'],['original']);
  assert.deepEqual(migratedCaptions.report.assetSnapshots['asset:Project/src/shared/direct.png'],['path']);
  assert.equal(migratedCaptions.report.status, 'complete');
  const relativePathMigration = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:true,captionOverrides:{'asset:src/shared/direct.png':['relative path']}}, dataset:{...dataset,triggerWord:'hero'},
    sourceImages:sourceRecord,datasetItems:editedRecord,pathAssets:[{path:'Project/src/shared/direct.png',tags:['path']}],
  });
  assert.deepEqual(relativePathMigration.pathCaptions['Project/src/shared/direct.png'],['relative path'],'Legacy path keys work with or without Project/');
  const conflictingMigration = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:true,captionOverrides:{'asset:Project/src/shared/direct.png':['first'],'asset:src/shared/direct.png':['second']}}, dataset:{...dataset,triggerWord:'hero'},
    sourceImages:sourceRecord,datasetItems:editedRecord,pathAssets:[{path:'Project/src/shared/direct.png',tags:['path']}],
  });
  assert.equal(conflictingMigration.pathCaptions['Project/src/shared/direct.png'],undefined,'Ambiguous aliases are not resolved by key order');
  assert.equal(conflictingMigration.report.conflicts.length,1);
  assert.equal(conflictingMigration.report.status,'pending');
  const disabledMigration = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:false,captionOverrides:{'source:outside':['disabled']}}, dataset:{...dataset,triggerWord:'hero'}, sourceImages:sourceRecord, datasetItems:editedRecord,
  });
  assert.deepEqual(disabledMigration.sourceImages.outside.tags, ['original'], 'disabled overrides remain archival only');
  assert.deepEqual(disabledMigration.report.legacyOverrides, {'source:outside':['disabled']});
  console.log('dataset assembly contracts: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
