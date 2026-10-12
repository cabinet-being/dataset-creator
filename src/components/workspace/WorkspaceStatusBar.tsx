import { OperationStatus } from './OperationStatus';
import type { useProjectSave } from '../../hooks/useProjectSave';

export function WorkspaceStatusBar({ projectName, save, onFocusOperation, onOutput, onHelp }: {
  projectName: string;
  save: ReturnType<typeof useProjectSave>;
  onFocusOperation: (id: string) => void;
  onOutput: () => void;
  onHelp: () => void;
}) {
  return <footer className="flex min-h-8 shrink-0 flex-wrap items-center gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
    <span className="truncate">{projectName}</span>
    <span className="ml-auto" role="status">{save.status === 'local' ? 'Temporary workspace' : save.status === 'saving' ? 'Saving…' : save.status === 'pending' ? 'Unsaved changes' : save.status === 'error' ? 'Not saved' : 'Saved'}</span>
    {save.status === 'error' && <button className="text-destructive" title={save.error} onClick={() => void save.retry().catch(() => {})}>Retry save</button>}
    <OperationStatus onFocusView={onFocusOperation} />
    <button onClick={onOutput}>Output</button><button aria-label="Keyboard shortcuts" onClick={onHelp}>?</button>
  </footer>;
}
