import { openVideo, sampleCanvas } from './videoReader';
import { getVideoMeta, putVideoFrames, setVideoMeta, videoFingerprint, videoFrameBatches } from './videoCache';
import { loadVideoModel, VIDEO_MODEL_KEY } from './videoModel';
import { inspectFramePixels, isAnalysisCandidate } from './frameQuality';
import { selectVideoFrames, validateFrameSelection } from './frameSelection';
import { checkVideoAbort, frameTimestamp, type FrameRecord, type VideoAnalysisOptions, type VideoProgress, type FrameSelectionOptions } from './types';

export const analysisCacheKey = (fingerprint: string, options: VideoAnalysisOptions) =>
  JSON.stringify([VIDEO_MODEL_KEY, 'candidates-quality-v2', fingerprint, options.mode, options.start, options.end, options.mode === 'fast' ? options.sampleRate : null]);
export const analyzeVideo = async (file: Blob, options: VideoAnalysisOptions, selection: FrameSelectionOptions, signal: AbortSignal, progress: (progress: VideoProgress) => void) => {
  validateFrameSelection(selection);
  if (![options.start, options.end].every(Number.isFinite) || options.start < 0 || options.end <= options.start ||
    !['fast', 'full'].includes(options.mode) || (options.mode === 'fast' && (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0 || options.sampleRate > 60))) throw new Error('Invalid video range or sampling rate.');
  const fingerprint = await videoFingerprint(file, signal, (completed) => progress({ phase: 'Identifying video', completed, total: file.size }));
  const run = analysisCacheKey(fingerprint, options);
  let summary = await getVideoMeta<{ count: number; runtime: string }>(run);
  if (!summary) {
    const video = await openVideo(file, signal);
    let model: Awaited<ReturnType<typeof loadVideoModel>> | undefined;
    try {
      if (options.start < video.start || options.start >= video.end || options.end > video.end + 0.000001) throw new Error('Choose a fragment within the video duration.');
      model = await loadVideoModel(signal, progress);
      const cached = new Set<number>();
      for await (const batch of videoFrameBatches(run, signal)) for (const frame of batch) cached.add(frame.timestamp);
      const qualityCanvas = new OffscreenCanvas(64, 64);
      const context = qualityCanvas.getContext('2d', { willReadFrequently: true })!;
      let previous: Float32Array | undefined;
      let nextSample = options.start;
      let followup = Infinity;
      let frames: FrameRecord[] = [];
      let thumbnails: { run: string; timestamp: number; blob: Blob }[] = [];
      let count = 0;
      const started = performance.now();
      for await (const sample of video.sink.samples(options.start, Math.min(options.end, video.end))) {
        try {
          checkVideoAbort(signal);
          const timestamp = frameTimestamp(sample.timestamp);
          sample.draw(context, 0, 0, 64, 64);
          const inspected = inspectFramePixels(context.getImageData(0, 0, 64, 64).data, 64, 64, previous);
          previous = inspected.histogram;
          if (isAnalysisCandidate(options.mode, timestamp, nextSample, inspected.quality.transition, followup)) {
            if (!cached.has(timestamp)) {
              const embedding = await model.embed(sample);
              checkVideoAbort(signal);
              frames.push({ run, source: fingerprint, id: `${fingerprint}@${timestamp}`, timestamp, duration: sample.duration, quality: inspected.quality, embedding });
              thumbnails.push({ run, timestamp, blob: await sampleCanvas(sample, 128).convertToBlob({ type: 'image/jpeg', quality: 0.65 }) });
            }
            count++;
            if (timestamp >= nextSample) nextSample = timestamp + 1 / options.sampleRate;
            if (timestamp >= followup) followup = Infinity;
            if (inspected.quality.transition) followup = timestamp + 0.15;
          }
          if (frames.length >= 32) {
            await putVideoFrames(frames, thumbnails);
            frames = []; thumbnails = [];
          }
          const completed = Math.max(0, timestamp + sample.duration - options.start);
          const total = Math.min(options.end, video.end) - options.start;
          progress({ phase: `Analyzing (${model.runtime})`, completed, total, analyzed: count,
            secondsRemaining: completed > 0 ? (performance.now() - started) / 1000 * Math.max(0, total - completed) / completed : undefined });
        } finally { sample.close(); }
      }
      checkVideoAbort(signal);
      if (frames.length) await putVideoFrames(frames, thumbnails);
      summary = { count, runtime: model.runtime };
      await setVideoMeta(run, summary);
    } finally { video.dispose(); await model?.dispose(); }
  }
  const frames = await selectVideoFrames(() => videoFrameBatches(run, signal), selection, signal,
    (completed) => progress({ phase: 'Selecting diverse frames', completed, total: selection.limit }));
  return { run, frames, ...summary };
};

export const includeVideoFrame = async (file: Blob, run: string, timestamp: number, signal: AbortSignal) => {
  const fingerprint = await videoFingerprint(file, signal);
  const parts: unknown = JSON.parse(run);
  if (!Array.isArray(parts) || parts[0] !== VIDEO_MODEL_KEY || parts[2] !== fingerprint) throw new Error('This analysis belongs to another video or model. Run analysis again.');
  if (!Number.isFinite(timestamp) || timestamp < Number(parts[4]) || timestamp >= Number(parts[5])) throw new Error('Choose a replacement frame inside the analyzed range.');
  const video = await openVideo(file, signal);
  let model: Awaited<ReturnType<typeof loadVideoModel>> | undefined;
  try {
    const sample = await video.sink.getSample(timestamp + 0.0000005);
    if (!sample) throw new Error('The replacement frame cannot be decoded.');
    try {
      model = await loadVideoModel(signal);
      const canvas = new OffscreenCanvas(64, 64);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      sample.draw(context, 0, 0, 64, 64);
      const { quality } = inspectFramePixels(context.getImageData(0, 0, 64, 64).data, 64, 64);
      const actualTimestamp = frameTimestamp(sample.timestamp);
      const frame = { run, source: fingerprint, id: `${fingerprint}@${actualTimestamp}`, timestamp: actualTimestamp, duration: sample.duration, quality, embedding: await model.embed(sample) };
      checkVideoAbort(signal);
      await putVideoFrames([frame], [{ run, timestamp: frame.timestamp, blob: await sampleCanvas(sample, 128).convertToBlob({ type: 'image/jpeg', quality: 0.65 }) }]);
      return { source: frame.source, id: frame.id, timestamp: frame.timestamp, duration: frame.duration, quality };
    } finally { sample.close(); }
  } finally { video.dispose(); await model?.dispose(); }
};
