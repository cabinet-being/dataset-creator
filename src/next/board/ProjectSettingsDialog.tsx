import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';
import type { BuildSession, BuildTransformRecipe } from '../../types';
import { BuildProfileControls } from './BuildProfileControls';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const selectClass = cn('min-h-[44px] rounded-md border border-border bg-background px-3 text-sm', focusRing);

const TRANSFORM_OPTIONS = [
  { value: 'none', label: 'None (original images)' },
  { value: 'fit-512', label: 'Fit within 512' },
  { value: 'crop-512', label: 'Center crop 512' },
  { value: 'crop-768', label: 'Center crop 768' },
] as const;

/** Select value of a recipe: `none`, a preset id, or `custom` for a saved recipe that no preset describes. */
export const transformChoice = (transform: BuildTransformRecipe | undefined): string => {
  if (!transform) return 'none';
  const id = `${transform.mode}-${transform.width}`;
  const preset = TRANSFORM_OPTIONS.some(option => option.value === id) && transform.width === transform.height && !transform.allowUpscale && !transform.crop;
  return preset ? id : 'custom';
};

/** Recipe of a preset id; `none` removes the transform. Records that carry their own transform are not changed. */
export const transformFromChoice = (value: string): BuildTransformRecipe | undefined => {
  if (value === 'none') return undefined;
  const size = value === 'crop-768' ? 768 : 512;
  return { mode: value === 'fit-512' ? 'fit' : 'crop', width: size, height: size, allowUpscale: false };
};

/** Project settings of the Board: type, target model, character traits and the Build transform (crop or fit). */
export function ProjectSettingsDialog({ open, onOpenChange, session, patchSession, onModelChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BuildSession;
  patchSession: (update: (session: BuildSession) => BuildSession) => void;
  onModelChange: () => void;
}) {
  const transform = session.profile.transform;
  const choice = transformChoice(transform);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[2100] bg-black/60" />
      <Dialog.Content data-project-settings aria-describedby="project-settings-description"
        className="fixed left-1/2 top-1/2 z-[2101] flex max-h-[90vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-lg border border-border bg-card p-6 shadow-xl">
        <div>
          <Dialog.Title className="text-lg font-semibold">Project settings</Dialog.Title>
          <Dialog.Description id="project-settings-description" className="mt-1 text-sm text-muted-foreground">
            Type and target model decide the minimum image size and the quality checks.</Dialog.Description>
        </div>
        <BuildProfileControls onModelChange={onModelChange} />
        <section className="space-y-2 border-t border-border pt-4">
          <label className="grid gap-2 text-sm">Output transform
            <select aria-label="Output transform" data-profile-transform value={choice} className={selectClass}
              onChange={event => { if (event.target.value !== 'custom') patchSession(current => ({ ...current, profile: { ...current.profile, transform: transformFromChoice(event.target.value) } })); }}>
              {choice === 'custom' && transform && <option value="custom" disabled>Custom ({transform.mode} {transform.width}×{transform.height})</option>}
              {TRANSFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
          <p className="text-xs text-muted-foreground">Applied to images when they are accepted into the Dataset. Choose None to keep the original images.</p>
        </section>
        <div className="flex justify-end"><Dialog.Close asChild><button type="button" className={cn('min-h-[44px] rounded-md border border-border px-4 text-sm hover:bg-secondary', focusRing)}>Close</button></Dialog.Close></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
