import React from 'react';
import { createRoot } from 'react-dom/client';
import { WdTaggerDownloadPanel } from '../src/components/tagging/WdTaggerDownloadPanel';
import { useLocalTaggerStore, type WdTaggerDownloadState } from '../src/stores/useLocalTaggerStore';
import { downloadWdTaggerModel, cancelWdTaggerDownload } from '../src/services/tagging/wdTaggerDownloadService';
import { sha256Hex } from '../src/services/models/verifiedModelDownload';
import { getLocalTaggerSavedFile, saveLocalTaggerFile } from '../src/services/tagging/localTaggerFileSettings';
import { restoreSavedLocalTagger } from '../src/services/tagging/localTaggerConnectionService';
import { WD_TAGGER_MODEL, type WdTaggerModelManifest } from '../src/services/tagging/wdTaggerModelManifest';
import '../src/index.css';

// The fake bytes are not a real ONNX model, so after a verified save ONNX Runtime fails to start and logs
// wasm errors. Those expected runtime errors are dropped here (the spec serves an empty .wasm so the
// browser adds no 404 noise); every other console error still reaches the e2e guard.
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => { if (!/wasm|WebAssembly|ArrayBuffer instantiation/i.test(args.map(String).join(' '))) originalConsoleError(...args); };

// Small test manifest with real hashes so the success/integrity paths run without the 378 MB model.
const modelBytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256);
const tagsBytes = new TextEncoder().encode('tag_id,name,category,count\n1,blue_hair,0,10\n');
const base = 'https://huggingface.co/test/wd-fixture/resolve/rev';
const toBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const testManifest: WdTaggerModelManifest = {
  ...WD_TAGGER_MODEL,
  id: 'fixture',
  files: {
    model: { label: 'model.onnx', url: `${base}/model.onnx`, bytes: modelBytes.length, sha256: await sha256Hex(toBuffer(modelBytes)) },
    tags: { label: 'selected_tags.csv', url: `${base}/selected_tags.csv`, bytes: tagsBytes.length, sha256: await sha256Hex(toBuffer(tagsBytes)) },
  },
  totalBytes: modelBytes.length + tagsBytes.length,
};

const states: WdTaggerDownloadState[] = [];
useLocalTaggerStore.subscribe((state, previous) => { if (state.modelDownload !== previous.modelDownload) states.push(state.modelDownload); });

const strip = async (key: 'model' | 'tags') => {
  const entry = await getLocalTaggerSavedFile(key);
  return entry ? { name: entry.name, size: entry.file?.size, sha256: entry.sha256, source: entry.source, hasHandle: !!entry.handle } : null;
};

(window as unknown as Record<string, unknown>).__wd = {
  manifest: testManifest,
  modelBytes: Array.from(modelBytes),
  tagsBytes: Array.from(tagsBytes),
  states: () => states.map((state) => ({ ...state })),
  download: () => downloadWdTaggerModel({ manifest: testManifest }),
  cancel: cancelWdTaggerDownload,
  saved: async () => ({ model: await strip('model'), tags: await strip('tags') }),
  // Replace stored model bytes with different content but keep the recorded sha256 (simulates corruption).
  tamper: async () => {
    const entry = await getLocalTaggerSavedFile('model');
    const bytes = modelBytes.slice(); bytes[10] ^= 0xff;
    await saveLocalTaggerFile('model', new File([toBuffer(bytes)], 'model.onnx'), { sha256: entry!.sha256!, source: 'download' });
  },
  restore: async () => ({ connected: await restoreSavedLocalTagger(false, true), message: useLocalTaggerStore.getState().message, status: useLocalTaggerStore.getState().status }),
  storeMessage: () => useLocalTaggerStore.getState().message,
};

createRoot(document.getElementById('root')!).render(<div className="p-4 max-w-md"><WdTaggerDownloadPanel /></div>);
