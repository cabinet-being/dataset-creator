import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'similarity-levels-'));
let levels, service, assembly;
try {
  await build({
    input: [
      'src/services/similarity/similarityLevels.ts',
      'src/services/similarity/similarityService.ts',
      'src/services/dataset/datasetAssemblyService.ts',
    ],
    platform: 'node',
    transform: { define: { 'import.meta.env.DEV': 'false' } },
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  levels = await import(pathToFileURL(join(temp, 'similarityLevels.mjs')));
  service = await import(pathToFileURL(join(temp, 'similarityService.mjs')));
  assembly = await import(pathToFileURL(join(temp, 'datasetAssemblyService.mjs')));
} finally {
  await rm(temp, { recursive: true, force: true });
}

const BASES = ['dinov2', 'histogram'];
const DIM = 384;

// Deterministic orthonormal basis vectors e0, e1, e2 ...
const basisVector = (index) => {
  const v = new Float32Array(DIM);
  v[index] = 1;
  return v;
};
// Unit vector with cosine `cos` to e0 (uses e1 as the orthogonal direction).
const withCosine = (cos, orthIndex = 1) => {
  const v = new Float32Array(DIM);
  v[0] = cos;
  v[orthIndex] = Math.sqrt(1 - cos * cos);
  return v;
};
const cluster = (embeddings, threshold) => {
  const matrix = service.computeDistanceMatrix(embeddings);
  return { matrix, clusters: service.performClustering([...embeddings.keys()], matrix, threshold) };
};

test('levels are ordered strict to loose with strictly decreasing thresholds in (0,1]', () => {
  assert.deepEqual(levels.SIMILARITY_LEVELS.map((l) => l.id), ['duplicate', 'near-copy', 'similar', 'related']);
  for (const basis of BASES) {
    const values = levels.SIMILARITY_LEVELS.map((l) => l.minSimilarity[basis]);
    for (let i = 0; i < values.length; i += 1) {
      assert.ok(values[i] > 0 && values[i] <= 1, `${basis} ${values[i]} in (0,1]`);
      if (i > 0) assert.ok(values[i] < values[i - 1], `${basis} strictly decreasing at ${i}`);
    }
  }
});

test('classifySimilarity boundaries for both bases', () => {
  const eps = 1e-6;
  for (const basis of BASES) {
    const table = levels.SIMILARITY_LEVELS;
    table.forEach((level, i) => {
      const t = level.minSimilarity[basis];
      assert.equal(levels.classifySimilarity(t, basis).id, level.id, `${basis} exactly ${level.id}`);
      const below = levels.classifySimilarity(t - eps, basis);
      assert.equal(below?.id ?? null, table[i + 1]?.id ?? null, `${basis} just below ${level.id}`);
    });
    assert.equal(levels.classifySimilarity(1, basis).id, 'duplicate');
    assert.equal(levels.classifySimilarity(0, basis), null);
  }
});

test('hammingDistance handles equal and different lengths', () => {
  assert.equal(levels.hammingDistance('abcd', 'abcd'), 0);
  assert.equal(levels.hammingDistance('abcd', 'abxd'), 1);
  assert.equal(levels.hammingDistance('abcd', 'ab'), 2);
  assert.equal(levels.hammingDistance('ab', 'abcd'), 2);
  assert.equal(levels.hammingDistance('', 'abc'), 3);
  assert.equal(levels.hammingDistance('axc', 'ab'), 2);
});

test('isExactDuplicate uses sha256 or aHash distance', () => {
  const base = '0'.repeat(16);
  const flip = (n) => '1'.repeat(n) + '0'.repeat(16 - n);
  assert.equal(levels.DUPLICATE_HASH_DISTANCE, 4);
  assert.equal(levels.isExactDuplicate({ sha256: 'x' }, { sha256: 'x' }), true);
  assert.equal(levels.isExactDuplicate({ sha256: 'x', aHash: base }, { sha256: 'y', aHash: flip(4) }), true);
  assert.equal(levels.isExactDuplicate({ sha256: 'x', aHash: base }, { sha256: 'y', aHash: flip(5) }), false);
  assert.equal(levels.isExactDuplicate({ sha256: 'x' }, { sha256: 'y' }), false);
  assert.equal(levels.isExactDuplicate({}, {}), false);
  assert.equal(levels.isExactDuplicate({ aHash: base }, {}), false);
  assert.equal(levels.isExactDuplicate({ sha256: 'x' }, { aHash: base }), false);
  assert.equal(levels.isExactDuplicate({ sha256: '' }, { sha256: '' }), false);
});

test('classifyPair: exact overrides similarity; null similarity without exact is null', () => {
  const same = [{ sha256: 'a' }, { sha256: 'a' }];
  const diff = [{ sha256: 'a' }, { sha256: 'b' }];
  assert.equal(levels.classifyPair(same, 0.1, 'dinov2').id, 'duplicate');
  assert.equal(levels.classifyPair(same, null, 'histogram').id, 'duplicate');
  assert.equal(levels.classifyPair(diff, null, 'dinov2'), null);
  assert.equal(levels.classifyPair(diff, 0.5, 'dinov2'), null);
  assert.equal(levels.classifyPair(diff, 0.93, 'dinov2').id, 'similar');
  assert.equal(levels.classifyPair(diff, 0.94, 'histogram').id, 'similar');
});

test('strictness maps to levels and thresholds', () => {
  assert.deepEqual(levels.SIMILARITY_STRICTNESS.map((s) => [s.id, s.level]), [
    ['strict', 'near-copy'], ['balanced', 'similar'], ['loose', 'related'],
  ]);
  assert.equal(levels.getStrictness('strict').level, 'near-copy');
  assert.equal(levels.getStrictness('balanced').level, 'similar');
  assert.equal(levels.getStrictness('loose').level, 'related');
  assert.equal(levels.getStrictness('bogus').id, 'strict');
  for (const s of levels.SIMILARITY_STRICTNESS) {
    for (const basis of BASES) {
      assert.equal(levels.getStrictnessThreshold(s.id, basis), levels.getSimilarityThreshold(s.level, basis));
    }
  }
  assert.equal(levels.getStrictnessThreshold('bogus', 'dinov2'), levels.getSimilarityThreshold('near-copy', 'dinov2'));
});

test('clustering synthetic vectors respects strictness thresholds', () => {
  const strict = levels.getStrictnessThreshold('strict', 'dinov2');
  const balanced = levels.getStrictnessThreshold('balanced', 'dinov2');

  const close = new Map([['base', basisVector(0)], ['close', withCosine(0.99)], ['ortho', basisVector(2)]]);
  const closeResult = cluster(close, strict);
  assert.equal(closeResult.clusters.length, 1);
  assert.deepEqual([...closeResult.clusters[0].imageIds].sort(), ['base', 'close']);
  assert.ok(!closeResult.clusters.some((c) => c.imageIds.includes('ortho')));

  const mid = new Map([['base', basisVector(0)], ['mid', withCosine(0.95)], ['ortho', basisVector(2)]]);
  assert.equal(cluster(mid, strict).clusters.length, 0, '0.95 is not grouped at strict');
  const midBalanced = cluster(mid, balanced);
  assert.equal(midBalanced.clusters.length, 1, '0.95 is grouped at balanced');
  assert.deepEqual([...midBalanced.clusters[0].imageIds].sort(), ['base', 'mid']);
});

test('getClusterLevel reports the weakest link level', () => {
  const near = new Map([['base', basisVector(0)], ['close', withCosine(0.99)]]);
  const nearResult = cluster(near, levels.getStrictnessThreshold('strict', 'dinov2'));
  assert.ok(Math.abs(nearResult.matrix.get('base')[0].similarity - 0.99) < 1e-4);
  assert.equal(service.getClusterLevel(['base', 'close'], nearResult.matrix, 'dinov2').id, 'near-copy');

  const identical = new Map([['a', withCosine(0.5)], ['b', withCosine(0.5)]]);
  const matrix = service.computeDistanceMatrix(identical);
  assert.equal(service.getClusterLevel(['a', 'b'], matrix, 'dinov2').id, 'duplicate');
  assert.equal(service.getClusterLevel(['a'], matrix, 'dinov2'), null);
});

test('NEAR_DUPLICATE_THRESHOLD equals the near-copy dinov2 threshold', () => {
  assert.equal(assembly.NEAR_DUPLICATE_THRESHOLD, 0.985);
  assert.equal(assembly.NEAR_DUPLICATE_THRESHOLD, levels.getSimilarityThreshold('near-copy', 'dinov2'));
});
