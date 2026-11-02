import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { connectLocalTaggerBundle, type LocalTaggerBundleSource } from './localTaggerService';
import {
  getLocalTaggerSavedFileNames,
  readLocalTaggerSavedFile,
  saveLocalTaggerFile,
  type LocalTaggerFileKey,
  type LocalTaggerSavedFile,
} from './localTaggerFileSettings';

let generation = 0;
let restoreFlight: Promise<boolean> | undefined;
let restoreFlightGeneration = -1;
let restoreFlightRequestsPermission = false;
let restoredOnThisPage = false;

const messageFrom = (error: unknown) => error instanceof Error ? error.message : 'Could not connect the model.';

const connectSource = async (source: LocalTaggerBundleSource, current: number): Promise<boolean> => {
  const state = useLocalTaggerStore.getState();
  state.setBundle(null);
  state.setStatus('loading');
  state.setProgress('Starting model connection...');
  state.setMessage('Validating local caption model...');
  try {
    const bundle = await connectLocalTaggerBundle(source, (progress) => {
      if (current === generation) useLocalTaggerStore.getState().setProgress(progress);
    });
    if (current !== generation) {
      await bundle.session.release();
      return false;
    }
    const latest = useLocalTaggerStore.getState();
    latest.setBundle(bundle);
    latest.setStatus('ready');
    latest.setProgress('');
    latest.setMessage(`Ready. Loaded ${bundle.tags.length.toLocaleString()} tags from ${bundle.name}.`);
    return true;
  } catch (error) {
    if (current === generation) {
      const latest = useLocalTaggerStore.getState();
      latest.setBundle(null);
      latest.setStatus('not-ready');
      latest.setProgress('');
      latest.setMessage(messageFrom(error));
    }
    return false;
  }
};

export const connectLocalTaggerSource = (source: LocalTaggerBundleSource): Promise<boolean> => {
  generation += 1;
  restoredOnThisPage = true;
  return connectSource(source, generation);
};

export const restoreSavedLocalTagger = (requestPermission = false, force = false): Promise<boolean> => {
  if (restoreFlight && restoreFlightGeneration === generation && (!requestPermission || restoreFlightRequestsPermission)) return restoreFlight;
  if (!requestPermission && !force && restoredOnThisPage) return Promise.resolve(false);
  const current = ++generation;
  if (!requestPermission) restoredOnThisPage = true;
  const flight = (async () => {
    try {
      const names = await getLocalTaggerSavedFileNames();
      if (current !== generation) return false;
      useLocalTaggerStore.getState().setSavedFileNames(names);
      if (!names.model || !names.tags) {
        if (requestPermission) useLocalTaggerStore.getState().setMessage('Select model.onnx and selected_tags.csv in Settings first.');
        return false;
      }
      useLocalTaggerStore.getState().setBundle(null);
      useLocalTaggerStore.getState().setStatus('loading');
      useLocalTaggerStore.getState().setMessage('Reading saved caption model files...');
      const [modelFile, tagsFile] = await Promise.all([
        readLocalTaggerSavedFile('model', requestPermission),
        readLocalTaggerSavedFile('tags', requestPermission),
      ]);
      if (current !== generation) return false;
      if (!modelFile || !tagsFile) throw new Error('Saved caption model files are unavailable. Choose them again in Settings.');
      return connectSource({ kind: 'explicit-files', name: names.model, modelFile, tagsFile }, current);
    } catch (error) {
      if (current === generation) {
        useLocalTaggerStore.getState().setStatus('not-ready');
        useLocalTaggerStore.getState().setProgress('');
        useLocalTaggerStore.getState().setMessage(messageFrom(error));
      }
      return false;
    }
  })();
  restoreFlight = flight;
  restoreFlightGeneration = current;
  restoreFlightRequestsPermission = requestPermission;
  void flight.then(() => { if (restoreFlight === flight) restoreFlight = undefined; });
  return flight;
};

export const saveAndConnectLocalTaggerFile = async (key: LocalTaggerFileKey, resource: LocalTaggerSavedFile): Promise<boolean> => {
  const current = ++generation;
  restoredOnThisPage = true;
  try {
    await saveLocalTaggerFile(key, resource);
    if (current !== generation) return false;
    useLocalTaggerStore.getState().setBundle(null);
    useLocalTaggerStore.getState().setStatus('loading');
    useLocalTaggerStore.getState().setMessage('Saved file. Connecting caption model...');
    const names = await getLocalTaggerSavedFileNames();
    if (current !== generation) return false;
    useLocalTaggerStore.getState().setSavedFileNames(names);
    if (names.model && names.tags) {
      await restoreSavedLocalTagger(false, true);
      return true;
    }
    useLocalTaggerStore.getState().setBundle(null);
    useLocalTaggerStore.getState().setStatus('not-connected');
    useLocalTaggerStore.getState().setMessage('Select the other caption model file to connect.');
    return true;
  } catch (error) {
    if (current === generation) {
      useLocalTaggerStore.getState().setStatus('not-ready');
      useLocalTaggerStore.getState().setMessage(`Could not save ${resource.name}: ${messageFrom(error)}`);
    }
    return false;
  }
};

export const disconnectLocalTaggerConnection = (): void => {
  generation += 1;
  restoredOnThisPage = true;
  useLocalTaggerStore.getState().disconnect();
};
