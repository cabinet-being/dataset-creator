import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BufferTarget, CanvasSource, Output, WebMOutputFormat, Mp4OutputFormat } from 'mediabunny';
import { VideoFramesTool } from '../src/components/tools/VideoFramesTool';
import { inspectVideo, readVideoFrame, openVideo } from '../src/services/video/videoReader';
import { downloadVideoModel, loadVideoModel, VIDEO_MODEL_KEY } from '../src/services/video/videoModel';
import { analyzeVideo, analysisCacheKey } from '../src/services/video/videoAnalysis';
import { DEFAULT_FRAME_SELECTION } from '../src/services/video/types';
import { frameDistance } from '../src/services/video/frameSelection';
import { videoFrameBatches, getVideoMeta } from '../src/services/video/videoCache';
import { VideoClient } from '../src/services/video/videoClient';
import '../src/index.css';

const timestamps = [0, 0.08, 0.24, 0.3, 0.7, 1, 1.2, 1.9];
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const makeFixture = async (rotation = false, hour = false) => {
  const canvas = new OffscreenCanvas(320, 180);
  const context = canvas.getContext('2d')!;
  const target = new BufferTarget();
  const output = new Output({ format: rotation ? new Mp4OutputFormat() : new WebMOutputFormat(), target });
  const source = new CanvasSource(canvas, { codec: rotation ? 'avc' : 'vp8', bitrate: 1_000_000 });
  output.addVideoTrack(source, { rotation: rotation ? 90 : 0 });
  await output.start();
  const times = hour ? Array.from({ length: 3600 }, (_, index) => index) : timestamps;
  for (let index = 0; index < times.length; index++) {
    context.fillStyle = ['#d32f2f', '#d32f2f', '#1565c0', '#16a34a', '#111111', '#d32f2f', '#c026d3', '#1565c0'][index % 8];
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#ffffff';
    context.fillRect(index % 2 ? 160 : 20, 30, 70, 100);
    context.fillStyle = '#111111';
    context.font = '24px sans-serif'; context.fillText(String(index), 120, 100);
    await source.add(times[index], (times[index + 1] ?? (hour ? 3600 : 2.1)) - times[index]);
  }
  await output.finalize(); source.close();
  return new File([target.buffer!], rotation ? 'rotated.mp4' : 'variable-rate.webm', { type: rotation ? 'video/mp4' : 'video/webm' });
};
const saved = new Map<string, Blob>();
const directory = {
  name: 'Video test project',
  async *entries() { for (const name of saved.keys()) yield [name, await this.getFileHandle(name)] as const; },
  async getDirectoryHandle() { throw new DOMException('Missing', 'NotFoundError'); },
  async removeEntry(name: string) { saved.delete(name); },
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!saved.has(name) && options?.create) saved.set(name, new Blob());
    if (!saved.has(name)) throw new DOMException('Missing', 'NotFoundError');
    return { name, getFile: async () => new File([saved.get(name)!], name), createWritable: async () => ({ write: async (blob: Blob) => { saved.set(name, blob); }, close: async () => {} }) };
  },
};
const Harness = () => {
  const [file, setFile] = useState<File>();
  const [status, setStatus] = useState('Ready');
  const [paths, setPaths] = useState<string[]>([]);
  const run = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { setStatus(`FAIL: ${error instanceof Error ? error.stack : error}`); } };
  const fixture = async (rotated = false) => {
    const video = await makeFixture(rotated);
    const info = await inspectVideo(video);
    assert(info.timestamps.length === timestamps.length, `All frame timestamps must be indexed: ${JSON.stringify(info)}`);
    assert(info.timestamps.every((timestamp, index) => Math.abs(timestamp - timestamps[index]) < 0.001), 'VFR presentation timestamps must match');
    const frame = await readVideoFrame(video, 0.24);
    assert(frame.timestamp === 0.24, 'Exact frame at 0.24');
    assert(frame.canvas.width === (rotated ? 180 : 320) && frame.canvas.height === (rotated ? 320 : 180), 'Rotation and resolution');
    const png = await frame.canvas.convertToBlob({ type: 'image/png' });
    const bitmap = await createImageBitmap(png);
    assert(bitmap.width === frame.canvas.width && bitmap.height === frame.canvas.height, 'PNG dimensions'); bitmap.close();
    setFile(video); setStatus(`PASS: ${rotated ? 'MP4 rotation' : 'WebM'} decoding, VFR timestamps, exact frame and PNG dimensions`);
  };
  return <div className="flex h-screen flex-col bg-background text-foreground">
    <div className="flex flex-wrap gap-2 border-b p-2 text-xs">
      <button onClick={() => void run(() => fixture())}>Create VFR fixture</button>
      <button onClick={() => void run(() => fixture(true))}>Test rotated MP4</button>
      <button onClick={() => void run(async () => {
        setStatus('Encoding one-hour streaming fixture (3600 frames)…');
        const longVideo = await makeFixture(false, true);
        const reader = await openVideo(longVideo);
        let count = 0;
        let liveFrames = 0;
        let peakFrames = 0;
        try {
          assert(reader.end >= 3600, 'One-hour duration');
          for await (const sample of reader.sink.samples()) {
            liveFrames++; peakFrames = Math.max(peakFrames, liveFrames);
            try { count++; if (count % 100 === 0) setStatus(`Streaming one-hour video: ${count}/3600`); }
            finally { sample.close(); liveFrames--; }
          }
        } finally { reader.dispose(); }
        assert(count === 3600 && liveFrames === 0 && peakFrames === 1, 'Bounded frame lifetime');
        setStatus('PASS: one-hour video, 3600 frames decoded and closed sequentially; no retained full-resolution frame list');
      })}>Test one-hour streaming</button>
      <button onClick={() => void run(async () => {
        assert(file, 'Create a fixture first');
        setStatus('Downloading and checking real DINOv2…');
        await downloadVideoModel(undefined, (progress) => setStatus(`${progress.phase}: ${progress.completed}/${progress.total}`));
        const cpu = await loadVideoModel(undefined, undefined, 'wasm');
        const input = new Float32Array(3 * 224 * 224).fill(0.1);
        const cpuEmbedding = await cpu.infer(input); await cpu.dispose();
        assert(cpuEmbedding.length === 384, 'DINOv2 dimensions');
        let gpuResult = 'WebGPU unavailable';
        let gpu: Awaited<ReturnType<typeof loadVideoModel>> | undefined;
        try {
          gpu = await loadVideoModel(undefined, undefined, 'webgpu');
        } catch (error) { gpuResult = `WebGPU unavailable: ${String(error)}`; }
        if (gpu) {
          try { const gpuEmbedding = await gpu.infer(input); assert(frameDistance(cpuEmbedding, gpuEmbedding) < 0.001, 'GPU/CPU agreement'); gpuResult = 'WebGPU/WASM agreement'; }
          finally { await gpu.dispose(); }
        }
        setStatus(`WASM PASS; ${gpuResult}. Running Full…`);
        const abort = new AbortController();
        const options = { mode: 'full' as const, start: 0, end: 2.1, sampleRate: 2 };
        const result = await analyzeVideo(file!, options, { ...DEFAULT_FRAME_SELECTION, distance: 0 }, abort.signal, (progress) => setStatus(`${progress.phase}: ${progress.completed}/${progress.total}`));
        assert(result.count === timestamps.length, 'Full must infer every frame');
        let count = 0;
        for await (const batch of videoFrameBatches(result.run)) count += batch.length;
        assert(count === timestamps.length, 'Every frame cached');
        assert(result.run.includes(VIDEO_MODEL_KEY), 'Cache must include the model and preprocessing version');
        assert(analysisCacheKey('other', options) !== result.run, 'Cache isolated by video content');
        assert(await getVideoMeta(result.run), 'Completion is persisted');
        const cached = await analyzeVideo(file!, options, DEFAULT_FRAME_SELECTION, abort.signal, () => {});
        assert(cached.run === result.run, 'Cached analysis reused');
        const client = new VideoClient();
        const workerResult = await client.request({ type: 'analyze', file: file!, options: { ...options, mode: 'fast' }, selection: DEFAULT_FRAME_SELECTION });
        assert(workerResult.count! >= 3 && workerResult.count! <= timestamps.length, 'Fast scene candidates');
        client.cancel();
        setStatus(`PASS: real DINOv2 WASM, ${gpuResult}; Full (${count} frames), cache reuse, Fast worker (${workerResult.count} frames)`);
      })}>Run real model checks</button>
      <span>Saved files: {paths.join(', ') || 'none'}</span>
    </div>
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap p-2 text-xs" role="status">{status}</pre>
    <div className="relative min-h-0 flex-1 overflow-auto" data-dock-view="tool:video">
      <VideoFramesTool key={file?.name} tabId="test-video" file={file} fileName={file?.name} projectDirectoryHandle={directory} onSaved={() => setPaths([...saved.keys()])} />
    </div>
  </div>;
};
const root = createRoot(document.getElementById('root')!);
root.render(<Harness />);
import.meta.hot?.dispose(() => root.unmount());
