import { Loader2 } from 'lucide-react';
import type { SimilarityFeatures } from '../../services/similarity/useSimilarityFeatures';
import type { QualityAction, QualityReport as QualityReportData } from '../../services/quality/metrics';
import { QualityReport } from '../quality/QualityReport';

type Props = {
  report: QualityReportData;
  features: SimilarityFeatures;
  datasetCount: number;
  labelFor: (id: string) => string;
  onSelectId?: (id: string) => void;
  onAction?: (source: unknown, action: QualityAction) => void;
  canApply?: (source: unknown, action: QualityAction) => boolean;
  testId: string;
};

/** Dataset quality report with the DINOv2 state that the diversity and coverage metrics depend on. */
export function BuildQualityPanel({ report, features, datasetCount, labelFor, onSelectId, onAction, canApply, testId }: Props) {
  const needsModel = features.basis !== 'dinov2';
  return <div data-testid={testId} className="space-y-3">
    <p className="text-xs text-muted-foreground">Checks the {datasetCount} file{datasetCount === 1 ? '' : 's'} currently in Dataset. These metrics describe the files, they do not predict how well the trained LoRA will turn out.</p>
    {needsModel && <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-secondary/40 px-3 py-2 text-xs">
      {features.modelState === 'loading'
        ? <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Computing DINOv2 image features{features.progress.total > 0 && ` ${features.progress.completed}/${features.progress.total}`}</span>
        : <>
          <span>Diversity, coverage and consistency need DINOv2 image features{features.error ? `: ${features.error}` : '.'}</span>
          {(features.modelState === 'missing' || features.modelState === 'error') && <button type="button" onClick={features.loadModel} className="rounded border border-border px-2 py-1">Download DINOv2 (≈88 MB)</button>}
        </>}
    </div>}
    <QualityReport report={report} labelFor={labelFor} onSelectId={onSelectId} onAction={onAction} canApply={canApply} />
  </div>;
}
