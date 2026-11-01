import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { filterTagPredictions, packImageChannels, parseSelectedTagCsv, type TagCategory } from './wdTagger';

export type LocalTaggerRuntime = 'webgpu' | 'wasm';

export type LocalTaggerPrediction = {
  tag: string;
  score: number;
};

export type LocalTaggerBundle = {
  name: string;
  session: InferenceSession;
  inputName: string;
  outputName: string;
  tags: string[];
  tagCategories: TagCategory[];
  inputChannelOrder: 'rgb' | 'bgr';
  inputWidth: number;
  inputHeight: number;
  layout: 'nhwc' | 'nchw';
  runtime: LocalTaggerRuntime;
};

export type LocalTaggerProgress = (message: string) => void;

type DirectoryBundleSource = {
  kind: 'directory';
  name: string;
  handle: FileSystemDirectoryHandle;
};

type FileBundleSource = {
  kind: 'files';
  name: string;
  files: File[];
};

type ExplicitFileBundleSource = {
  kind: 'explicit-files';
  name: string;
  modelFile: File;
  tagsFile: File;
};

export type LocalTaggerBundleSource = DirectoryBundleSource | FileBundleSource | ExplicitFileBundleSource;

type OrtModule = typeof import('onnxruntime-web/all');

const REQUIRED_MODEL_FILE = 'model.onnx';
const REQUIRED_TAGS_FILE = 'selected_tags.csv';
const DEFAULT_INPUT_SIZE = 448;
const ORT_WASM_URL = new URL(
  '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  import.meta.url
).href;

export const parseSelectedTagsCsv = (csv: string): string[] => parseSelectedTagCsv(csv).rows.map((tag) => tag.name);

const getFileFromDirectory = async (
  handle: FileSystemDirectoryHandle,
  fileName: string
): Promise<File | undefined> => {
  try {
    const fileHandle = await handle.getFileHandle(fileName);
    return await fileHandle.getFile();
  } catch {
    return undefined;
  }
};

const getFileFromSelection = (files: File[], fileName: string): File | undefined =>
  files.find((file) => {
    const relativePath = file.webkitRelativePath || file.name;
    const pathParts = relativePath.split('/').filter(Boolean);
    return pathParts[pathParts.length - 1] === fileName;
  });

