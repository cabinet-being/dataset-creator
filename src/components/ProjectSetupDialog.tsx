import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { DEFAULT_TARGET_MODEL, PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../lib/projectProfiles';
import type { ProjectType, TargetModelId } from '../types';

export function ProjectSetupDialog({ name, migration, onComplete }: {
  name: string; migration: boolean;
  onComplete: (value: { name: string; projectType: ProjectType; targetModel: TargetModelId } | null) => void;
}) {
  const [projectName, setProjectName] = useState(name);
  const [projectType, setProjectType] = useState<ProjectType>('general');
  const [targetModel, setTargetModel] = useState<TargetModelId>(DEFAULT_TARGET_MODEL);
  return <Dialog.Root open onOpenChange={(open) => { if (!open) onComplete(null); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[2101] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">{migration ? 'Choose this project’s type' : 'Create project'}</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-muted-foreground">{migration ? `Choose a type for “${name}”. Your selection will be saved to the project before it opens.` : 'Choose a name and the kind of dataset project you want to build.'}</Dialog.Description>
        <form onSubmit={(event) => { event.preventDefault(); if (projectType && projectName.trim()) onComplete({ name: projectName.trim(), projectType, targetModel }); }}>
          {!migration && <label className="mt-4 block text-sm">Project name<input autoFocus required value={projectName} onChange={(event) => setProjectName(event.target.value)} className="mt-2 w-full rounded border border-border bg-background p-2" /></label>}
          <fieldset className="mt-5"><legend className="mb-2 text-sm font-medium">Project type</legend>
            <div className="grid gap-3 sm:grid-cols-4">{(Object.keys(PROJECT_TYPE_PROFILES) as ProjectType[]).map((type) => {
              const profile = PROJECT_TYPE_PROFILES[type];
              return <label key={type} className={`cursor-pointer rounded border p-3 ${projectType === type ? 'border-primary bg-primary/10' : 'border-border'}`}>
                <input type="radio" name="projectType" required value={type} checked={projectType === type} onChange={() => setProjectType(type)} className="mr-2" />
                <span className="font-medium">{profile.label}</span><span className="mt-2 block text-xs text-muted-foreground">{profile.description}</span>
              </label>;
            })}</div>
          </fieldset>
          {!migration && <label className="mt-4 block text-sm">Target model<select aria-label="Target model" value={targetModel} onChange={(event) => setTargetModel(event.target.value as TargetModelId)} className="mt-2 w-full rounded border border-border bg-background p-2">
            {(Object.keys(TARGET_MODEL_PRESETS) as TargetModelId[]).map((id) => <option key={id} value={id}>{TARGET_MODEL_PRESETS[id].label} (min {TARGET_MODEL_PRESETS[id].minShortSide}px)</option>)}
          </select></label>}
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => onComplete(null)} className="rounded border border-border px-4 py-2">Cancel</button><button disabled={!projectType || !projectName.trim()} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40">{migration ? 'Save type and open' : 'Choose location and create'}</button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
