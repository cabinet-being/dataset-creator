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
    assert.match(effective.display, /20 файлів ≈ 1 ефективно різних/);
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
      assert.ok(metric.explanation.length > 0 && /[а-яіїєґ]/i.test(metric.explanation), `${metric.id} has a Ukrainian explanation`);
    }

    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const html = renderToStaticMarkup(createElement(QualityReport, { report: failed, labelFor: (id) => `file:${id}`, onAction: () => {} }));
    assert.match(html, /data-readiness="fail"/);
    assert.match(html, /Не готово/);
    assert.match(html, /data-metric="trigger" data-status="fail"/);
    assert.match(html, /file:item-0/, 'Action ids are rendered through labelFor');
    assert.match(html, /Ще 12/, 'Long action lists are collapsed');
    assert.match(html, /Застосувати/);
  }

  console.log('quality metrics: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
