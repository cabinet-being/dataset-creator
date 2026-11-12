import { measureCaptionLength, measureCommonTags, measureRareTags } from './captionBalance';
import { measureConsistency, measureEffectiveSize, measureMaterialCoverage, measureSaturation } from './embeddingMetrics';
import { checkCaptions, checkCount, checkNearDuplicates, checkResolution, checkTechnical, checkTrigger } from './requiredChecks';
import { worstStatus } from './thresholds';
import type { QualityReport, QualityReportInput } from './types';

/** No overall score: readiness is the worst required check, insights only explain. */
export const buildQualityReport = (input: QualityReportInput): QualityReport => {
  const { items } = input;
  const required = [
    checkCount(items.length, input.target),
    checkResolution(items, input.resolutionPreset, input.minShortSide),
    checkNearDuplicates(items),
    checkCaptions(items),
    checkTrigger(items, input.triggerWord),
    checkTechnical(items, input.technical),
  ];
  const insights = [
    measureEffectiveSize(items),
    measureMaterialCoverage(items, input.candidates),
    measureSaturation(items, input.candidates, input.selectionOrder),
    measureCommonTags(items, input.triggerWord),
    measureRareTags(items, input.triggerWord),
    measureCaptionLength(items),
    measureConsistency(items, input.projectType),
  ];
  return { readiness: worstStatus(required.map((metric) => metric.status)), required, insights };
};
