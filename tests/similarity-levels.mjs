import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'similarity-levels-'));
let levels, service, assembly, clusters;
try {
  await build({
    input: [
      'src/services/similarity/similarityLevels.ts',
      'src/services/similarity/similarityService.ts',
      'src/services/dataset/datasetAssemblyService.ts',
      'src/services/build/buildClusterService.ts',
    ],
    platform: 'node',
    transform: { define: { 'import.meta.env.DEV': 'false' } },
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  levels = await import(pathToFileURL(join(temp, 'similarityLevels.mjs')));
  service = await import(pathToFileURL(join(temp, 'similarityService.mjs')));
  assembly = await import(pathToFileURL(join(temp, 'datasetAssemblyService.mjs')));
  clusters = await import(pathToFileURL(join(temp, 'buildClusterService.mjs')));
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

// ---------------------------------------------------------------------------------------------
// Build clusters: sliced clustering core and buildClusterService
// ---------------------------------------------------------------------------------------------

// Unit vector with cosine `cos` to e(base), orthogonal part on e(orth).
const pair = (base, orth, cos) => {
  const v = new Float32Array(DIM);
  v[base] = cos;
  v[orth] = Math.sqrt(1 - cos * cos);
  return v;
};
const denseMatrix = (ids, embeddings) => {
  const distance = service.computeDistanceMatrix(embeddings);
  const index = new Map(ids.map((id, i) => [id, i]));
  const matrix = new Float32Array(ids.length * ids.length);
  for (let i = 0; i < ids.length; i += 1) matrix[i * ids.length + i] = 1;
  for (const [id, results] of distance) {
    for (const r of results) {
      const a = index.get(r.imageId1), b = index.get(r.imageId2);
      matrix[a * ids.length + b] = r.similarity; matrix[b * ids.length + a] = r.similarity;
    }
    void id;
  }
  return matrix;
};
const normalizeClusters = (list) => list.map((c) => [...c.imageIds].sort().join('|')).sort();

// Mixed synthetic set: two near-duplicate pairs, a theme pair (cos 0.95), a triple (0.99 chain), singletons.
const syntheticSet = () => new Map([
  ['n1', basisVector(0)], ['n2', pair(0, 1, 0.995)],
  ['m1', basisVector(5)], ['m2', pair(5, 6, 0.997)],
  ['t1', basisVector(10)], ['t2', pair(10, 11, 0.95)],
  ['s1', basisVector(20)], ['s2', basisVector(21)], ['s3', basisVector(22)],
]);

test('performClusteringSliced equals performClustering at every threshold, also with sliceMs=0', async () => {
  const embeddings = syntheticSet();
  const ids = [...embeddings.keys()];
  const distance = service.computeDistanceMatrix(embeddings);
  const dense = denseMatrix(ids, embeddings);
  for (const threshold of [0.995, 0.985, 0.93, 0.85, 0.5]) {
    const sync = service.performClustering(ids, distance, threshold);
    const sliced = await service.performClusteringSliced(ids, dense, threshold, { sliceMs: 0, yieldToUi: async () => undefined });
    assert.deepEqual(normalizeClusters(sliced), normalizeClusters(sync), `threshold ${threshold}`);
    assert.deepEqual(sliced.map((c) => c.imageIds), sync.map((c) => c.imageIds), `order at ${threshold}`);
    for (let i = 0; i < sync.length; i += 1) assert.ok(Math.abs(sliced[i].avgSimilarity - sync[i].avgSimilarity) < 1e-4);
  }
});

test('performClusteringSliced rejects with AbortError when the signal is aborted', async () => {
  const embeddings = syntheticSet();
  const ids = [...embeddings.keys()];
  const dense = denseMatrix(ids, embeddings);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(service.performClusteringSliced(ids, dense, 0.93, { signal: pre.signal }), (e) => e.name === 'AbortError');
  const mid = new AbortController();
  let yields = 0;
  await assert.rejects(service.performClusteringSliced(ids, dense, 0.5, {
    signal: mid.signal, sliceMs: 0, yieldToUi: async () => { yields += 1; mid.abort(); },
  }), (e) => e.name === 'AbortError');
  assert.equal(yields, 1, 'stops right after the aborting yield');
});

const randomSet = (count, seed = 7) => {
  let state = seed;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 - 0.5; };
  const embeddings = {};
  for (let i = 0; i < count; i += 1) {
    const v = new Float32Array(DIM);
    // Cluster centres every 4th vector with small noise, others random.
    const centre = i % 4 === 0 ? i : i - (i % 4);
    for (let d = 0; d < DIM; d += 1) v[d] = ((d * 31 + centre * 17) % 13) - 6 + (i % 4 === 0 ? 0 : next() * 0.2);
    embeddings[`img${i}`] = v;
  }
  return embeddings;
};

test('yieldToUi is called while clustering 1000x384 and the result matches without yielding', async () => {
  const embeddings = randomSet(1000);
  const ids = Object.keys(embeddings);
  const sha256ById = {};
  let yields = 0;
  const started = performance.now();
  const result = await clusters.computeBuildClusters(
    { ids, embeddings, sha256ById, basis: 'dinov2', strictness: 'balanced' },
    { sliceMs: 1, yieldToUi: async () => { yields += 1; } }
  );
  const elapsed = performance.now() - started;
  console.log(`# computeBuildClusters 1000x384 (sliceMs=1): ${elapsed.toFixed(0)} ms, ${yields} yields, ${result.nearDuplicateGroups.length} near groups, ${result.themes.length} themes`);
  assert.ok(yields > 0, 'yields at least once');
  // With a huge slice only the explicit pre-Vendi yields remain (at most 2); the result is identical.
  let plainYields = 0;
  const plain = await clusters.computeBuildClusters(
    { ids, embeddings, sha256ById, basis: 'dinov2', strictness: 'balanced' },
    { sliceMs: 1e9, yieldToUi: async () => { plainYields += 1; } }
  );
  assert.ok(plainYields <= 2, `plain yields ${plainYields}`);
  assert.ok(yields > plainYields, 'small slices yield more often');
  assert.deepEqual(plain, result);
});

test('cluster thresholds are the shared similarity thresholds, none new', () => {
  const src = clusters.createBuildClusterKey({ ids: [], sha256ById: {}, basis: 'dinov2', strictness: 'loose' });
  assert.ok(src.startsWith(`dinov2|${levels.getStrictnessThreshold('strict', 'dinov2')}|${levels.getStrictnessThreshold('loose', 'dinov2')}|`));
  assert.equal(levels.getStrictnessThreshold('strict', 'dinov2'), levels.getSimilarityThreshold('near-copy', 'dinov2'));
  assert.equal(levels.getStrictnessThreshold('balanced', 'dinov2'), levels.getSimilarityThreshold('similar', 'dinov2'));
  assert.equal(levels.getStrictnessThreshold('loose', 'dinov2'), levels.getSimilarityThreshold('related', 'dinov2'));
});

test('computeBuildClusters boundaries: near-copy threshold for near-duplicates, strictness for themes', async () => {
  const strict = levels.getStrictnessThreshold('strict', 'dinov2');
  const balanced = levels.getStrictnessThreshold('balanced', 'dinov2');
  const embeddings = {
    a: basisVector(0), a2: pair(0, 1, strict + 0.002),     // just above near-copy
    b: basisVector(5), b2: pair(5, 6, strict - 0.005),     // just below near-copy, above balanced
    c: basisVector(10), c2: pair(10, 11, balanced - 0.03), // below balanced
  };
  const ids = Object.keys(embeddings);
  const balancedResult = await clusters.computeBuildClusters({ ids, embeddings, sha256ById: {}, basis: 'dinov2', strictness: 'balanced' });
  assert.deepEqual(balancedResult.nearDuplicateGroups.map((c) => c.memberIds), [['a', 'a2']]);
  assert.deepEqual(balancedResult.themes.map((c) => c.memberIds).sort(), [['a', 'a2'], ['b', 'b2']]);
  assert.equal(balancedResult.nearDuplicateGroups[0].kind, 'near-duplicate');
  assert.ok(balancedResult.themes.every((c) => c.kind === 'theme'));
  assert.deepEqual(balancedResult.unclusteredIds.sort(), ['c', 'c2']);
  const strictResult = await clusters.computeBuildClusters({ ids, embeddings, sha256ById: {}, basis: 'dinov2', strictness: 'strict' });
  assert.deepEqual(strictResult.themes, [], 'strict does not repeat near-duplicates as themes');
  assert.deepEqual(strictResult.unclusteredIds, []);
  const looseResult = await clusters.computeBuildClusters({ ids, embeddings, sha256ById: {}, basis: 'dinov2', strictness: 'loose' });
  assert.ok(looseResult.themes.length >= balancedResult.themes.length);
});

test('computeBuildClusters on histogram basis groups only identical SHA-256, no themes, no Vendi', async () => {
  // Vectors are all identical (would be near-duplicates under DINOv2) but hashes differ.
  const embeddings = { a: basisVector(0), b: basisVector(0), c: basisVector(0), d: basisVector(0), e: basisVector(1) };
  const sha256ById = { a: 'h1', b: 'h1', c: 'h2', d: 'h1', e: 'h3' };
  const result = await clusters.computeBuildClusters({ ids: ['a', 'b', 'c', 'd', 'e'], embeddings, sha256ById, basis: 'histogram', strictness: 'loose' });
  assert.equal(result.basis, 'histogram');
  assert.deepEqual(result.nearDuplicateGroups.map((c) => c.memberIds), [['a', 'b', 'd']]);
  assert.equal(result.nearDuplicateGroups[0].avgSimilarity, 1);
  assert.deepEqual(result.themes, []);
  assert.deepEqual(result.unclusteredIds, []);
  assert.equal(result.vendi, null);
  const none = await clusters.computeBuildClusters({ ids: ['a', 'c'], embeddings, sha256ById, basis: 'histogram', strictness: 'balanced' });
  assert.deepEqual(none.nearDuplicateGroups, []);
  const missing = await clusters.computeBuildClusters({ ids: ['a', 'b'], embeddings, sha256ById: {}, basis: 'histogram', strictness: 'balanced' });
  assert.deepEqual(missing.nearDuplicateGroups, [], 'missing hashes never group');
});

test('exact SHA-256 duplicates are similarity 1 on DINOv2 even with different vectors', async () => {
  const matrix = await clusters.computeSimilarityMatrix({
    ids: ['x', 'y', 'z'], embeddings: { x: basisVector(0), y: basisVector(1), z: basisVector(2) }, sha256ById: { x: 'same', y: 'same', z: 'other' },
  });
  assert.equal(matrix[0 * 3 + 1], 1); assert.equal(matrix[1 * 3 + 0], 1);
  assert.equal(matrix[0 * 3 + 2], 0);
  assert.equal(matrix[1 * 3 + 1], 1);
});

test('findMedoid picks the most central member; ties go to the earlier member (deterministic)', () => {
  // 0 and 2 are close to 1; 1 is the centre of a chain 0-1-2.
  const sim = (rows) => Float32Array.from(rows.flat());
  const chain = sim([[1, 0.99, 0.9], [0.99, 1, 0.99], [0.9, 0.99, 1]]);
  assert.equal(clusters.findMedoid([0, 1, 2], chain, 3), 1);
  const tied = sim([[1, 0.99, 0.99], [0.99, 1, 0.99], [0.99, 0.99, 1]]);
  assert.equal(clusters.findMedoid([0, 1, 2], tied, 3), 0);
  assert.equal(clusters.findMedoid([2, 1, 0], tied, 3), 2, 'ties follow the member order given');
  assert.equal(clusters.findMedoid([1], tied, 3), 1);
});

test('computeBuildClusters is deterministic for tied members and independent of Record key order', async () => {
  const v = basisVector(0);
  const embeddings = { p: v, q: Float32Array.from(v), r: Float32Array.from(v) };
  const first = await clusters.computeBuildClusters({ ids: ['p', 'q', 'r'], embeddings, sha256ById: {}, basis: 'dinov2', strictness: 'balanced' });
  const again = await clusters.computeBuildClusters({ ids: ['p', 'q', 'r'], embeddings: { r: embeddings.r, q: embeddings.q, p: embeddings.p }, sha256ById: {}, basis: 'dinov2', strictness: 'balanced' });
  assert.deepEqual(first, again);
  assert.equal(first.nearDuplicateGroups[0].medoidId, 'p');
  assert.equal(first.nearDuplicateGroups[0].id, 'near-duplicate:p');
  assert.deepEqual(first.nearDuplicateGroups[0].memberIds, ['p', 'q', 'r'], 'members in input id order');
});

test('cluster key depends on ids, sha, basis and strictness but not on id order or decisions', () => {
  const base = { ids: ['a', 'b'], sha256ById: { a: 'h1', b: 'h2' }, basis: 'dinov2', strictness: 'balanced' };
  const key = clusters.createBuildClusterKey(base);
  assert.equal(clusters.createBuildClusterKey({ ...base, ids: ['b', 'a'] }), key, 'order independent');
  assert.equal(clusters.createBuildClusterKey({ ...base, decisions: { a: 'accepted' }, tags: ['x'] }), key, 'decisions and tags ignored');
  assert.notEqual(clusters.createBuildClusterKey({ ...base, ids: ['a', 'b', 'c'] }), key);
  assert.notEqual(clusters.createBuildClusterKey({ ...base, ids: ['a'] }), key);
  assert.notEqual(clusters.createBuildClusterKey({ ...base, sha256ById: { a: 'h1', b: 'h3' } }), key);
  assert.notEqual(clusters.createBuildClusterKey({ ...base, basis: 'histogram' }), key);
  assert.notEqual(clusters.createBuildClusterKey({ ...base, strictness: 'loose' }), key);
  assert.notEqual(clusters.createBuildClusterKey({ ...base, strictness: 'strict' }), key);
});

test('cluster cache is a small LRU', () => {
  const cache = clusters.createClusterCache(2);
  const value = (key) => ({ key, basis: 'dinov2', nearDuplicateGroups: [], themes: [], unclusteredIds: [], vendi: null });
  cache.set('a', value('a')); cache.set('b', value('b'));
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a').key, 'a'); // a becomes most recent
  cache.set('c', value('c'));            // evicts b
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('a') && cache.get('c'));
  assert.equal(cache.size, 2);
  cache.set('a', value('a')); cache.set('d', value('d')); // evicts c
  assert.equal(cache.get('c'), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(clusters.createClusterCache().get('x'), undefined);
});

test('Vendi after >= before when copies are dropped; removable counts dropped members', async () => {
  const embeddings = {
    a: basisVector(0), a2: pair(0, 1, 0.999), a3: pair(0, 2, 0.999),
    b: basisVector(10), c: basisVector(20), d: basisVector(30),
  };
  const result = await clusters.computeBuildClusters({ ids: Object.keys(embeddings), embeddings, sha256ById: {}, basis: 'dinov2', strictness: 'balanced' });
  assert.equal(result.nearDuplicateGroups.length, 1);
  assert.equal(result.vendi.removable, 2);
  assert.ok(result.vendi.after >= result.vendi.before, `${result.vendi.after} >= ${result.vendi.before}`);
  assert.ok(result.vendi.after > result.vendi.before, 'strictly greater when real copies are removed');
  const unique = { a: basisVector(0), b: basisVector(1), c: basisVector(2) };
  const flat = await clusters.computeBuildClusters({ ids: ['a', 'b', 'c'], embeddings: unique, sha256ById: {}, basis: 'dinov2', strictness: 'balanced' });
  assert.equal(flat.vendi.removable, 0);
  assert.equal(flat.vendi.after, flat.vendi.before);
});

test('computeBuildClusters aborts through the signal', async () => {
  const embeddings = randomSet(200);
  const controller = new AbortController();
  await assert.rejects(clusters.computeBuildClusters(
    { ids: Object.keys(embeddings), embeddings, sha256ById: {}, basis: 'dinov2', strictness: 'balanced' },
    { signal: controller.signal, sliceMs: 0, yieldToUi: async () => controller.abort() }
  ), (e) => e.name === 'AbortError');
});

const quality = (extra = {}) => ({ version: 1, width: 2000, height: 2000, shortSide: 2000, sharpness: 0.01, brightness: 0.5, darkShare: 0, brightShare: 0, minShortSide: 1024, ...extra });

test('rankKeepCandidates: reject flags, sharpness, shortSide, inDataset, session order, unmeasured last', () => {
  const rank = (entries, min = 1024) => clusters.rankKeepCandidates(entries, min);
  // sharpest wins among clean images
  assert.deepEqual(rank([
    { id: 'soft', quality: quality({ sharpness: 0.005 }), inDataset: false },
    { id: 'sharp', quality: quality({ sharpness: 0.02 }), inDataset: false },
  ]), ['sharp', 'soft']);
  // a reject-level flag (blurry) loses even to a duller clean image; too-small likewise
  assert.deepEqual(rank([
    { id: 'blurry', quality: quality({ sharpness: 0.0001 }), inDataset: true },
    { id: 'ok', quality: quality({ sharpness: 0.0015 }), inDataset: false },
  ]), ['ok', 'blurry']);
  assert.deepEqual(rank([
    { id: 'small', quality: quality({ width: 500, height: 500, shortSide: 500, sharpness: 0.5 }), inDataset: false },
    { id: 'big', quality: quality({ sharpness: 0.002 }), inDataset: false },
  ]), ['big', 'small']);
  // the same image is fine under a lower minShortSide
  assert.deepEqual(rank([
    { id: 'small', quality: quality({ width: 500, height: 500, shortSide: 500, sharpness: 0.5 }), inDataset: false },
    { id: 'big', quality: quality({ sharpness: 0.002 }), inDataset: false },
  ], 256), ['small', 'big']);
  // equal sharpness: larger shortSide, then inDataset, then order
  assert.deepEqual(rank([
    { id: 'narrow', quality: quality({ shortSide: 1500 }), inDataset: true },
    { id: 'wide', quality: quality({ shortSide: 2000 }), inDataset: false },
  ]), ['wide', 'narrow']);
  assert.deepEqual(rank([
    { id: 'out', quality: quality(), inDataset: false },
    { id: 'in', quality: quality(), inDataset: true },
  ]), ['in', 'out']);
  assert.deepEqual(rank([
    { id: 'first', quality: quality(), inDataset: false },
    { id: 'second', quality: quality(), inDataset: false },
  ]), ['first', 'second']);
  // no measurement goes last, even behind a blurry measured image
  assert.deepEqual(rank([
    { id: 'none', inDataset: true },
    { id: 'blurry', quality: quality({ sharpness: 0.0001 }), inDataset: false },
    { id: 'good', quality: quality(), inDataset: false },
  ]), ['good', 'blurry', 'none']);
  assert.deepEqual(rank([{ id: 'n1', inDataset: false }, { id: 'n2', inDataset: true }]), ['n2', 'n1']);
  assert.deepEqual(rank([]), []);
});

const mkItem = (id, extra = {}) => ({ id, sourceImageId: id, kind: 'source', assetPath: `src/shared/${id}.png`, fileName: `${id}.png`, tags: undefined, ...extra });
const assetOf = (item) => `source:${item.sourceImageId}`;
const mkSession = (items, records = {}, order = items.map(assetOf)) => ({
  version: 1, profile: { target: 10, reviewMode: 'every-item', captionRequired: true }, cursor: 0, filter: 'all', order,
  records: Object.fromEntries(Object.entries(records).map(([id, r]) => [`source:${id}`, { assetId: `source:${id}`, decision: 'unreviewed', application: 'idle', validation: 'pending', ...r }])),
});
const byId = (items) => new Map(items.map((i) => [i.id, i]));
const summary = (targets) => targets.map((t) => `${t.item.id}:${t.decision}`);

test('selectClusterActionTargets accept/reject skip videos and already applied items', () => {
  const items = [
    mkItem('a'), mkItem('b'), mkItem('c', { kind: 'video' }), mkItem('d'), mkItem('e'),
  ];
  const session = mkSession(items, {
    b: { decision: 'accepted', application: 'applied' },
    d: { decision: 'accepted', application: 'pending' },
    e: { decision: 'skipped' },
  });
  const cluster = { memberIds: items.map((i) => i.id) };
  assert.deepEqual(summary(clusters.selectClusterActionTargets(cluster, byId(items), session, 'accept', 1024)),
    ['a:accepted', 'd:accepted', 'e:accepted'], 'video and applied-accepted skipped; pending-accepted retried');
  assert.deepEqual(summary(clusters.selectClusterActionTargets(cluster, byId(items), session, 'reject', 1024)),
    ['a:skipped', 'b:skipped', 'c:skipped', 'd:skipped'], 'already skipped is dropped, video may be rejected');
});

test('selectClusterActionTargets returns members in session order and ignores unknown members', () => {
  const items = [mkItem('a'), mkItem('b'), mkItem('c')];
  const session = mkSession(items, {}, ['source:c', 'source:a', 'source:b']);
  const cluster = { memberIds: ['a', 'ghost', 'b', 'c'] };
  assert.deepEqual(summary(clusters.selectClusterActionTargets(cluster, byId(items), session, 'accept', 1024)),
    ['c:accepted', 'a:accepted', 'b:accepted']);
});

test('selectClusterActionTargets keep-best accepts the best and rejects the rest', () => {
  const items = [mkItem('a'), mkItem('b'), mkItem('v', { kind: 'video' }), mkItem('c')];
  const session = mkSession(items, {
    a: { triage: { group: 'accepted', quality: quality({ sharpness: 0.002 }) } },
    b: { triage: { group: 'accepted', quality: quality({ sharpness: 0.02 }) } },
    c: { triage: { group: 'accepted', quality: quality({ sharpness: 0.0001 }) } },
  });
  const cluster = { memberIds: ['a', 'b', 'v', 'c'] };
  assert.deepEqual(summary(clusters.selectClusterActionTargets(cluster, byId(items), session, 'keep-best', 1024)),
    ['a:skipped', 'b:accepted', 'v:skipped', 'c:skipped'], 'video can never be best, but may be rejected');
  // already applied best => no redundant accept; already skipped others => nothing to do for them
  const settled = mkSession(items, {
    a: { decision: 'skipped', triage: { group: 'accepted', quality: quality({ sharpness: 0.002 }) } },
    b: { decision: 'accepted', application: 'applied', triage: { group: 'accepted', quality: quality({ sharpness: 0.02 }) } },
    c: { decision: 'skipped', triage: { group: 'accepted', quality: quality({ sharpness: 0.0001 }) } },
  });
  assert.deepEqual(summary(clusters.selectClusterActionTargets(cluster, byId(items), settled, 'keep-best', 1024)), ['v:skipped']);
  // Dataset membership breaks ties
  const tied = [mkItem('x'), mkItem('y', { assetPath: 'dataset/y.png' })];
  const tiedSession = mkSession(tied, { x: { triage: { group: 'accepted', quality: quality() } }, y: { triage: { group: 'accepted', quality: quality() } } });
  assert.deepEqual(summary(clusters.selectClusterActionTargets({ memberIds: ['x', 'y'] }, byId(tied), tiedSession, 'keep-best', 1024)), ['x:skipped', 'y:accepted']);
  // all videos: nobody is accepted
  const videos = [mkItem('v1', { kind: 'video' }), mkItem('v2', { kind: 'video' })];
  assert.deepEqual(summary(clusters.selectClusterActionTargets({ memberIds: ['v1', 'v2'] }, byId(videos), mkSession(videos), 'keep-best', 1024)), ['v1:skipped', 'v2:skipped']);
});

test('getBuildClusterStatus counts decisions over proposals and Dataset membership', () => {
  const items = [mkItem('a'), mkItem('b'), mkItem('c'), mkItem('d', { assetPath: 'dataset/d.png' }), mkItem('e')];
  const session = mkSession(items, {
    a: { decision: 'accepted' },
    b: { decision: 'skipped', triage: { group: 'accepted' } },   // manual reject wins over accepted proposal
    c: { decision: 'unreviewed', triage: { group: 'rejected' } }, // proposal counts
    d: { decision: 'deferred' },                                  // deferred is undecided
    // e has no record => pending => undecided
  });
  const status = clusters.getBuildClusterStatus({ memberIds: ['a', 'b', 'c', 'd', 'e', 'ghost'] }, byId(items), session);
  assert.deepEqual(status, { total: 5, accepted: 1, rejected: 2, undecided: 2, inDataset: 1 });
  assert.deepEqual(clusters.getBuildClusterStatus({ memberIds: [] }, byId(items), session), { total: 0, accepted: 0, rejected: 0, undecided: 0, inDataset: 0 });
});
