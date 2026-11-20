import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { isTaggerWorkerSupported, scoreImageInTaggerWorker, validateModelInTaggerWorker } from './taggerWorkerClient';
import { filterTagPredictions, packImageChannels, parseSelectedTagCsv, type TagCategory } from './wdTagger';

export type LocalTaggerRuntime = 'webgpu' | 'wasm';

export type LocalTaggerPrediction = {
  tag: string;
  score: number;
};

export type LocalTaggerBundle = {
  name: string;
  /** Main-thread session; absent when inference runs in the tagger worker (the model is loaded there from `modelFile`). */
  session?: InferenceSession;
  modelFile: File;
  inputName: string;
  outputName: string;
  tags: string[];
  tagCategories: TagCategory[];
  inputChannelOrder: 'rgb' | 'bgr';
  inputWidth: number;
  inputHeight: number;
  layout: 'nhwc' | 'nchw';
  /** Runtime actually used by the tagger worker; updated if the worker falls back from WebGPU. */
  runtime: LocalTaggerRuntime;
  /** Identity of the tagger worker that owns this bundle's model (the bundle object itself is not used as owner). */
  workerKey: object;
};

/** Structured-cloneable description of a loaded ONNX model, so validation does not need an ORT session on the calling thread. */
export type TaggerModelInfo = {
  inputNames: string[];
  outputNames: string[];
  inputShapes: Record<string, (number | string)[]>;
  outputShapes: Record<string, (number | string)[]>;
  runtime: LocalTaggerRuntime;
};

export type TaggerInputSpec = Pick<LocalTaggerBundle, 'inputName' | 'outputName' | 'inputWidth' | 'inputHeight' | 'layout' | 'inputChannelOrder'>;

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

export const describeSession = (session: InferenceSession, runtime: LocalTaggerRuntime): TaggerModelInfo => {
  const shapes = (entries: InferenceSession['inputMetadata']): Record<string, (number | string)[]> => Object.fromEntries(
    entries.flatMap((entry) => (entry.isTensor ? [[entry.name, [...entry.shape] as (number | string)[]] as const] : []))
  );
  return {
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
    inputShapes: shapes(session.inputMetadata),
    outputShapes: shapes(session.outputMetadata),
    runtime,
  };
};

