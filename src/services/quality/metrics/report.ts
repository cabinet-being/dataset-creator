import { measureCaptionLength, measureCommonTags, measureRareTags } from './captionBalance';
import { PROFILE_RULES } from '../../../lib/projectProfilePresets';
import { measureConsistency, measureEffectiveSize, measureMaterialCoverage, measureSaturation } from './embeddingMetrics';
import { checkCaptions, checkCount, checkNearDuplicates, checkResolution, checkTechnical, checkTrigger } from './requiredChecks';
import { buildGapHints, measureProfileCoverage } from './profileCoverage';
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
    measureCommonTags(items, input.triggerWord, PROFILE_RULES[input.projectType ?? 'general'].tagPolicy),
    measureRareTags(items, input.triggerWord),
    measureCaptionLength(items),
    measureConsistency(items, input.projectType),
  ];
  const coverage = measureProfileCoverage(input);
  const hints = buildGapHints(input, { required, insights, coverage });
  return { readiness: worstStatus(required.map((metric) => metric.status)), required, insights, coverage, hints };
};
