import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temporary = await mkdtemp(join(tmpdir(), 'video-frames-'));
try {
  await build({ input: ['src/services/video/frameSelection.ts', 'src/services/video/frameQuality.ts', 'src/services/video/frameExport.ts', 'src/services/video/videoReader.ts', 'src/services/video/types.ts', 'src/services/video/videoCache.ts', 'src/services/video/videoClient.ts'], platform: 'node', output: { dir: temporary, format: 'esm', entryFileNames: '[name].mjs' } });
  const load = (name) => import(pathToFileURL(join(temporary, `${name}.mjs`)));
  const { selectVideoFrames, normalizeFrameEmbedding, frameDistance } = await load('frameSelection');
  const { DEFAULT_FRAME_SELECTION, frameTimecode } = await load('types');
  const { inspectFramePixels, isAnalysisCandidate } = await load('frameQuality');
  const { findFrameIndex } = await load('videoReader');
  const { videoFingerprint } = await load('videoCache');
  const { saveVideoFrame, validateFrameDirectory } = await load('frameExport');
  const frame = (timestamp, vector, quality = {}) => ({ run: 'test', source: 'fixture', id: `fixture@${timestamp}`, timestamp, duration: 0.1, embedding: normalizeFrameEmbedding(vector), quality: { sharpness: 1, dark: false, blurry: false, transition: false, ...quality } });
  const records = [frame(0, [1, 0, 0]), frame(0.08, [1, 0, 0]), frame(0.24, [0, 1, 0]), frame(0.30, [0, 0, 1]), frame(0.7, [-1, 0, 0], { dark: true })];
  const batches = async function* () { yield records.slice(0, 2); yield records.slice(2); };
  const select = (options = {}, signal) => selectVideoFrames(batches, { ...DEFAULT_FRAME_SELECTION, ...options }, signal);
  assert.equal(frameDistance(normalizeFrameEmbedding([3, 4]), normalizeFrameEmbedding([3, 4])) < 1e-6, true);
  assert.throws(() => normalizeFrameEmbedding([NaN]), /invalid/);
  assert.throws(() => normalizeFrameEmbedding([0, 0]), /empty/);
  assert.throws(() => frameDistance(new Float32Array(2), new Float32Array(3)), /Incompatible/);
  assert.deepEqual((await select()).map((record) => record.timestamp), [0, 0.24, 0.3]);
  assert.equal((await select({ limit: 2 })).length, 2);
  assert.equal((await select({ distance: 1.5 })).length, 1);
  assert.deepEqual(await select(), await select());
  assert.ok((await select()).every((reference) => reference.source === 'fixture' && reference.id === `fixture@${reference.timestamp}` && !('embedding' in reference)));
  const pinned = await select({ pinned: [0.7], limit: 2 });
  assert.ok(pinned.some((record) => record.timestamp === 0.7));
  assert.equal(pinned.length, 2);
  assert.ok(!(await select({ excluded: [0.24] })).some((record) => record.timestamp === 0.24));
  await assert.rejects(select({ pinned: [0, 0.24], limit: 1 }), /smaller/);
  await assert.rejects(select({ pinned: [42] }), /missing/);
  await assert.rejects(select({ pinned: [0], excluded: [0] }), /both/);
  await assert.rejects(select({ limit: NaN }), /between/);
  await assert.rejects(select({ distance: NaN }), /between/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(select({}, abort.signal), { name: 'AbortError' });
  const filtered = await selectVideoFrames(async function* () { yield records.map((record) => ({ ...record, quality: { ...record.quality, blurry: true } })); }, { ...DEFAULT_FRAME_SELECTION, excludeBlurry: true });
  assert.deepEqual(filtered, []);
  const zeros = new Uint8ClampedArray(64 * 64 * 4);
  const black = inspectFramePixels(zeros, 64, 64);
  assert.equal(black.quality.dark, true);
  const white = inspectFramePixels(zeros.map(() => 255), 64, 64, black.histogram);
  assert.equal(white.quality.transition, true);
  assert.equal(white.quality.dark, false);
  assert.equal(isAnalysisCandidate('full', 0.1, 1, false, Infinity), true);
  assert.equal(isAnalysisCandidate('fast', 0.1, 1, false, Infinity), false);
  assert.equal(isAnalysisCandidate('fast', 0.1, 1, true, Infinity), true);
  assert.equal(isAnalysisCandidate('fast', 0.3, 1, false, 0.25), true);
  assert.equal(findFrameIndex([0, 0.08, 0.24, 0.3], 0.23), 1);
  assert.equal(findFrameIndex([0, 0.08, 0.24, 0.3], 0.24), 2);
  assert.equal(findFrameIndex([0, 0.08, 0.24, 0.3], 99), 3);
  assert.equal(frameTimecode(3661.123), '01:01:01.123');
  assert.equal(await videoFingerprint(new Blob(['same'])), await videoFingerprint(new Blob(['same'])));
  assert.notEqual(await videoFingerprint(new Blob(['same'])), await videoFingerprint(new Blob(['diff'])));
  await assert.rejects(videoFingerprint(new Blob(['x']), abort.signal), { name: 'AbortError' });
  for (const path of ['Project/../outside', 'Project/.git', '/tmp', 'Project//assets']) assert.throws(() => validateFrameDirectory(path));
  const entries = new Map();
  let fail = false;
  const directory = {
    name: 'project',
    async getFileHandle(name, options) {
      if (!entries.has(name) && options?.create) entries.set(name, new Blob());
      if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
      return { name, getFile: async () => entries.get(name), createWritable: async () => ({ write: async (blob) => { if (fail) throw new Error('Disk full'); entries.set(name, blob); }, close: async () => {} }) };
    },
    async getDirectoryHandle() { throw new DOMException('Missing', 'NotFoundError'); },
    async removeEntry(name) { entries.delete(name); },
  };
  const image = new Blob(['png-fixture'], { type: 'image/png' });
  const paths = await Promise.all([saveVideoFrame(directory, 'Project', 'clip.mp4', 0.24, image), saveVideoFrame(directory, 'Project', 'clip.mp4', 0.24, image)]);
  assert.notEqual(paths[0], paths[1]);
  assert.equal(entries.size, 2);
  fail = true;
  await assert.rejects(saveVideoFrame(directory, 'Project', 'clip.mp4', 0.24, image), /Disk full/);
  assert.equal(entries.size, 2);
  assert.equal(await entries.get(paths[0].replace('Project/', '')).text(), 'png-fixture');
  const { VideoClient, setVideoTabBusy, hasBusyVideoTabs, hasBusyVideoTasks } = await load('videoClient');
  const workers = [];
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
  };
  try {
    const client = new VideoClient();
    const cancelled = client.request({ type: 'model' });
    const cancelledAssertion = assert.rejects(cancelled, { name: 'AbortError' });
    client.cancel();
    await cancelledAssertion;
    assert.equal(workers[0].terminated, true);
    const resumed = client.request({ type: 'select', run: 'test', selection: DEFAULT_FRAME_SELECTION });
    const worker = workers[1];
    worker.onmessage({ data: { id: worker.message.id, type: 'result', frames: [] } });
    assert.deepEqual((await resumed).frames, []);
    assert.equal(worker.terminated, true);
    setVideoTabBusy('video-test', true);
    assert.equal(hasBusyVideoTabs(['unrelated', 'video-test']), true);
    assert.equal(hasBusyVideoTasks(), true);
    setVideoTabBusy('video-test', false);
    assert.equal(hasBusyVideoTasks(), false);
  } finally { globalThis.Worker = originalWorker; }
  let largestBatch = 0;
  let passes = 0;
  const hourFrames = 108000;
  const hourBatches = async function* () {
    passes++;
    for (let offset = 0; offset < hourFrames; offset += 256) {
      const batch = [];
      for (let index = offset; index < Math.min(hourFrames, offset + 256); index++) {
        const embedding = new Float32Array(384);
        embedding[Math.floor(index / 36000)] = 1;
        batch.push({ ...frame(index / 30, [1]), embedding });
      }
      largestBatch = Math.max(largestBatch, batch.length);
      yield batch;
    }
  };
  const hourSelection = await selectVideoFrames(hourBatches, { ...DEFAULT_FRAME_SELECTION, limit: 5 });
  assert.equal(hourSelection.length, 3);
  assert.ok(largestBatch <= 256 && passes <= 6);
  assert.equal(hourSelection[2].timestamp, 2400);
  console.log('PASS: video selection, pin/exclude/filter rules, cancellation, VFR indexing, scene candidates, content fingerprints, and safe PNG writes.');
  console.log('PASS: streaming selection over 108,000 384-dimensional vectors (one hour at 30 fps), batches bounded to 256 records.');
} finally { await rm(temporary, { recursive: true, force: true }); }
