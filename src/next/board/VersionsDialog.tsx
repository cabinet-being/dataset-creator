import { useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';
import type { useProjectRuntime } from '../useProjectRuntime';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass = cn('min-h-[44px] rounded-md border border-border px-4 text-sm hover:bg-secondary disabled:opacity-40', focusRing);

/** Project versions: Save version snapshots the project, Restore (after confirmation) replaces it with a snapshot. */
export function VersionsDialog({ runtime }: { runtime: ReturnType<typeof useProjectRuntime> }) {
  const { lifecycle, versionsOpen, setVersionsOpen, isProjectDirectoryBusy } = runtime;
  const { projectVersions, currentProjectVersionId, newVersionName, setNewVersionName } = lifecycle;
  const { openProjectVersions } = lifecycle;
  useEffect(() => { if (versionsOpen) void openProjectVersions(); }, [versionsOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const ordered = [...projectVersions].reverse();
  return <Dialog.Root open={versionsOpen} onOpenChange={setVersionsOpen}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
      <Dialog.Content data-versions-dialog aria-describedby="versions-description"
        className="fixed left-1/2 top-1/2 z-[2101] flex max-h-[90vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-lg border border-border bg-card p-6 shadow-xl">
        <div>
          <Dialog.Title className="text-lg font-semibold">Versions</Dialog.Title>
          <Dialog.Description id="versions-description" className="mt-1 text-sm text-muted-foreground">
            A version is a snapshot of the project files. Restoring replaces the current state.</Dialog.Description>
        </div>
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void lifecycle.handleCreateProjectVersion(); }}>
          <input aria-label="Version name" value={newVersionName} placeholder="Version name" onChange={event => setNewVersionName(event.target.value)}
            className={cn('min-h-[44px] min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm', focusRing)} />
          <button type="submit" data-version-save disabled={isProjectDirectoryBusy || !newVersionName.trim()} className={buttonClass}>Save version</button>
        </form>
        {ordered.length === 0
          ? <p data-versions-empty className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">No versions yet.</p>
          : <ul aria-label="Saved versions" className="space-y-1">
            {ordered.map(version => <li key={version.id} data-version={version.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1">
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{version.name}</span>
                <span className="block text-xs text-muted-foreground">{new Date(version.createdAt).toLocaleString()}{version.id === currentProjectVersionId ? ' · current' : ''}</span></span>
              <button type="button" data-version-restore aria-label={`Restore ${version.name}`} disabled={isProjectDirectoryBusy} onClick={() => void lifecycle.handleRestoreProjectVersion(version)} className={buttonClass}>Restore</button>
            </li>)}
          </ul>}
        <div className="flex justify-end"><Dialog.Close asChild><button type="button" className={buttonClass}>Close</button></Dialog.Close></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
