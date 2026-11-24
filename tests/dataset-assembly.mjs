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
      'src/services/project/assetRegistryService.ts',
      'src/services/dataset/coverageService.ts',
      'src/services/dataset/datasetAssemblyService.ts',
      'src/services/dataset/shortlistService.ts',
      'src/services/analysis/semanticFeatureService.ts',
      'src/services/analysis/semanticFeatureCache.ts',
      'src/services/caption/captionMigrationService.ts',
      'src/services/build/buildSessionService.ts',
      'src/services/build/buildTransformService.ts',
      'src/services/quality/imageQuality.ts',
      'src/lib/projectProfilePresets.ts',
      'src/services/build/buildTriageService.ts',
      'src/lib/buildStageSummary.ts',
      'src/services/build/buildClusterService.ts',
      'src/services/quality/metrics/thresholds.ts',
      'src/lib/imageStatusLabels.ts',
      'src/next/board/frameEntries.ts',
      'src/services/similarity/similarityLevels.ts',
    ],
    platform: 'node',
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const caption = await import(pathToFileURL(join(temp, 'captionResolver.mjs')));
  const membership = await import(pathToFileURL(join(temp, 'datasetMembershipResolver.mjs')));
  const shared = await import(pathToFileURL(join(temp, 'sharedCandidateService.mjs')));
  const registryService = await import(pathToFileURL(join(temp, 'assetRegistryService.mjs')));
  const coverage = await import(pathToFileURL(join(temp, 'coverageService.mjs')));
  const assembly = await import(pathToFileURL(join(temp, 'datasetAssemblyService.mjs')));
  const shortlist = await import(pathToFileURL(join(temp, 'shortlistService.mjs')));
  const featureCache = await import(pathToFileURL(join(temp, 'semanticFeatureCache.mjs')));
  const migration = await import(pathToFileURL(join(temp, 'captionMigrationService.mjs')));
  const buildSession = await import(pathToFileURL(join(temp, 'buildSessionService.mjs')));
  const buildTransform = await import(pathToFileURL(join(temp, 'buildTransformService.mjs')));
  const quality = await import(pathToFileURL(join(temp, 'imageQuality.mjs')));
  const presets = await import(pathToFileURL(join(temp, 'projectProfilePresets.mjs')));
  const triage = await import(pathToFileURL(join(temp, 'buildTriageService.mjs')));
  const stageSummary = await import(pathToFileURL(join(temp, 'buildStageSummary.mjs')));
  const clusterSvc = await import(pathToFileURL(join(temp, 'buildClusterService.mjs')));
  const thresholds = await import(pathToFileURL(join(temp, 'thresholds.mjs')));
  const statusLabels = await import(pathToFileURL(join(temp, 'imageStatusLabels.mjs')));
  const frames = await import(pathToFileURL(join(temp, 'frameEntries.mjs')));
  const levels = await import(pathToFileURL(join(temp, 'similarityLevels.mjs')));

  const dataset = { assetIds: ['outside', 'group'], assetPaths: ['Project/inbox/direct.png'], psdAssetPaths: [], overwriteCaptions: true, captionOverrides: { 'source:outside': [] }, triggerWord: 'hero' };
  const item = (id, sourceImageId, assetPath, extra = {}) => ({ id, sourceImageId, assetPath, kind: 'image', imageData: new Blob(['x']), tags: ['hero', 'portrait'], ...extra });
  {
    const first = item('source:first','first','Project/inbox/first.png',{byteSize:10,modifiedAt:1});
    const second = item('source:second','second','Project/inbox/second.png',{byteSize:20,modifiedAt:2,tags:undefined});
    let session = buildSession.reconcileBuildSession(buildSession.createBuildSession(),[first,second],'2026-10-21T00:00:00.000Z');
    assert.deepEqual(session.order,['source:first','source:second']);
    session = buildSession.updateBuildDecision(session,'source:first','accepted',{application:'applied',validation:'valid',acceptedRevision:session.records['source:first'].revision});
    const arriving = item('source:arriving','arriving','Project/inbox/arriving.png',{byteSize:30,modifiedAt:3});
    session = buildSession.reconcileBuildSession({...session,cursor:1},[arriving,second,first]);
    assert.deepEqual(session.order,['source:first','source:second','source:arriving'],'Background arrivals append without reordering reviewed work');
    assert.equal(session.cursor,1);
    const edited = {...first,tags:['changed']};
    session = buildSession.reconcileBuildSession(session,[edited,second,arriving]);
    assert.equal(session.records['source:first'].validation,'stale','A changed accepted revision returns to review');
    const transformAccepted = buildSession.updateBuildDecision(buildSession.reconcileBuildSession(buildSession.createBuildSession(),[first]),'source:first','accepted',{application:'applied',validation:'valid'});
    const changedProfile = {...transformAccepted,profile:{...transformAccepted.profile,transform:{mode:'crop',width:512,height:512,allowUpscale:false}}};
    assert.equal(buildSession.reconcileBuildSession(changedProfile,[first]).records['source:first'].validation,'stale','Changing the output recipe invalidates an accepted revision');
    const moved = buildSession.applyBuildSessionPathMoves(session,[{from:'Project/inbox',to:'Project/renamed'}]);
    assert.equal(moved.records['source:first'].locator,'Project/renamed/first.png');
    const restored = buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(moved)));
    assert.equal(restored.records['source:first'].decision,'accepted');
    assert.deepEqual(buildSession.selectBuildQueue({...restored,filter:'unresolved'},[edited,second,arriving]).map(buildSession.getBuildAssetId),['source:first','source:second','source:arriving']);
  }
  {
    const source = item('source:frame','frame','Project/inbox/frame.png',{byteSize:100,modifiedAt:1,tags:['original']});
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
    const second = item('source:next','next','Project/inbox/next.png');
    const third = item('source:last','last','Project/inbox/last.png');
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
    ['scene.txt', file('scene.txt', 'back view\n', 'text/plain')],
    ['clip.mp4', file('clip.mp4', 'video', 'video/mp4')],
    ['nocaption.png', file('nocaption.png', 'image', 'image/png')],
  ]);
  const record = (id, name, width, height, extra = {}) => ({ id, path: `inbox/${name}`, role: 'file', fileKind: 'image', size: 5, mtime: 7, mimeType: 'image/png', width, height, fileName: name, createdAt: '2025-01-01T00:00:00.000Z', ...extra });
  const registry = { format: 'dataset-creator-assets', version: 1, assets: { 'scene-id': record('scene-id', 'scene.png', 640, 480), n: record('n', 'nocaption.png', 8, 8) } };
  const registryDir = directory([['assets.json', file('assets.json', JSON.stringify(registry), 'application/json')]]);
  const root = directory([['inbox', sharedDir], ['.datasetcreator', registryDir]]);
  await registryService.loadAssetRegistry(root); // Dimensions come from the registry, so no image decoder is needed.
  const scan = await shared.scanSharedCandidates(root);
  assert.equal(scan.sharedAvailable, true);
  assert.equal(scan.candidates.length, 2, 'Caption .txt files are not listed as candidates');
  const sceneCandidate = scan.candidates.find((candidate) => candidate.assetPath === 'Project/inbox/scene.png');
  assert.deepEqual(sceneCandidate.tags, ['back view'], 'The caption comes from the TXT next to the image');
  assert.equal(scan.candidates.find((candidate) => candidate.assetPath === 'Project/inbox/nocaption.png').tags, undefined, 'An image without a TXT has no caption');
  assert.equal(scan.skipped.some((entry) => entry.reason === 'video'), true);

  const vector = (...values) => new Float32Array(values);
  const feature = (hash, image, caption, contexts = []) => ({ imageHash: hash, image: vector(...image), text: vector(...image), caption, contexts });
  const assemblyItem = (path, semantic, quality = 1) => ({ item: item(`asset:${path}`, '', path), feature: semantic, caption: semantic.caption, quality });
  const baseline = assemblyItem('Project/private/front.png', feature('front', [1, 0], 'front portrait', ['front', 'portrait']));
  const back = assemblyItem('Project/inbox/back.png', feature('back', [0, 1], 'back view', ['back', 'view']));
  const backDuplicate = assemblyItem('Project/inbox/z-back-copy.png', feature('back', [0, 1], 'duplicate words', ['duplicate']));
  const similarFront = assemblyItem('Project/inbox/front-2.png', feature('front-2', [0.99, 0.01], 'front portrait', ['front', 'portrait']));
  const metrics = coverage.measureCoverage([assembly.coverageAsset?.(baseline) ?? { key: 'front', feature: baseline.feature }], [{ key: 'front', feature: baseline.feature }, { key: 'back', feature: back.feature }]);
  assert.ok(metrics.total > 0 && metrics.total < 1);
  const datasetForAssembly = { ...dataset, id: 'global' };
  const plan = await assembly.assembleDataset({ projectId: 'project', projectType: 'character', dataset: datasetForAssembly, baseline: [baseline], candidates: [similarFront, backDuplicate, back], mode: { kind: 'max-new', maxNew: 2 } });
  assert.equal(plan.selected[0].path, 'Project/inbox/back.png', 'a missing view should beat a near-duplicate portrait');
  assert.deepEqual(plan.rejectedDuplicates.sort(), ['inbox/front-2.png','inbox/z-back-copy.png']);
  assert.equal(plan.duplicatePairs.find(pair => pair.rejected === 'inbox/front-2.png')?.kind, 'near');
  assert.ok(plan.funnel.evaluated >= plan.funnel.eligible, 'all eligible candidates are evaluated before a selection');
  assert.ok(plan.after.total > plan.before.total);
  assert.ok(plan.selected.every((step,index) => index === 0 || step.coverage.total >= plan.selected[index-1].coverage.total), 'coverage must be monotonic');
  const totalPlan = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,baseline:[baseline],candidates:[back],mode:{kind:'total',target:2}});
  assert.equal(totalPlan.selected.length,1); assert.equal(totalPlan.stoppedBecause,'target-reached'); assert.equal(totalPlan.shortfall,0);
  const shortPlan = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,baseline:[baseline],candidates:[back],mode:{kind:'range',min:4,max:6}});
  assert.equal(shortPlan.shortfall,2); assert.equal(shortPlan.stoppedBecause,'insufficient-pool');
  const textBait = assemblyItem('Project/inbox/text-bait.png', feature('bait',[0.999,0.001],'perfect requested caption',['front']));
  const textPlan = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,baseline:[baseline],candidates:[textBait,back],mode:{kind:'max-new',maxNew:2}});
  assert.equal(textPlan.selected.some(step => step.path.endsWith('text-bait.png')),false,'a caption-similar near-duplicate image is still rejected visually');
  const fingerprintA = await assembly.createAssemblyFingerprint(datasetForAssembly,[baseline,back],{mode:{kind:'auto'},pinnedKeys:new Set()});
  const fingerprintB = await assembly.createAssemblyFingerprint(datasetForAssembly,[baseline,back],{mode:{kind:'auto'},pinnedKeys:new Set(['inbox/back.png'])});
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
      baseline:targetBaseline,candidates:[bait,useful],mode});
    assert.equal(result.selected[0]?.path, 'b-useful.png', 'Saturation must consider every eligible candidate');
    assert.ok(result.after.total > result.before.total);
  }
  const forcedTarget = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,
    baseline:targetBaseline,candidates:[bait,useful],mode:{kind:'total',target:5}});
  assert.equal(forcedTarget.selected.length, 2, 'A requested total still fills beyond the saturation threshold');
  const pinnedLowGain = await assembly.assembleDataset({projectId:'project',projectType:'character',dataset:datasetForAssembly,
    baseline:targetBaseline,candidates:[bait],mode:{kind:'auto'},pinnedKeys:new Set(['a-bait.png'])});
  assert.equal(pinnedLowGain.selected.length, 1, 'A pinned eligible item bypasses saturation');
  const sourceRecord = { outside: { id:'outside', originalFilePath:'private/outside.png', tags:['original'] }, group: { id:'group', originalFilePath:'inbox/group.png', tags:['source'] } };
  const editedRecord = { crop: { id:'crop', sourceImageId:'group', imageDataPath:'inbox/crop.png', tags:['crop'], deleted:false } };
  const migratedCaptions = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:true,captionOverrides:{'source:outside':[], 'source:group':['shared override'], 'edited:crop':['crop override'], 'asset:Project/inbox/direct.png':['path override']}},
    dataset:{...dataset,triggerWord:'hero'}, sourceImages:sourceRecord, datasetItems:editedRecord,
    pathAssets:[{path:'Project/inbox/direct.png',tags:['path']}],
  });
  assert.deepEqual(migratedCaptions.sourceImages.outside.tags, [], 'an explicit empty override stays empty');
  assert.deepEqual(migratedCaptions.sourceImages.group.tags, ['shared override']);
  assert.deepEqual(migratedCaptions.datasetItems.crop.tags, ['crop override']);
  assert.deepEqual(migratedCaptions.pathCaptions['Project/inbox/direct.png'], ['path override']);
  assert.deepEqual(migratedCaptions.report.assetSnapshots['source:outside'],['original']);
  assert.deepEqual(migratedCaptions.report.assetSnapshots['asset:Project/inbox/direct.png'],['path']);
  assert.equal(migratedCaptions.report.status, 'complete');
  const relativePathMigration = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:true,captionOverrides:{'asset:inbox/direct.png':['relative path']}}, dataset:{...dataset,triggerWord:'hero'},
    sourceImages:sourceRecord,datasetItems:editedRecord,pathAssets:[{path:'Project/inbox/direct.png',tags:['path']}],
  });
  assert.deepEqual(relativePathMigration.pathCaptions['Project/inbox/direct.png'],['relative path'],'Legacy path keys work with or without Project/');
  const conflictingMigration = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:true,captionOverrides:{'asset:Project/inbox/direct.png':['first'],'asset:inbox/direct.png':['second']}}, dataset:{...dataset,triggerWord:'hero'},
    sourceImages:sourceRecord,datasetItems:editedRecord,pathAssets:[{path:'Project/inbox/direct.png',tags:['path']}],
  });
  assert.equal(conflictingMigration.pathCaptions['Project/inbox/direct.png'],undefined,'Ambiguous aliases are not resolved by key order');
  assert.equal(conflictingMigration.report.conflicts.length,1);
  assert.equal(conflictingMigration.report.status,'pending');
  const disabledMigration = migration.migrateLegacyCaptions({
    legacy:{overwriteCaptions:false,captionOverrides:{'source:outside':['disabled']}}, dataset:{...dataset,triggerWord:'hero'}, sourceImages:sourceRecord, datasetItems:editedRecord,
  });
  assert.deepEqual(disabledMigration.sourceImages.outside.tags, ['original'], 'disabled overrides remain archival only');
  assert.deepEqual(disabledMigration.report.legacyOverrides, {'source:outside':['disabled']});

  // ---- Stage A: image quality ----
  {
    const good = {width:2000,height:1500,sharpness:0.01,brightness:0.5,darkShare:0.05,brightShare:0.05,dark:false,analysisWidth:512,analysisHeight:384};
    const codes = (r) => r.flags.map((f) => f.code);
    let r = quality.classifyImageQuality(good);
    assert.equal(r.verdict,'pass'); assert.deepEqual(r.flags,[]);
    assert.equal(r.minShortSide,1024,'default min short side is 1024'); assert.equal(r.shortSide,1500);
    r = quality.classifyImageQuality({...good,width:700,height:900});
    assert.equal(r.verdict,'reject'); assert.deepEqual(codes(r),['too-small'],'700 < 0.75*1024 rejects');
    r = quality.classifyImageQuality({...good,width:768,height:900});
    assert.deepEqual(codes(r),['below-target-resolution'],'768 == 0.75*1024 is only review'); assert.equal(r.verdict,'review');
    r = quality.classifyImageQuality({...good,width:1023,height:2000});
    assert.deepEqual(codes(r),['below-target-resolution']);
    r = quality.classifyImageQuality({...good,width:383,height:2000},{minShortSide:512});
    assert.deepEqual(codes(r),['too-small']); assert.equal(r.minShortSide,512);
    r = quality.classifyImageQuality({...good,width:400,height:2000},{minShortSide:512});
    assert.deepEqual(codes(r),['below-target-resolution']);
    r = quality.classifyImageQuality({...good,width:512,height:512},{minShortSide:512});
    assert.equal(r.verdict,'pass','preset 512 passes a 512 image');
    r = quality.classifyImageQuality({...good,sharpness:0.0001});
    assert.deepEqual(codes(r),['blurry']); assert.equal(r.verdict,'reject');
    r = quality.classifyImageQuality({...good,sharpness:0.0007});
    assert.deepEqual(codes(r),['soft']); assert.equal(r.verdict,'review');
    r = quality.classifyImageQuality({...good,dark:true,brightness:0.01,darkShare:1});
    assert.ok(codes(r).includes('dark')); assert.equal(r.verdict,'reject'); assert.ok(!codes(r).includes('underexposed'));
    r = quality.classifyImageQuality({...good,brightness:0.05});
    assert.deepEqual(codes(r),['underexposed']); assert.equal(r.verdict,'review');
    r = quality.classifyImageQuality({...good,darkShare:0.7});
    assert.deepEqual(codes(r),['underexposed']);
    r = quality.classifyImageQuality({...good,brightShare:0.6});
    assert.deepEqual(codes(r),['overexposed']); assert.equal(r.verdict,'review');
    r = quality.classifyImageQuality({...good,width:400,height:400,brightShare:0.6,sharpness:0.0001});
    assert.equal(r.verdict,'reject','verdict is the worst severity'); assert.equal(r.flags.length,3);

    const make = (w,h,fn) => { const d = new Uint8ClampedArray(w*h*4); for (let y=0;y<h;y++) for (let x=0;x<w;x++) { const [R,G,B]=fn(x,y); const i=(y*w+x)*4; d[i]=R;d[i+1]=G;d[i+2]=B;d[i+3]=255; } return d; };
    const src = {width:2000,height:2000};
    const flat = quality.assessImagePixels(make(64,64,()=>[128,128,128]),64,64,src);
    assert.ok(flat.flags.some((f)=>f.code==='blurry')); assert.equal(flat.verdict,'reject');
    assert.equal(typeof flat.sharpness,'number'); assert.equal(typeof flat.brightness,'number');
    assert.ok(Math.abs(flat.brightness-0.5)<0.1,'flat grey brightness ~0.5, got '+flat.brightness);
    assert.equal(flat.shortSide,2000); assert.equal(flat.analysisWidth,64);
    const checker = quality.assessImagePixels(make(64,64,(x,y)=>((x+y)%2?[200,200,200]:[60,60,60])),64,64,src);
    assert.ok(checker.sharpness>0.001,'checkerboard sharp: '+checker.sharpness);
    assert.ok(!checker.flags.some((f)=>f.code==='blurry'||f.code==='soft')); assert.equal(checker.verdict,'pass');
    const black = quality.assessImagePixels(make(64,64,()=>[0,0,0]),64,64,src);
    assert.ok(black.flags.some((f)=>f.code==='dark')); assert.equal(black.verdict,'reject'); assert.ok(black.brightness<0.05);
    const white = quality.assessImagePixels(make(64,64,(x,y)=>((x+y)%2?[255,255,255]:[250,250,250])),64,64,src);
    assert.ok(white.flags.some((f)=>f.code==='overexposed')); assert.ok(white.brightShare>0.9); assert.ok(white.brightness>0.9);
    const small = quality.assessImagePixels(make(64,64,(x,y)=>((x+y)%2?[200,200,200]:[60,60,60])),64,64,{width:300,height:900},{minShortSide:512});
    assert.equal(small.shortSide,300); assert.equal(small.minShortSide,512); assert.ok(small.flags.some((f)=>f.code==='too-small'));
    const summary = quality.summarizeImageQuality(checker);
    assert.equal(summary.flags,undefined); assert.equal(summary.sharpness,checker.sharpness); assert.equal(summary.minShortSide,1024);
  }

  // ---- Stage A: triage service ----
  {
    const NOW='2026-11-01T00:00:00.000Z';
    const img = (id,path,extra={}) => item('source:'+id,id,'Project/src/'+path,{byteSize:1,modifiedAt:1,...extra});
    const a=img('a','a.png'), b=img('b','b.png'), c=img('c','c.png'), d=img('d','d.png');
    const video = {...img('v','v.mp4'),kind:'video'};
    const rep = (over={}) => quality.classifyImageQuality({width:2000,height:2000,sharpness:0.01,brightness:0.5,darkShare:0,brightShare:0,dark:false,analysisWidth:64,analysisHeight:64,...over});
    const cls = (o) => triage.classifyQualityTriage({item:a,inDataset:false,revision:'r1',now:NOW,...o});
    let p = cls({item:video,report:rep()});
    assert.equal(p.group,'needs-decision'); assert.equal(p.reasons[0].code,'video');
    p = cls({}); assert.equal(p.group,'needs-decision'); assert.equal(p.reasons[0].code,'unmeasured');
    p = cls({report:rep(),duplicateOf:'source:b',digest:'abc'});
    assert.equal(p.group,'rejected'); assert.equal(p.duplicateOf,'source:b'); assert.ok(p.reasons.some((r)=>r.code==='exact-duplicate')); assert.equal(p.digest,'abc');
    p = cls({report:rep({sharpness:0.0001})}); assert.equal(p.group,'rejected');
    p = cls({report:rep({sharpness:0.0007})}); assert.equal(p.group,'needs-decision');
    p = cls({report:rep()}); assert.equal(p.group,'accepted'); assert.ok(p.reasons.some((r)=>r.code==='quality-ok'));
    assert.equal(p.stage,'quality'); assert.equal(p.revision,'r1'); assert.equal(p.createdAt,NOW); assert.equal(typeof p.quality.sharpness,'number');
    p = cls({report:rep({sharpness:0.0001}),inDataset:true}); assert.notEqual(p.group,'rejected','Dataset member is never rejected');
    p = cls({report:rep(),duplicateOf:'source:b',inDataset:true}); assert.equal(p.group,'needs-decision');

    const dup = triage.findExactDuplicates([
      {assetId:'x1',digest:'h',inDataset:false},{assetId:'x2',digest:'h',inDataset:true},{assetId:'x3',digest:'h',inDataset:false},
      {assetId:'y1',digest:'k',inDataset:false},{assetId:'y2',digest:'k',inDataset:false},{assetId:'z',digest:'z',inDataset:false}]);
    assert.deepEqual([...dup.entries()].sort(),[['x1','x2'],['x3','x2'],['y2','y1']]);

    const base = buildSession.reconcileBuildSession(buildSession.createBuildSession(),[a,b,c,d,video],NOW);
    const prop = {group:'accepted',reasons:[],stage:'quality',revision:'r',createdAt:NOW};
    let s2 = triage.applyTriageProposal(base,'source:a',prop);
    assert.equal(s2.records['source:a'].triage.group,'accepted');
    const skipped = buildSession.updateBuildDecision(base,'source:a','skipped');
    assert.equal(triage.applyTriageProposal(skipped,'source:a',prop).records['source:a'].triage,undefined,'only unreviewed get triage');
    assert.equal(triage.applyTriageProposal(base,'source:missing',prop),base);

    // applyAssemblyTriage
    const pathOf = (i) => i.assetPath;
    const keyMap = new Map([['k:a','source:a'],['k:b','source:b'],['k:c','source:c'],['k:d','source:d']]);
    let ms = buildSession.updateBuildDecision(base,'source:d','accepted',{application:'applied',validation:'valid'});
    ms = triage.applyTriageProposal(ms,'source:a',{...prop,revision:'qrev'});
    const plan = {
      selected:[{key:'k:a',reason:'gain'}],
      duplicatePairs:[{kept:'k:a',rejected:'k:b',kind:'near',similarity:0.97},{kept:'k:a',rejected:'k:d',kind:'exact',similarity:1}],
      rejectedCandidates:[{path:'k:b',reason:'near-duplicate'},{path:'k:c',reason:'not-selected'},{path:'k:d',reason:'exact-duplicate'}],
      stoppedBecause:'target-reached',
    };
    const out = triage.applyAssemblyTriage(ms,plan,keyMap,NOW);
    const ra=out.records['source:a'].triage, rb=out.records['source:b'].triage, rc=out.records['source:c'].triage;
    assert.equal(ra.group,'accepted'); assert.equal(ra.stage,'assembly'); assert.equal(ra.revision,'qrev','keeps previous revision');
    assert.equal(rb.group,'rejected'); assert.equal(rb.duplicateOf,'source:a'); assert.equal(rb.similarity,0.97); assert.equal(rb.reasons[0].code,'near-duplicate');
    assert.equal(rc.group,'rejected'); assert.equal(rc.reasons[0].code,'not-selected'); assert.ok(rc.reasons[0].message.includes('target reached'));
    assert.equal(out.records['source:d'].triage,undefined,'manual decision untouched'); assert.equal(out.records['source:d'].decision,'accepted');
    const exactOut = triage.applyAssemblyTriage(base,{...plan,selected:[],duplicatePairs:[{kept:'k:a',rejected:'k:c',kind:'exact',similarity:1}]},keyMap,NOW);
    assert.equal(exactOut.records['source:c'].triage.reasons[0].code,'exact-duplicate'); assert.equal(exactOut.records['source:c'].triage.duplicateOf,'source:a');

    // counts and selectors
    let cs = buildSession.createBuildSession();
    cs = buildSession.reconcileBuildSession(cs,[a,b,c,d,video],NOW);
    cs = triage.applyTriageProposal(cs,'source:a',{...prop,group:'accepted'});
    cs = triage.applyTriageProposal(cs,'source:b',{...prop,group:'rejected'});
    cs = triage.applyTriageProposal(cs,'source:c',{...prop,group:'needs-decision'});
    assert.deepEqual(triage.getBuildTriageCounts(cs,[a,b,c,d,video]),{accepted:1,rejected:1,needsDecision:1,pending:2});
    assert.deepEqual(triage.getBuildTriageCounts(cs,[a,b]),{accepted:1,rejected:1,needsDecision:0,pending:0});
    cs = buildSession.updateBuildDecision(cs,'source:d','skipped');
    assert.equal(triage.getBuildTriageCounts(cs,[d]).rejected,1,'manual skip counts as rejected');
    const targets = triage.selectTriageTargets(cs,[video,c,b,a,d,{...img('new','new.png')}]).map(buildSession.getBuildAssetId);
    assert.deepEqual(targets,['source:v'],'targets are unreviewed without triage, in session order');
    const dsItem = {...img('ds','x.png'),assetPath:'Project/dataset/x.png'};
    const cs2 = buildSession.reconcileBuildSession(cs,[a,b,c,d,video,dsItem],NOW);
    const withDs = triage.applyTriageProposal(triage.applyTriageProposal(cs2,'source:a',{...prop,group:'accepted'}),'source:ds',{...prop,group:'accepted'});
    assert.equal(cs2.records['source:a'].triage,undefined,'proposals with a foreign revision are dropped on reconcile');
    assert.deepEqual(triage.selectAssemblyCandidates(withDs,[dsItem,b,a,c]).map(buildSession.getBuildAssetId),['source:a'],'only quality-accepted, unreviewed, non-Dataset');
    const asm = triage.applyAssemblyTriage(cs,{selected:[{key:'k:a',reason:'g'}],duplicatePairs:[],rejectedCandidates:[],stoppedBecause:'x'},keyMap,NOW);
    assert.equal(asm.records['source:a'].triage.stage,'assembly');
    assert.deepEqual(triage.selectAssemblyCandidates(asm,[a]).map(buildSession.getBuildAssetId),['source:a'],'frames from the previous Assemble (assembly-stage triage) return to the pool');
    const asmRejected = triage.applyAssemblyTriage(cs,{selected:[],duplicatePairs:[{kept:'k:a',rejected:'k:b',kind:'near',similarity:0.9}],rejectedCandidates:[{path:'k:c',reason:'not-selected'}],stoppedBecause:'target-reached'},keyMap,NOW);
    assert.deepEqual(triage.selectAssemblyCandidates(asmRejected,[b,c]).map(buildSession.getBuildAssetId),['source:b','source:c'],'previous duplicate and not-selected outcomes are candidates again');
    const k1 = triage.createAssemblyKey(10,[a,b],cs), k2 = triage.createAssemblyKey(10,[b,a],cs);
    assert.equal(k1,k2); assert.notEqual(k1,triage.createAssemblyKey(11,[a,b],cs));
    assert.notEqual(k1,triage.createAssemblyKey(10,[a],cs));
    const revChanged = {...cs,records:{...cs.records,'source:a':{...cs.records['source:a'],triage:{...cs.records['source:a'].triage,revision:'other'}}}};
    assert.notEqual(k1,triage.createAssemblyKey(10,[a,b],revChanged));
    void pathOf;
  }

  // ---- Stage A: build session triage behaviour ----
  {
    const NOW='2026-11-01T00:00:00.000Z';
    const mk = (id,extra={}) => item('source:'+id,id,'Project/src/t/'+id+'.png',{byteSize:5,modifiedAt:1,...extra});
    const a=mk('a'), b=mk('b'), c=mk('c');
    const tri = (group,revision) => ({group,reasons:[{code:'quality-ok',message:'x'}],stage:'quality',revision,createdAt:NOW});
    let s = buildSession.reconcileBuildSession(buildSession.createBuildSession(),[a,b,c],NOW);
    const rev = (id,i) => buildSession.getBuildContentRevision(i,undefined);
    s = {...s,records:{...s.records,
      'source:a':{...s.records['source:a'],triage:tri('rejected',rev('a',a))},
      'source:b':{...s.records['source:b'],triage:tri('accepted',rev('b',b))},
    }};
    assert.equal(buildSession.getBuildCounts(s,[a,b,c]).unresolved,2,'triage-rejected unreviewed is not unresolved');
    const ids = (sess) => buildSession.selectBuildQueue(sess,[a,b,c]).map(buildSession.getBuildAssetId);
    assert.deepEqual(ids({...s,filter:'unresolved'}),['source:b','source:c']);
    assert.deepEqual(ids({...s,filter:'rejected'}),['source:a']);
    assert.deepEqual(ids({...s,filter:'accepted'}),['source:b']);
    assert.deepEqual(ids({...s,filter:'needs-decision'}),['source:c'],'pending counts as needs-decision filter');
    assert.deepEqual(ids({...s,filter:'all'}),['source:a','source:b','source:c']);
    assert.deepEqual(ids({...s,filter:'all',profile:{...s.profile,reviewMode:'uncertain-only'}}),['source:b','source:c'],'uncertain-only hides triage-rejected in all');
    // manual override wins
    const accepted = buildSession.updateBuildDecision(s,'source:a','accepted',{application:'applied',validation:'valid'});
    assert.equal(buildSession.getBuildTriageGroup(accepted.records['source:a']),'accepted');
    assert.equal(buildSession.getBuildTriageGroup(buildSession.updateBuildDecision(s,'source:b','skipped').records['source:b']),'rejected');
    assert.equal(buildSession.getBuildTriageGroup(buildSession.updateBuildDecision(s,'source:b','deferred').records['source:b']),'needs-decision');
    assert.equal(buildSession.getBuildTriageGroup(s.records['source:c']),'pending');
    assert.equal(buildSession.getBuildTriageGroup(s.records['source:a']),'rejected');
    // reconcile
    const same = buildSession.reconcileBuildSession(s,[a,b,c],NOW);
    assert.equal(same,s,'unchanged reconcile keeps session identity'); assert.ok(same.records['source:a'].triage);
    const tagOnly = buildSession.reconcileBuildSession(s,[{...a,tags:['other','tags']},b,c],NOW);
    assert.ok(tagOnly.records['source:a'].triage,'tag-only change keeps triage');
    const changed = buildSession.reconcileBuildSession(s,[{...a,byteSize:999,modifiedAt:7},b,c],NOW);
    assert.equal(changed.records['source:a'].triage,undefined,'content change drops triage');
    assert.ok(changed.records['source:b'].triage);
    // normalize
    const json = JSON.parse(JSON.stringify({...s,filter:'needs-decision',profile:{...s.profile,minShortSide:512.7,autoPipeline:false},auto:{assemblyKey:'k'}}));
    json.records['source:c'].triage = {group:'bogus',reasons:[],revision:'x'};
    json.records['source:b'].triage = {group:'accepted',reasons:'no',revision:'x'};
    const n = buildSession.normalizeBuildSession(json);
    assert.ok(n.records['source:a'].triage,'valid triage kept'); assert.equal(n.records['source:b'].triage,undefined); assert.equal(n.records['source:c'].triage,undefined);
    assert.equal(n.filter,'needs-decision'); assert.equal(n.profile.minShortSide,undefined,'normalize no longer emits profile.minShortSide'); assert.equal(n.profile.autoPipeline,false); assert.equal(n.auto.assemblyKey,'k');
    // legacy Build minShortSide migrates to the project target model
    assert.equal(presets.resolveTargetModel(undefined,512),'sd15','legacy 512 -> sd15');
    assert.equal(presets.resolveTargetModel(undefined,512.7),'sd15','legacy 512.7 floors to 512 -> sd15');
    assert.equal(presets.resolveTargetModel(undefined,1024),'sdxl'); assert.equal(presets.resolveTargetModel(undefined,768),'sdxl');
    assert.equal(presets.resolveTargetModel(undefined),'sdxl','missing -> sdxl'); assert.equal(presets.resolveTargetModel(null,undefined),'sdxl');
    assert.equal(presets.resolveTargetModel('flux',512),'flux','stored targetModel wins over legacy'); assert.equal(presets.resolveTargetModel('sdxl',512),'sdxl');
    assert.equal(presets.resolveTargetModel('bogus',512),'sd15','invalid stored value falls back to legacy migration');
    assert.deepEqual(['sd15','sdxl','flux'].map((m)=>quality.getMinShortSide(m)),[512,1024,1024]);
    assert.equal(quality.getMinShortSide(),1024,'default target model is sdxl');
    assert.equal(quality.getMinShortSide(buildSession.normalizeBuildSession(json).profile.targetModel),1024);
    for (const f of ['accepted','rejected']) assert.equal(buildSession.normalizeBuildSession({...json,filter:f}).filter,f);
    assert.equal(buildSession.normalizeBuildSession({...json,filter:'nope'}).filter,'all');
    const def = buildSession.normalizeBuildSession({version:1});
    assert.equal(def.profile.autoPipeline,true,'autoPipeline defaults on'); assert.equal(def.profile.minShortSide,undefined);
    assert.equal('minShortSide' in n.profile,false);
    assert.equal(buildSession.normalizeBuildSession(null).profile.autoPipeline ?? true,true);
    // profile.similarityStrictness: known ids survive, anything else is dropped (absent = Balanced).
    for (const id of ['strict','balanced','loose']) assert.equal(buildSession.normalizeBuildSession({...json,profile:{...json.profile,similarityStrictness:id}}).profile.similarityStrictness,id);
    for (const bad of ['STRICT','duplicate','',null,3,{},['strict']]) assert.equal('similarityStrictness' in buildSession.normalizeBuildSession({...json,profile:{...json.profile,similarityStrictness:bad}}).profile,false,`unknown strictness ${JSON.stringify(bad)} is dropped`);
    assert.equal('similarityStrictness' in buildSession.normalizeBuildSession({version:1}).profile,false);
    assert.equal(buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(buildSession.normalizeBuildSession({...json,profile:{...json.profile,similarityStrictness:'loose'}})))).profile.similarityStrictness,'loose','survives a JSON round trip');
  }

  // ---- Stage A: encodeAssemblyInputs ----
  {
    const mkImg = (id,tags) => ({id,sourceImageId:id,assetPath:'Project/src/'+id+'.png',kind:'image',imageData:new Blob(['x']),tags,width:2048,height:512,dimensionsKnown:true});
    const items = [mkImg('e1',['hero','a']),mkImg('e2',['b']),mkImg('e3',['c'])];
    const calls = []; const progress = [];
    const encoder = {async encode(i,cap){ calls.push([i.id,cap]); return {id:i.id}; }};
    const res = await assembly.encodeAssemblyInputs(items,{triggerWord:'hero',encoder,onProgress:(x,y)=>progress.push([x,y])});
    assert.deepEqual(res.map((r)=>r.item.id),['e1','e2','e3']); assert.deepEqual(calls.map((x)=>x[0]),['e1','e2','e3']);
    assert.deepEqual(res.map((r)=>r.caption),calls.map((x)=>x[1]),'caption passed to encoder and returned');
    assert.equal(calls[0][1],caption.resolveAssetCaption(items[0],'hero').normalized); assert.ok(calls[0][1].includes('a'));
    assert.deepEqual(res[0].feature,{id:'e1'}); assert.equal(res[0].quality,Math.min(1,Math.sqrt(2048*512)/1024));
    assert.deepEqual(progress.map((x)=>x[0]),[0,1,2]); assert.ok(progress.every((x)=>x[1]===3));
    const ctrl = new AbortController(); const seen = [];
    await assert.rejects(assembly.encodeAssemblyInputs(items,{triggerWord:'hero',signal:ctrl.signal,
      encoder:{async encode(i){ seen.push(i.id); ctrl.abort(); return {id:i.id}; }}}));
    assert.deepEqual(seen,['e1'],'abort stops after the in-flight item');
    const pre = new AbortController(); pre.abort(); const none=[];
    await assert.rejects(assembly.encodeAssemblyInputs(items,{triggerWord:'',signal:pre.signal,encoder:{async encode(i){none.push(i);return {};}}}));
    assert.equal(none.length,0);
  }
  {
    // encodeAssemblyInputs skips an unreadable item (reported via onSkip) while the rest proceed; abort is never swallowed.
    const mkImg = (id) => ({id,sourceImageId:id,assetPath:'Project/inbox/'+id+'.png',kind:'image',imageData:new Blob(['x']),tags:[id],width:64,height:64,dimensionsKnown:true});
    const items = ['s1','bad','s3','empty'].map(mkImg);
    const skipped = []; const progress = [];
    const res = await assembly.encodeAssemblyInputs(items,{triggerWord:'',onProgress:(x,y)=>progress.push([x,y]),onSkip:(entry)=>skipped.push([entry.item.id,entry.reason]),
      encoder:{async encode(i){ if (i.id==='bad') throw new Error('could not be decoded'); if (i.id==='empty') throw new Error(''); return {id:i.id}; }}});
    assert.deepEqual(res.map((r)=>r.item.id),['s1','s3'],'throwing items are skipped, others proceed');
    assert.deepEqual(skipped,[['bad','could not be decoded'],['empty','Could not be read']],'skips carry the reason with a fallback');
    assert.deepEqual(progress.map((x)=>x[0]),[0,1,2,3]);
    const silent = await assembly.encodeAssemblyInputs(items,{triggerWord:'',encoder:{async encode(i){ if (i.id!=='s1') throw new Error('x'); return {}; }}});
    assert.equal(silent.length,1,'onSkip is optional');
    const ctrl = new AbortController();
    await assert.rejects(assembly.encodeAssemblyInputs(items,{triggerWord:'',signal:ctrl.signal,onSkip:()=>{ throw new Error('abort must not be reported as a skip'); },
      encoder:{async encode(){ ctrl.abort(); throw new Error('encoder failed after abort'); }}}),(error)=>error?.name==='AbortError','abort during a failing encode rethrows instead of skipping');
  }
  {
    // assembleDataset: deterministic picks equal the pre-7c585f4 implementation's picks (derived by running both on this fixture).
    const v = (...x) => new Float32Array(x);
    const f = (hash,image,cap,contexts=[]) => ({imageHash:hash,image:v(...image),text:v(...image),caption:cap,contexts});
    const it = (path,semantic) => ({item:{id:'asset:'+path,assetPath:path,kind:'image',width:1024,height:1024,dimensionsKnown:true},feature:semantic,caption:semantic.caption,quality:1});
    const base = [it('b/front.png',f('f',[1,0,0],'front',['front']))];
    const cands = [it('inbox/a-front2.png',f('f2',[0.99,0.14,0],'front',['front'])),it('inbox/b-back.png',f('bk',[0,1,0],'back',['back'])),
      it('inbox/c-back-copy.png',f('bk',[0,1,0],'copy',['x'])),it('inbox/d-side.png',f('sd',[0,0,1],'side',['side'])),it('inbox/e-three.png',f('t',[0,0.7,0.7],'three',['three']))];
    const plan = await assembly.assembleDataset({projectId:'p',projectType:'character',dataset:{id:'g'},baseline:base,candidates:cands,mode:{kind:'auto'}});
    assert.deepEqual(plan.selected.map((s)=>s.key),['inbox/e-three.png','inbox/b-back.png','inbox/d-side.png']);
    assert.deepEqual(plan.rejectedDuplicates,['inbox/a-front2.png','inbox/c-back-copy.png'],'near copy and exact hash duplicate are deduplicated');
    assert.deepEqual(plan.duplicatePairs.map((p)=>p.kind),['near','exact']);
    assert.equal(plan.stoppedBecause,'exhausted');
    assert.deepEqual(plan.selected.map((s)=>s.gain.toFixed(4)),['0.5432','0.1013','0.1013']);
    assert.equal(plan.before.total.toFixed(4),'0.2500'); assert.equal(plan.after.total.toFixed(4),'0.9957');
    const excluded = await assembly.assembleDataset({projectId:'p',projectType:'character',dataset:{id:'g'},baseline:base,candidates:cands,mode:{kind:'auto'},excludedKeys:new Set(['inbox/e-three.png'])});
    assert.equal(excluded.selected.some((s)=>s.key==='inbox/e-three.png'),false); assert.equal(excluded.funnel.excluded,1);

    // progress and abort
    const events = [];
    await assembly.assembleDataset({projectId:'p',projectType:'character',dataset:{id:'g'},baseline:base,candidates:cands,mode:{kind:'auto'},onProgress:(e)=>events.push(e)});
    assert.equal(events[0].phase,'similarity'); assert.equal(events[0].total,6,'similarity pool is baseline + all non-excluded candidates');
    const selecting = events.filter((e)=>e.phase==='selecting');
    assert.deepEqual(selecting.map((e)=>e.completed),[1,2,3]); assert.ok(selecting.every((e)=>e.total===3));
    const pre = new AbortController(); pre.abort();
    await assert.rejects(assembly.assembleDataset({projectId:'p',projectType:'character',dataset:{id:'g'},baseline:base,candidates:cands,mode:{kind:'auto'},signal:pre.signal}),(e)=>e?.name==='AbortError');
    // Large pool: abort from a timer stops the run promptly instead of finishing it.
    const many = Array.from({length:700},(_,i)=>{ const a=i*0.37; return it(`inbox/m${String(i).padStart(4,'0')}.png`,f('h'+i,[Math.cos(a),Math.sin(a)*Math.cos(i),Math.sin(a)*Math.sin(i)],'c'+i,['c'+(i%40)])); });
    const ctrl = new AbortController();
    const started = performance.now(); const timer = setTimeout(()=>ctrl.abort(),30);
    const outcome = await assembly.assembleDataset({projectId:'p',projectType:'character',dataset:{id:'g'},baseline:base,candidates:many,mode:{kind:'auto'},signal:ctrl.signal}).then(()=>'done',(e)=>e?.name);
    clearTimeout(timer);
    assert.equal(outcome,'AbortError','a long run is cancelled by the signal'); assert.ok(performance.now()-started<1500,'abort is prompt');
  }
  {
    // mergeBuildItems: registered images override passed items by Build asset id, extra registered images are
    // appended, and the merge stays linear (Build recomputes it for projects with thousands of files).
    {
      const source = (id) => ({ id, fileName: `${id}.png`, mimeType: 'image/png', originalFilePath: `inbox/${id}.png`, originalFile: new Blob(['x']), width: 1024, height: 1024, createdAt: new Date(0), tags: ['t'] });
      const merged = stageSummary.mergeBuildItems([{ id: 'source:a', sourceImageId: 'a', kind: 'image', assetPath: 'Project/inbox/stale.png' }, { id: 'asset:Project/inbox/v.mp4', kind: 'video', assetPath: 'Project/inbox/v.mp4' }], [source('a'), source('b')], []);
      assert.deepEqual(merged.map((entry) => entry.assetPath), ['Project/inbox/a.png', 'Project/inbox/v.mp4', 'Project/inbox/b.png'], 'Registered images win and new ones are appended');
      const count = 20000;
      const sources = Array.from({ length: count }, (_, index) => source(`s${index}`));
      const passed = sources.map((entry) => ({ id: `source:${entry.id}`, sourceImageId: entry.id, kind: 'image', assetPath: `Project/inbox/${entry.id}.png` }));
      const started = performance.now();
      const large = stageSummary.mergeBuildItems(passed, sources, []);
      const elapsed = performance.now() - started;
      assert.equal(large.length, count, 'No duplicates when every passed item is registered');
      assert.ok(elapsed < 1500, `Merging ${count} items stays linear (took ${Math.round(elapsed)} ms)`);
    }
    // Build stages: normalizeBuildSession defaults and getBuildStageSummary counters/states
    const fresh = buildSession.createBuildSession();
    assert.equal(fresh.stage,'add','new session starts in Add');
    assert.deepEqual([...buildSession.BUILD_STAGES],['add','select','caption','check','export']);
    const legacyEmpty = { ...fresh }; delete legacyEmpty.stage;
    assert.equal(buildSession.normalizeBuildSession(legacyEmpty).stage,'add','legacy empty session -> add');
    assert.equal(buildSession.normalizeBuildSession(undefined).stage,'add');
    const record = { assetId:'source:a', decision:'unreviewed', application:'idle', validation:'pending' };
    assert.equal(buildSession.normalizeBuildSession({ ...legacyEmpty, order:['source:a'], records:{ 'source:a': record } }).stage,'select','legacy session with records -> select');
    for (const stage of ['caption','check','export']) assert.equal(buildSession.normalizeBuildSession({ ...fresh, stage }).stage,stage,`valid stage ${stage} kept`);
    assert.equal(buildSession.normalizeBuildSession({ ...fresh, stage:'bogus' }).stage,'add','invalid stage falls back');
    assert.equal(buildSession.normalizeBuildSession({ ...legacyEmpty, stage:'bogus', records:{ 'source:a': record } }).stage,'select','invalid stage with records falls back to select');
    // Select view mode: grid/clusters persist, invalid or missing -> list (absent)
    for (const view of ['grid','clusters']) assert.equal(buildSession.normalizeBuildSession({ ...fresh, view }).view,view,`view ${view} kept`);
    for (const view of ['list','bogus',5,null,undefined]) assert.equal(buildSession.normalizeBuildSession({ ...fresh, view }).view ?? 'list','list',`view ${String(view)} -> list`);
    assert.equal(buildSession.normalizeBuildSession(null).view ?? 'list','list');

    const img = (id, extra = {}) => ({ id, sourceImageId:id, kind:'image', label:'Image', displayIdentity:id, fileName:`${id}.png`, assetPath:`inbox/${id}.png`, imageData:new Blob(), width:1024, height:1024, aspectRatio:'1:1', ...extra });
    const summarize = (items, session, readiness) => stageSummary.getBuildStageSummary({ session, effectiveItems:items, candidates:items.filter((i)=>!i.assetPath?.startsWith('dataset/')), readiness });
    const byId = (summary) => Object.fromEntries(summary.stages.map((entry) => [entry.id, entry]));
    const empty = summarize([], fresh);
    assert.deepEqual(empty.stages.map((e)=>e.id),['add','select','caption','check','export']);
    assert.ok(empty.stages.every((e)=>e.state==='empty'),'nothing -> every stage empty');
    assert.equal(byId(empty).add.counter,'0 files'); assert.equal(byId(empty).caption.counter,'0/0 captioned');
    assert.equal(empty.nextIncomplete,'add');

    const inbox = [img('a'), img('b')];
    const withMaterials = summarize(inbox, buildSession.reconcileBuildSession(fresh, inbox));
    assert.equal(byId(withMaterials).add.state,'done'); assert.equal(byId(withMaterials).add.counter,'2 files');
    assert.equal(byId(withMaterials).select.state,'in-progress'); assert.match(byId(withMaterials).select.counter,/0\/60 ready · 2 undecided/);
    assert.equal(byId(withMaterials).caption.state,'empty');
    assert.equal(withMaterials.nextIncomplete,'select');
    assert.equal(byId(summarize([img('a')], buildSession.reconcileBuildSession(fresh, [img('a')]))).add.counter,'1 file','singular file');

    const dataset = [img('d1',{ assetPath:'dataset/d1.png', tags:['x'] }), img('d2',{ assetPath:'dataset/d2.png', tags:[] }), img('d3',{ assetPath:'dataset/d3.png' })];
    const partial = summarize([...inbox, ...dataset], fresh, 'warn');
    assert.equal(partial.datasetSize,3); assert.equal(partial.captioned,1,'tags: [] and missing tags are not captioned');
    assert.equal(byId(partial).caption.counter,'1/3 captioned'); assert.equal(byId(partial).caption.state,'in-progress');
    assert.equal(byId(partial).check.state,'in-progress'); assert.equal(byId(partial).check.counter,'Needs attention');
    const captioned = summarize(dataset.map((i)=>({ ...i, tags:['x'] })), fresh, 'ok');
    assert.equal(byId(captioned).caption.state,'done'); assert.equal(byId(captioned).check.state,'done'); assert.equal(byId(captioned).check.counter,'Ready');
    assert.equal(byId(summarize(dataset, fresh, 'fail')).check.counter,'Not ready');
    assert.equal(byId(captioned).export.state,'empty');
    assert.equal(captioned.nextIncomplete,'add','Add is not done without source materials');
    const exported = summarize([...inbox, ...dataset.map((i)=>({ ...i, tags:['x'] }))], { ...fresh, lastExport:{ fingerprint:'f', entries:3, completedAt:'2024-01-01T00:00:00.000Z' } }, 'ok');
    assert.equal(byId(exported).export.state,'done'); assert.equal(byId(exported).export.counter,'3 files exported');
    assert.equal(byId(exported).caption.state,'done');
    assert.equal(exported.nextIncomplete,'select','first non-done stage is reported');
  }
  {
    // Semantic feature cache LRU (memory tier; semanticFeatureStore needs IndexedDB, which Node lacks and no fake-indexeddb is installed).
    featureCache.clearSemanticFeatureCache();
    const vec = (n) => new Float32Array([n]);
    for (let i = 0; i < 5000; i += 1) featureCache.setCachedImageFeature(`k${i}`, vec(i));
    assert.ok(featureCache.getCachedImageFeature('k0'), 'a full cache keeps every entry');
    featureCache.setCachedImageFeature('new', vec(-1)); // evicts the least recently used: k1 (k0 was just read)
    assert.equal(featureCache.getCachedImageFeature('k1'), undefined, 'least recently used entry is evicted first');
    assert.ok(featureCache.getCachedImageFeature('k0'), 'a recently read entry survives eviction');
    assert.ok(featureCache.getCachedImageFeature('k2'));
    featureCache.setCachedImageFeature('k2', vec(99)); // overwrite refreshes recency without growing
    featureCache.setCachedImageFeature('new2', vec(-2)); // evicts k3
    assert.equal(featureCache.getCachedImageFeature('k3'), undefined);
    assert.equal(featureCache.getCachedImageFeature('k2')[0], 99);
    assert.equal(await featureCache.readImageFeature('missing-without-indexeddb'), undefined, 'storage unavailable is a miss, not an error');
    featureCache.writeImageFeature('w', vec(7));
    assert.equal((await featureCache.readImageFeature('w'))[0], 7, 'write is served from memory');
    featureCache.clearSemanticFeatureCache();
  }
  {
    // encodeAssemblyInputs: model failures are fatal, per-item failures are skipped.
    const semantic = await import(pathToFileURL(join(temp, 'semanticFeatureService.mjs')));
    const imgs = ['a', 'b', 'c'].map((n) => item(`source:${n}`, n, `Project/inbox/${n}.png`));
    const feature = { imageHash: 'h', image: new Float32Array(1), text: new Float32Array(1), contexts: [], caption: '' };
    const skipped = [];
    const ok = await assembly.encodeAssemblyInputs(imgs, {
      triggerWord: 'hero', onSkip: (s) => skipped.push(s),
      encoder: { encode: async (i) => { if (i.id === 'source:b') throw new Error('bad pixels'); return feature; } },
    });
    assert.deepEqual(ok.map((a) => a.item.id), ['source:a', 'source:c']);
    assert.deepEqual(skipped.map((s) => [s.item.id, s.reason]), [['source:b', 'bad pixels']]);
    const skippedOnModelError = [];
    await assert.rejects(assembly.encodeAssemblyInputs(imgs, {
      triggerWord: 'hero', onSkip: (s) => skippedOnModelError.push(s),
      encoder: { encode: async () => { throw new semantic.SemanticModelError('model missing'); } },
    }), (e) => semantic.isSemanticModelError(e) && e.message === 'model missing');
    assert.equal(skippedOnModelError.length, 0, 'SemanticModelError must not reach onSkip');
  }

  {
    // Two-pass shortlist: synthetic unit vectors; similarity is the dot product.
    const DIM = 80;
    const unit = (parts) => { const v = new Float32Array(DIM); for (const [axis, w] of parts) v[axis] += w; const n = Math.hypot(...v); return v.map((x) => x / n); };
    const input = (path, parts, extra = {}) => ({
      item: { id: `asset:${path}`, sourceImageId: path, assetPath: path, kind: 'image', imageData: new Blob(['x']) },
      feature: { imageHash: `h:${path}`, image: unit(parts), text: unit(parts), caption: '', contexts: [] }, caption: '', quality: 0.5, ...extra,
    });
    const keys = (items) => items.map((entry) => entry.path);
    const cutoff = shortlist.SHORTLIST_DUPLICATE_THRESHOLD;
    assert.equal(cutoff, 0.93);

    // 5 near-identical comic pages (pairwise >= 0.93) plus distinct images: at most one page is shortlisted.
    {
      const pages = [0, 1, 2, 3, 4].map((n) => input(`Project/inbox/comic_p${n}.png`, [[0, 1], [10 + n, 0.1]]));
      for (const a of pages) for (const b of pages) if (a !== b) assert.ok(a.feature.image.reduce((sum, x, i) => sum + x * b.feature.image[i], 0) >= cutoff, 'pages are near-identical');
      const others = [20, 21, 22, 23, 24, 25].map((axis) => input(`Project/inbox/other_${axis}.png`, [[axis, 1]]));
      const result = await shortlist.buildShortlist({ baseline: [], candidates: [...pages, ...others], needed: 6 });
      const pickedPages = keys(result.items).filter((path) => path.includes('comic_p'));
      assert.ok(pickedPages.length <= 1, `at most one comic page, got ${pickedPages.length}`);
      assert.equal(result.items.length, 7, 'the rest of the shortlist is filled with distinct images');
      assert.ok(result.duplicates.filter((entry) => entry.against === 'shortlist').length >= 4, 'other pages are reported as duplicates of the pick');
    }

    // duplicateThreshold (Strictness): the same pool gives more groups at Strict and fewer at Loose; the default is Balanced (0.93).
    {
      const levelCutoff = (id) => levels.getStrictnessThreshold(id, 'dinov2');
      assert.equal(levelCutoff('balanced'), cutoff, 'Balanced is the former fixed 0.93');
      assert.ok(levelCutoff('strict') > levelCutoff('balanced') && levelCutoff('balanced') > levelCutoff('loose'));
      // a, b (cos 0.96 to a), c (cos 0.90 to a, 0.864 to b): between the three cutoffs. Plus two clearly different images.
      const along = (axis, cos) => [[0, cos], [axis, Math.sqrt(1 - cos * cos)]];
      const pool = () => [input('Project/inbox/a.png', [[0, 1]]), input('Project/inbox/b.png', along(1, 0.96)), input('Project/inbox/c.png', along(2, 0.9)),
        input('Project/inbox/x.png', [[40, 1]]), input('Project/inbox/y.png', [[41, 1]])];
      const counts = async (threshold) => (await shortlist.buildShortlist({ baseline: [], candidates: pool(), needed: 'auto', duplicateThreshold: threshold })).items.length;
      assert.equal(await counts(levelCutoff('strict')), 5, 'Strict: nothing is a duplicate');
      assert.equal(await counts(levelCutoff('balanced')), 4, 'Balanced: b is a duplicate of a');
      assert.equal(await counts(levelCutoff('loose')), 3, 'Loose: a, b, c are one group');
      assert.equal(await counts(undefined), await counts(cutoff), 'omitted threshold = the former fixed cutoff');
      const loose = await shortlist.buildShortlist({ baseline: [], candidates: pool(), needed: 'auto', duplicateThreshold: levelCutoff('loose') });
      assert.equal(loose.duplicates.filter((entry) => entry.against === 'shortlist').length, 2);
      // A Dataset item takes part in the same cutoff.
      const base = input('Project/dataset/base.png', [[0, 1]]);
      const against = async (id) => (await shortlist.buildShortlist({ baseline: [base], candidates: [pool()[2]], needed: 'auto', duplicateThreshold: levelCutoff(id) })).items.length;
      assert.deepEqual([await against('strict'), await against('balanced'), await against('loose')], [1, 1, 0], 'c is only a duplicate of the Dataset item at Loose');
    }

    // A candidate >= 0.93 similar to a Dataset item is never shortlisted.
    {
      const base = input('Project/dataset/base.png', [[0, 1]]);
      const near = input('Project/inbox/near_base.png', [[0, 1], [1, 0.25]]);
      assert.ok(0.97 < 1 / Math.hypot(1, 0.25) && 1 / Math.hypot(1, 0.25) < 0.98);
      const far = [30, 31, 32].map((axis) => input(`Project/inbox/far_${axis}.png`, [[axis, 1]]));
      const result = await shortlist.buildShortlist({ baseline: [base], candidates: [near, ...far], needed: 3 });
      assert.ok(!keys(result.items).includes('Project/inbox/near_base.png'));
      assert.deepEqual(result.duplicates.filter((entry) => entry.against === 'dataset').map((entry) => entry.path), ['Project/inbox/near_base.png']);
      assert.equal(result.items.length, 3);
    }

    // A large dense cluster cannot exceed its quota in round 1.
    {
      const dense = Array.from({ length: 30 }, (_, n) => input(`Project/inbox/dense_${String(n).padStart(2, '0')}.png`, [[0, 1], [1 + n, 0.5]]));
      const singles = [0, 1, 2, 3].flatMap((group) => Array.from({ length: 10 }, (_, n) => input(`Project/inbox/group${group}_${String(n).padStart(2, '0')}.png`, [[32 + group, 1], [36 + group * 10 + n, 0.5]])));
      const result = await shortlist.buildShortlist({ baseline: [], candidates: [...dense, ...singles], needed: 12 });
      assert.equal(result.items.length, result.requested);
      assert.ok(result.clusters.length >= 2);
      assert.ok(result.clusters.reduce((sum, cluster) => sum + Math.min(cluster.size, cluster.quota), 0) >= result.requested, 'round 1 alone can fill the shortlist');
      for (const cluster of result.clusters) assert.ok(cluster.selected <= cluster.quota, `${cluster.id} selected ${cluster.selected} > quota ${cluster.quota}`);
      const biggest = result.clusters.reduce((a, b) => (b.size > a.size ? b : a));
      assert.ok(biggest.quota < biggest.size && biggest.quota < result.requested, 'quota is below the cluster size and the shortlist size');
      assert.ok(result.items.filter((entry) => entry.cluster === biggest.id).length <= biggest.quota);
    }

    // Input order never changes the result.
    {
      const pool = [...[0, 1, 2].map((n) => input(`Project/inbox/a${n}.png`, [[0, 1], [10 + n, 0.3]])), ...[20, 21, 22, 23, 24].map((axis) => input(`Project/inbox/b${axis}.png`, [[axis, 1], [axis + 5, 0.2]]))];
      const forward = await shortlist.buildShortlist({ baseline: [], candidates: pool, needed: 4 });
      const reversed = await shortlist.buildShortlist({ baseline: [], candidates: [...pool].reverse(), needed: 4 });
      assert.deepEqual(keys(forward.items), keys(reversed.items));
      assert.deepEqual(forward.clusters, reversed.clusters);
    }

    // Names are not grouped: the same post id with different vectors stays fully eligible.
    {
      const post = [0, 1, 2, 3].map((n) => input(`Project/inbox/post12345_${n}.png`, [[n, 1]]));
      const result = await shortlist.buildShortlist({ baseline: [], candidates: post, needed: 4 });
      assert.deepEqual(keys(result.items).sort(), post.map((entry) => entry.item.assetPath).sort());
      assert.equal(result.duplicates.length, 0);
    }

    // Pass 2.
    const narrowItems = (rows) => rows.map(([name, tags], n) => ({ asset: input(`Project/inbox/${name}.png`, [[n, 1]]), tags }));
    {
      const levelCutoff = (id) => levels.getStrictnessThreshold(id, 'dinov2');
      const along = (axis, cos) => [[0, cos], [axis, Math.sqrt(1 - cos * cos)]];
      const rows = () => [['a', [[0, 1]]], ['b', along(1, 0.96)], ['c', along(2, 0.9)], ['x', [[40, 1]]]]
        .map(([name, parts]) => ({ asset: input(`Project/inbox/${name}.png`, parts), tags: [] }));
      const kept = async (id) => (await shortlist.narrowShortlist({ baseline: [], items: rows(), target: 4, duplicateThreshold: levelCutoff(id) })).items.length;
      const [strict, balanced, loose] = [await kept('strict'), await kept('balanced'), await kept('loose')];
      assert.ok(strict > balanced && balanced > loose, `narrow: Strict ${strict} > Balanced ${balanced} > Loose ${loose}`);
      const fixed = await shortlist.narrowShortlist({ baseline: [], items: rows(), target: 4 });
      assert.equal(fixed.items.length, balanced, 'narrow without a threshold = Balanced');
    }
    {
      const rows = [['a', ['solo', 'smile']], ['b', ['solo', 'smile']], ['c', ['solo', 'smile']], ['d', ['solo', 'smile', 'rare_hat']], ['e', ['solo', 'smile', 'rare scarf']], ['f', ['solo', 'smile']]];
      const result = await shortlist.narrowShortlist({ baseline: [], items: narrowItems(rows), target: 2 });
      assert.deepEqual(keys(result.items).sort(), ['Project/inbox/d.png', 'Project/inbox/e.png'], 'rare tags win over equal visual gain');
      assert.deepEqual(result.items.map((entry) => entry.newTags).flat().sort(), ['rare_hat', 'rare_scarf']);
      assert.equal(result.tagged, 6);
    }
    {
      // Trigger word and trait tags are ignored even when they are the rarest tags.
      const rows = [['a', ['solo', 'x1']], ['b', ['solo', 'x2']], ['c', ['solo', 'x3']], ['f', ['hero', 'red_hair', 'long hair', 'solo']]];
      const control = await shortlist.narrowShortlist({ baseline: [], items: narrowItems(rows), target: 1 });
      assert.equal(control.items[0].path, 'Project/inbox/f.png', 'without ignoring, three unique tags win');
      const ignored = await shortlist.narrowShortlist({ baseline: [], items: narrowItems(rows), target: 4, ignoredTags: ['Hero', 'red_hair', 'long_hair'] });
      assert.notEqual(ignored.items[0].path, 'Project/inbox/f.png');
      assert.equal(ignored.items.at(-1).path, 'Project/inbox/f.png', 'an image with only ignored tags adds nothing and ranks last');
      for (const entry of ignored.items) for (const tag of ['hero', 'red_hair', 'long_hair']) assert.ok(!entry.newTags.includes(tag));
    }
    {
      // Tags present in >= 90% of the shortlist carry no weight.
      const rows = [...Array.from({ length: 9 }, (_, n) => [`c${n}`, ['common']]), ['zz', ['uniq']]];
      const result = await shortlist.narrowShortlist({ baseline: [], items: narrowItems(rows), target: 3 });
      assert.equal(result.items[0].path, 'Project/inbox/zz.png');
      for (const entry of result.items) assert.ok(!entry.newTags.includes('common'));
    }
  }
  {
    // Auto size mode: one representative per group of similar images; lazy greedy (CELF) equals the old full-scan greedy in Target mode.
    const DIM = 80;
    const unit = (parts, dim = DIM) => { const v = new Float32Array(dim); for (const [axis, w] of parts) v[axis] += w; const n = Math.hypot(...v); return v.map((x) => x / n); };
    const input = (path, parts, extra = {}) => ({
      item: { id: `asset:${path}`, sourceImageId: path, assetPath: path, kind: 'image', imageData: new Blob(['x']) },
      feature: { imageHash: `h:${path}`, image: unit(parts), text: unit(parts), caption: '', contexts: [] }, caption: '', quality: 0.5, ...extra,
    });
    const dot = (a, b) => a.feature.image.reduce((sum, x, i) => sum + x * b.feature.image[i], 0);
    const cutoff = shortlist.SHORTLIST_DUPLICATE_THRESHOLD;

    // 200 identical images collapse into one candidate; so do 200 images that are >= 0.995 similar.
    for (const make of [() => [[0, 1]], (n) => [[0, 1], [1 + (n % 50), 0.05]]]) {
      const pool = Array.from({ length: 200 }, (_, n) => input(`Project/inbox/same_${String(n).padStart(3, '0')}.png`, make(n)));
      assert.ok(dot(pool[0], pool[1]) >= 0.995 || make(0).length === 1);
      const result = await shortlist.buildShortlist({ baseline: [], candidates: pool, needed: 'auto' });
      assert.equal(result.items.length, 1);
      assert.equal(result.mode, 'auto'); assert.equal(result.needed, 0); assert.equal(result.eligibleCount, 200); assert.equal(result.poolCount, 200);
      assert.deepEqual(result.clusters, []);
      assert.equal(result.items[0].reason, 'Group of 200 similar');
      assert.equal(result.duplicates.filter((entry) => entry.against === 'shortlist').length, 199);
    }

    // 60 pairwise different images: Auto keeps all of them, Target 20 stays limited to its shortlist size.
    {
      const pool = Array.from({ length: 60 }, (_, n) => input(`Project/inbox/diff_${String(n).padStart(2, '0')}.png`, [[n, 1]]));
      const auto = await shortlist.buildShortlist({ baseline: [], candidates: pool, needed: 'auto' });
      assert.equal(auto.items.length, 60);
      assert.ok(auto.items.every((entry) => entry.reason === 'Unique image'));
      assert.equal(auto.duplicates.length, 0);
      const target = await shortlist.buildShortlist({ baseline: [], candidates: pool, needed: 20 });
      assert.equal(target.mode, undefined);
      assert.equal(target.items.length, shortlist.getShortlistSize(20));
      assert.ok(target.items.length < auto.items.length);
      assert.ok(target.items.every((entry) => /^Cluster c\d+ \(/.test(entry.reason)));
      assert.deepEqual(new Set(auto.items.map((entry) => entry.cluster)).size, 60, 'Auto items carry their own group ids');
    }

    // Mixed pool: group sizes show up in the reasons.
    {
      const groupA = [0, 1, 2, 3, 4].map((n) => input(`Project/inbox/a_${n}.png`, [[0, 1], [10 + n, 0.1]]));
      const groupB = [0, 1, 2].map((n) => input(`Project/inbox/b_${n}.png`, [[1, 1], [20 + n, 0.1]]));
      const singles = [30, 31, 32, 33].map((axis) => input(`Project/inbox/s_${axis}.png`, [[axis, 1]]));
      const result = await shortlist.buildShortlist({ baseline: [], candidates: [...singles, ...groupB, ...groupA], needed: 'auto' });
      assert.equal(result.items.length, 6);
      assert.deepEqual(result.items.map((entry) => entry.reason).sort(), ['Group of 3 similar', 'Group of 5 similar', ...Array(4).fill('Unique image')].sort());
      assert.equal(result.duplicates.filter((entry) => entry.against === 'shortlist').length, 6);
      assert.equal(result.items.filter((entry) => entry.path.includes('/a_')).length, 1);
      assert.equal(result.items.filter((entry) => entry.path.includes('/b_')).length, 1);
      assert.deepEqual(result.items.map((entry) => entry.rank), [1, 2, 3, 4, 5, 6]);
    }

    // A group whose members are similar to a Dataset image yields nothing; Auto with an empty pool is empty.
    {
      const base = input('Project/dataset/base.png', [[0, 1]]);
      const group = [0, 1, 2].map((n) => input(`Project/inbox/g_${n}.png`, [[0, 1], [10 + n, 0.1]]));
      const other = input('Project/inbox/other.png', [[40, 1]]);
      const result = await shortlist.buildShortlist({ baseline: [base], candidates: [...group, other], needed: 'auto' });
      assert.deepEqual(result.items.map((entry) => entry.path), ['Project/inbox/other.png']);
      assert.equal(result.duplicates.filter((entry) => entry.against === 'dataset').length, 3);
      assert.equal(result.items[0].reason, 'Unique image');
      const empty = await shortlist.buildShortlist({ baseline: [], candidates: [], needed: 'auto' });
      assert.equal(empty.items.length, 0); assert.equal(empty.mode, 'auto');
    }

    // computeShortlist forwards 'auto'.
    {
      const feature = (n) => ({ imageHash: `h${n}`, image: unit([[n < 3 ? 0 : n, 1], [20 + n, 0.1]]), text: unit([[0, 1]]), caption: '', contexts: [] });
      const pool = [0, 1, 2, 3, 4].map((n) => ({ id: `source:${n}`, sourceImageId: String(n), assetPath: `Project/inbox/c${n}.png`, kind: 'image', imageData: new Blob(['x']), tags: ['hero'], width: 64, height: 64 }));
      const result = await shortlist.computeShortlist({
        baselineItems: [], poolItems: pool, needed: 'auto', triggerWord: 'hero',
        encoder: { encode: async (entry) => feature(Number(entry.sourceImageId)) },
      });
      assert.equal(result.mode, 'auto'); assert.equal(result.items.length, 3);
    }

    // Seeded random data.
    const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const randomPool = (seed, count, { dim = 14, centers = 12, noise = 0.3, prefix = 'p', withUndefinedQuality = true } = {}) => {
      const random = rng(seed);
      const hubs = Array.from({ length: centers }, () => Array.from({ length: dim }, () => random() - 0.5));
      return Array.from({ length: count }, (_, n) => {
        const hub = hubs[Math.floor(random() * centers)];
        const raw = hub.map((x) => x + (random() - 0.5) * noise * (random() < 0.3 ? 0.1 : 1));
        const v = unit(raw.map((w, axis) => [axis, w]), dim);
        const duplicateOf = n > 3 && random() < 0.08;
        const asset = { item: { id: `asset:${prefix}${n}`, sourceImageId: `${prefix}${n}`, assetPath: `Project/inbox/${prefix}${String(n).padStart(3, '0')}.png`, kind: 'image', imageData: new Blob(['x']) },
          feature: { imageHash: duplicateOf ? `${prefix}-dup` : `h:${prefix}${n}`, image: v, text: v, caption: '', contexts: [] }, caption: '',
          quality: withUndefinedQuality && random() < 0.2 ? undefined : Math.round(random() * 4) / 4 };
        return asset;
      });
    };

    // Reference: the previous full-scan greedy loops, copied from the code before the lazy rewrite.
    const slice = assembly.createSlicer();
    const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const pathOf = (asset) => asset.item.assetPath ?? asset.item.id;
    const refCluster = (members, matrix, size, count) => {
      const k = Math.max(1, Math.min(count, members.length));
      let densest = members[0]; let densestSum = -Infinity;
      for (const member of members) { let sum = 0; for (const other of members) sum += matrix[member * size + other]; if (sum > densestSum + 1e-9) { densestSum = sum; densest = member; } }
      let medoids = [densest];
      const nearest = new Float64Array(members.length);
      members.forEach((member, index) => { nearest[index] = matrix[densest * size + member]; });
      while (medoids.length < k) {
        let pick = -1; let lowest = Infinity;
        members.forEach((member, index) => { if (!medoids.includes(member) && nearest[index] < lowest - 1e-9) { lowest = nearest[index]; pick = index; } });
        if (pick < 0) break;
        medoids.push(members[pick]);
        members.forEach((member, index) => { nearest[index] = Math.max(nearest[index], matrix[members[pick] * size + member]); });
      }
      let groups = [];
      for (let round = 0; round < 6; round += 1) {
        groups = medoids.map(() => []);
        for (const member of members) {
          let best = 0; let bestSimilarity = -Infinity;
          medoids.forEach((medoid, index) => { const similarity = member === medoid ? 2 : matrix[member * size + medoid]; if (similarity > bestSimilarity + 1e-9) { bestSimilarity = similarity; best = index; } });
          groups[best].push(member);
        }
        const next = groups.map((group, index) => group.length ? clusterSvc.findMedoid(group, matrix, size) : medoids[index]);
        if (next.every((medoid, index) => medoid === medoids[index])) break;
        medoids = next;
      }
      return groups.filter((group) => group.length);
    };
    const refBuild = async ({ baseline, candidates, needed }) => {
      const threshold = shortlist.SHORTLIST_DUPLICATE_THRESHOLD;
      const sorted = [...candidates].sort((l, r) => compare(assembly.stableKey(l), assembly.stableKey(r)));
      const baselineCount = baseline.length; const assets = [...baseline, ...sorted]; const total = assets.length;
      const matrix = await assembly.pairwiseSimilarity(assets.map((a) => a.feature.image), slice);
      const duplicates = [];
      const duplicate = (target, kept, similarity, against) => duplicates.push({ key: assembly.stableKey(assets[target]), keptKey: assembly.stableKey(assets[kept]), similarity, against });
      const best = new Float64Array(total);
      for (let index = 0; index < baselineCount; index += 1) for (let target = 0; target < total; target += 1) best[target] = Math.max(best[target], matrix[index * total + target]);
      const alive = new Uint8Array(total); let eligibleCount = 0;
      for (let index = baselineCount; index < total; index += 1) {
        let nearest = -1; let nearestSimilarity = -Infinity;
        for (let member = 0; member < baselineCount; member += 1) { const s = assets[member].feature.imageHash === assets[index].feature.imageHash ? 1 : matrix[index * total + member]; if (s > nearestSimilarity) { nearestSimilarity = s; nearest = member; } }
        if (nearest >= 0 && nearestSimilarity >= threshold) duplicate(index, nearest, nearestSimilarity, 'dataset'); else { alive[index] = 1; eligibleCount += 1; }
      }
      const requested = shortlist.getShortlistSize(needed); const size = Math.min(requested, eligibleCount);
      if (size <= 0) return { items: [], duplicates, clusters: [] };
      const eligible = Array.from({ length: total - baselineCount }, (_, index) => baselineCount + index).filter((index) => alive[index]);
      const groups = refCluster(eligible, matrix, total, shortlist.planShortlistClusters(size, eligible.length))
        .map((members) => ({ members, medoidKey: assembly.stableKey(assets[clusterSvc.findMedoid(members, matrix, total)]) }))
        .sort((l, r) => r.members.length - l.members.length || l.medoidKey.localeCompare(r.medoidKey));
      const weightSum = groups.reduce((sum, group) => sum + Math.sqrt(group.members.length), 0);
      const clusters = groups.map((group, index) => ({ id: `c${index + 1}`, size: group.members.length, quota: Math.max(1, Math.ceil(size * Math.sqrt(group.members.length) / weightSum)), selected: 0 }));
      const clusterOf = new Int32Array(total).fill(-1);
      groups.forEach((group, index) => group.members.forEach((member) => { clusterOf[member] = index; }));
      const items = [];
      for (let round = 1; round <= 2 && items.length < size; round += 1) {
        while (items.length < size) {
          let pick = -1; let pickScore = -Infinity; let pickGain = 0;
          for (const index of eligible) {
            if (!alive[index] || clusters[clusterOf[index]].selected >= clusters[clusterOf[index]].quota * round) continue;
            let gain = 0;
            for (let target = 0; target < total; target += 1) { const delta = matrix[index * total + target] - best[target]; if (delta > 0) gain += delta; }
            gain /= total;
            const score = gain * (1 + 0.15 * (assets[index].quality ?? 0.5));
            if (score > pickScore + 1e-12 || (Math.abs(score - pickScore) <= 1e-12 && pick >= 0 && assembly.stableKey(assets[index]).localeCompare(assembly.stableKey(assets[pick])) < 0)) { pick = index; pickScore = score; pickGain = gain; }
          }
          if (pick < 0) break;
          const cluster = clusters[clusterOf[pick]]; cluster.selected += 1; alive[pick] = 0;
          for (let target = 0; target < total; target += 1) best[target] = Math.max(best[target], matrix[pick * total + target]);
          for (const index of eligible) {
            if (!alive[index]) continue;
            const similarity = assets[index].feature.imageHash === assets[pick].feature.imageHash ? 1 : matrix[pick * total + index];
            if (similarity >= threshold) { alive[index] = 0; duplicate(index, pick, similarity, 'shortlist'); }
          }
          items.push({ key: assembly.stableKey(assets[pick]), cluster: cluster.id, gain: pickGain, rank: items.length + 1, reason: `Cluster ${cluster.id} (${cluster.size} similar, quota ${cluster.quota}): +${(pickGain * 100).toFixed(1)}% coverage` });
        }
      }
      return { items, duplicates, clusters };
    };
    const refNarrow = async ({ baseline, baselineTags = [], items: input, target, ignoredTags = [] }) => {
      const threshold = shortlist.SHORTLIST_DUPLICATE_THRESHOLD;
      const ignored = new Set(ignoredTags.map(shortlist.normalizeNarrowTag));
      const entries = [...input].sort((l, r) => compare(assembly.stableKey(l.asset), assembly.stableKey(r.asset)));
      const baselineCount = baseline.length; const assets = [...baseline, ...entries.map((e) => e.asset)]; const total = assets.length;
      const matrix = await assembly.pairwiseSimilarity(assets.map((a) => a.feature.image), slice);
      const tagSets = entries.map((e) => new Set(e.tags.map(shortlist.normalizeNarrowTag).filter((t) => t && !ignored.has(t))));
      const df = new Map(); for (const tags of tagSets) for (const tag of tags) df.set(tag, (df.get(tag) ?? 0) + 1);
      const weights = new Map();
      for (const [tag, files] of df) { if (entries.length >= 3 && files / entries.length >= thresholds.QUALITY_THRESHOLDS.tags.commonFraction) continue; weights.set(tag, Math.log(1 + entries.length / files)); }
      const weightTotal = Math.max([...weights.values()].reduce((s, v) => s + v, 0), 1e-9);
      const counts = new Map();
      for (const tags of baselineTags) for (const tag of new Set(tags.map(shortlist.normalizeNarrowTag))) if (weights.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      const best = new Float64Array(total);
      for (let index = 0; index < baselineCount; index += 1) for (let t = 0; t < total; t += 1) best[t] = Math.max(best[t], matrix[index * total + t]);
      const alive = new Uint8Array(total);
      for (let index = baselineCount; index < total; index += 1) {
        let nearestSimilarity = -Infinity;
        for (let member = 0; member < baselineCount; member += 1) if (matrix[index * total + member] > nearestSimilarity) nearestSimilarity = matrix[index * total + member];
        if (baselineCount && nearestSimilarity >= threshold) continue; alive[index] = 1;
      }
      const out = []; const want = Math.max(0, Math.min(target, entries.length));
      while (out.length < want) {
        let pick = -1; let pickScore = -Infinity; let pickGain = 0;
        for (let index = baselineCount; index < total; index += 1) {
          if (!alive[index]) continue;
          let tagGain = 0;
          for (const tag of tagSets[index - baselineCount]) { const weight = weights.get(tag); if (weight) tagGain += weight * 0.5 ** ((counts.get(tag) ?? 0) + 1); }
          let visualGain = 0;
          for (let t = 0; t < total; t += 1) { const delta = matrix[index * total + t] - best[t]; if (delta > 0) visualGain += delta; }
          const gain = tagGain / weightTotal + shortlist.NARROW_VISUAL_WEIGHT * (visualGain / total);
          const score = gain * (1 + 0.05 * (assets[index].quality ?? 0.5));
          if (score > pickScore + 1e-12 || (Math.abs(score - pickScore) <= 1e-12 && pick >= 0 && assembly.stableKey(assets[index]).localeCompare(assembly.stableKey(assets[pick])) < 0)) { pick = index; pickScore = score; pickGain = gain; }
        }
        if (pick < 0) break;
        alive[pick] = 0;
        const newTags = [...tagSets[pick - baselineCount]].filter((tag) => weights.has(tag) && !counts.get(tag));
        for (const tag of tagSets[pick - baselineCount]) if (weights.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        for (let t = 0; t < total; t += 1) best[t] = Math.max(best[t], matrix[pick * total + t]);
        for (let index = baselineCount; index < total; index += 1) if (alive[index] && matrix[pick * total + index] >= threshold) alive[index] = 0;
        out.push({ key: assembly.stableKey(assets[pick]), gain: pickGain, rank: out.length + 1, newTags });
      }
      return out;
    };
    const summarize = (result) => result.items.map((entry) => ({ key: entry.key, cluster: entry.cluster, gain: entry.gain, rank: entry.rank, reason: entry.reason }));

    // Target mode: the lazy greedy picks exactly what the full-scan greedy picked, in the same order.
    for (const [seed, count, needed, baselineSize, noise] of [[1, 120, 10, 0, 0.3], [2, 200, 25, 6, 0.2], [3, 250, 40, 0, 0.15], [4, 90, 60, 3, 0.4], [5, 160, 8, 10, 0.1], [6, 60, 100, 0, 0.3]]) {
      const all = randomPool(seed, count + baselineSize, { noise, prefix: 't' });
      const baseline = all.slice(0, baselineSize); const candidates = all.slice(baselineSize);
      const actual = await shortlist.buildShortlist({ baseline, candidates, needed });
      const expected = await refBuild({ baseline, candidates, needed });
      assert.ok(expected.items.length > 0, `seed ${seed}: reference selects something`);
      assert.deepEqual(summarize(actual), expected.items, `buildShortlist seed ${seed} matches the full-scan greedy`);
      assert.deepEqual(actual.clusters, expected.clusters, `seed ${seed}: clusters`);
      const shape = (list) => list.map((entry) => [entry.key, entry.keptKey, entry.similarity, entry.against]);
      assert.deepEqual(shape(actual.duplicates), shape(expected.duplicates), `seed ${seed}: duplicates`);
    }

    const vocabulary = Array.from({ length: 25 }, (_, n) => `tag${n}`);
    for (const [seed, count, target, baselineSize] of [[11, 80, 12, 0], [12, 120, 30, 5], [13, 100, 100, 0], [14, 70, 5, 8], [15, 150, 40, 0]]) {
      const all = randomPool(seed, count + baselineSize, { noise: 0.25, prefix: 'n' });
      const random = rng(seed * 7);
      const tagsFor = () => Array.from({ length: Math.floor(random() * 6) }, () => vocabulary[Math.floor(random() ** 2 * vocabulary.length)]);
      const baseline = all.slice(0, baselineSize);
      const baselineTags = baseline.map(tagsFor);
      const items = all.slice(baselineSize).map((asset) => ({ asset, tags: tagsFor() }));
      const options = { baseline, baselineTags, items, target, ignoredTags: ['tag0'] };
      const actual = await shortlist.narrowShortlist(options);
      const expected = await refNarrow(options);
      assert.ok(expected.length > 0);
      const pick = (list) => list.map((entry) => ({ key: entry.key, gain: entry.gain, rank: entry.rank, newTags: entry.newTags }));
      assert.deepEqual(pick(actual.items), expected, `narrowShortlist seed ${seed} matches the full-scan greedy`);
    }

    // Auto invariants on random data: representatives are pairwise below the cutoff and cover every other eligible image.
    for (const [seed, count, baselineSize] of [[21, 150, 0], [22, 250, 8], [23, 300, 0]]) {
      const all = randomPool(seed, count + baselineSize, { noise: 0.2, prefix: 'a' });
      const baseline = all.slice(0, baselineSize); const candidates = all.slice(baselineSize);
      const result = await shortlist.buildShortlist({ baseline, candidates, needed: 'auto' });
      const byPath = new Map(all.map((asset) => [pathOf(asset), asset]));
      const sim = (a, b) => (a.feature.imageHash === b.feature.imageHash ? 1 : dot(a, b));
      const picked = result.items.map((entry) => byPath.get(entry.path));
      assert.equal(new Set(picked).size, picked.length);
      for (const a of picked) for (const b of picked) if (a !== b) assert.ok(sim(a, b) < cutoff, 'representatives are not similar to each other');
      for (const a of picked) for (const member of baseline) assert.ok(sim(a, member) < cutoff, 'no representative is similar to the Dataset');
      const skipped = new Set(result.duplicates.map((entry) => entry.path));
      assert.equal(picked.length + skipped.size, count, 'every image is either a representative or a skipped duplicate');
      for (const entry of result.duplicates) assert.ok(entry.against === 'dataset' || sim(byPath.get(entry.path), byPath.get(entry.keptPath)) >= cutoff);
      assert.equal(result.items.length, result.eligibleCount - result.duplicates.filter((entry) => entry.against === 'shortlist').length);
      const reverse = await shortlist.buildShortlist({ baseline, candidates: [...candidates].reverse(), needed: 'auto' });
      assert.deepEqual(reverse.items.map((entry) => entry.path), result.items.map((entry) => entry.path), 'Auto ignores input order');
    }

    // Performance guard: ~1500 low-dimensional vectors in Auto mode finish quickly (generous bound; the old full rescan was the bottleneck).
    {
      const pool = randomPool(99, 1500, { dim: 8, centers: 40, noise: 0.5, prefix: 'z' });
      const started = Date.now();
      const result = await shortlist.buildShortlist({ baseline: [], candidates: pool, needed: 'auto' });
      const elapsed = Date.now() - started;
      assert.ok(result.items.length > 1 && result.items.length < 1500);
      assert.ok(elapsed < 20000, `Auto on 1500 vectors took ${elapsed} ms`);
      console.log(`  auto 1500 vectors: ${result.items.length} groups in ${elapsed} ms`);
    }
  }
  {
    // Build session size mode.
    const fresh = buildSession.createBuildSession();
    assert.equal(fresh.profile.sizeMode, 'auto', 'new sessions start in Auto mode');
    assert.equal(buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(fresh))).profile.sizeMode, 'auto', 'sizeMode survives normalize');
    const legacy = JSON.parse(JSON.stringify(fresh));
    delete legacy.profile.sizeMode; legacy.profile.target = 42;
    const migrated = buildSession.normalizeBuildSession(legacy);
    assert.equal(migrated.profile.sizeMode, undefined, 'a session without sizeMode stays in Target mode');
    assert.equal(migrated.profile.target, 42);
    for (const bogus of ['target', 'AUTO', true, null, 1]) assert.equal(buildSession.normalizeBuildSession({ ...JSON.parse(JSON.stringify(fresh)), profile: { ...fresh.profile, sizeMode: bogus } }).profile.sizeMode, undefined, `sizeMode ${JSON.stringify(bogus)} is not Auto`);
    const reconciled = buildSession.reconcileBuildSession(fresh, [], '2026-10-21T00:00:00.000Z');
    assert.equal(reconciled.profile.sizeMode, 'auto', 'reconcile keeps the size mode');
    assert.equal(buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(reconciled))).profile.sizeMode, 'auto');
    // Clearing the shortlist keeps the mode; the shortlist stores mode and compared count.
    const a = item('source:a', 'a', 'Project/inbox/a.png', { byteSize: 1, modifiedAt: 1 });
    let session = buildSession.reconcileBuildSession(fresh, [a], '2026-10-21T00:00:00.000Z');
    session = buildSession.createBuildShortlist(session, { needed: 0, requested: 1, duplicates: 3, mode: 'auto', poolCount: 4, items: [{ item: a, cluster: 'g1', gain: 0.2, rank: 1 }] });
    assert.equal(session.auto.shortlist.mode, 'auto'); assert.equal(session.auto.shortlist.poolCount, 4); assert.equal(session.auto.shortlist.entries.length, 1);
    assert.equal(buildSession.clearBuildShortlist(session).profile.sizeMode, 'auto');
    assert.equal(buildSession.clearBuildShortlist(session).auto.shortlist, undefined);
  }
  {
    // Unified image status (stage 1): migration, getImageStatus, reconcile, path moves, pool and filters.
    const NOW = '2026-11-20T00:00:00.000Z';
    const mk = (id, path = `Project/inbox/${id}.png`, extra = {}) => item(`source:${id}`, id, path, { byteSize: 5, modifiedAt: 1, ...extra });
    const rec = (id, extra = {}) => ({ assetId: `source:${id}`, decision: 'unreviewed', application: 'idle', validation: 'pending', revision: 'r', updatedAt: NOW, ...extra });
    const tri = (group, revision, stage = 'quality') => ({ group, reasons: [{ code: 'quality-ok', message: 'x' }], stage, revision, createdAt: NOW });

    // 1. v1 -> v2 migration.
    {
      const v1 = { ...buildSession.createBuildSession(), version: 1, records: {
        'source:skip': rec('skip', { decision: 'skipped' }),
        'source:manual': rec('manual', { decision: 'accepted', provenance: 'manual' }),
        'source:auto': rec('auto', { decision: 'accepted', provenance: 'auto' }),
        'source:noprov': rec('noprov', { decision: 'accepted' }),
        'source:defer': rec('defer', { decision: 'deferred' }),
        'source:new': rec('new'),
      } };
      const m = buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(v1)));
      assert.equal(m.version, 2);
      assert.equal(m.records['source:skip'].override, 'ban', 'skipped -> ban');
      assert.equal(m.records['source:manual'].override, 'pin', 'manual accepted -> pin');
      for (const id of ['auto', 'noprov', 'defer', 'new']) assert.equal(m.records[`source:${id}`].override, undefined, `${id} gets no override`);
      assert.equal(m.records['source:skip'].decision, 'skipped', 'decision is not changed');
      assert.equal(m.records['source:manual'].decision, 'accepted');
      assert.equal(m.records['source:auto'].decision, 'accepted');
      // v2 is never migrated again: clearing the override must stick.
      const cleared = { ...m, records: { ...m.records, 'source:skip': (({ override, ...rest }) => (void override, rest))(m.records['source:skip']), 'source:manual': (({ override, ...rest }) => (void override, rest))(m.records['source:manual']) } };
      const again = buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(cleared)));
      assert.equal(again.records['source:skip'].override, undefined, 'a cleared ban is not restored');
      assert.equal(again.records['source:manual'].override, undefined, 'a cleared pin is not restored');
      assert.equal(again.records['source:skip'].decision, 'skipped');
      // v2 keeps valid overrides, drops bogus ones and invalid assembly outcomes.
      const v2 = { ...m, records: { 'source:a': rec('a', { override: 'ban', assembly: { outcome: 'duplicate', revision: 'x' } }), 'source:b': rec('b', { override: 'bogus', assembly: { outcome: 'weird', revision: 'x' }, origin: 7 }) } };
      const n = buildSession.normalizeBuildSession(JSON.parse(JSON.stringify(v2)));
      assert.equal(n.records['source:a'].override, 'ban'); assert.equal(n.records['source:a'].assembly.outcome, 'duplicate');
      assert.equal(n.records['source:b'].override, undefined); assert.equal(n.records['source:b'].assembly, undefined); assert.equal(n.records['source:b'].origin, undefined);
      assert.equal(buildSession.normalizeBuildSession({ ...v2, version: 3 }).version, 2, 'an unknown version falls back to defaults');
      assert.deepEqual(buildSession.normalizeBuildSession({ ...v2, version: 3 }).records, {});
      assert.deepEqual(buildSession.normalizeBuildSession({ ...v2, profile: { ...v2.profile, sources: ['Project/inbox/a', 'Project/inbox/a', '', 5] } }).profile.sources, ['Project/inbox/a']);
      assert.equal(buildSession.normalizeBuildSession(v2).profile.sources, undefined);
    }

    // 2. getImageStatus: every branch.
    {
      const inbox = mk('i');
      const rev = buildSession.getBuildContentRevision(inbox, undefined);
      const status = (record, it = inbox, out) => buildSession.getImageStatus(record, it, out);
      assert.deepEqual(status(undefined), { kind: 'inbox', pending: true }, 'no record, no verdict');
      assert.deepEqual(status(rec('i')), { kind: 'inbox', pending: true });
      assert.deepEqual(status(rec('i', { triage: tri('accepted', rev) })), { kind: 'inbox' });
      assert.deepEqual(status(rec('i', { triage: tri('needs-decision', rev) })), { kind: 'inbox' });
      assert.deepEqual(status(rec('i', { override: 'ban', triage: tri('accepted', rev) })), { kind: 'out', reason: 'ban' });
      assert.deepEqual(status(rec('i', { override: 'ban' })), { kind: 'out', reason: 'ban' }, 'ban needs no verdict');
      assert.deepEqual(status(rec('i', { triage: tri('rejected', rev) })), { kind: 'out', reason: 'quality' });
      assert.deepEqual(status(rec('i', { override: 'pin', triage: tri('rejected', rev) })), { kind: 'inbox' }, 'pin overrides a quality rejection');
      const dupAssembly = { outcome: 'duplicate', of: 'source:keep', similarity: 0.97, revision: rev };
      const asmTriage = tri('rejected', rev, 'assembly');
      assert.deepEqual(status(rec('i', { triage: asmTriage, assembly: dupAssembly })), { kind: 'out', reason: 'duplicate', of: 'source:keep', similarity: 0.97 });
      assert.deepEqual(status(rec('i', { triage: asmTriage, assembly: { outcome: 'not-selected', revision: rev } })), { kind: 'out', reason: 'not-selected' }, 'no `of` for not-selected');
      assert.deepEqual(status(rec('i', { triage: asmTriage, assembly: { outcome: 'duplicate', revision: rev } })), { kind: 'out', reason: 'duplicate' }, 'duplicate without of/similarity');
      assert.deepEqual(status(rec('i', { triage: asmTriage, assembly: { ...dupAssembly, revision: 'old' } })), { kind: 'inbox' }, 'stale assembly (revision mismatch) is inbox');
      assert.deepEqual(status(rec('i', { override: 'pin', triage: asmTriage, assembly: dupAssembly })), { kind: 'inbox' }, 'a pin ignores the assembly outcome');
      assert.deepEqual(status(rec('i', { triage: tri('accepted', rev, 'assembly') })), { kind: 'inbox' }, 'a selected image has no outcome');
      const video = { ...mk('v', 'Project/inbox/v.mp4'), kind: 'video' };
      assert.deepEqual(status(rec('v', { triage: tri('accepted', rev) }), video), { kind: 'inbox', needsFrames: true });
      assert.deepEqual(status(undefined, video), { kind: 'inbox', needsFrames: true });
      assert.deepEqual(status(rec('v', { override: 'ban' }), video), { kind: 'out', reason: 'ban' }, 'ban is checked before video');
      const inDs = mk('d', 'Project/dataset/d.png');
      assert.deepEqual(status(undefined, inDs), { kind: 'in', pinned: false });
      assert.deepEqual(status(rec('d', { override: 'pin' }), inDs), { kind: 'in', pinned: true });
      assert.deepEqual(status(rec('d', { override: 'ban' }), inDs), { kind: 'in', pinned: false }, 'dataset membership wins over ban');
      assert.deepEqual(status(rec('i', { override: 'pin' }), inbox, mk('o', 'Project/dataset/o.png')), { kind: 'in', pinned: true }, 'an output in dataset/ makes the frame in');
      assert.deepEqual(status(rec('i'), inbox, mk('o', 'Project/inbox/o.png')), { kind: 'inbox', pending: true }, 'an output outside dataset/ does not');
    }

    // 3. reconcile: stale assembly dropped, origin recorded.
    {
      const x = mk('x', 'Project/inbox/day1/x.png'), y = mk('y', 'Project/inbox/y.png'), z = mk('z', 'Project/other/z.png');
      let s = buildSession.reconcileBuildSession(buildSession.createBuildSession(), [x, y, z], NOW);
      assert.equal(s.records['source:x'].origin, 'Project/inbox/day1', 'new record in inbox gets an origin');
      assert.equal(s.records['source:y'].origin, 'Project/inbox');
      assert.equal(s.records['source:z'].origin, undefined, 'outside the inbox: no origin');
      const revX = buildSession.getBuildContentRevision(x, undefined);
      s = { ...s, records: { ...s.records, 'source:x': { ...s.records['source:x'], triage: tri('rejected', revX, 'assembly'), assembly: { outcome: 'not-selected', revision: revX } } } };
      assert.equal(buildSession.reconcileBuildSession(s, [x, y, z], NOW), s, 'a fresh assembly outcome keeps session identity');
      const changed = buildSession.reconcileBuildSession(s, [{ ...x, byteSize: 999, modifiedAt: 9 }, y, z], NOW);
      assert.equal(changed.records['source:x'].assembly, undefined, 'content change drops the stale assembly outcome');
      assert.equal(changed.records['source:x'].triage, undefined);
      assert.equal(changed.records['source:x'].origin, 'Project/inbox/day1', 'origin survives');
      // An old record without origin gets it; moving into dataset/ keeps the remembered origin.
      const legacy = { ...s, records: { ...s.records, 'source:y': (({ origin, ...rest }) => (void origin, rest))(s.records['source:y']) } };
      assert.equal(buildSession.reconcileBuildSession(legacy, [x, y, z], NOW).records['source:y'].origin, 'Project/inbox');
      const inDataset = buildSession.reconcileBuildSession(s, [{ ...x, assetPath: 'Project/dataset/x.png' }, y, z], NOW);
      assert.equal(inDataset.records['source:x'].origin, 'Project/inbox/day1', 'moving to dataset/ keeps the origin');
      assert.equal(inDataset.records['source:x'].locator, 'Project/dataset/x.png');
      const moved = buildSession.reconcileBuildSession(s, [{ ...x, assetPath: 'Project/inbox/day2/x.png' }, y, z], NOW);
      assert.equal(moved.records['source:x'].origin, 'Project/inbox/day2', 'a move inside the inbox updates the origin');
    }

    // 4. path moves: locator, origin, profile.sources.
    {
      const x = mk('x', 'Project/inbox/day1/x.png'), y = mk('y', 'Project/inbox/day2/y.png');
      let s = buildSession.reconcileBuildSession(buildSession.createBuildSession(), [x, y], NOW);
      s = { ...s, profile: { ...s.profile, sources: ['Project/inbox/day1', 'Project/inbox/day2'] } };
      const moved = buildSession.applyBuildSessionPathMoves(s, [{ from: 'Project/inbox/day1', to: 'Project/inbox/monday' }]);
      assert.equal(moved.records['source:x'].locator, 'Project/inbox/monday/x.png');
      assert.equal(moved.records['source:x'].origin, 'Project/inbox/monday');
      assert.equal(moved.records['source:y'].origin, 'Project/inbox/day2'); assert.equal(moved.records['source:y'], s.records['source:y'], 'untouched record keeps identity');
      assert.deepEqual(moved.profile.sources, ['Project/inbox/monday', 'Project/inbox/day2']);
      assert.deepEqual(s.profile.sources, ['Project/inbox/day1', 'Project/inbox/day2'], 'input is not mutated');
      const merged = buildSession.applyBuildSessionPathMoves(s, [{ from: 'Project/inbox/day2', to: 'Project/inbox/day1' }]);
      assert.deepEqual(merged.profile.sources, ['Project/inbox/day1'], 'sources are de-duplicated after a move');
      // Sources only changed (no record touched), and a move that touches nothing.
      const onlySources = buildSession.applyBuildSessionPathMoves({ ...s, records: {} }, [{ from: 'Project/inbox/day1', to: 'Project/inbox/q' }]);
      assert.equal(onlySources.profile.sources[0], 'Project/inbox/q');
      assert.equal(buildSession.applyBuildSessionPathMoves(s, [{ from: 'Project/nothing', to: 'Project/else' }]), s);
      const noSources = buildSession.applyBuildSessionPathMoves(buildSession.reconcileBuildSession(buildSession.createBuildSession(), [x], NOW), [{ from: 'Project/inbox/day1', to: 'Project/inbox/q' }]);
      assert.equal(noSources.profile.sources, undefined, 'absent sources stay absent');
      assert.equal(noSources.records['source:x'].origin, 'Project/inbox/q');
    }

    // 7. Pool, baseline and key.
    {
      const a = mk('a'), b = mk('b'), c = mk('c'), d = mk('d'), e = mk('e'), v = { ...mk('v', 'Project/inbox/v.mp4'), kind: 'video' };
      const ds = mk('ds', 'Project/dataset/ds.png'), p = mk('p'), prej = mk('prej'), asmItem = mk('asm');
      const all = [a, b, c, d, e, v, ds, p, prej, asmItem];
      let s = buildSession.reconcileBuildSession(buildSession.createBuildSession(), all, NOW);
      const R = (it) => buildSession.getBuildContentRevision(it, undefined);
      const setRec = (id, extra) => { s = { ...s, records: { ...s.records, [`source:${id}`]: { ...s.records[`source:${id}`], ...extra } } }; };
      setRec('a', { triage: tri('accepted', R(a)) });
      setRec('b', { triage: tri('accepted', R(b)), override: 'ban' });
      setRec('c', { triage: tri('rejected', R(c)) });
      setRec('d', { triage: tri('needs-decision', R(d)) });
      setRec('e'); // no verdict
      setRec('v', { triage: tri('accepted', R(v)) });
      setRec('ds', { triage: tri('accepted', R(ds)) });
      setRec('p', { triage: tri('accepted', R(p)), override: 'pin' });
      setRec('prej', { triage: tri('rejected', R(prej)), override: 'pin' });
      setRec('asm', { triage: tri('rejected', R(asmItem), 'assembly'), assembly: { outcome: 'duplicate', of: 'source:a', similarity: 0.9, revision: R(asmItem) } });
      const ids = (list) => list.map(buildSession.getBuildAssetId);
      assert.deepEqual(ids(triage.selectAssemblyCandidates(s, all)), ['source:a', 'source:d', 'source:asm'],
        'no ban, quality-rejected, video, no verdict, dataset or pinned; assembly-stage frames come back');
      assert.deepEqual(ids(triage.selectAssemblyCandidates(s, [asmItem])), ['source:asm']);
      assert.deepEqual(ids(triage.selectAssemblyBaseline(s, [ds], all)), ['source:ds', 'source:p', 'source:prej'], 'baseline = dataset + pinned');
      assert.deepEqual(ids(triage.selectAssemblyBaseline(s, [], [a, b])), [], 'no members, nothing pinned');
      const pinnedVideo = { ...v };
      setRec('v', { override: 'pin' });
      assert.deepEqual(ids(triage.selectAssemblyBaseline(s, [ds], [pinnedVideo, a])), ['source:ds'], 'a pinned video is not baseline');
      const pinnedInDs = mk('pd', 'Project/dataset/pd.png'); s = buildSession.reconcileBuildSession(s, [...all, pinnedInDs], NOW); setRec('pd', { override: 'pin' });
      assert.deepEqual(ids(triage.selectAssemblyBaseline(s, [ds, pinnedInDs], [pinnedInDs])), ['source:ds', 'source:pd'], 'a pinned member is counted once');

      const pool = triage.selectAssemblyCandidates(s, all);
      const base0 = triage.selectAssemblyBaseline(s, [ds], all);
      const key = triage.createAssemblyKey('auto', pool, s, base0);
      assert.equal(key, triage.createAssemblyKey('auto', [...pool].reverse(), s, [...base0].reverse()), 'order does not matter');
      assert.notEqual(key, triage.createAssemblyKey(10, pool, s, base0));
      const withOverride = { ...s, records: { ...s.records, 'source:a': { ...s.records['source:a'], override: 'pin' } } };
      assert.notEqual(key, triage.createAssemblyKey('auto', pool, withOverride, base0), 'an override change changes the key');
      const banned = { ...s, records: { ...s.records, 'source:a': { ...s.records['source:a'], override: 'ban' } } };
      assert.notEqual(triage.createAssemblyKey('auto', pool, withOverride, base0), triage.createAssemblyKey('auto', pool, banned, base0), 'pin and ban differ');
      assert.notEqual(key, triage.createAssemblyKey('auto', pool, s, [ds, p]), 'a baseline change changes the key');
      assert.notEqual(key, triage.createAssemblyKey('auto', pool, s, []), 'dropping the baseline changes the key');
      assert.equal(triage.createAssemblyKey(10, [a], s), triage.createAssemblyKey(10, [a], s, []), 'baseline is optional');
    }

    // 8. status-* filters in selectBuildQueue.
    {
      const inb = mk('inb'), out = mk('out'), qrej = mk('qrej'), ban = mk('ban'), pin = mk('pin'), ds = mk('ds', 'Project/dataset/ds.png'), pinDs = mk('pds', 'Project/dataset/pds.png'), asmOut = mk('asmo'), fresh = mk('fresh');
      const all = [inb, qrej, ban, pin, ds, pinDs, asmOut, fresh];
      let s = buildSession.reconcileBuildSession(buildSession.createBuildSession(), all, NOW);
      const R = (it) => buildSession.getBuildContentRevision(it, undefined);
      const setRec = (id, extra) => { s = { ...s, records: { ...s.records, [`source:${id}`]: { ...s.records[`source:${id}`], ...extra } } }; };
      setRec('inb', { triage: tri('accepted', R(inb)) });
      setRec('qrej', { triage: tri('rejected', R(qrej)) });
      setRec('ban', { override: 'ban' });
      setRec('pin', { override: 'pin', triage: tri('rejected', R(pin)) });
      setRec('pds', { override: 'pin' });
      setRec('asmo', { triage: tri('rejected', R(asmOut), 'assembly'), assembly: { outcome: 'not-selected', revision: R(asmOut) } });
      void out;
      const q = (filter) => buildSession.selectBuildQueue({ ...s, filter }, all).map(buildSession.getBuildAssetId);
      assert.deepEqual(q('status-inbox'), ['source:inb', 'source:pin', 'source:fresh']);
      assert.deepEqual(q('status-out'), ['source:qrej', 'source:ban', 'source:asmo']);
      assert.deepEqual(q('status-in-dataset'), ['source:ds', 'source:pds']);
      assert.deepEqual(q('status-pinned'), ['source:pin', 'source:pds']);
      assert.deepEqual(q('status-banned'), ['source:ban']);
      assert.equal(q('all').length, all.length);
      for (const filter of ['status-inbox', 'status-out', 'status-in-dataset', 'status-pinned', 'status-banned']) {
        assert.equal(buildSession.normalizeBuildSession(JSON.parse(JSON.stringify({ ...s, filter }))).filter, filter, `${filter} survives normalize`);
      }
      assert.equal(buildSession.normalizeBuildSession({ ...s, filter: 'status-bogus' }).filter, 'all');
      // A transformed output in dataset/ makes its frame "in".
      const frame = mk('frame'), output = mk('out2', 'Project/dataset/out2.png');
      let t = buildSession.reconcileBuildSession(buildSession.createBuildSession(), [frame, output], NOW);
      t = { ...t, records: { ...t.records, 'source:frame': { ...t.records['source:frame'], outputAssetId: 'source:out2' } } };
      assert.ok(buildSession.selectBuildQueue({ ...t, filter: 'status-in-dataset' }, [frame, output]).map(buildSession.getBuildAssetId).includes('source:frame'));
      assert.ok(!buildSession.selectBuildQueue({ ...t, filter: 'status-inbox' }, [frame, output]).map(buildSession.getBuildAssetId).includes('source:frame'));
    }
  }
  // Next UI Board: status labels, filters, frame entries (grouping, order, counts) and keyboard cursor movement.
  {
    const NOW = '2026-11-20T00:00:00.000Z';
    const rec = (id, extra = {}) => ({ assetId: `source:${id}`, decision: 'unreviewed', application: 'idle', validation: 'pending', revision: 'r', updatedAt: NOW, ...extra });
    const tri = (group, revision, stage = 'quality', reasons = [{ code: 'x', message: 'x' }]) => ({ group, reasons, stage, revision, createdAt: NOW });
    const { describeImageStatus, matchesBoardFilter, buildKeptDuplicateCounts, BOARD_FILTERS } = statusLabels;

    // describeImageStatus: every branch.
    assert.deepEqual([...BOARD_FILTERS], ['all', 'in', 'out', 'pinned', 'banned']);
    const pinned = describeImageStatus({ kind: 'in', pinned: true });
    assert.deepEqual([pinned.badge, pinned.tone, pinned.muted], ['Pinned', 'pinned', false]); assert.match(pinned.reason, /Pinned by you/);
    const plain = describeImageStatus({ kind: 'in', pinned: false });
    assert.deepEqual([plain.badge, plain.tone, plain.muted, plain.reason], ['In', 'in', false, 'In the dataset.']);
    assert.equal(describeImageStatus({ kind: 'in', pinned: false }, { keptDuplicates: 0 }).reason, 'In the dataset.');
    assert.equal(describeImageStatus({ kind: 'in', pinned: false }, { keptDuplicates: 1 }).reason, 'Best of its group: 1 similar frame was left out.');
    assert.equal(describeImageStatus({ kind: 'in', pinned: false }, { keptDuplicates: 3 }).reason, 'Best of its group: 3 similar frames were left out.');
    assert.equal(describeImageStatus({ kind: 'in', pinned: false }, { keptDuplicates: 3 }).badge, 'In', 'best of a group is still In');
    assert.equal(describeImageStatus({ kind: 'in', pinned: true }, { keptDuplicates: 3 }).badge, 'Pinned', 'Pinned wins over Best of group');
    const banned = describeImageStatus({ kind: 'out', reason: 'ban' });
    assert.deepEqual([banned.badge, banned.tone, banned.muted], ['Banned', 'banned', true]);
    const quality = (reasons) => describeImageStatus({ kind: 'out', reason: 'quality' }, { record: rec('q', { triage: tri('rejected', 'v', 'quality', reasons) }) });
    assert.deepEqual([quality([]).badge, quality([]).tone, quality([]).muted], ['Out', 'out', true]);
    assert.equal(quality([{ code: 'a', message: 'Too small' }, { code: 'b', message: 'Blurry' }]).reason, 'Quality: Too small; Blurry.');
    assert.equal(quality([]).reason, 'Did not pass the quality check.');
    assert.equal(quality([{ code: 'a', message: '' }]).reason, 'Did not pass the quality check.', 'empty messages are skipped');
    assert.equal(describeImageStatus({ kind: 'out', reason: 'quality' }).reason, 'Did not pass the quality check.', 'no record at all');
    const dup = { kind: 'out', reason: 'duplicate', of: 'source:keep', similarity: 0.974 };
    assert.equal(describeImageStatus(dup, { nameOf: (id) => id === 'source:keep' ? 'keep.png' : undefined }).reason, 'Duplicate of keep.png (97% similar).');
    assert.equal(describeImageStatus(dup, { nameOf: () => undefined }).reason, 'Duplicate of a better frame (97% similar).');
    assert.equal(describeImageStatus({ kind: 'out', reason: 'duplicate' }).reason, 'Duplicate of a better frame.', 'no of, no similarity');
    assert.equal(describeImageStatus({ kind: 'out', reason: 'duplicate', of: 'source:keep', similarity: 0 }, { nameOf: () => 'k.png' }).reason, 'Duplicate of k.png (0% similar).', 'zero similarity is still shown');
    const notSelected = describeImageStatus({ kind: 'out', reason: 'not-selected' });
    assert.deepEqual([notSelected.badge, notSelected.muted], ['Out', true]); assert.match(notSelected.reason, /^Not selected/);
    assert.equal(describeImageStatus({ kind: 'inbox', needsFrames: true }).reason, 'Video: extract frames to use it.');
    assert.equal(describeImageStatus({ kind: 'inbox', pending: true }).reason, 'Not analyzed yet.');
    assert.equal(describeImageStatus({ kind: 'inbox', needsFrames: true, pending: true }).reason, 'Video: extract frames to use it.', 'needsFrames wins over pending');
    const inboxLabel = describeImageStatus({ kind: 'inbox' });
    assert.deepEqual([inboxLabel.badge, inboxLabel.tone, inboxLabel.muted, inboxLabel.reason], ['Inbox', 'inbox', false, 'Waiting for Assemble.']);
    for (const status of [{ kind: 'in', pinned: false }, { kind: 'in', pinned: true }, { kind: 'out', reason: 'ban' }, { kind: 'out', reason: 'quality' }, dup, { kind: 'inbox' }]) {
      assert.ok(describeImageStatus(status).badge.length > 0, 'the badge always carries text, not only colour');
    }

    // matchesBoardFilter.
    const inStatus = { kind: 'in', pinned: false }, outStatus = { kind: 'out', reason: 'quality' }, inboxStatus = { kind: 'inbox' };
    for (const status of [inStatus, outStatus, inboxStatus]) assert.equal(matchesBoardFilter('all', status, undefined), true);
    assert.deepEqual([inStatus, outStatus, inboxStatus].map((status) => matchesBoardFilter('in', status, undefined)), [true, false, false]);
    assert.deepEqual([inStatus, outStatus, inboxStatus].map((status) => matchesBoardFilter('out', status, undefined)), [false, true, false]);
    assert.equal(matchesBoardFilter('pinned', { kind: 'in', pinned: true }, rec('p', { override: 'pin' })), true);
    assert.equal(matchesBoardFilter('pinned', inStatus, rec('p')), false);
    assert.equal(matchesBoardFilter('pinned', inStatus, undefined), false, 'no record means no override');
    assert.equal(matchesBoardFilter('banned', { kind: 'out', reason: 'ban' }, rec('b', { override: 'ban' })), true);
    assert.equal(matchesBoardFilter('banned', outStatus, rec('b', { override: 'pin' })), false);
    assert.equal(matchesBoardFilter('pinned', outStatus, rec('b', { override: 'ban' })), false);

    // buildKeptDuplicateCounts: reverse of assembly.of.
    assert.equal(buildKeptDuplicateCounts({}).size, 0);
    const kept = buildKeptDuplicateCounts({
      'source:d1': rec('d1', { assembly: { outcome: 'duplicate', of: 'source:keep', revision: 'v' } }),
      'source:d2': rec('d2', { assembly: { outcome: 'duplicate', of: 'source:keep', revision: 'v' } }),
      'source:d3': rec('d3', { assembly: { outcome: 'duplicate', of: 'source:other', revision: 'v' } }),
      'source:n1': rec('n1', { assembly: { outcome: 'not-selected', of: 'source:keep', revision: 'v' } }),
      'source:d4': rec('d4', { assembly: { outcome: 'duplicate', revision: 'v' } }),
      'source:x': rec('x'),
    });
    assert.deepEqual([...kept.entries()].sort(), [['source:keep', 2], ['source:other', 1]], 'only duplicate outcomes with an `of` are counted');

    // buildFrameEntries: grouping, dataset first, natural folder order, session order, videos dropped, labels and counters.
    const img = (id, path, extra = {}) => ({ id: `source:${id}`, sourceImageId: id, assetPath: path, fileName: path?.split('/').pop() ?? `${id}.png`, kind: 'image', byteSize: 5, modifiedAt: 1, ...extra });
    const keep = img('keep', 'Project/dataset/keep.png'), pin = img('pin', 'Project/dataset/pin.png', { originalFileName: 'Pinned original.png' });
    const d10 = img('d10', 'Project/inbox/day10/x.png'), d2a = img('d2a', 'Project/inbox/day2/a.png'), d2b = img('d2b', 'Project/inbox/day2/b.png');
    const dupe = img('dupe', 'Project/inbox/day2/dupe.png'), bad = img('bad', 'Project/inbox/day2/bad.png'), ban = img('ban', 'Project/inbox/day2/ban.png');
    const loose = img('loose', undefined), clip = img('clip', 'Project/inbox/clip.mp4', { kind: 'video' });
    const all = [d10, d2b, dupe, d2a, bad, ban, loose, clip, pin, keep];
    const revOf = (item) => buildSession.getBuildContentRevision(item, undefined);
    const session = {
      ...buildSession.createBuildSession(),
      order: ['source:d2b', 'source:d2a', 'source:dupe', 'source:bad', 'source:ban', 'source:keep', 'source:pin'],
      records: {
        'source:pin': rec('pin', { override: 'pin' }),
        'source:dupe': rec('dupe', { triage: tri('rejected', revOf(dupe), 'assembly'), assembly: { outcome: 'duplicate', of: 'source:keep', similarity: 0.9, revision: revOf(dupe) } }),
        'source:bad': rec('bad', { triage: tri('rejected', revOf(bad), 'quality', [{ code: 'low', message: 'Too small' }]) }),
        'source:ban': rec('ban', { override: 'ban' }),
        'source:d2a': rec('d2a', { triage: tri('accepted', revOf(d2a)) }),
      },
    };
    const entries = frames.buildFrameEntries(all, all, session);
    assert.ok(!entries.some((entry) => entry.id === 'source:clip'), 'videos are excluded');
    assert.deepEqual(entries.map((entry) => entry.folder), ['dataset', 'dataset', 'inbox/day2', 'inbox/day2', 'inbox/day2', 'inbox/day2', 'inbox/day2', 'inbox/day10', 'Unsorted'],
      'dataset first, then folders in natural order (day2 before day10), items without a path last');
    assert.deepEqual(entries.map((entry) => entry.id), ['source:keep', 'source:pin', 'source:d2b', 'source:d2a', 'source:dupe', 'source:bad', 'source:ban', 'source:d10', 'source:loose'],
      'inside a folder the session order wins');
    const by = Object.fromEntries(entries.map((entry) => [entry.id.replace('source:', ''), entry]));
    assert.equal(by.keep.label.badge, 'In'); assert.equal(by.keep.label.reason, 'Best of its group: 1 similar frame was left out.', 'the kept frame knows how many duplicates it replaced');
    assert.equal(by.pin.label.badge, 'Pinned'); assert.equal(by.pin.name, 'Pinned original.png', 'the display name prefers the original file name');
    assert.equal(by.dupe.label.reason, 'Duplicate of keep.png (90% similar).', 'the kept frame is named through the merged items');
    assert.equal(by.bad.label.reason, 'Quality: Too small.');
    assert.equal(by.ban.label.badge, 'Banned');
    assert.deepEqual(by.d2a.status, { kind: 'inbox' }); assert.deepEqual(by.d10.status, { kind: 'inbox', pending: true });
    assert.equal(by.d2a.assetId, 'source:d2a'); assert.equal(by.d2a.item, d2a);
    assert.deepEqual(frames.countBoardFilters(entries), { all: 9, in: 2, out: 3, pinned: 1, banned: 1 });
    assert.deepEqual(frames.countBoardFilters([]), { all: 0, in: 0, out: 0, pinned: 0, banned: 0 });
    const grouped = frames.groupFrameEntries(entries);
    assert.deepEqual(grouped.map((group) => [group.key, group.label, group.items.length]), [['dataset', 'dataset', 2], ['inbox/day2', 'inbox/day2', 5], ['inbox/day10', 'inbox/day10', 1], ['Unsorted', 'Unsorted', 1]]);
    assert.deepEqual(frames.groupFrameEntries([]), []);
    assert.equal(frames.folderOfImage(loose), frames.UNSORTED_FOLDER);
    // A filtered list keeps the group order and drops empty groups.
    const onlyOut = frames.groupFrameEntries(entries.filter((entry) => matchesBoardFilter('out', entry.status, entry.record)));
    assert.deepEqual(onlyOut.map((group) => [group.key, group.items.length]), [['inbox/day2', 3]]);
    // A transformed output in dataset/ makes its source frame "In".
    const outputItem = img('out2', 'Project/dataset/out2.png');
    const src = img('src2', 'Project/inbox/src2.png');
    const viaOutput = frames.buildFrameEntries([src], [src, outputItem], { ...buildSession.createBuildSession(), records: { 'source:src2': rec('src2', { outputAssetId: 'source:out2' }) } });
    assert.deepEqual(viaOutput[0].status, { kind: 'in', pinned: false });

    // isDatasetEntry: membership is the physical path.
    assert.deepEqual(entries.filter(frames.isDatasetEntry).map((entry) => entry.id), ['source:keep', 'source:pin']);
    assert.equal(frames.isDatasetEntry(by.loose), false, 'no path is not Dataset');
    // overrideKeyAction: the key sets the override, or clears it when every entry already has it.
    {
      const one = (key) => frames.overrideKeyAction([by.pin], key);
      assert.equal(one('pin'), 'clear'); assert.equal(one('ban'), 'ban');
      assert.equal(frames.overrideKeyAction([by.ban], 'ban'), 'clear'); assert.equal(frames.overrideKeyAction([by.ban], 'pin'), 'pin');
      assert.equal(frames.overrideKeyAction([by.pin, by.d2a], 'pin'), 'pin', 'a mixed selection sets');
      assert.equal(frames.overrideKeyAction([by.pin, by.ban], 'pin'), 'pin');
      assert.equal(frames.overrideKeyAction([by.pin, by.pin], 'pin'), 'clear');
      assert.equal(frames.overrideKeyAction([], 'pin'), 'pin', 'nothing to clear');
    }
    // groupFrameEntriesByClusters: themes, else repeats, rest last; entry order is kept inside a group.
    {
      const cluster = (id, memberIds) => ({ id, memberIds });
      const names = (groups) => groups.map((group) => [group.key, group.label, group.items.map((entry) => entry.id.replace('source:', ''))]);
      const themed = frames.groupFrameEntriesByClusters(entries, {
        themes: [cluster('t1', ['source:d2a', 'source:keep']), cluster('t2', ['source:bad'])],
        nearDuplicateGroups: [cluster('n1', ['source:dupe', 'source:ban'])],
      });
      assert.deepEqual(names(themed), [['t1', 'Theme 1', ['keep', 'd2a']], ['t2', 'Theme 2', ['bad']], ['unclustered', 'Other frames', ['pin', 'd2b', 'dupe', 'ban', 'd10', 'loose']]],
        'themes win over repeats; order inside a group follows the entries');
      const repeats = frames.groupFrameEntriesByClusters(entries, { themes: [], nearDuplicateGroups: [cluster('n1', ['source:dupe', 'source:ban'])] });
      assert.deepEqual(names(repeats).map(([key, label]) => [key, label]), [['n1', 'Repeats 1'], ['unclustered', 'Other frames']]);
      assert.deepEqual(names(repeats)[0][2], ['dupe', 'ban']);
      // An id in two clusters lands in the first; a cluster with no visible member is dropped and numbering keeps the cluster index.
      const skipped = frames.groupFrameEntriesByClusters(entries.slice(0, 3), { themes: [cluster('gone', ['source:nope']), cluster('t2', ['source:keep', 'source:pin']), cluster('t3', ['source:keep', 'source:d2b'])], nearDuplicateGroups: [] });
      assert.deepEqual(names(skipped), [['t2', 'Theme 2', ['keep', 'pin']], ['t3', 'Theme 3', ['d2b']]]);
      // Nothing clustered: one group "All frames"; nothing to show: no groups.
      assert.deepEqual(names(frames.groupFrameEntriesByClusters(entries.slice(0, 2), { themes: [], nearDuplicateGroups: [] })), [['unclustered', 'All frames', ['keep', 'pin']]]);
      assert.deepEqual(frames.groupFrameEntriesByClusters([], { themes: [cluster('t1', ['source:keep'])], nearDuplicateGroups: [] }), []);
    }

    // moveFrameCursor: rows of `columns` tiles, group boundaries, a shorter last row.
    const mkGroup = (key, count) => ({ key, label: key, items: Array.from({ length: count }, (_, index) => ({ id: `${key}${index}` })) });
    const A = mkGroup('a', 5), B = mkGroup('b', 3), C = mkGroup('c', 1);
    const move = (groups, from, direction, columns) => frames.moveFrameCursor(groups, from, direction, columns);
    assert.equal(move([], 'a0', 'right', 2), null, 'no entries, no target');
    assert.equal(move([A, B], 'b1', 'home', 2), 'a0'); assert.equal(move([A, B], 'a0', 'end', 2), 'b2');
    assert.equal(move([A, B], null, 'down', 2), 'a0', 'no cursor starts at the first frame');
    assert.equal(move([A, B], 'gone', 'left', 2), 'a0', 'an unknown cursor starts at the first frame');
    assert.equal(move([A, B], 'a4', 'right', 2), 'b0', 'right crosses into the next group'); assert.equal(move([A, B], 'b0', 'left', 2), 'a4');
    assert.equal(move([A, B], 'a0', 'left', 2), 'a0', 'left is clamped at the start'); assert.equal(move([A, B], 'b2', 'right', 2), 'b2', 'right is clamped at the end');
    assert.equal(move([A, B], 'a0', 'down', 2), 'a2'); assert.equal(move([A, B], 'a1', 'down', 2), 'a3'); assert.equal(move([A, B], 'a2', 'down', 2), 'a4');
    assert.equal(move([A, B], 'a3', 'down', 2), 'a4', 'a shorter last row: down goes to its last tile');
    assert.equal(move([A, B], 'a4', 'down', 2), 'b0', 'down from the last row enters the next group in the same column');
    assert.equal(move([A, C], 'a3', 'down', 2), 'a4'); assert.equal(move([A, C], 'a4', 'down', 2), 'c0'); assert.equal(move([[mkGroup('d', 4)][0], C], 'd3', 'down', 2), 'c0', 'a one-tile group is entered at its only tile');
    assert.equal(move([A, B], 'b2', 'down', 2), 'b2', 'down at the very end stays'); assert.equal(move([A, B], 'b1', 'down', 2), 'b2', 'short last row of the last group');
    assert.equal(move([A, B], 'a2', 'up', 2), 'a0'); assert.equal(move([A, B], 'a0', 'up', 2), 'a0', 'up at the very start stays');
    assert.equal(move([A, B], 'b0', 'up', 2), 'a4', 'up enters the last row of the previous group'); assert.equal(move([A, B], 'b1', 'up', 2), 'a4', 'its short last row ends at the last tile');
    assert.equal(move([A, B], 'b2', 'up', 2), 'b0');
    const wide = mkGroup('w', 7);
    assert.equal(move([wide, B], 'w5', 'down', 3), 'w6', 'columns=3: 5 -> 6 is the short last row'); assert.equal(move([wide, B], 'w2', 'down', 3), 'w5');
    assert.equal(move([wide, B], 'b2', 'up', 3), 'w6', 'previous group last row starts at 6, column 2 is clamped');
    assert.equal(move([A, B], 'a2', 'down', 1), 'a3', 'one column moves tile by tile'); assert.equal(move([A, B], 'a4', 'down', 1), 'b0'); assert.equal(move([A, B], 'b0', 'up', 1), 'a4');
  }
  console.log('dataset assembly contracts: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
