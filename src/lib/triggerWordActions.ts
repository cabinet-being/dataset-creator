import { runProjectFileOperation, flushProjectSave } from '../hooks/useProjectSave';
import { rewriteTriggerWord, type TriggerRewriteResult } from '../services/caption/captionMutationService';
import { useUIStore } from '../stores/useUIStore';

/**
 * The one way to change the dataset trigger word: every caption in dataset/ is rewritten in one undoable step,
 * then the project is saved. Not for per-keystroke use.
 */
export async function changeDatasetTriggerWord(value: string): Promise<TriggerRewriteResult> {
  const result = await rewriteTriggerWord({
    directory: useUIStore.getState().projectDirectoryHandle,
    newTrigger: value,
    runFileOperation: runProjectFileOperation,
  });
  await flushProjectSave();
  return result;
}
