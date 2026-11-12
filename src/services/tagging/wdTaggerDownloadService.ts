import { useLocalTaggerStore, type WdTaggerDownloadState } from '../../stores/useLocalTaggerStore';
import { downloadVerifiedModelAsset } from '../models/verifiedModelDownload';
import { getLocalTaggerSavedFile, getLocalTaggerSavedFileNames, saveLocalTaggerFile } from './localTaggerFileSettings';
import { restoreSavedLocalTagger } from './localTaggerConnectionService';
import { WD_TAGGER_MODEL, type WdTaggerModelManifest } from './wdTaggerModelManifest';

export type WdTaggerDownloadOptions = { manifest?: WdTaggerModelManifest };

let flight: Promise<boolean> | undefined;
let controller: AbortController | undefined;

const setState = (state: WdTaggerDownloadState) => useLocalTaggerStore.getState().setModelDownload(state);

const describeError = (error: unknown): string => {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Not enough browser storage space to save the model. Free up disk space and try again.';
  return error instanceof Error ? error.message : 'Could not download the caption model.';
};

const isCached = async (manifest: WdTaggerModelManifest): Promise<boolean> => {
  const [model, tags] = await Promise.all([getLocalTaggerSavedFile('model'), getLocalTaggerSavedFile('tags')]);
  return !!model?.file && !!tags?.file
    && model.source === 'download' && tags.source === 'download'
    && model.sha256 === manifest.files.model.sha256 && tags.sha256 === manifest.files.tags.sha256;
};

const run = async (manifest: WdTaggerModelManifest, signal: AbortSignal): Promise<boolean> => {
  const total = manifest.totalBytes;
  try {
    if (!(await isCached(manifest))) {
      setState({ status: 'downloading', completed: 0, total });
      const received = { model: 0, tags: 0 };
      const report = () => setState({ status: 'downloading', completed: received.model + received.tags, total });
      const buffers = {} as Record<'model' | 'tags', ArrayBuffer>;
      for (const key of ['model', 'tags'] as const) {
        buffers[key] = await downloadVerifiedModelAsset(manifest.files[key], { signal, onBytes: (bytes) => { received[key] = bytes; report(); } });
      }
      signal.throwIfAborted();
      setState({ status: 'saving', completed: total, total });
      for (const key of ['tags', 'model'] as const) {
        const asset = manifest.files[key];
        await saveLocalTaggerFile(key, new File([buffers[key]], asset.label), { sha256: asset.sha256, source: 'download' });
      }
      useLocalTaggerStore.getState().setSavedFileNames(await getLocalTaggerSavedFileNames());
    }
    const connected = await restoreSavedLocalTagger(false, true);
    if (!connected) {
      setState({ status: 'error', completed: total, total, error: useLocalTaggerStore.getState().message || 'The downloaded model could not be connected.' });
      return false;
    }
    setState({ status: 'done', completed: total, total });
    return true;
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) setState({ status: 'cancelled', completed: 0, total });
    else setState({ status: 'error', completed: 0, total, error: describeError(error) });
    return false;
  }
};

/** Explicit user action only. Resolves true when the tagger is connected. A second call while running returns the same promise. */
export const downloadWdTaggerModel = (options: WdTaggerDownloadOptions = {}): Promise<boolean> => {
  if (flight) return flight;
  const active = new AbortController();
  controller = active;
  const current = run(options.manifest ?? WD_TAGGER_MODEL, active.signal).finally(() => {
    if (flight === current) { flight = undefined; controller = undefined; }
  });
  flight = current;
  return current;
};

export const cancelWdTaggerDownload = (): void => { controller?.abort(); };
