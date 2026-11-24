import { useMemo } from 'react';
import { Check, Circle } from 'lucide-react';
import type { BuildStage, ProjectState, ToolName } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { BUILD_STAGE_LABELS, getBuildStageSummary } from '../../lib/buildStageSummary';
import { ADVANCED_TOOLS } from '../../lib/constants';
import { TOOL_DEFINITIONS } from '../../lib/toolDefinitions';
import { PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../../lib/projectProfiles';
import { useBuildModel } from '../build/useBuildModel';
import { useProjectStore } from '../../stores/useProjectStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { useDatasetQualityReport } from '../quality/useDatasetQualityReport';

type SaveStatus = 'local' | 'saved' | 'pending' | 'saving' | 'error';
const SAVE_TEXT: Record<SaveStatus, string> = { local: 'Temporary workspace', saving: 'Saving…', pending: 'Unsaved changes', error: 'Not saved', saved: 'Saved' };
const STATE_TEXT = { empty: 'Not started', 'in-progress': 'In progress', done: 'Done' } as const;

type Props = {
  projectName?: string | null;
  saveStatus: SaveStatus;
  items: WorkspaceImage[];
  enabledTools: readonly ToolName[];
  onOpenStage: (stage: BuildStage) => void;
  onOpenTool: (tool: ToolName) => void;
  /** Present when Home is shown on top of open editors. */
  onClose?: () => void;
};

/** Landing view of an open project: where the project stands and what to do next. */
export function ProjectHome({ projectName, saveStatus, items, enabledTools, onOpenStage, onOpenTool, onClose }: Props) {
  const storedName = useProjectStore((state) => state.name);
  const projectType = useProjectStore((state) => state.projectType);
  const targetModel = useProjectStore((state) => state.targetModel);
  const triggerWord = useProjectStore((state: ProjectState) => state.dataset.triggerWord);
  const taggerBundle = useLocalTaggerStore((state) => state.bundle);
  const savedTagger = useLocalTaggerStore((state) => state.savedFileNames);
  const { effectiveItems, candidates, reconciled } = useBuildModel(items);
  const quality = useDatasetQualityReport({ featuresActive: false, items: effectiveItems, candidates, session: reconciled, triggerWord, projectType, targetModel });
  const summary = useMemo(() => getBuildStageSummary({ session: reconciled, effectiveItems, candidates, readiness: quality.report.readiness }),
    [candidates, effectiveItems, quality.report.readiness, reconciled]);
  const next = summary.nextIncomplete;
  const checklist = [
    { id: 'import', label: 'Import images', done: summary.materials > 0 },
    { id: 'auto-select', label: 'Auto-select a Dataset', done: Boolean(reconciled.auto?.assembledAt) || Object.values(reconciled.records).some((record) => record.provenance === 'auto') },
    { id: 'tagger', label: 'Download the tagger', done: Boolean(taggerBundle) || Boolean(savedTagger.model && savedTagger.tags) },
    { id: 'check', label: 'Check the Dataset', done: summary.readiness === 'ok' },
    { id: 'export', label: 'Export', done: Boolean(reconciled.lastExport) },
  ];
  const advanced = ADVANCED_TOOLS.filter((tool) => enabledTools.includes(tool));
  const name = projectName || storedName || 'Untitled project';

  return <div data-workspace-welcome data-testid="project-home" tabIndex={-1} className="h-full overflow-auto p-6">
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{PROJECT_TYPE_PROFILES[projectType].label} · {TARGET_MODEL_PRESETS[targetModel].label}</p>
        </div>
        <span role="status" data-testid="project-home-save" className="rounded bg-secondary px-2 py-1 text-xs">{SAVE_TEXT[saveStatus]}</span>
        {onClose && <button type="button" onClick={onClose} className="rounded border border-border px-2 py-1 text-xs">Back to editor</button>}
      </header>

      <button type="button" data-testid="project-home-continue" onClick={() => onOpenStage(next)} className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">Continue: {BUILD_STAGE_LABELS[next]}</button>

      <section aria-label="Build stages">
        <ol className="grid gap-2 sm:grid-cols-5">
          {summary.stages.map((stage, index) => <li key={stage.id}>
            <button type="button" data-testid={`project-home-stage-${stage.id}`} data-state={stage.state} onClick={() => onOpenStage(stage.id)}
              className={`h-full w-full rounded-lg border p-3 text-left text-xs hover:bg-secondary ${stage.id === next ? 'border-primary' : 'border-border'}`}>
              <span className="block text-muted-foreground">{index + 1}</span>
              <span className="block text-sm font-medium">{stage.label}</span>
              <span className="block text-muted-foreground">{stage.counter}</span>
              <span className="mt-1 block">{STATE_TEXT[stage.state]}</span>
            </button>
          </li>)}
        </ol>
      </section>

      <section aria-label="First run checklist">
        <h2 className="mb-2 text-sm font-semibold">Getting started</h2>
        <ul className="space-y-1 text-sm">
          {checklist.map((entry) => <li key={entry.id} data-done={entry.done} className="flex items-center gap-2">
            {entry.done ? <Check aria-hidden className="h-4 w-4 text-emerald-600" /> : <Circle aria-hidden className="h-4 w-4 text-muted-foreground" />}
            <span className={entry.done ? 'text-muted-foreground line-through' : ''}>{entry.label}</span>
            <span className="sr-only">{entry.done ? 'done' : 'to do'}</span>
          </li>)}
        </ul>
      </section>

      {advanced.length > 0 && <section aria-label="Advanced tools">
        <h2 className="mb-2 text-sm font-semibold">Advanced tools</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {advanced.map((tool) => <li key={tool}><button type="button" onClick={() => onOpenTool(tool)} className="w-full rounded border border-border px-3 py-2 text-left text-sm hover:bg-secondary">
            <span className="block font-medium">{TOOL_DEFINITIONS[tool].label}</span><span className="block text-xs text-muted-foreground">{TOOL_DEFINITIONS[tool].description}</span></button></li>)}
        </ul>
      </section>}
    </div>
  </div>;
}
