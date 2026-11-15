import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

// Inside node_modules so the bundled component resolves react and lucide-react.
await mkdir('node_modules/.cache', { recursive: true });
const temp = await mkdtemp(join('node_modules/.cache', 'quality-metrics-'));
try {
  await build({
    input: {
      metrics: 'src/services/quality/metrics/index.ts',
      coverage: 'src/services/dataset/coverageService.ts',
      vectorMath: 'src/services/quality/metrics/vectorMath.ts',
      component: 'src/components/quality/QualityReport.tsx',
      adapter: 'src/services/quality/datasetQualityInput.ts',
      similarityLevels: 'src/services/similarity/similarityLevels.ts',
      imageQuality: 'src/services/quality/imageQuality.ts',
      presets: 'src/lib/projectProfilePresets.ts',
    },
    platform: 'node',
    external: [/^react/, /^lucide-react/, /^clsx/, /^tailwind-merge/],
    transform: { jsx: 'react-jsx' },
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const metrics = await import(pathToFileURL(resolve(temp, 'metrics.mjs')));
  const coverage = await import(pathToFileURL(resolve(temp, 'coverage.mjs')));
  const { symmetricEigenvalues } = await import(pathToFileURL(resolve(temp, 'vectorMath.mjs')));
  const { QualityReport } = await import(pathToFileURL(resolve(temp, 'component.mjs')));

  const adapter = await import(pathToFileURL(resolve(temp, 'adapter.mjs')));
  const { PROFILE_RULES, TARGET_MODEL_PRESETS } = await import(pathToFileURL(resolve(temp, 'presets.mjs')));
  const { getMinShortSide } = await import(pathToFileURL(resolve(temp, 'imageQuality.mjs')));
  const { getSimilarityThreshold } = await import(pathToFileURL(resolve(temp, 'similarityLevels.mjs')));

  const close = (actual, expected, epsilon, message) => assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} ≠ ${expected}`);
  const basis = (dimension, index, scale = 1) => { const vector = new Float32Array(dimension); vector[index] = scale; return vector; };
  // Deterministic pseudo-random generator so failures are reproducible.
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const noisy = (base, amount) => Float32Array.from(base, (value) => value + (random() - 0.5) * amount);

  // Eigenvalue solver: trace and Frobenius norm are preserved, known 2×2 spectrum.
  {
    const size = 9;
    const matrix = Array.from({ length: size }, () => new Float64Array(size));
    for (let i = 0; i < size; i += 1) for (let j = i; j < size; j += 1) { const value = random() - 0.5; matrix[i][j] = value; matrix[j][i] = value; }
    const trace = matrix.reduce((sum, row, index) => sum + row[index], 0);
    const frobenius = matrix.reduce((sum, row) => sum + row.reduce((inner, value) => inner + value * value, 0), 0);
    const eigenvalues = symmetricEigenvalues(matrix.map((row) => Float64Array.from(row)));
    close(eigenvalues.reduce((sum, value) => sum + value, 0), trace, 1e-9, 'Eigenvalues sum to the trace');
    close(eigenvalues.reduce((sum, value) => sum + value * value, 0), frobenius, 1e-9, 'Squared eigenvalues sum to the Frobenius norm');
    assert.deepEqual(symmetricEigenvalues([Float64Array.from([2, 1]), Float64Array.from([1, 2])]).map((value) => Math.round(value * 1e9) / 1e9).sort(), [1, 3]);
  }

  // Vendi Score.
  {
    const same = Array.from({ length: 10 }, () => Float32Array.from([0.3, -1, 2, 0.5]));
    close(metrics.vendiScore(same), 1, 1e-6, 'n identical vectors → Vendi 1');
    const scaled = same.map((vector, index) => Float32Array.from(vector, (value) => value * (index + 1)));
    close(metrics.vendiScore(scaled), 1, 1e-6, 'Vendi ignores vector length');
    close(metrics.vendiScore(Array.from({ length: 6 }, (_, index) => basis(16, index))), 6, 1e-6, 'n orthogonal vectors (n < d) → Vendi n');
    close(metrics.vendiScore(Array.from({ length: 12 }, (_, index) => basis(12, index))), 12, 1e-6, 'n orthogonal vectors (n = d) → Vendi n');
    close(metrics.vendiScore(Array.from({ length: 20 }, (_, index) => basis(4, index % 4))), 4, 1e-6, '4 equal clusters in 4 dims (n > d path) → Vendi 4');
    const unequal = [...Array.from({ length: 3 }, () => basis(4, 0)), basis(4, 1)];
    close(metrics.vendiScore(unequal), Math.exp(-(0.75 * Math.log(0.75) + 0.25 * Math.log(0.25))), 1e-9, 'Unequal clusters follow Shannon entropy');
    assert.equal(metrics.vendiScore([]), 0);
    assert.equal(metrics.vendiScore([new Float32Array(4)]), 0, 'Zero vectors are ignored');
    const spread = Array.from({ length: 40 }, () => Float32Array.from({ length: 24 }, () => random() - 0.5));
    const score = metrics.vendiScore(spread);
    assert.ok(score > 10 && score <= 24, `Random vectors are diverse but bounded by rank: ${score}`);
  }

  // Coverage extension keeps the assembly API and adds radius coverage + saturation curve.
  {
    assert.equal(typeof coverage.measureCoverage, 'function');
    const pool = [0, 1, 2, 3].map((index) => ({ id: `c${index}`, vector: basis(4, index) }));
    const result = coverage.measureRadiusCoverage(pool, [basis(4, 0), basis(4, 1)], 0.1);
    assert.equal(result.fraction, 0.5);
    assert.deepEqual(result.uncovered.map((entry) => entry.id), ['c2', 'c3']);
    assert.deepEqual(coverage.measureCoverageCurve(pool, [basis(4, 0), basis(4, 0), basis(4, 3)], 0.1), [0.25, 0.25, 0.5]);
    assert.equal(coverage.measureRadiusCoverage([], [basis(4, 0)], 0.1).fraction, 0);
  }

  const items = (count, extra = () => ({})) => Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`, width: 1024, height: 1536, caption: `hero, tag${index}, smile`, tags: undefined, embedding: basis(64, index % 64), ...extra(index),
  }));

  // Required checks.
  {
    assert.equal(metrics.checkCount(20, { min: 15, max: 40 }).status, 'ok');
    assert.equal(metrics.checkCount(10, { min: 15, max: 40 }).status, 'warn');
    assert.equal(metrics.checkCount(5, { min: 15, max: 40 }).status, 'fail');
    assert.equal(metrics.checkCount(50, { min: 15, max: 40 }).status, 'warn');

    const sizes = items(20, (index) => (index < 1 ? { width: 900, height: 2000 } : {}));
    const sdxl = metrics.checkResolution(sizes);
    assert.equal(sdxl.status, 'warn', '1 of 20 below 1024 → warn');
    assert.deepEqual(sdxl.action.ids, ['item-0']);
    assert.equal(metrics.checkResolution(sizes, 'flux').status, 'warn', 'Flux preset uses 1024');
    assert.deepEqual(['sd15', 'sdxl', 'flux'].map((id) => metrics.QUALITY_THRESHOLDS.resolution.presets[id]), [512, 1024, 1024]);
    assert.deepEqual(['sd15', 'sdxl', 'flux'].map((id) => getMinShortSide(id)), [512, 1024, 1024], 'checkResolution presets agree with getMinShortSide');
    assert.equal(metrics.checkResolution(sizes, 'sd15').status, 'ok', 'SD1.5 preset uses 512');
    assert.equal(metrics.checkResolution(items(4, () => ({ width: 600, height: 600 }))).status, 'fail');
    assert.equal(metrics.checkResolution(sizes, 'sdxl', 800).status, 'ok', 'Explicit minimum overrides the preset');
    assert.equal(metrics.checkResolution(items(3, () => ({ width: undefined, height: undefined }))).evaluated, false);

    const duplicated = items(20, (index) => (index === 19 ? { embedding: noisy(basis(64, 3), 0.01) } : {}));
    const duplicates = metrics.checkNearDuplicates(duplicated);
    assert.equal(duplicates.status, 'warn');
    assert.deepEqual(duplicates.action.ids, ['item-19'], 'The later file of a pair is proposed for removal');
    assert.deepEqual(metrics.findNearDuplicates([{ id: 'a', imageHash: 'h' }, { id: 'b', imageHash: 'h' }]).map((pair) => pair.kind), ['exact']);
    assert.equal(metrics.checkNearDuplicates(items(10)).status, 'ok');
    assert.equal(metrics.checkNearDuplicates(items(10, () => ({ embedding: basis(64, 0) }))).status, 'fail');

    const uncaptioned = items(10, (index) => (index === 4 ? { caption: '  ' } : index === 5 ? { caption: '', tags: ['hero'] } : {}));
    const captions = metrics.checkCaptions(uncaptioned);
    assert.equal(captions.status, 'fail', 'Any missing caption fails');
    assert.deepEqual(captions.action.ids, ['item-4'], 'Tags count as a caption');
    const noCaptions = metrics.checkCaptions([]);
    assert.equal(noCaptions.evaluated, false, 'An empty Dataset is not reported as fully captioned');
    assert.equal(noCaptions.display, 'no files');
    assert.doesNotMatch(noCaptions.explanation, /Every file has a caption/);

    const trigger = metrics.checkTrigger(items(10, (index) => (index === 2 ? { caption: 'heroine, smile' } : index === 3 ? { caption: 'HERO. portrait' } : {})), 'hero');
    assert.deepEqual(trigger.action.ids, ['item-2'], 'Trigger matches whole words case-insensitively');
    assert.equal(trigger.status, 'fail');
    assert.equal(metrics.checkTrigger(items(2), 'тест').status, 'fail');
    assert.equal(metrics.checkTrigger([{ id: 'u', caption: 'тест, усмішка' }], 'тест').status, 'ok', 'Cyrillic trigger word is matched');
    const noTrigger = metrics.checkTrigger(items(2), '');
    assert.equal(noTrigger.status, 'ok');
    assert.equal(noTrigger.evaluated, false);

    const all = items(20);
    assert.equal(metrics.checkTechnical(all).evaluated, false, 'Missing technical data is reported, not assumed ok');
    assert.equal(metrics.checkTechnical(all).status, 'warn');
    const verdicts = all.map((item, index) => ({ id: item.id, verdict: index < 2 ? 'bad' : 'ok', reasons: index < 2 ? ['blur'] : [] }));
    const technical = metrics.checkTechnical(all, verdicts);
    assert.equal(technical.status, 'warn', '10% bad → warn');
    assert.deepEqual(technical.action.ids, ['item-0', 'item-1']);
    assert.match(technical.explanation, /blur/);
    assert.equal(metrics.checkTechnical(all, verdicts.map((verdict, index) => ({ ...verdict, verdict: index < 5 ? 'bad' : 'ok' }))).status, 'fail');
    assert.equal(metrics.checkTechnical(all, verdicts.slice(2)).status, 'warn', 'Unchecked files keep the check at warn');
    assert.equal(metrics.checkTechnical(all, verdicts.map((verdict) => ({ ...verdict, verdict: 'ok' }))).status, 'ok');
  }

  // Effective size, coverage, saturation, consistency.
  {
    const clones = items(20, () => ({ embedding: basis(64, 0) }));
    const effective = metrics.measureEffectiveSize(clones);
    close(effective.value, 1, 1e-6, 'Clones are one effective file');
    assert.equal(effective.status, 'fail');
    assert.match(effective.display, /20 files ≈ 1 effectively distinct/);
    const diverse = metrics.measureEffectiveSize(items(20));
    close(diverse.value, 20, 1e-6, 'Orthogonal files are all effective');
    assert.equal(diverse.status, 'ok');

    const candidates = Array.from({ length: 30 }, (_, index) => ({ id: `cand-${index}`, embedding: basis(64, index) }));
    const selected = items(10);
    const covered = metrics.measureMaterialCoverage(selected, candidates);
    close(covered.value, 10 / 30, 1e-9, 'Coverage counts candidates within the radius');
    assert.equal(covered.status, 'fail');
    assert.equal(covered.action.kind, 'add');
    assert.equal(covered.action.ids.length, 12, 'Gaps are capped');
    assert.ok(covered.action.ids.every((id) => Number(id.split('-')[1]) >= 10), 'Only uncovered candidates are suggested');
    const clustered = Array.from({ length: 20 }, (_, index) => ({ id: `near-${index}`, embedding: noisy(basis(64, 40), 0.02) }));
    const gaps = metrics.measureMaterialCoverage(selected, clustered);
    assert.equal(gaps.action.ids.length, 1, 'One representative per uncovered cluster');
    assert.equal(metrics.measureMaterialCoverage(selected, undefined).evaluated, false);
    assert.equal(metrics.measureMaterialCoverage(selected, candidates.slice(0, 10)).status, 'ok');

    const growing = metrics.measureSaturation(selected, candidates);
    assert.equal(growing.series.length, 10);
    assert.equal(growing.status, 'warn', 'Each file still adds coverage');
    const saturated = metrics.measureSaturation(items(15, (index) => ({ embedding: basis(64, index % 5) })), candidates.slice(0, 5));
    assert.equal(saturated.value, 0);
    assert.equal(saturated.status, 'ok');
    const ordered = metrics.measureSaturation(items(10, (index) => ({ embedding: basis(64, index % 5) })), candidates.slice(0, 5), ['item-0', 'item-5', 'item-1', 'item-2', 'item-3', 'item-4']);
    assert.deepEqual(ordered.series.map((value) => Math.round(value * 10) / 10), [0.2, 0.2, 0.4, 0.6, 0.8, 1]);

    const base = Float32Array.from({ length: 64 }, (_, index) => (index < 8 ? 1 : 0));
    const character = Array.from({ length: 20 }, (_, index) => ({ id: `ch-${index}`, embedding: index === 7 ? basis(64, 60) : noisy(base, 0.2) }));
    const consistency = metrics.measureConsistency(character, 'character');
    assert.deepEqual(consistency.action.ids, ['ch-7'], 'The unrelated frame is an outlier');
    assert.equal(consistency.status, 'warn');
    assert.equal(metrics.measureConsistency(character.filter((item) => item.id !== 'ch-7'), 'character').status, 'ok');
    assert.equal(metrics.measureConsistency(character, 'style').evaluated, false, 'Only Character projects are checked');
  }

  // Tags and captions.
  {
    const tagged = Array.from({ length: 12 }, (_, index) => ({ id: `t${index}`, caption: '', tags: ['hero', 'red hair', index % 2 ? 'smile' : 'serious', `unique${index}`] }));
    const frequencies = metrics.countTagFrequencies(tagged, 'Hero');
    assert.ok(!frequencies.some((entry) => entry.tag === 'hero'), 'Trigger is excluded from tag statistics');
    const common = metrics.measureCommonTags(tagged, 'hero');
    assert.deepEqual(common.action.tags, ['red hair']);
    assert.equal(common.status, 'warn');
    const rare = metrics.measureRareTags(tagged, 'hero');
    assert.equal(rare.action.tags.length, 12);
    assert.equal(rare.status, 'warn');
    assert.equal(metrics.measureRareTags(tagged.slice(0, 5)).evaluated, false);
    assert.deepEqual(metrics.countTagFrequencies([{ id: 'x', caption: 'A, b , a' }]).map((entry) => entry.tag), ['a', 'b'], 'Missing tags fall back to caption parts');
    assert.deepEqual(metrics.countTagFrequencies([{ id: 'x', caption: 'a, b', tags: [] }]), [], 'Explicit empty tags are respected');

    const short = metrics.measureCaptionLength(Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, caption: 'hero' })));
    assert.equal(short.status, 'warn');
    const longCaption = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
    const long = metrics.measureCaptionLength([{ id: 'long', caption: longCaption }, { id: 'ok', caption: 'hero, red hair, smile, outdoors' }, { id: 'ok2', caption: 'hero, red hair, serious face' }]);
    assert.deepEqual(long.action.ids, ['long']);
    assert.equal(metrics.measureCaptionLength([{ id: 'n', caption: 'hero, red hair, smile' }]).status, 'ok');
  }

  // Report: readiness is the worst required check; no overall score.
  {
    const ready = items(20, (index) => ({ caption: `hero, detail${index}, smile, outdoors` }));
    const technical = ready.map((item) => ({ id: item.id, verdict: 'ok' }));
    const report = metrics.buildQualityReport({ items: ready, triggerWord: 'hero', technical, target: { min: 15, max: 40 }, projectType: 'character' });
    assert.equal(report.readiness, 'ok', report.required.filter((metric) => metric.status !== 'ok').map((metric) => metric.explanation).join('\n'));
    assert.ok(!('score' in report) && !('total' in report), 'No single overall score');
    assert.deepEqual(report.required.map((metric) => metric.id), ['count', 'resolution', 'near-duplicates', 'captions', 'trigger', 'technical']);
    assert.ok(report.insights.some((metric) => metric.id === 'effective-size'));
    const warned = metrics.buildQualityReport({ items: ready, triggerWord: 'hero', target: { min: 15, max: 40 } });
    assert.equal(warned.readiness, 'warn', 'Unrun technical checks only warn');
    const failed = metrics.buildQualityReport({ items: ready, triggerWord: 'villain', technical });
    assert.equal(failed.readiness, 'fail');
    for (const metric of [...report.required, ...report.insights, ...failed.required]) {
      assert.ok(['ok', 'warn', 'fail'].includes(metric.status), metric.id);
      assert.ok(metric.explanation.length > 0 && /[a-z]/i.test(metric.explanation) && !/[а-яіїєґ]/i.test(metric.explanation), `${metric.id} has an English explanation`);
    }

    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const html = renderToStaticMarkup(createElement(QualityReport, { report: failed, labelFor: (id) => `file:${id}`, onAction: () => {} }));
    assert.match(html, /data-readiness="fail"/);
    assert.match(html, /Not ready/);
    assert.match(html, /data-metric="trigger" data-status="fail"/);
    assert.match(html, /file:item-0/, 'Action ids are rendered through labelFor');
    assert.match(html, /12 more/, 'Long action lists are collapsed');
    assert.match(html, /Apply/);
  }

  // Build adapter: workspace data -> QualityReportInput.
  {
    const { buildDatasetQualityInput, toTechnicalVerdict } = adapter;
    const image = (id, tags = ['tag']) => ({ id, sourceImageId: '', kind: 'image', tags, width: 1200, height: 1200 });
    const vec = (index) => basis(4, index);
    const embeddings = { a: vec(0), b: vec(1), c: vec(2) };
    const items = [image('a'), image('b')];
    const candidates = [image('a'), image('b'), image('c')];

    const histogram = buildDatasetQualityInput({ items, candidates, features: { basis: 'histogram', embeddings } });
    assert.ok(histogram.items.every((item) => item.embedding === undefined), 'histogram vectors are not embeddings');
    assert.equal(histogram.candidates, undefined);

    const dino = buildDatasetQualityInput({ items, candidates, features: { basis: 'dinov2', embeddings } });
    assert.ok(dino.items.every((item) => item.embedding instanceof Float32Array), 'dinov2 vectors are embeddings');
    assert.deepEqual(dino.candidates.map((item) => item.id), ['a', 'b', 'c']);

    const good = { version: 1, width: 1200, height: 1200, shortSide: 1200, sharpness: 1000, brightness: 0.5, darkShare: 0, brightShare: 0, minShortSide: 1024 };
    assert.equal(toTechnicalVerdict('x', good).verdict, 'ok');
    assert.equal(toTechnicalVerdict('x', { ...good, sharpness: 0 }).verdict, 'bad', 'blurry is bad');
    assert.equal(toTechnicalVerdict('x', { ...good, dark: true, brightness: 0, darkShare: 1 }).verdict, 'bad', 'dark is bad');
    const small = toTechnicalVerdict('x', { ...good, width: 100, height: 100, shortSide: 100 });
    assert.equal(small.verdict, 'ok', 'resolution does not affect the technical verdict');
    assert.deepEqual(small.reasons, []);

    const withSummaries = buildDatasetQualityInput({ items, qualitySummaries: new Map([['a', { ...good, sharpness: 0 }]]) });
    assert.deepEqual(withSummaries.technical.map((entry) => [entry.id, entry.verdict]), [['a', 'bad']]);
    assert.equal(buildDatasetQualityInput({ items }).technical, undefined, 'no summaries -> technical undefined');
    assert.equal(buildDatasetQualityInput({ items, qualitySummaries: new Map() }).technical, undefined);

    assert.equal(buildDatasetQualityInput({ items }).resolutionPreset, 'sdxl', 'default resolution preset');
    assert.equal(buildDatasetQualityInput({ items }).minShortSide, undefined, 'minShortSide is no longer emitted');
    for (const targetModel of ['sd15', 'sdxl', 'flux']) assert.equal(buildDatasetQualityInput({ items, targetModel }).resolutionPreset, targetModel);
    assert.deepEqual(buildDatasetQualityInput({ items, target: 50 }).target, { min: 50, max: 200 });
    assert.deepEqual(buildDatasetQualityInput({ items, target: 500 }).target, { min: 500, max: 500 });
    assert.equal(buildDatasetQualityInput({ items }).target, undefined);

    assert.equal(metrics.QUALITY_THRESHOLDS.nearDuplicates.similarity, getSimilarityThreshold('near-copy', 'dinov2'));
  }

  // Profile coverage axes, tag policy and gap hints.
  {
    const T = metrics.QUALITY_THRESHOLDS;
    const cfg = T.profileCoverage;
    const mk = (count, extra = () => ({})) => Array.from({ length: count }, (_, index) => ({
      id: `f-${index}.png`, width: 1024, height: 1024, caption: undefined, tags: ['solo'], ...extra(index),
    }));
    const axis = (list, type, id, extra = {}) => metrics.measureProfileCoverage({ items: list, projectType: type, ...extra }).find((metric) => metric.id === `axis-${id}`);
    const bucketOf = (metric, id) => metric.buckets.find((bucket) => bucket.id === id);
    const n = cfg.minItems + 12;

    // Per-profile axis sets.
    const ids = (type) => metrics.measureProfileCoverage({ items: mk(n), projectType: type }).map((metric) => metric.id.replace('axis-', ''));
    assert.deepEqual(ids('general'), ['orientation', 'setting']);
    assert.deepEqual(ids('character'), ['framing', 'orientation', 'setting', 'lighting']);
    assert.deepEqual(ids('style'), ['subject', 'aspect', 'setting']);
    assert.deepEqual(ids('concept'), ['setting', 'framing', 'orientation']);
    assert.deepEqual(ids(undefined), ids('general'), 'Missing projectType behaves as general');
    for (const type of Object.keys(PROFILE_RULES)) assert.deepEqual(ids(type), [...PROFILE_RULES[type].coverageAxes]);

    // Vocabulary: underscores, case, patterns.
    const framingItems = (tagFor) => mk(n, (index) => ({ tags: [tagFor(index)] }));
    assert.equal(bucketOf(axis(framingItems(() => 'full_body'), 'character', 'framing'), 'full').count, n, 'full_body → full');
    assert.equal(bucketOf(axis(framingItems(() => 'Full Body'), 'character', 'framing'), 'full').count, n, 'Full Body → full');
    const halves = axis(framingItems((i) => (i % 2 ? 'Close-Up' : 'upper_body')), 'character', 'framing');
    assert.equal(bucketOf(halves, 'close').count, n / 2);
    assert.equal(bucketOf(halves, 'mid').count, n / 2);
    const bg = (tag) => bucketOf(axis(mk(n, () => ({ tags: [tag, 'indoors'] })), 'general', 'setting'), 'simple').count;
    assert.equal(bg('white background'), n, 'color background pattern');
    assert.equal(bg('Blue_Background'), n, 'pattern after _ and case normalization');
    assert.equal(bg('simple background'), n);
    assert.equal(bg('forest background'), 0, 'non-color background is not simple');
    const subj = (tag) => bucketOf(axis(mk(n, () => ({ tags: [tag, 'no humans'] })), 'style', 'subject'), 'people').count;
    assert.equal(subj('1girl'), n);
    assert.equal(subj('2boys'), n);
    assert.equal(subj('6+girls'), n);
    assert.equal(subj('multiple girls'), n);
    assert.equal(subj('girl scouts'), 0);

    // Framing precedence full > mid > close.
    {
      const metric = axis(mk(n, () => ({ tags: ['close-up', 'upper body', 'full body'] })), 'character', 'framing');
      assert.deepEqual(['full', 'mid', 'close'].map((id) => bucketOf(metric, id).count), [n, 0, 0]);
      const midClose = axis(mk(n, () => ({ tags: ['portrait', 'cowboy shot'] })), 'character', 'framing');
      assert.deepEqual(['full', 'mid', 'close'].map((id) => bucketOf(midClose, id).count), [0, n, 0], 'mid beats close');
    }

    // Orientation from dimensions with tolerance.
    {
      const edge = Math.round(1000 * cfg.orientationTolerance);
      const dims = [[1000, 1500], [1500, 1000], [1000, 1000], [1000, edge - 1], [edge - 1, 1000], [1000, edge + 5], [edge + 5, 1000]];
      const list = mk(dims.length * 3, (index) => ({ width: dims[index % dims.length][0], height: dims[index % dims.length][1] }));
      const metric = axis(list, 'general', 'orientation');
      assert.deepEqual(['portrait', 'square', 'landscape'].map((id) => bucketOf(metric, id).count), [6, 9, 6]);
      assert.equal(metric.unlabeled, 0);
    }

    // Aspect buckets for sd15 vs sdxl and the "other" bucket.
    {
      const used = (width, height, model) => axis(mk(n, () => ({ width, height })), 'style', 'aspect', { resolutionPreset: model }).buckets.filter((bucket) => bucket.count > 0).map((bucket) => bucket.id);
      const bucketIds = (model) => TARGET_MODEL_PRESETS[model].buckets.map((bucket) => bucket.id);
      const sdxlWide = TARGET_MODEL_PRESETS.sdxl.buckets.find((bucket) => bucket.width === 1344);
      const sd15Wide = TARGET_MODEL_PRESETS.sd15.buckets.find((bucket) => bucket.width === 640);
      assert.deepEqual(used(1344, 768, 'sdxl'), [sdxlWide.id], 'exact sdxl bucket');
      assert.deepEqual(used(640, 384, 'sd15'), [sd15Wide.id], 'exact sd15 bucket');
      assert.ok(!bucketIds('sd15').includes(sdxlWide.id), 'sd15 has no 1344×768 bucket');
      const dist = Math.abs(Math.log(1344 / 768) - Math.log(640 / 384));
      assert.deepEqual(used(1344, 768, 'sd15'), [dist <= cfg.aspectMaxLogDistance ? sd15Wide.id : 'other'], 'nearest bucket by |log ratio| or other');
      assert.deepEqual(used(1000, 100, 'sdxl'), ['other'], 'extreme ratio → other');
      assert.deepEqual(used(1000, 100, 'sd15'), ['other']);
      for (const model of ['sd15', 'sdxl', 'flux']) {
        assert.deepEqual(axis(mk(n), 'style', 'aspect', { resolutionPreset: model }).buckets.map((bucket) => bucket.id), [...bucketIds(model), 'other']);
      }
      assert.deepEqual(axis(mk(n), 'style', 'aspect').buckets.map((bucket) => bucket.id), [...bucketIds('sdxl'), 'other'], 'default model is sdxl');
      const mostlyOther = axis(mk(n, (index) => (index < n * 0.6 ? { width: 1000, height: 100 } : {})), 'style', 'aspect');
      assert.equal(mostlyOther.status, 'warn');
      assert.match(mostlyOther.explanation, /fit none of the .* buckets/);
    }

    // Not evaluated: too few items.
    {
      const few = axis(mk(cfg.minItems - 1, () => ({ tags: ['full body'] })), 'character', 'framing');
      assert.equal(few.evaluated, false);
      assert.equal(few.value, null, 'not evaluated is null, not 0');
      assert.equal(few.status, 'ok');
      assert.ok(few.explanation.includes(String(cfg.minItems - 1)) && few.explanation.includes(String(cfg.minItems)), few.explanation);
      assert.equal(axis(mk(cfg.minItems, () => ({ tags: ['full body'] })), 'character', 'framing').evaluated, true, 'exactly minItems evaluates');
    }

    // Not evaluated: labeled fraction below minimum.
    {
      const total = 20;
      const labeledCount = Math.ceil(cfg.minLabeledFraction * total) - 1;
      const sparse = axis(mk(total, (index) => ({ tags: index < labeledCount ? ['full body'] : ['solo'] })), 'character', 'framing');
      assert.equal(sparse.evaluated, false);
      assert.equal(sparse.value, null);
      assert.equal(sparse.unlabeled, total - labeledCount);
      assert.ok(sparse.explanation.includes(`only ${labeledCount} of ${total} files`), sparse.explanation);
      assert.match(sparse.explanation, /Axis not evaluated/);
      assert.match(sparse.explanation, /framing tags/);
      const enough = axis(mk(total, (index) => ({ tags: index <= labeledCount ? ['full body'] : ['solo'] })), 'character', 'framing');
      assert.equal(enough.evaluated, true, 'fraction at the minimum evaluates');
      assert.equal(enough.unlabeled, total - labeledCount - 1);
      const noSize = axis(mk(total, () => ({ width: undefined, height: undefined })), 'general', 'orientation');
      assert.equal(noSize.evaluated, false);
      assert.match(noSize.explanation, /sizes are known for only 0 of 20/);
    }

    // Tags semantics: undefined → derive from caption; [] → unlabeled.
    {
      const fromCaption = axis(mk(n, () => ({ tags: undefined, caption: 'hero, full body, smile' })), 'character', 'framing');
      assert.equal(bucketOf(fromCaption, 'full').count, n, 'tags undefined resolves from caption');
      const empty = axis(mk(n, () => ({ tags: [], caption: 'hero, full body' })), 'character', 'framing');
      assert.equal(empty.evaluated, false, 'tags [] are unlabeled even when the caption has vocabulary');
      assert.equal(empty.unlabeled, n);
      const mixed = axis(mk(n, (index) => (index % 2 ? { tags: [], caption: 'full body' } : { tags: undefined, caption: 'full body' })), 'character', 'framing');
      assert.equal(bucketOf(mixed, 'full').count, n / 2);
      assert.equal(mixed.unlabeled, n / 2);
      assert.ok(!mixed.buckets.some((bucket) => bucket.id === 'unlabeled'), 'unlabeled is never a bucket');
    }

    // Recommended = ceil(share × max(items, target.min)) with the formula in explanation and hint.
    {
      const share = cfg.bucketMinShare.framing.full;
      const pct = Math.round(share * 100);
      const list = mk(n, () => ({ tags: ['close-up'] }));
      assert.equal(bucketOf(axis(list, 'character', 'framing'), 'full').recommended, Math.ceil(share * Math.max(n, T.count.defaultTarget.min)), 'default target.min is used');
      const withTarget = axis(list, 'character', 'framing', { target: { min: 100, max: 200 } });
      const expected = Math.ceil(share * 100);
      assert.equal(bucketOf(withTarget, 'full').recommended, expected, 'target.min above item count is the basis');
      assert.equal(bucketOf(withTarget, 'full').count, 0);
      assert.equal(withTarget.status, 'warn');
      assert.ok(withTarget.explanation.includes(`ceil(${pct}% × 100) = ${expected}`), withTarget.explanation);
      assert.ok(withTarget.explanation.includes(`0 of ${expected} recommended`), withTarget.explanation);
      const small = axis(list, 'character', 'framing', { target: { min: 5, max: 10 } });
      assert.equal(bucketOf(small, 'full').recommended, Math.ceil(share * n), 'item count is the basis when above target.min');
      assert.ok(small.explanation.includes(`ceil(${pct}% × ${n}) = ${Math.ceil(share * n)}`), small.explanation);
      assert.equal(bucketOf(axis(list, 'general', 'orientation'), 'square').recommended, undefined, 'buckets without a share have no recommendation');
      const input = { items: list, projectType: 'character', target: { min: 100, max: 200 }, triggerWord: 'hero' };
      const hint = metrics.buildQualityReport(input).hints.find((entry) => entry.id === 'gap-axis-framing-full');
      assert.ok(hint, 'gap hint for the missing bucket');
      assert.equal(hint.metricId, 'axis-framing');
      assert.ok(hint.text.includes(`0 of ${expected} recommended`), hint.text);
      assert.ok(hint.explanation.includes(`ceil(${pct}% × 100) = ${expected}`), hint.explanation);
      assert.equal(hint.action, undefined);
      // A bucket meeting its recommendation produces no hint.
      const filled = mk(n, (index) => ({ tags: [index < expected ? 'full body' : 'close-up'] }));
      const filledReport = metrics.buildQualityReport({ ...input, items: filled, target: { min: 5, max: 10 } });
      const need = Math.ceil(share * n);
      assert.equal(filled.filter((item) => item.tags[0] === 'full body').length >= need, true, 'precondition');
      assert.ok(!filledReport.hints.some((entry) => entry.id === 'gap-axis-framing-full'));
    }

    // Axes never fail and never change readiness.
    {
      const bare = { items: mk(30, () => ({ tags: ['close-up'], width: 1000, height: 100, caption: 'hero, close-up' })), projectType: 'character', triggerWord: 'hero', target: { min: 20, max: 60 } };
      for (const type of Object.keys(PROFILE_RULES)) {
        for (const metric of metrics.measureProfileCoverage({ ...bare, projectType: type })) assert.notEqual(metric.status, 'fail', `${type}/${metric.id}`);
      }
      const report = metrics.buildQualityReport(bare);
      assert.ok(report.coverage.some((metric) => metric.status === 'warn'), 'precondition: some axis warns');
      assert.ok(![...report.required, ...report.insights].some((metric) => metric.id.startsWith('axis-')), 'axes live only in coverage');
      const rank = { ok: 0, warn: 1, fail: 2 };
      const worst = report.required.map((metric) => metric.status).reduce((acc, status) => (rank[status] > rank[acc] ? status : acc), 'ok');
      assert.equal(report.readiness, worst, 'readiness is the worst required check');
      // Same required checks, different axis sets → same readiness; a warning-only axis does not downgrade ok.
      const clean = metrics.buildQualityReport({ items: mk(30, (index) => ({ embedding: basis(64, index), caption: 'hero, a', tags: ['close-up'] })), projectType: 'character', triggerWord: 'hero', target: { min: 20, max: 60 }, technical: [] });
      assert.ok(clean.coverage.some((metric) => metric.status === 'warn'));
      const noAxesReport = metrics.buildQualityReport({ items: clean.required.length ? mk(30, (index) => ({ embedding: basis(64, index), caption: 'hero, a', tags: ['close-up'] })).slice(0, 30) : [], projectType: 'general', triggerWord: 'hero', target: { min: 20, max: 60 }, technical: [] });
      assert.equal(clean.readiness, noAxesReport.readiness, 'a different axis set does not change readiness');
    }

    // groupNearDuplicates grouping and order.
    {
      const pair = (kept, removed, kind = 'near') => ({ kept, removed, similarity: kind === 'exact' ? 1 : 0.99, kind });
      const groups = metrics.groupNearDuplicates([
        pair('a', 'a1'), pair('b', 'b1'), pair('b', 'b2', 'exact'), pair('c', 'c1'), pair('b', 'b3'), pair('a', 'a2'),
      ]);
      assert.deepEqual(groups.map((group) => group.kept), ['b', 'a', 'c'], 'larger groups first, ties by first appearance');
      assert.deepEqual(groups.map((group) => group.removed), [['b1', 'b2', 'b3'], ['a1', 'a2'], ['c1']], 'removed keeps pair order');
      assert.deepEqual(groups.map((group) => group.exact), [1, 0, 0]);
      assert.deepEqual(metrics.groupNearDuplicates([]), []);
      assert.deepEqual(metrics.groupNearDuplicates([pair('x', 'x1'), pair('y', 'y1')]).map((group) => group.kept), ['x', 'y'], 'ties keep first appearance');
    }

    // Near-duplicate hint text and action.
    {
      const list = mk(20, (index) => ({ id: `dir/f-${index}.png`, embedding: basis(64, index) }));
      list[5] = { ...list[5], embedding: noisy(basis(64, 3), 0.01) };
      list[9] = { ...list[9], embedding: noisy(basis(64, 3), 0.01) };
      list[12] = { ...list[12], imageHash: 'h' };
      list[13] = { ...list[13], imageHash: 'h' };
      const report = metrics.buildQualityReport({ items: list, projectType: 'general' });
      const hints = report.hints.filter((hint) => hint.metricId === 'near-duplicates');
      assert.equal(hints.length, 2, 'one hint per kept anchor');
      const first = hints[0];
      assert.equal(first.id, 'near-duplicates-dir/f-3.png');
      assert.equal(first.text, '2 near-duplicates of “f-3.png”');
      assert.equal(first.action.kind, 'remove');
      assert.deepEqual(first.action.ids, ['dir/f-5.png', 'dir/f-9.png']);
      assert.ok(first.explanation.includes('DINOv2'));
      assert.ok(first.explanation.includes(String(T.nearDuplicates.similarity)), 'explanation names the threshold');
      assert.ok(first.explanation.includes('found 2 of 20 files'), first.explanation);
      assert.ok(!first.explanation.includes('Exact copies'), 'no exact note without exact copies');
      const exactHint = hints[1];
      assert.equal(exactHint.id, 'near-duplicates-dir/f-12.png');
      assert.equal(exactHint.text, '1 near-duplicate of “f-12.png”');
      assert.match(exactHint.explanation, /Exact copies by hash: 1/);
      assert.deepEqual(exactHint.action.ids, ['dir/f-13.png']);
      assert.equal(metrics.buildQualityReport({ items: mk(20, (index) => ({ embedding: basis(64, index) })) }).hints.filter((hint) => hint.metricId === 'near-duplicates').length, 0);
      const many = mk(40, (index) => ({ embedding: basis(64, Math.floor(index / 2)) }));
      assert.equal(metrics.buildQualityReport({ items: many }).hints.filter((hint) => hint.metricId === 'near-duplicates').length, 5, 'at most 5 groups');
    }

    // Trigger-missing hint only for requireTrigger profiles.
    {
      const list = mk(20, (index) => ({ embedding: basis(64, index), caption: 'a, b' }));
      assert.deepEqual(['general', 'character', 'style', 'concept'].filter((type) => PROFILE_RULES[type].tagPolicy.requireTrigger), ['character', 'concept']);
      for (const [type, rules] of Object.entries(PROFILE_RULES)) {
        const hint = (trigger) => metrics.buildQualityReport({ items: list, projectType: type, triggerWord: trigger }).hints.find((entry) => entry.id === 'trigger-missing');
        if (rules.tagPolicy.requireTrigger) {
          assert.ok(hint(undefined) && hint('') && hint('  '), `${type}: hint without trigger`);
          assert.equal(hint('hero'), undefined, `${type}: no hint with a trigger`);
          assert.ok(hint('').explanation.includes(type));
          assert.equal(hint('').metricId, 'trigger');
        } else assert.equal(hint(''), undefined, `${type}: no trigger hint`);
      }
    }

    // Common tags by tag policy.
    {
      const list = mk(20, (index) => ({ tags: ['hero', 'red hair', 'blue eyes', `unique-${index}`] }));
      const constant = ['red hair', 'blue eyes'].sort();
      const character = metrics.measureCommonTags(list, 'hero', PROFILE_RULES.character.tagPolicy);
      assert.equal(character.status, 'warn');
      assert.equal(character.action.kind, 'remove');
      assert.equal(character.action.label, 'Remove from captions');
      assert.deepEqual([...character.action.tags].sort(), constant);
      assert.match(character.explanation, /constant traits/);
      assert.ok(character.explanation.includes(String(Math.ceil(T.tags.commonFraction * 20))), 'explanation states the file threshold');
      const style = metrics.measureCommonTags(list, 'hero', PROFILE_RULES.style.tagPolicy);
      assert.equal(style.status, 'ok');
      assert.equal(style.action, undefined);
      assert.equal(style.evaluated, true);
      assert.match(style.explanation, /keep such tags/);
      assert.equal(style.display, character.display);
      const general = metrics.measureCommonTags(list, 'hero', PROFILE_RULES.general.tagPolicy);
      const legacy = metrics.measureCommonTags(list, 'hero');
      assert.deepEqual(general, legacy, 'general policy equals the previous behaviour');
      assert.equal(legacy.status, 'warn');
      assert.equal(legacy.action.kind, 'review');
      assert.deepEqual([...legacy.action.tags].sort(), constant);
      const none = metrics.measureCommonTags(mk(20, (index) => ({ tags: [`u-${index}`] })), 'hero', PROFILE_RULES.character.tagPolicy);
      assert.equal(none.status, 'ok');
      assert.equal(none.action, undefined);
      assert.equal(metrics.measureCommonTags(mk(2), 'hero', PROFILE_RULES.character.tagPolicy).evaluated, false);

      const hintFor = (type) => metrics.buildQualityReport({ items: list, projectType: type, triggerWord: 'hero' }).hints.find((entry) => entry.id === 'common-tags-prune');
      const pruneHint = hintFor('character');
      assert.ok(pruneHint);
      assert.equal(pruneHint.metricId, 'common-tags');
      assert.equal(pruneHint.action.kind, 'remove');
      assert.deepEqual([...pruneHint.action.tags].sort(), constant);
      assert.ok(pruneHint.text.startsWith('2 tags in almost every file'), pruneHint.text);
      assert.ok(pruneHint.explanation.length > 0);
      assert.ok(hintFor('concept'));
      assert.equal(hintFor('style'), undefined, 'keep: no hint');
      assert.equal(hintFor('general'), undefined, 'review: no prune hint');
      const styleCommon = metrics.buildQualityReport({ items: list, projectType: 'style', triggerWord: 'hero' }).insights.find((metric) => metric.id === 'common-tags');
      assert.equal(styleCommon.status, 'ok');
      assert.equal(styleCommon.action, undefined);
    }
  }

  console.log('quality metrics: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
