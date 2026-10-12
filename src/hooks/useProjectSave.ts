import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';
import { writeProjectDirectoryChanges } from '../services/project/projectDirectoryService';
import { createSaveSession } from '../services/project/saveSession';
import { createOperationLogger } from '../services/logging/applicationLog';

const noSave = async () => {};
let flush: () => Promise<void> = noSave;
type FileOperation = <T>(action: () => Promise<T>) => Promise<T>;
const unavailableFileOperation: FileOperation = async () => { throw new Error('Project saving is not ready. Try again.'); };
let fileOperation: FileOperation = unavailableFileOperation;
export const flushProjectSave = () => flush();
export const runProjectFileOperation: FileOperation = action => fileOperation(action);
export function useProjectSave() {
  const [status, setStatus] = useState<'local' | 'saved' | 'pending' | 'saving' | 'error'>('local');
  const [error, setError] = useState('');
  const retry = useRef<() => Promise<void>>(noSave);
  useEffect(() => {
    const session = createSaveSession({
      getProject: useProjectStore.getState,
      subscribeProject: useProjectStore.subscribe,
      getDirectory: () => useUIStore.getState().projectDirectoryHandle,
      subscribeDirectory: listener => useUIStore.subscribe((state, previous) => {
        if (state.projectDirectoryHandle !== previous.projectDirectoryHandle) listener(state.projectDirectoryHandle);
      }),
      write: writeProjectDirectoryChanges,
      changed: state => {
        setStatus(state.status);
        if (state.status === 'error') {
          const message = state.error instanceof Error ? state.error.message : 'Unable to save project';
          setError(message); createOperationLogger('Project').error(message);
        } else if (state.status === 'saved' || state.status === 'local') setError('');
      },
    });
    const save = session.flush;
    const mutate: FileOperation = session.runExclusive;
    fileOperation = mutate;
    retry.current = save; flush = save;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (session.isDirty()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      session.dispose();
      window.removeEventListener('beforeunload', beforeUnload);
      if (flush === save) flush = noSave;
      if (fileOperation === mutate) fileOperation = unavailableFileOperation;
      if (retry.current === save) retry.current = noSave;
    };
  }, []);
  return { status, error, retry: () => retry.current() };
}
