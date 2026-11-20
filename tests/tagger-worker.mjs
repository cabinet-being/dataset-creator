import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

// Any import of ORT in the bundle resolves to a stub that counts instantiations, so the main thread is provably ORT-free.
globalThis.__ortImports = 0;
const temp = await mkdtemp(join(tmpdir(), 'tagger-worker-'));
let service, client;
try {
  await build({
    input: { service: 'src/services/tagging/localTaggerService.ts', client: 'src/services/tagging/taggerWorkerClient.ts' },
    platform: 'node',
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [{
      name: 'ort-stub',
      resolveId: (id) => (id.startsWith('onnxruntime-web') ? '\0ort-stub' : undefined),
      load: (id) => (id === '\0ort-stub' ? 'globalThis.__ortImports++; export const env = { wasm: {} }; export const InferenceSession = {}; export const Tensor = class {};' : undefined),
    }],
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  service = await import(pathToFileURL(join(temp, 'service.mjs')));
  client = await import(pathToFileURL(join(temp, 'client.mjs')));
} finally {
  await rm(temp, { recursive: true, force: true });
}

const info = (overrides = {}) => ({
  inputNames: ['input'], outputNames: ['output'],
  inputShapes: { input: [1, 448, 448, 3] }, outputShapes: { output: [1, 3] }, runtime: 'wasm', ...overrides,
});

/** Fake Worker. `script(worker, request)` returns the response body (or throws) for each request. */
const workers = [];
let script;
class FakeWorker {
  constructor(url, options) {
    this.url = url; this.options = options; this.terminated = false; this.requests = [];
    workers.push(this);
  }
  postMessage(message) {
    this.requests.push(message);
    setTimeout(() => {
      if (this.terminated) return;
      Promise.resolve().then(() => script(this, message)).then(
        (body) => this.onmessage?.({ data: { id: message.id, ...body } }),
        (error) => this.onmessage?.({ data: { id: message.id, type: 'error', message: error.message, code: error.code } }),
      );
    }, 0);
  }
  terminate() { this.terminated = true; }
}
const install = (impl) => {
  workers.length = 0; script = impl;
  globalThis.Worker = FakeWorker; globalThis.OffscreenCanvas = class {};
};
const uninstall = () => { delete globalThis.Worker; delete globalThis.OffscreenCanvas; };
const okScript = (modelInfo = info()) => (_worker, request) =>
  request.type === 'init' ? { type: 'ready', info: modelInfo } : { type: 'scores', scores: new Float32Array([0.1, 0.2, 0.3]) };
const failWith = (message, code) => Object.assign(new Error(message), { code });
const file = (name, text = 'x') => new File([text], name);
const makeBundle = (extra = {}) => ({
  name: 't', modelFile: file('model.onnx'), tags: ['a', 'b', 'c'], tagCategories: ['general', 'general', 'general'],
  inputChannelOrder: 'rgb', inputName: 'input', outputName: 'output', inputWidth: 448, inputHeight: 448,
  layout: 'nhwc', runtime: 'webgpu', workerKey: {}, ...extra,
});

test('pure spec inference handles nhwc, nchw and default size', () => {
  const nhwc = service.inferInputSpec(info({ inputShapes: { input: [1, 224, 320, 3] } }));
  assert.deepEqual(nhwc, { inputName: 'input', outputName: 'output', inputWidth: 320, inputHeight: 224, layout: 'nhwc' });
  const nchw = service.inferInputSpec(info({ inputShapes: { input: [1, 3, 256, 384] } }));
  assert.deepEqual(nchw, { inputName: 'input', outputName: 'output', inputWidth: 384, inputHeight: 256, layout: 'nchw' });
  const dynamic = service.inferInputSpec(info({ inputShapes: { input: ['batch', 'h', 'w', 3] } }));
  assert.equal(dynamic.inputWidth, 448); assert.equal(dynamic.inputHeight, 448); assert.equal(dynamic.layout, 'nhwc');
  const missingShape = service.inferInputSpec(info({ inputShapes: {} }));
  assert.equal(missingShape.inputWidth, 448); assert.equal(missingShape.layout, 'nhwc');
  assert.throws(() => service.inferInputSpec(info({ outputNames: [] })), /usable input and output/);
});

test('validateOutputTagCount accepts matches and reports mismatches', () => {
  service.validateOutputTagCount(info(), 'output', 3);
  service.validateOutputTagCount(info({ outputShapes: { output: [1, 'n'] } }), 'output', 99);
  service.validateOutputTagCount(info({ outputShapes: {} }), 'output', 99);
  assert.throws(() => service.validateOutputTagCount(info(), 'output', 5), (error) => {
    assert.match(error.message, /3/); assert.match(error.message, /5/); return true;
  });
});

test('validateModelInTaggerWorker returns info and terminates unless kept warm', async (t) => {
  t.after(uninstall);
  install(okScript(info({ runtime: 'webgpu' })));
  let seen;
  const cold = await client.validateModelInTaggerWorker({}, file('m.onnx'), (value) => { seen = value; }, false);
  assert.equal(cold.runtime, 'webgpu'); assert.equal(seen, cold);
  assert.equal(workers.length, 1); assert.equal(workers[0].requests[0].type, 'init');
  assert.equal(workers[0].requests[0].disableWebGpu, false);
  assert.equal(workers[0].terminated, true);

  install(okScript());
  const key = {};
  await client.validateModelInTaggerWorker(key, file('m.onnx'), () => {}, true);
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, false);
  client.releaseTaggerWorker(makeBundle({ workerKey: key }));
  assert.equal(workers[0].terminated, true);
});

test('validateModelInTaggerWorker terminates and rethrows when validate throws', async (t) => {
  t.after(uninstall);
  install(okScript());
  await assert.rejects(client.validateModelInTaggerWorker({}, file('m.onnx'), () => { throw new Error('bad model'); }, true), /bad model/);
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, true);
});

