type Props = {
  projectName?: string | null;
  hasDirectory: boolean;
  recoveryNeeded: boolean;
  onOpen: () => void;
  onCreate: () => void;
  onContinue: () => void;
};

export function WorkspaceWelcome({projectName, hasDirectory, recoveryNeeded, onOpen, onCreate, onContinue}: Props) {
  return <div data-workspace-welcome tabIndex={-1} className="flex h-full items-center justify-center p-6">
    <div className="w-full max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dataset Creator</h1>
        {recoveryNeeded ? <div role="status" className="mt-3 space-y-1">
          <p className="text-sm font-medium">The previous editor is unavailable.</p>
          <p className="text-sm text-muted-foreground">Open its project, then select the file or tool again.</p>
        </div> : <p className="mt-2 text-sm text-muted-foreground">{projectName ?? 'Your next dataset starts here.'}</p>}
      </div>
      <div className="grid gap-2">
        <button onClick={onOpen} className="rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">Open project</button>
        <button onClick={onCreate} className="rounded-lg border border-border px-4 py-3 text-sm">New project</button>
        <button onClick={onContinue} className="px-4 py-2 text-sm text-muted-foreground">{hasDirectory ? 'Continue in Build' : 'Start in Build'}</button>
      </div>
    </div>
  </div>;
}
