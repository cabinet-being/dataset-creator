import type { ReactNode } from 'react';

/** Owns workspace geometry; project actions and editor lifetimes stay with their owners. */
export function AppShell({ busy, setupDialog, backgroundTasks, header, activityBar, footer, overlays, children }: {
  busy: boolean;
  setupDialog?: ReactNode;
  backgroundTasks?: ReactNode;
  header: ReactNode;
  activityBar: ReactNode;
  footer: ReactNode;
  overlays: ReactNode;
  children: ReactNode;
}) {
  return <>
    {setupDialog}
    {busy && !setupDialog && <div role="status" className="fixed inset-0 z-[2050] flex items-center justify-center bg-background/60 text-sm backdrop-blur-sm">Working with project…</div>}
    <div {...{inert:busy ? '' : undefined}} data-workspace-busy={busy || undefined} aria-busy={busy} className="flex h-screen bg-background text-foreground">
      {backgroundTasks}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {header}
        <div className="flex min-h-0 flex-1">{activityBar}{children}</div>
        {footer}
        {overlays}
      </main>
    </div>
  </>;
}
