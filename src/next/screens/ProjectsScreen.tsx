import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { FolderOpen, FolderPlus, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { DEFAULT_TARGET_MODEL, PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../../lib/projectProfiles';
import { cn } from '../../lib/utils';
import {
  forgetRecentProject, getRecentProjectAccess, listRecentProjects, type RecentProject, type RecentProjectAccess,
} from '../../services/project/recentProjectsService';
import type { ProjectType, TargetModelId } from '../../types';
import type { useProjectRuntime } from '../useProjectRuntime';

type Runtime = ReturnType<typeof useProjectRuntime>;
type RecentRow = RecentProject & { access: RecentProjectAccess };

const TYPE_ORDER: readonly ProjectType[] = ['character', 'style', 'concept', 'general'];
const TYPE_LABELS: Partial<Record<ProjectType, string>> = { concept: 'Concept or object' };
const MODEL_ORDER: readonly TargetModelId[] = ['sd15', 'sdxl', 'flux'];
const ACCESS_TEXT: Record<RecentProjectAccess, string> = { granted: 'Ready', prompt: 'Needs access', denied: 'No access', unknown: 'Ready' };

const timeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];
export const formatEdited = (iso: string, now = Date.now()): string => {
  const elapsed = Date.parse(iso) - now;
  if (Number.isNaN(elapsed)) return 'Unknown';
  for (const [unit, size] of RELATIVE_UNITS) if (Math.abs(elapsed) >= size) return timeFormat.format(Math.trunc(elapsed / size), unit);
  return 'Just now';
};

const choiceClass = (selected: boolean) => cn(
  'min-h-[44px] rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  selected ? 'border-primary bg-primary/15 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground'
);

/** Start screen of the next UI: recent projects on the left, a new project form on the right. */
export function ProjectsScreen({ runtime }: { runtime: Runtime }) {
  const { lifecycle, isProjectDirectoryBusy, projectDirectoryName } = runtime;
  const [recent, setRecent] = useState<RecentRow[] | null>(null);
  const [name, setName] = useState('');
  const [projectType, setProjectType] = useState<ProjectType>('character');
  const [targetModel, setTargetModel] = useState<TargetModelId>(DEFAULT_TARGET_MODEL);

  const loadRecent = useCallback(async () => {
    try {
      const entries = await listRecentProjects();
      setRecent(await Promise.all(entries.map(async entry => ({ ...entry, access: await getRecentProjectAccess(entry.handle) }))));
    } catch { setRecent([]); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => { if (!cancelled) await loadRecent(); })();
    return () => { cancelled = true; };
  }, [loadRecent]);

  const trimmedName = name.trim();
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmedName || isProjectDirectoryBusy) return;
    void lifecycle.createProjectFromPreset({ name: trimmedName, projectType, targetModel });
  };
  const forget = async (id: string) => { await forgetRecentProject(id).catch(() => {}); await loadRecent(); };

  return <div data-projects-screen className="flex min-h-0 flex-1 flex-col gap-8 overflow-auto p-6 md:flex-row md:p-10">
    <section aria-labelledby="recent-heading" className="min-w-0 flex-1">
      <h2 id="recent-heading" className="mb-4 text-lg font-semibold">Recent projects</h2>
      {recent === null ? <p className="text-sm text-muted-foreground">Loading…</p>
        : recent.length === 0 ? <p data-recent-empty className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No recent projects yet. Create one or open a folder.</p>
        : <ul data-recent-list className="space-y-2">
          {recent.map(entry => <li key={entry.id} data-recent-project={entry.name} className="flex items-stretch gap-2">
            <button type="button" disabled={isProjectDirectoryBusy} onClick={() => void lifecycle.openProjectDirectory(entry.handle)}
              className="flex min-h-[64px] min-w-0 flex-1 items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entry.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{PROJECT_TYPE_PROFILES[entry.projectType]?.label ?? entry.projectType} · {TARGET_MODEL_PRESETS[entry.targetModel]?.label ?? entry.targetModel}</span>
              </span>
              <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
                <span className="block">Edited {formatEdited(entry.lastEditedAt)}</span>
                <span className="block">{entry.datasetCount} {entry.datasetCount === 1 ? 'frame' : 'frames'} in dataset</span>
              </span>
              <span data-recent-state className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs', entry.access === 'prompt' || entry.access === 'denied' ? 'border-primary text-primary' : 'border-border text-muted-foreground')}>{ACCESS_TEXT[entry.access]}</span>
            </button>
            <button type="button" aria-label={`Remove ${entry.name} from recent projects`} onClick={() => void forget(entry.id)}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="h-4 w-4" />
            </button>
          </li>)}
        </ul>}
      <Button variant="outline" className="mt-4 min-h-[44px]" disabled={isProjectDirectoryBusy} onClick={() => void lifecycle.handleOpenProject()}>
        <FolderOpen className="h-4 w-4" />Open folder…
      </Button>
      {projectDirectoryName && <p className="mt-2 text-xs text-muted-foreground">Last opened: {projectDirectoryName}</p>}
    </section>

    <form onSubmit={create} aria-labelledby="new-project-heading" className="w-full shrink-0 space-y-5 rounded-lg border border-border bg-card p-6 md:w-[26rem]">
      <h2 id="new-project-heading" className="text-lg font-semibold">New project</h2>
      <label className="block text-sm font-medium">Name
        <input data-new-project-name required value={name} onChange={event => setName(event.target.value)} placeholder="My dataset"
          className="mt-2 min-h-[44px] w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Type</legend>
        <div role="radiogroup" aria-label="Project type" className="grid grid-cols-2 gap-2">
          {TYPE_ORDER.map(type => <button key={type} type="button" role="radio" aria-checked={projectType === type} data-project-type={type}
            onClick={() => setProjectType(type)} className={choiceClass(projectType === type)}>
            <span className="block font-medium text-foreground">{TYPE_LABELS[type] ?? PROJECT_TYPE_PROFILES[type].label}</span>
            <span className="block text-xs">{PROJECT_TYPE_PROFILES[type].description}</span>
          </button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Model</legend>
        <div role="radiogroup" aria-label="Target model" className="grid grid-cols-3 gap-2">
          {MODEL_ORDER.map(model => <button key={model} type="button" role="radio" aria-checked={targetModel === model} data-target-model={model}
            onClick={() => setTargetModel(model)} className={choiceClass(targetModel === model)}>
            <span className="block font-medium text-foreground">{TARGET_MODEL_PRESETS[model].label}</span>
            <span className="block text-xs">min {TARGET_MODEL_PRESETS[model].minShortSide}px</span>
          </button>)}
        </div>
      </fieldset>
      <Button type="submit" size="lg" className="min-h-[44px] w-full" disabled={!trimmedName || isProjectDirectoryBusy}>
        <FolderPlus className="h-4 w-4" />Choose folder and create
      </Button>
    </form>
  </div>;
}
