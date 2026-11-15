import type { BuildSession, BuildStage } from '../types';
import type { WorkspaceImage } from './workspaceImages';
import { getBuildAssetId, getBuildCounts, type BuildCounts } from '../services/build/buildSessionService';
import { isProjectDatasetPath } from '../services/dataset/datasetFolderService';
import type { QualityStatus } from '../services/quality/metrics';
import { toWorkspaceImages } from './workspaceImages';

export type BuildStageState = 'empty' | 'in-progress' | 'done';

export const BUILD_STAGE_LABELS: Record<BuildStage, string> = {
  add: 'Add', select: 'Select', caption: 'Caption', check: 'Check', export: 'Export',
};

export type BuildStageSummaryEntry = { id: BuildStage; label: string; counter: string; state: BuildStageState };

export type BuildStageSummary = {
  stages: BuildStageSummaryEntry[];
  counts: BuildCounts;
  materials: number;
  datasetSize: number;
  captioned: number;
  readiness: QualityStatus | undefined;
  /** First stage that is not done yet (Export when everything is done). */
  nextIncomplete: BuildStage;
};

const READINESS_TEXT: Record<QualityStatus, string> = { ok: 'Ready', warn: 'Needs attention', fail: 'Not ready' };

/** Registered (project-state) images merged over the images the workspace passes in. */
export const mergeBuildItems = (
  items: readonly WorkspaceImage[],
  sourceImages: Parameters<typeof toWorkspaceImages>[0],
  datasetItems: Parameters<typeof toWorkspaceImages>[1],
): WorkspaceImage[] => {
  const registered = toWorkspaceImages(sourceImages, datasetItems);
  const byId = new Map(registered.map((item) => [getBuildAssetId(item), item]));
  return [...items.map((item) => item.sourceImageId ? byId.get(getBuildAssetId(item)) ?? item : item),
    ...registered.filter((item) => !items.some((candidate) => getBuildAssetId(candidate) === getBuildAssetId(item)))];
};

/** Source materials Build chooses from: everything except Build's own transformed outputs. */
export const selectBuildCandidates = (effectiveItems: readonly WorkspaceImage[], session: BuildSession): WorkspaceImage[] => {
  const outputIds = new Set(Object.values(session.records).flatMap((record) => record.outputAssetId ? [record.outputAssetId] : []));
  return effectiveItems.filter((item) => !outputIds.has(getBuildAssetId(item)) &&
    !(item.kind === 'edited' && item.editedAssetType === 'crop' && item.editedAssetId?.startsWith('build-')));
};

export const selectBuildDatasetItems = (items: readonly WorkspaceImage[]): WorkspaceImage[] =>
  items.filter((item) => item.kind !== 'video' && isProjectDatasetPath(item.assetPath));

/** One source of truth for the Build stepper and the Project Home stage cards. */
export const getBuildStageSummary = ({ session, effectiveItems, candidates, readiness }: {
  session: BuildSession;
  effectiveItems: readonly WorkspaceImage[];
  candidates: readonly WorkspaceImage[];
  readiness?: QualityStatus;
}): BuildStageSummary => {
  const counts = getBuildCounts(session, [...effectiveItems]);
  const dataset = selectBuildDatasetItems(effectiveItems);
  const captioned = dataset.filter((item) => Boolean(item.tags?.length)).length;
  const materials = candidates.length;
  const addState: BuildStageState = materials ? 'done' : 'empty';
  const selectState: BuildStageState = !materials ? 'empty' : counts.unresolved === 0 && counts.ready > 0 ? 'done' : 'in-progress';
  const captionState: BuildStageState = !dataset.length ? 'empty' : captioned === dataset.length ? 'done' : 'in-progress';
  const checkState: BuildStageState = !dataset.length ? 'empty' : readiness === 'ok' ? 'done' : 'in-progress';
  const exportState: BuildStageState = session.lastExport ? 'done' : 'empty';
  const stages: BuildStageSummaryEntry[] = [
    { id: 'add', label: BUILD_STAGE_LABELS.add, counter: `${materials} file${materials === 1 ? '' : 's'}`, state: addState },
    { id: 'select', label: BUILD_STAGE_LABELS.select, counter: `${counts.ready}/${counts.target} ready · ${counts.unresolved} undecided`, state: selectState },
    { id: 'caption', label: BUILD_STAGE_LABELS.caption, counter: `${captioned}/${dataset.length} captioned`, state: captionState },
    { id: 'check', label: BUILD_STAGE_LABELS.check, counter: readiness ? READINESS_TEXT[readiness] : '—', state: checkState },
    { id: 'export', label: BUILD_STAGE_LABELS.export, counter: session.lastExport ? `${session.lastExport.entries} files exported` : '—', state: exportState },
  ];
  return { stages, counts, materials, datasetSize: dataset.length, captioned, readiness,
    nextIncomplete: stages.find((stage) => stage.state !== 'done')?.id ?? 'export' };
};
