import type { FrameQuality } from './types';

export const inspectFramePixels = (pixels: Uint8ClampedArray, width: number, height: number, previous?: Float32Array) => {
  const histogram = new Float32Array(48);
  const luminance = new Float32Array(width * height);
  let darkPixels = 0;
  for (let index = 0; index < luminance.length; index++) {
    luminance[index] = (pixels[index * 4] * 0.2126 + pixels[index * 4 + 1] * 0.7152 + pixels[index * 4 + 2] * 0.0722) / 255;
    if (luminance[index] < 0.03) darkPixels++;
    for (let channel = 0; channel < 3; channel++) histogram[channel * 16 + Math.floor(pixels[index * 4 + channel] / 16)] += 1 / (luminance.length * 3);
  }
  let sharpness = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let column = 1; column < width - 1; column++) {
      const index = row * width + column;
      const laplacian = 4 * luminance[index] - luminance[index - 1] - luminance[index + 1] - luminance[index - width] - luminance[index + width];
      sharpness += laplacian * laplacian;
    }
  }
  sharpness /= Math.max(1, (width - 2) * (height - 2));
  let difference = 0;
  if (previous) for (let index = 0; index < histogram.length; index++) difference += Math.abs(histogram[index] - previous[index]) / 2;
  const quality: FrameQuality = { sharpness, dark: darkPixels / luminance.length > 0.98, blurry: sharpness < 0.001, transition: Boolean(previous) && difference > 0.35 };
  return { histogram, quality };
};
export const isAnalysisCandidate = (mode: 'fast' | 'full', timestamp: number, nextSample: number, transition: boolean, followup: number) =>
  mode === 'full' || timestamp >= nextSample || transition || timestamp >= followup;
