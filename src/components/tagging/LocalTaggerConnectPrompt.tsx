import { useRef } from 'react';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { useUIStore } from '../../stores/useUIStore';
import { connectLocalTaggerSource, restoreSavedLocalTagger } from '../../services/tagging/localTaggerConnectionService';
import { WdTaggerDownloadPanel } from './WdTaggerDownloadPanel';

/** Shown where a caption model is needed but none is connected: connect files, restore the saved model or download one. */
export function LocalTaggerConnectPrompt({ message = 'No local caption model connected.', className = '' }: { message?: string; className?: string }) {
  const savedFileNames = useLocalTaggerStore((state) => state.savedFileNames);
  const notify = useUIStore((state) => state.addNotification);
  const input = useRef<HTMLInputElement>(null);
  return <div className={`text-xs text-muted-foreground ${className}`} data-testid="local-tagger-connect">
    <p>{message}</p>
    <input ref={input} type="file" multiple accept=".onnx,.csv" className="hidden" onChange={(event) => {
      const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = '';
      if (!files.length) return;
      void connectLocalTaggerSource({ kind: 'files', name: 'Build workspace model', files }).then((connected) => { if (!connected) notify('error', useLocalTaggerStore.getState().message); });
    }} />
    <button type="button" className="mt-2 rounded border border-border px-2 py-1" onClick={() => input.current?.click()}>Connect model.onnx + selected_tags.csv</button>
    {savedFileNames.model && savedFileNames.tags && <button type="button" className="mt-2 ml-2 rounded border border-border px-2 py-1" onClick={() => void restoreSavedLocalTagger(true)}>Restore saved model</button>}
    <WdTaggerDownloadPanel className="mt-3" />
  </div>;
}