const readBundleFiles = async (
  source: LocalTaggerBundleSource
): Promise<{ modelFile: File; tagsFile: File }> => {
  if (source.kind === 'explicit-files') {
    return { modelFile: source.modelFile, tagsFile: source.tagsFile };
  }

  const modelFile =
    source.kind === 'directory'
      ? await getFileFromDirectory(source.handle, REQUIRED_MODEL_FILE)
      : getFileFromSelection(source.files, REQUIRED_MODEL_FILE);
  const tagsFile =
    source.kind === 'directory'
      ? await getFileFromDirectory(source.handle, REQUIRED_TAGS_FILE)
      : getFileFromSelection(source.files, REQUIRED_TAGS_FILE);

  const missing = [
    modelFile ? undefined : REQUIRED_MODEL_FILE,
    tagsFile ? undefined : REQUIRED_TAGS_FILE,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required file(s): ${missing.join(', ')}.`);
  }

  return { modelFile: modelFile!, tagsFile: tagsFile! };
};

const inferInputSpec = (session: InferenceSession) => {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const metadata = session.inputMetadata.find((entry) => entry.name === inputName);
  const dims = metadata?.isTensor ? metadata.shape : [];
  const numericDims = dims.map((dimension) => (typeof dimension === 'number' ? dimension : undefined));
  const secondDim = numericDims[1];
  const layout: 'nhwc' | 'nchw' = secondDim === 3 ? 'nchw' : 'nhwc';
  const height = layout === 'nchw' ? numericDims[2] : numericDims[1];
  const width = layout === 'nchw' ? numericDims[3] : numericDims[2];

  if (!inputName || !outputName) {
    throw new Error('The ONNX model does not expose a usable input and output.');
  }

  return {
    inputName,
    outputName,
    inputWidth: width && width > 0 ? width : DEFAULT_INPUT_SIZE,
    inputHeight: height && height > 0 ? height : DEFAULT_INPUT_SIZE,
    layout,
  };
};

const validateOutputTagCount = (session: InferenceSession, outputName: string, tagCount: number) => {
  const metadata = session.outputMetadata.find((entry) => entry.name === outputName);
  const shape = metadata?.isTensor ? metadata.shape : [];
  const outputCount = [...shape].reverse().find((dimension) => typeof dimension === 'number' && dimension > 1);

  if (typeof outputCount === 'number' && outputCount !== tagCount) {
    throw new Error(
      `selected_tags.csv contains ${tagCount} tags, but the model output expects ${outputCount}.`
    );
  }
};

const createSession = async (
  ort: OrtModule,
  modelBuffer: ArrayBuffer,
  onProgress?: LocalTaggerProgress
): Promise<{ session: InferenceSession; runtime: LocalTaggerRuntime }> => {
  const webGpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

  if (!globalThis.crossOriginIsolated) {
    ort.env.wasm.numThreads = 1;
  }
  ort.env.wasm.wasmPaths = { wasm: ORT_WASM_URL };

  if (webGpuAvailable) {
    try {
      onProgress?.('Loading ONNX model with WebGPU acceleration...');
      const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['webgpu'],
      });
      return { session, runtime: 'webgpu' };
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[tagging] WebGPU model load failed, falling back to WASM', error);
      }
    }
  }

  onProgress?.('Loading ONNX model with WASM runtime...');
  const session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ['wasm'],
  });
  return { session, runtime: 'wasm' };
};

export const connectLocalTaggerBundle = async (
  source: LocalTaggerBundleSource,
  onProgress?: LocalTaggerProgress
): Promise<LocalTaggerBundle> => {
  onProgress?.('Validating model folder...');
  const { modelFile, tagsFile } = await readBundleFiles(source);

  onProgress?.('Reading selected_tags.csv...');
  const parsedTags = parseSelectedTagCsv(await tagsFile.text());
  const tagRows = parsedTags.rows;
  const tags = tagRows.map((tag) => tag.name);

  onProgress?.('Loading browser ONNX runtime...');
  const ort = await import('onnxruntime-web/all');

  const { session, runtime } = await createSession(ort, await modelFile.arrayBuffer(), onProgress);

  try {
    const inputSpec = inferInputSpec(session);
    validateOutputTagCount(session, inputSpec.outputName, tags.length);

    if (tags.length === 0) {
      throw new Error('selected_tags.csv did not contain any usable tags.');
    }

    return {
      name: source.name || 'Local model',
      session,
      tags,
      tagCategories: tagRows.map((tag) => tag.category),
      inputChannelOrder: parsedTags.hasCategories ? 'bgr' : 'rgb',
      runtime,
      ...inputSpec,
    };
  } catch (error) {
    await session.release();
    throw error;
  }
};

const loadImageBitmap = async (blob: Blob): Promise<ImageBitmap> => {
  try {
    return await createImageBitmap(blob, { colorSpaceConversion: 'default' });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('Failed to decode image for tagging.'));
        element.src = url;
      });
      return await createImageBitmap(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

const preprocessImage = async (image: Blob, bundle: LocalTaggerBundle): Promise<Tensor> => {
  const ort = await import('onnxruntime-web/all');
  const bitmap = await loadImageBitmap(image);
  const canvas = document.createElement('canvas');
  canvas.width = bundle.inputWidth;
  canvas.height = bundle.inputHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('Browser canvas is unavailable for image preprocessing.');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
  const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
  const offsetX = Math.round((canvas.width - targetWidth) / 2);
  const offsetY = Math.round((canvas.height - targetHeight) / 2);

  context.drawImage(bitmap, offsetX, offsetY, targetWidth, targetHeight);
  bitmap.close();

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const channelSize = canvas.width * canvas.height;
  const data = packImageChannels(pixels, channelSize, bundle.layout, bundle.inputChannelOrder ?? 'rgb');

  const dims =
    bundle.layout === 'nhwc'
      ? [1, canvas.height, canvas.width, 3]
      : [1, 3, canvas.height, canvas.width];

  return new ort.Tensor('float32', data, dims);
};

export const predictLocalTags = async (
  bundle: LocalTaggerBundle,
  image: Blob,
  threshold: number,
  maxTags: number,
  options: { characterThreshold?: number; includeRatings?: boolean } = {}
): Promise<LocalTaggerPrediction[]> => {
  const inputTensor = await preprocessImage(image, bundle);
  const results = await bundle.session.run({ [bundle.inputName]: inputTensor });
  const output = results[bundle.outputName];

  if (!output) {
    throw new Error('The ONNX model did not return the expected output tensor.');
  }

  const scores = Array.from(output.data as Float32Array | number[]);
  if (scores.length !== bundle.tags.length) {
    throw new Error(`The ONNX model returned ${scores.length} scores for ${bundle.tags.length} selected tags.`);
  }
  const predictions = scores.map((score, index) => ({ tag: bundle.tags[index], score }));
  return filterTagPredictions(predictions, bundle.tagCategories ?? [], threshold, maxTags, options);
};
