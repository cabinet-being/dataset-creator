import { useCommandRunner, useCommandState } from './Commands';

export function DocumentActions({ active = true, close = false, open = false }: { active?: boolean; close?: boolean; open?: boolean }) {
  const run = useCommandRunner();
  const save = useCommandState('document.save');
  const copy = useCommandState('document.saveCopy');
  const cancel = useCommandState('document.cancel');
  return <div className="flex flex-wrap items-center gap-2">
    {open && <button type="button" onClick={() => run('focus.explorer')} title="Open files · Ctrl / ⌘ O in Photopea" className="rounded border border-border px-3 py-1.5 text-sm">Open file</button>}
    <button type="button" disabled={!active || save.disabled} title={!active ? 'Focus this editor to save' : save.disabled ? save.reason : 'Save · Ctrl / ⌘ S'} onClick={() => run('document.save')} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">Save</button>
    <button type="button" disabled={!active || copy.disabled} title={!active ? 'Focus this editor to save' : copy.disabled ? copy.reason : undefined} onClick={() => run('document.saveCopy')} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">Save copy</button>
    {close && <button type="button" disabled={!active || cancel.disabled} onClick={() => run('document.cancel')} className="rounded px-3 py-1.5 text-sm disabled:opacity-50">Close editor</button>}
  </div>;
}