export const inferInputSpec = (info: TaggerModelInfo) => {
  const inputName = info.inputNames[0];
  const outputName = info.outputNames[0];
  const dims = (inputName ? info.inputShapes[inputName] : undefined) ?? [];
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

export const validateOutputTagCount = (info: TaggerModelInfo, outputName: string, tagCount: number) => {
  const shape = info.outputShapes[outputName] ?? [];
  const outputCount = [...shape].reverse().find((dimension) => typeof dimension === 'number' && dimension > 1);

  if (typeof outputCount === 'number' && outputCount !== tagCount) {
    throw new Error(
      `selected_tags.csv contains ${tagCount} tags, but the model output expects ${outputCount}.`
    );
  }
};

/** Thrown by createSession (with `failOnWebGpuError`) so the worker can report a WebGPU-specific failure. */
export class WebGpuSessionError extends Error {}

export type CreateSessionOptions = {
  disableWebGpu?: boolean;
  /** Throw WebGpuSessionError instead of falling back to WASM in the same heap. */
  failOnWebGpuError?: boolean;
};

const hasWebGpuAdapter = async (): Promise<boolean> => {
  try {
    const gpu = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    return Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
};

export const createSession = async (
  ort: OrtModule,
  modelBuffer: ArrayBuffer,
  onProgress?: LocalTaggerProgress,
  options: CreateSessionOptions = {}
): Promise<{ session: InferenceSession; runtime: LocalTaggerRuntime }> => {
  const webGpuAvailable = !options.disableWebGpu && await hasWebGpuAdapter();

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
      if (options.failOnWebGpuError) throw new WebGpuSessionError(error instanceof Error ? error.message : String(error));
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

export type ConnectLocalTaggerOptions = {
  /** Keep the tagger worker (and its model) alive after validation. Startup restore passes false so the memory is returned. */
  keepWorkerWarm?: boolean;
};

export const connectLocalTaggerBundle = async (
  source: LocalTaggerBundleSource,
  onProgress?: LocalTaggerProgress,
  options: ConnectLocalTaggerOptions = {}
): Promise<LocalTaggerBundle> => {
  onProgress?.('Validating model folder...');
  const { modelFile, tagsFile } = await readBundleFiles(source);

  onProgress?.('Reading selected_tags.csv...');
  const parsedTags = parseSelectedTagCsv(await tagsFile.text());
  const tagRows = parsedTags.rows;
  const tags = tagRows.map((tag) => tag.name);
  if (tags.length === 0) {
    throw new Error('selected_tags.csv did not contain any usable tags.');
  }
  const common = {
    name: source.name || 'Local model',
    modelFile,
    tags,
    tagCategories: tagRows.map((tag) => tag.category),
    inputChannelOrder: parsedTags.hasCategories ? 'bgr' as const : 'rgb' as const,
    workerKey: {},
  };

  if (isTaggerWorkerSupported()) {
    // The model is loaded and checked inside the worker; ORT is never instantiated on the main thread.
    onProgress?.('Loading ONNX model in a background worker...');
    let inputSpec: ReturnType<typeof inferInputSpec> | undefined;
    const info = await validateModelInTaggerWorker(common.workerKey, modelFile, (modelInfo) => {
      inputSpec = inferInputSpec(modelInfo);
      validateOutputTagCount(modelInfo, inputSpec.outputName, tags.length);
    }, options.keepWorkerWarm ?? true);
    return { ...common, runtime: info.runtime, ...inputSpec! };
  }

  onProgress?.('Loading browser ONNX runtime...');
  const ort = await import('onnxruntime-web/all');

  const { session, runtime } = await createSession(ort, await modelFile.arrayBuffer(), onProgress);

  try {
    const inputSpec = inferInputSpec(describeSession(session, runtime));
    validateOutputTagCount(describeSession(session, runtime), inputSpec.outputName, tags.length);
    return { ...common, session, runtime, ...inputSpec };
  } catch (error) {
    await session.release();
    throw error;
  }
};

const loadImageBitmap = async (blob: Blob): Promise<ImageBitmap> => {
  try {
    return await createImageBitmap(blob, { colorSpaceConversion: 'default' });
  } catch (error) {
    if (typeof Image === 'undefined') throw error; // worker: no <img> fallback
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

const preprocessImage = async (image: Blob, bundle: TaggerInputSpec): Promise<Tensor> => {
  const ort = await import('onnxruntime-web/all');
  const bitmap = await loadImageBitmap(image);
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(bundle.inputWidth, bundle.inputHeight) : document.createElement('canvas');
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

/** Runs the tagger on one image and returns the raw per-tag scores. Used on the main thread and inside the tagger worker. */
export const scoreImageWithSession = async (session: InferenceSession, spec: TaggerInputSpec, image: Blob): Promise<Float32Array> => {
  const inputTensor = await preprocessImage(image, spec);
  const results = await session.run({ [spec.inputName]: inputTensor });
  const output = results[spec.outputName];
  if (!output) throw new Error('The ONNX model did not return the expected output tensor.');
  return Float32Array.from(output.data as Float32Array | number[]);
};

export const predictLocalTags = async (
  bundle: LocalTaggerBundle,
  image: Blob,
  threshold: number,
  maxTags: number,
  options: { characterThreshold?: number; includeRatings?: boolean } = {}
): Promise<LocalTaggerPrediction[]> => {
  const scores = bundle.session
    ? await scoreImageWithSession(bundle.session, bundle, image)
    : await scoreImageInTaggerWorker(bundle, image);
  if (scores.length !== bundle.tags.length) {
    throw new Error(`The ONNX model returned ${scores.length} scores for ${bundle.tags.length} selected tags.`);
  }
  const predictions = Array.from(scores, (score, index) => ({ tag: bundle.tags[index], score }));
  return filterTagPredictions(predictions, bundle.tagCategories ?? [], threshold, maxTags, options);
};
