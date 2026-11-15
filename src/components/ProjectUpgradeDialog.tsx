import * as Dialog from '@radix-ui/react-dialog';
import { formatFileSize } from '../lib/utils';
import type { LayoutMigrationPlan } from '../services/project/layoutMigrationService';
import { PROJECT_LAYOUT } from '../services/project/projectLayoutService';

export function ProjectUpgradeDialog({ name, plan, blockedReason, onComplete }: {
  name: string; plan: LayoutMigrationPlan; blockedReason?: string; onComplete: (proceed: boolean) => void;
}) {
  if (blockedReason) return <Dialog.Root open onOpenChange={(open) => { if (!open) onComplete(false); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[2101] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">Project cannot be upgraded yet</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-muted-foreground">{blockedReason}</Dialog.Description>
        <p className="mt-3 text-sm">You can open “{name}” in the previous layout to resolve this. The upgrade will be offered again the next time you open it.</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => onComplete(false)} className="rounded border border-border px-4 py-2">Cancel</button>
          <button type="button" autoFocus onClick={() => onComplete(true)} className="rounded bg-primary px-4 py-2 text-primary-foreground">Open without upgrading</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
  return <Dialog.Root open onOpenChange={(open) => { if (!open) onComplete(false); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[2101] max-h-[90vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">Upgrade project layout?</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-muted-foreground">“{name}” uses the previous project layout. It has to be upgraded before it can be opened.</Dialog.Description>
        <h3 className="mt-4 text-sm font-medium">What will change</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{plan.changes.map((change) => <li key={change}>{change}</li>)}</ul>
        <h3 className="mt-4 text-sm font-medium">How your data is protected</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>First, a snapshot of the project ({plan.snapshotFileCount} file{plan.snapshotFileCount === 1 ? '' : 's'}, about {formatFileSize(plan.snapshotBytes)}) is saved as a version in {PROJECT_LAYOUT.versionsDir}. If it cannot be written, nothing is changed.</li>
          <li>Files that are replaced are also backed up in {PROJECT_LAYOUT.backupDir}.</li>
          <li>If the upgrade is interrupted, it continues the next time you open the project.</li>
        </ul>
        {plan.pendingJournals > 0 && <p className="mt-3 text-sm">An earlier upgrade was interrupted; it will be finished first.</p>}
        {plan.warnings.map((warning) => <p key={warning} role="note" className="mt-3 text-sm text-amber-500">{warning}</p>)}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => onComplete(false)} className="rounded border border-border px-4 py-2">Cancel</button>
          <button type="button" autoFocus onClick={() => onComplete(true)} className="rounded bg-primary px-4 py-2 text-primary-foreground">Upgrade project</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
