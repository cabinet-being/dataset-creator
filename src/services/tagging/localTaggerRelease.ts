import type { LocalTaggerBundle } from './localTaggerService';
import { releaseTaggerWorker } from './taggerWorkerClient';

/** Releases the main-thread session (if any) and the tagger worker that holds this bundle's model. */
export const releaseLocalTaggerBundle = async (bundle: LocalTaggerBundle): Promise<void> => {
  releaseTaggerWorker(bundle);
  await bundle.session?.release();
};
