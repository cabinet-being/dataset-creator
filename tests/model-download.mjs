import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'model-download-'));
let helper, manifestModule;
try {
  await build({
    input: ['src/services/models/verifiedModelDownload.ts', 'src/services/tagging/wdTaggerModelManifest.ts'],
    platform: 'node',
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  helper = await import(pathToFileURL(join(temp, 'verifiedModelDownload.mjs')));
  manifestModule = await import(pathToFileURL(join(temp, 'wdTaggerModelManifest.mjs')));
} finally {
  await rm(temp, { recursive: true, force: true });
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const payload = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) % 256);
const asset = { label: 'test.bin', url: 'https://example.invalid/test.bin', bytes: payload.length, sha256: sha(payload) };

const streamOf = (bytes, chunk = 300) => new ReadableStream({
  start(controller) {
    for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
    controller.close();
  },
});
const originalFetch = globalThis.fetch;
const withFetch = async (impl, run) => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  try { return await run(calls); } finally { globalThis.fetch = originalFetch; }
};
const ok = (bytes, chunk) => new Response(streamOf(bytes, chunk), { status: 200 });

test('WD tagger manifest is pinned, licensed and consistent', () => {
  const m = manifestModule.WD_TAGGER_MODEL;
  assert.equal(m.id, 'wd-vit-tagger-v3');
  assert.equal(m.license, 'Apache-2.0');
  assert.equal(m.files.model.bytes, 378536310);
  assert.equal(m.files.tags.bytes, 308468);
  assert.equal(m.totalBytes, m.files.model.bytes + m.files.tags.bytes);
  assert.match(m.revision, /^[0-9a-f]{40}$/);
  for (const file of Object.values(m.files)) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.url.startsWith('https://huggingface.co/'));
    assert.ok(file.url.includes(`/resolve/${m.revision}/`), 'URL is pinned to the revision, not main');
    assert.ok(file.url.endsWith(`/${file.label}`));
  }
  assert.ok(m.licenseUrl.startsWith('https://') && m.sourceUrl.startsWith('https://'));
});

test('sha256Hex and verifyModelAsset', async () => {
  assert.equal(await helper.sha256Hex(payload.buffer.slice(0)), sha(payload));
  await helper.verifyModelAsset(payload.buffer.slice(0), asset);
  await assert.rejects(helper.verifyModelAsset(payload.buffer.slice(0, 10), asset), /test\.bin failed its integrity check/);
  const flipped = payload.slice(); flipped[5] ^= 1;
  await assert.rejects(helper.verifyModelAsset(flipped.buffer, asset, 'custom'), /^Error: custom$/);
});

test('download succeeds, reports progress and omits credentials', async () => {
  await withFetch(() => ok(payload), async (calls) => {
    const progress = []; const bytes = [];
    const buffer = await helper.downloadVerifiedModelAsset(asset, { progress: (p) => progress.push(p), onBytes: (b) => bytes.push(b), phase: 'Phase X' });
    assert.deepEqual(new Uint8Array(buffer), payload);
    assert.deepEqual(bytes, [300, 600, 900, 1000]);
    assert.deepEqual(progress.at(-1), { phase: 'Phase X', completed: 1000, total: 1000 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, asset.url);
    assert.equal(calls[0].init.credentials, 'omit');
  });
});

test('default phase text names the asset', async () => {
  await withFetch(() => ok(payload), async () => {
    const progress = [];
    await helper.downloadVerifiedModelAsset(asset, { progress: (p) => progress.push(p) });
    assert.equal(progress[0].phase, 'Downloading test.bin');
  });
});

test('HTTP errors use default and custom messages', async () => {
  await withFetch(() => new Response('nope', { status: 404 }), async () => {
    await assert.rejects(helper.downloadVerifiedModelAsset(asset), /^Error: test\.bin download failed \(404\)\.$/);
    await assert.rejects(helper.downloadVerifiedModelAsset(asset, { messages: { http: (s) => `custom ${s}` } }), /^Error: custom 404$/);
  });
  await withFetch(() => new Response(null, { status: 200 }), async () => {
    await assert.rejects(helper.downloadVerifiedModelAsset(asset), /download failed/);
  });
});

test('oversized, incomplete and tampered bodies are rejected', async () => {
  await withFetch(() => ok(new Uint8Array(1001)), async () => {
    await assert.rejects(helper.downloadVerifiedModelAsset(asset), /^Error: Unexpected test\.bin size\.$/);
    await assert.rejects(helper.downloadVerifiedModelAsset(asset, { messages: { size: 'S' } }), /^Error: S$/);
  });
  await withFetch(() => ok(payload.slice(0, 999)), async () => {
    await assert.rejects(helper.downloadVerifiedModelAsset(asset), /^Error: Incomplete test\.bin download\. Please retry\.$/);
    await assert.rejects(helper.downloadVerifiedModelAsset(asset, { messages: { incomplete: 'I' } }), /^Error: I$/);
  });
  const bad = payload.slice(); bad[500] ^= 0xff;
  await withFetch(() => ok(bad), async () => {
    await assert.rejects(helper.downloadVerifiedModelAsset(asset), /^Error: test\.bin failed its integrity check\. Download it again\.$/);
    await assert.rejects(helper.downloadVerifiedModelAsset(asset, { messages: { integrity: 'G' } }), /^Error: G$/);
  });
});

test('abort before the request rejects with AbortError', async () => {
  const controller = new AbortController(); controller.abort();
  await withFetch((url, init) => { init.signal.throwIfAborted(); return ok(payload); }, async () => {
    await assert.rejects(helper.downloadVerifiedModelAsset(asset, { signal: controller.signal }), (e) => e.name === 'AbortError');
  });
});

test('abort while reading rejects with AbortError and cancels the stream', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) { c.enqueue(payload.slice(0, 100)); },
    cancel() { cancelled = true; },
  });
  await withFetch(() => new Response(body, { status: 200 }), async () => {
    await assert.rejects(
      helper.downloadVerifiedModelAsset(asset, { signal: controller.signal, onBytes: (b) => { if (b >= 200) controller.abort(); } }),
      (e) => e.name === 'AbortError');
    assert.ok(cancelled, 'reader cancelled');
  });
});

test('abort after the last byte but before returning still rejects', async () => {
  const controller = new AbortController();
  await withFetch(() => ok(payload), async () => {
    await assert.rejects(
      helper.downloadVerifiedModelAsset(asset, { signal: controller.signal, onBytes: (b) => { if (b === 1000) controller.abort(); } }),
      (e) => e.name === 'AbortError');
  });
});
