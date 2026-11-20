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
      'src/services/analysis/semanticFeatureService.ts',
      'src/services/caption/captionMigrationService.ts',
      'src/services/build/buildSessionService.ts',
      'src/services/build/buildTransformService.ts',
      'src/services/quality/imageQuality.ts',
      'src/lib/projectProfilePresets.ts',
      'src/services/build/buildTriageService.ts',
      'src/lib/buildStageSummary.ts',
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
  const migration = await import(pathToFileURL(join(temp, 'captionMigrationService.mjs')));
  const buildSession = await import(pathToFileURL(join(temp, 'buildSessionService.mjs')));
  const buildTransform = await import(pathToFileURL(join(temp, 'buildTransformService.mjs')));
  const quality = await import(pathToFileURL(join(temp, 'imageQuality.mjs')));
  const presets = await import(pathToFileURL(join(temp, 'projectProfilePresets.mjs')));
  const triage = await import(pathToFileURL(join(temp, 'buildTriageService.mjs')));
  const stageSummary = await import(pathToFileURL(join(temp, 'buildStageSummary.mjs')));

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
    assert.deepEqual(triage.selectAssemblyCandidates(asm,[a]),[],'assembly-stage triage is not a candidate');
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
  console.log('dataset assembly contracts: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
