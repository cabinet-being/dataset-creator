import { useRef, type ChangeEvent, type ReactNode } from 'react';
import { useUIStore } from '../stores/useUIStore';
import { useLocalTaggerStore } from '../stores/useLocalTaggerStore';
import { type LocalTaggerFileKey } from '../services/tagging/localTaggerFileSettings';
import { saveAndConnectLocalTaggerFile } from '../services/tagging/localTaggerConnectionService';

type FilePickerWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      excludeAcceptAllOption?: boolean;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle[]>;
  };

export function useLocalTaggerFilePicker(): { pickLocalTaggerFile: (key: LocalTaggerFileKey) => Promise<void>; inputs: ReactNode } {
  const addNotification = useUIStore(state => state.addNotification);
  const taggerModelInputRef = useRef<HTMLInputElement | null>(null);
  const taggerTagsInputRef = useRef<HTMLInputElement | null>(null);

  const updateLocalTaggerFileSetting = async (key: LocalTaggerFileKey, resource: FileSystemFileHandle | File) => {
    const fileName = resource.name.toLowerCase();
    const isValidFile = key === 'model' ? fileName.endsWith('.onnx') : fileName.endsWith('.csv');
    if (!isValidFile) {
      addNotification('error', `Select ${key === 'model' ? 'an ONNX model file' : 'a CSV tags file'}.`);
      return;
    }
    const saved = await saveAndConnectLocalTaggerFile(key, resource);
    if (!saved) {
      addNotification('error', useLocalTaggerStore.getState().message);
      return;
    }
  };

  const pickLocalTaggerFile = async (key: LocalTaggerFileKey) => {
    const pickerWindow = window as FilePickerWindow;
    const isModel = key === 'model';

    if (!pickerWindow.showOpenFilePicker) {
      (isModel ? taggerModelInputRef : taggerTagsInputRef).current?.click();
      return;
    }

    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          isModel
            ? {
                description: 'ONNX model',
                accept: { 'application/octet-stream': ['.onnx'] },
              }
            : {
                description: 'Selected tags CSV',
                accept: { 'text/csv': ['.csv'] },
              },
        ],
      });

      if (!handle) {
        return;
      }

      await updateLocalTaggerFileSetting(key, handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      addNotification(
        'error',
        error instanceof Error ? error.message : 'Could not save local tagger file setting.'
      );
    }
  };

  const handleFallbackLocalTaggerFileSelected = async (
    key: LocalTaggerFileKey,
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    const fileName = file.name.toLowerCase();
    const isValidFile = key === 'model' ? fileName.endsWith('.onnx') : fileName.endsWith('.csv');
    if (!isValidFile) {
      addNotification('error', `Select ${key === 'model' ? 'an ONNX model file' : 'a CSV tags file'}.`);
      return;
    }

    await updateLocalTaggerFileSetting(key, file);
  };

  const inputs = <>
    <input
      ref={taggerModelInputRef}
      type="file"
      accept=".onnx"
      className="hidden"
      onChange={(event) => void handleFallbackLocalTaggerFileSelected('model', event)}
      aria-hidden="true"
    />
    <input
      ref={taggerTagsInputRef}
      type="file"
      accept=".csv,text/csv"
      className="hidden"
      onChange={(event) => void handleFallbackLocalTaggerFileSelected('tags', event)}
      aria-hidden="true"
    />
  </>;

  return { pickLocalTaggerFile, inputs };
}
