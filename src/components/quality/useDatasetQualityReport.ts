import { useMemo } from 'react';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { BuildSession, ProjectType, TargetModelId } from '../../types';
import { isProjectDatasetPath } from '../../services/dataset/datasetFolderService';
import { buildDatasetQualityInput, collectBuildQualitySummaries } from '../../services/quality/datasetQualityInput';
import { buildQualityReport } from '../../services/quality/metrics';
import { useSimilarityFeatures } from '../../services/similarity/useSimilarityFeatures';

type Options = {
  /** Computes image features only while the report is visible. */
  featuresActive: boolean;
  /** Every workspace image Build knows about; Dataset members are picked by physical path. */
  items: readonly WorkspaceImage[];
  /** Source materials the Dataset is chosen from. */
  candidates: readonly WorkspaceImage[];
  session: BuildSession;
  triggerWord: string;
  projectType?: ProjectType;
  targetModel?: TargetModelId;
};

/** Dataset quality report for Build: shared similarity features + Build triage measurements + caption resolver. */
export const useDatasetQualityReport = ({ featuresActive, items, candidates, session, triggerWord, projectType, targetModel }: Options) => {
  const datasetItems = useMemo(() => items.filter((item) => item.kind !== 'video' && isProjectDatasetPath(item.assetPath)), [items]);
  const pool = useMemo(() => {
    const byId = new Map<string, WorkspaceImage>();
    for (const item of [...datasetItems, ...candidates]) if (item.kind !== 'video') byId.set(item.id, item);
    return [...byId.values()];
  }, [candidates, datasetItems]);
  const features = useSimilarityFeatures(pool, { active: featuresActive });
  const summaries = useMemo(() => collectBuildQualitySummaries(session), [session.records]);
  const report = useMemo(() => buildQualityReport(buildDatasetQualityInput({
    items: datasetItems, candidates, triggerWord, target: session.profile.target, targetModel,
    projectType, qualitySummaries: summaries, features,
  })), [candidates, datasetItems, features, projectType, session.profile.target, summaries, targetModel, triggerWord]);
  const labels = useMemo(() => new Map(pool.map((item) => [item.id, item.originalFileName || item.fileName])), [pool]);
  const labelFor = (id: string) => labels.get(id) ?? id;
  return { report, features, datasetItems, labelFor };
};
