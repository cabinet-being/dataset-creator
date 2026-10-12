import { BlobSource, EncodedPacketSink, Input, MP4, WEBM, VideoSampleSink, type VideoSample } from 'mediabunny';
import { checkVideoAbort, frameTimestamp, type VideoInfo } from './types';

export const openVideo = async (file: Blob, signal?: AbortSignal) => {
  if (typeof VideoDecoder === 'undefined') throw new Error('This browser does not support WebCodecs video decoding. Use a recent Chromium browser.');
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM] });
  const cancel = () => input.dispose();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    checkVideoAbort(signal);
    const track = await input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error('The video codec cannot be decoded in this browser. Try an MP4 (H.264) or WebM (VP8/VP9) file.');
    const sink = new VideoSampleSink(track);
    const start = Math.max(0, await track.getFirstTimestamp());
    const lastPacket = await new EncodedPacketSink(track).getPacket(Infinity, { metadataOnly: true });
    const end = Math.max(await track.computeDuration(), await input.getDurationFromMetadata() ?? 0,
      lastPacket ? lastPacket.timestamp + Math.max(lastPacket.duration, 0.000001) : 0);
    if (!Number.isFinite(end) || end <= start) throw new Error('The video has no readable frames.');
    return {
      sink, track, start, end,
      dispose: () => { signal?.removeEventListener('abort', cancel); input.dispose(); },
    };
  } catch (error) {
    signal?.removeEventListener('abort', cancel);
    input.dispose();
    throw error;
  }
};

export const inspectVideo = async (file: Blob, signal?: AbortSignal): Promise<VideoInfo> => {
  const video = await openVideo(file, signal);
  try {
    const timestamps = new Set<number>();
    for await (const packet of new EncodedPacketSink(video.track).packets(undefined, undefined, { metadataOnly: true })) {
      checkVideoAbort(signal);
      if (packet.timestamp >= video.start && packet.timestamp < video.end) timestamps.add(frameTimestamp(packet.timestamp));
    }
    if (!timestamps.size) throw new Error('The video contains no displayable frames.');
    return { width: await video.track.getDisplayWidth(), height: await video.track.getDisplayHeight(),
      start: video.start, end: video.end, timestamps: [...timestamps].sort((first, second) => first - second) };
  } finally { video.dispose(); }
};

export const findFrameIndex = (timestamps: number[], timestamp: number): number => {
  let lower = 0;
  let upper = timestamps.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (timestamps[middle] <= timestamp + 0.0000005) lower = middle + 1;
    else upper = middle;
  }
  return Math.max(0, lower - 1);
};

export const sampleCanvas = (sample: VideoSample, maximumWidth?: number): OffscreenCanvas => {
  const scale = maximumWidth ? Math.min(1, maximumWidth / Math.max(sample.displayWidth, sample.displayHeight)) : 1;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(sample.displayWidth * scale)), Math.max(1, Math.round(sample.displayHeight * scale)));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot create a video frame canvas.');
  sample.draw(context, 0, 0, canvas.width, canvas.height);
  return canvas;
};

export const readVideoFrame = async (file: Blob, timestamp: number, signal?: AbortSignal) => {
  const video = await openVideo(file, signal);
  try {
    const sample = await video.sink.getSample(timestamp + 0.0000005);
    if (!sample) throw new Error('No video frame at this timestamp.');
    try {
      checkVideoAbort(signal);
      const canvas = sampleCanvas(sample);
      return { canvas, timestamp: frameTimestamp(sample.timestamp), duration: sample.duration };
    } finally { sample.close(); }
  } finally { video.dispose(); }
};
