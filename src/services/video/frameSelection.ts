import { checkVideoAbort, type FrameRecord, type FrameReference, type FrameSelectionOptions } from './types';

export const normalizeFrameEmbedding = (values: ArrayLike<number>): Float32Array => {
  const result = Float32Array.from(values);
  let squared = 0;
  for (const value of result) {
    if (!Number.isFinite(value)) throw new Error('The video model returned invalid features.');
    squared += value * value;
  }
  if (!squared) throw new Error('The video model returned empty features.');
  const norm = Math.sqrt(squared);
  return result.map((value) => value / norm);
};
export const frameDistance = (first: Float32Array, second: Float32Array) => {
  if (first.length !== second.length) throw new Error('Incompatible video feature vectors.');
  let dot = 0;
  for (let index = 0; index < first.length; index++) dot += first[index] * second[index];
  return Math.max(0, Math.min(2, 1 - dot));
};
export const validateFrameSelection = (options: FrameSelectionOptions) => {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw new Error('Choose between 1 and 1000 frames.');
  if (!Number.isFinite(options.distance) || options.distance < 0 || options.distance > 2) throw new Error('Minimum distance must be between 0 and 2.');
  const pinned = new Set(options.pinned);
  const excluded = new Set(options.excluded);
  if (pinned.size > options.limit) throw new Error('The frame limit is smaller than the number of pinned frames.');
  if ([...pinned].some((timestamp) => excluded.has(timestamp))) throw new Error('A frame cannot be both pinned and excluded.');
};
export const selectVideoFrames = async (
  batches: () => AsyncIterable<FrameRecord[]>, options: FrameSelectionOptions,
  signal?: AbortSignal, progress?: (selected: number) => void,
): Promise<FrameReference[]> => {
  validateFrameSelection(options);
  const pinned = new Set(options.pinned);
  const excluded = new Set(options.excluded);
  const eligible = (frame: FrameRecord) => !excluded.has(frame.timestamp) && (pinned.has(frame.timestamp) ||
    !(options.excludeDark && frame.quality.dark || options.excludeBlurry && frame.quality.blurry || options.excludeTransitions && frame.quality.transition));
  const chosen: FrameRecord[] = [];
  let mean: Float32Array | undefined;
  let count = 0;
  for await (const batch of batches()) {
    checkVideoAbort(signal);
    for (const frame of batch) {
      if (!eligible(frame)) continue;
      mean ??= new Float32Array(frame.embedding.length);
      if (mean.length !== frame.embedding.length) throw new Error('Incompatible cached video features.');
      for (let index = 0; index < mean.length; index++) mean[index] += frame.embedding[index];
      if (pinned.has(frame.timestamp)) chosen.push(frame);
      count++;
    }
  }
  if (chosen.length !== pinned.size) throw new Error('Some pinned frames are missing from the analysis. Analyze the frame before pinning it.');
  if (!count || !mean) return [];
  if (!chosen.length) {
    const center = mean.some((value) => value !== 0) ? normalizeFrameEmbedding(mean) : mean;
    let representative: FrameRecord | undefined;
    let bestDistance = Infinity;
    for await (const batch of batches()) {
      checkVideoAbort(signal);
      for (const frame of batch) {
        if (!eligible(frame)) continue;
        const distance = frameDistance(frame.embedding, center);
        if (distance < bestDistance || (distance === bestDistance && frame.quality.sharpness > (representative?.quality.sharpness ?? -1))) {
          representative = frame;
          bestDistance = distance;
        }
      }
    }
    if (representative) chosen.push(representative);
  }
  const nearest = new Map<number, number>();
  const selected = new Set(chosen.map((frame) => frame.timestamp));
  let anchors = chosen.slice();
  while (chosen.length < Math.min(options.limit, count)) {
    checkVideoAbort(signal);
    let furthest: FrameRecord | undefined;
    let bestDistance = -1;
    for await (const batch of batches()) {
      checkVideoAbort(signal);
      for (const frame of batch) {
        if (!eligible(frame) || selected.has(frame.timestamp)) continue;
        let distance = nearest.get(frame.timestamp) ?? Infinity;
        for (const anchor of anchors) distance = Math.min(distance, frameDistance(frame.embedding, anchor.embedding));
        nearest.set(frame.timestamp, distance);
        if (distance > bestDistance || (distance === bestDistance && frame.quality.sharpness > (furthest?.quality.sharpness ?? -1))) {
          furthest = frame;
          bestDistance = distance;
        }
      }
    }
    if (!furthest || bestDistance < options.distance) break;
    chosen.push(furthest);
    selected.add(furthest.timestamp);
    anchors = [furthest];
    progress?.(chosen.length);
  }
  return chosen.sort((first, second) => first.timestamp - second.timestamp)
    .map(({ source, id, timestamp, duration, quality }) => ({ source, id, timestamp, duration, quality }));
};