test('a webgpu worker error restarts a WASM-only worker, remembered per key', async (t) => {
  t.after(uninstall);
  install((worker, request) => {
    if (request.type === 'init' && !request.disableWebGpu) throw failWith('webgpu device lost', 'webgpu');
    return okScript(info({ runtime: 'wasm' }))(worker, request);
  });
  const key = {};
  const result = await client.validateModelInTaggerWorker(key, file('m.onnx'), () => {}, true);
  assert.equal(result.runtime, 'wasm');
  assert.equal(workers.length, 2);
  assert.equal(workers[0].requests[0].disableWebGpu, false); assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].requests[0].disableWebGpu, true); assert.equal(workers[1].terminated, false);

  // Scoring with the same key reuses the warm WASM worker.
  const bundle = makeBundle({ workerKey: key });
  const scores = await client.scoreImageInTaggerWorker(bundle, new Blob(['i']));
  assert.equal(scores.length, 3); assert.equal(workers.length, 2); assert.equal(bundle.runtime, 'wasm');

  // After the worker is gone, a fresh ensure for the same key starts directly WASM-only (no webgpu attempt).
  client.releaseTaggerWorker(bundle);
  await client.scoreImageInTaggerWorker(bundle, new Blob(['i']));
  assert.equal(workers.length, 3); assert.equal(workers[2].requests[0].disableWebGpu, true);
  client.releaseTaggerWorker(bundle);

  // A different key still tries WebGPU first.
  await client.validateModelInTaggerWorker({}, file('m.onnx'), () => {}, false);
  assert.equal(workers[3].requests[0].disableWebGpu, false);
});

test('a persistent webgpu error after the WASM retry is surfaced instead of looping', async (t) => {
  t.after(uninstall);
  install(() => { throw failWith('still webgpu', 'webgpu'); });
  await assert.rejects(client.validateModelInTaggerWorker({}, file('m.onnx'), () => {}, true), /still webgpu/);
  assert.equal(workers.length, 2); assert.ok(workers.every((worker) => worker.terminated));
});

test('worker memory errors map to the memory message', async (t) => {
  t.after(uninstall);
  install(() => { throw failWith('RangeError: Array buffer allocation failed', 'memory'); });
  await assert.rejects(client.validateModelInTaggerWorker({}, file('m.onnx'), () => {}, true), (error) => {
    assert.equal(error.message, client.TAGGER_MEMORY_MESSAGE); return true;
  });
  assert.equal(workers[0].terminated, true);

  install(() => { throw failWith('out of memory'); });
  await assert.rejects(client.scoreImageInTaggerWorker(makeBundle(), new Blob(['i'])), /out of memory|Not enough memory/);
});

test('worker onerror with a memory-like message maps to the memory message', async (t) => {
  t.after(uninstall);
  install(() => new Promise(() => {}));
  const pending = client.validateModelInTaggerWorker({}, file('m.onnx'), () => {}, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  workers[0].onerror({ message: 'Out of memory' });
  await assert.rejects(pending, (error) => { assert.equal(error.message, client.TAGGER_MEMORY_MESSAGE); return true; });
});

const connectSource = (tagsCsv) => ({ kind: 'explicit-files', name: 'wd', modelFile: file('model.onnx'), tagsFile: file('selected_tags.csv', tagsCsv) });
const csv3 = 'tag_id,name,category,count\n1,a,0,1\n2,b,0,1\n3,c,4,1\n';

test('connectLocalTaggerBundle uses the worker, never ORT on the main thread, and honours keepWorkerWarm', async (t) => {
  t.after(uninstall);
  install(okScript(info({ inputShapes: { input: [1, 3, 256, 256] }, runtime: 'wasm' })));
  const before = globalThis.__ortImports;
  const bundle = await service.connectLocalTaggerBundle(connectSource(csv3), undefined, { keepWorkerWarm: false });
  assert.equal(globalThis.__ortImports, before);
  assert.equal(bundle.session, undefined);
  assert.deepEqual(bundle.tags, ['a', 'b', 'c']);
  assert.equal(bundle.layout, 'nchw'); assert.equal(bundle.inputWidth, 256); assert.equal(bundle.runtime, 'wasm');
  assert.equal(bundle.inputChannelOrder, 'bgr');
  assert.equal(typeof bundle.workerKey, 'object');
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, true);

  const warm = await service.connectLocalTaggerBundle(connectSource(csv3));
  assert.equal(workers.length, 2); assert.equal(workers[1].terminated, false);
  assert.equal(globalThis.__ortImports, before);
  client.releaseTaggerWorker(warm);
  assert.equal(workers[1].terminated, true);
});

test('connectLocalTaggerBundle rejects a tag-count mismatch and terminates the worker', async (t) => {
  t.after(uninstall);
  install(okScript(info({ outputShapes: { output: [1, 7] } })));
  await assert.rejects(service.connectLocalTaggerBundle(connectSource(csv3)), (error) => {
    assert.match(error.message, /7/); assert.match(error.message, /3/); return true;
  });
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, true);
});
