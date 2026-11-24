import { COVERAGE_AXES, DEFAULT_TARGET_MODEL, PROFILE_RULES, TARGET_MODEL_PRESETS } from '../../../lib/projectProfilePresets';
import type { CoverageAxisId, CoverageAxisSpec } from '../../../lib/projectProfilePresets';
import { findNearDuplicates, groupNearDuplicates } from './requiredChecks';
import { QUALITY_THRESHOLDS as T } from './thresholds';
import { countFiles, normalizeTag, percent, plural, resolveItemTags } from './text';
import type { QualityBucket, QualityHint, QualityItemInput, QualityMetric, QualityMetricId, QualityReportInput } from './types';

type CoverageInput = Pick<QualityReportInput, 'items' | 'projectType' | 'resolutionPreset' | 'target'>;

/** Noun used in "axis not evaluated" texts. */
const SIGNAL_NOUN: Record<CoverageAxisId, string> = {
  framing: 'framing', orientation: 'size', setting: 'background and setting', lighting: 'lighting', subject: 'subject', aspect: 'size',
};

/** Bucket order in which an item with several axis tags is assigned; default is spec order. */
const PRECEDENCE: Partial<Record<CoverageAxisId, readonly string[]>> = { framing: ['full', 'mid', 'close'] };

const tagKey = (tag: string) => normalizeTag(tag.replace(/_/g, ' '));

const hasSize = (item: QualityItemInput): item is QualityItemInput & { width: number; height: number } =>
  (item.width ?? 0) > 0 && (item.height ?? 0) > 0;

const tagBucket = (spec: CoverageAxisSpec, item: QualityItemInput): string | null => {
  const tags = resolveItemTags(item).map(tagKey);
  if (!tags.length) return null;
  const order = PRECEDENCE[spec.id];
  const buckets = order ? order.map((id) => spec.buckets.find((bucket) => bucket.id === id)!).filter(Boolean) : spec.buckets;
  for (const bucket of buckets) {
    if (tags.some((tag) => bucket.tags?.includes(tag) || bucket.pattern?.test(tag))) return bucket.id;
  }
  return null;
};

const orientationBucket = (item: QualityItemInput): string | null => {
  if (!hasSize(item)) return null;
  const tolerance = T.profileCoverage.orientationTolerance;
  if (item.height / item.width > tolerance) return 'portrait';
  if (item.width / item.height > tolerance) return 'landscape';
  return 'square';
};

const aspectBucket = (item: QualityItemInput, model: keyof typeof TARGET_MODEL_PRESETS): string | null => {
  if (!hasSize(item)) return null;
  const ratio = Math.log(item.width / item.height);
  let best: { id: string; distance: number } | null = null;
  for (const bucket of TARGET_MODEL_PRESETS[model].buckets) {
    const distance = Math.abs(ratio - Math.log(bucket.width / bucket.height));
    if (!best || distance < best.distance) best = { id: bucket.id, distance };
  }
  return best && best.distance <= T.profileCoverage.aspectMaxLogDistance ? best.id : 'other';
};

const axisMetric = (spec: CoverageAxisSpec, input: CoverageInput): QualityMetric => {
  const { items } = input;
  const cfg = T.profileCoverage;
  const id = `axis-${spec.id}` as QualityMetricId;
  const title = `Coverage: ${spec.label}`;
  const notEvaluated = (display: string, explanation: string): QualityMetric =>
    ({ id, title, value: null, display, status: 'ok', evaluated: false, explanation });
  if (items.length < cfg.minItems) {
    return notEvaluated('too few files', `Axis not evaluated: the set has ${countFiles(items.length)}, at least ${cfg.minItems} are required.`);
  }
  const model = input.resolutionPreset ?? DEFAULT_TARGET_MODEL;
  const assign = (item: QualityItemInput): string | null =>
    spec.id === 'orientation' ? orientationBucket(item) : spec.id === 'aspect' ? aspectBucket(item, model) : tagBucket(spec, item);
  const bucketDefs: { id: string; label: string }[] = spec.id === 'aspect'
    ? [...TARGET_MODEL_PRESETS[model].buckets.map((bucket) => ({ id: bucket.id, label: `${bucket.width}×${bucket.height}` })), { id: 'other', label: 'Other aspect ratios' }]
    : spec.buckets.map((bucket) => ({ id: bucket.id, label: bucket.label }));
  const counts = new Map<string, number>();
  const members = new Map<string, string[]>();
  let labeled = 0;
  for (const item of items) {
    const bucket = assign(item);
    if (bucket === null) continue;
    labeled += 1;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    members.set(bucket, [...(members.get(bucket) ?? []), item.id]);
  }
  const unlabeled = items.length - labeled;
  if (labeled / items.length < cfg.minLabeledFraction) {
    const signal = spec.source === 'dimensions' ? `sizes are known for only ${labeled}` : `${SIGNAL_NOUN[spec.id]} tags are present in only ${labeled}`;
    return { ...notEvaluated('not enough data', `Axis not evaluated: ${signal} of ${items.length} files (at least ${percent(cfg.minLabeledFraction)} required).`), unlabeled };
  }
  const shares = cfg.bucketMinShare[spec.id] ?? {};
  const basis = Math.max(items.length, input.target?.min ?? T.count.defaultTarget.min);
  const basisText = `max(${countFiles(items.length)}, target ${input.target?.min ?? T.count.defaultTarget.min})`;
  const buckets: QualityBucket[] = bucketDefs.map((def) => {
    const share = shares[def.id];
    const ids = members.get(def.id) ?? [];
    if (!share) return { id: def.id, label: def.label, count: counts.get(def.id) ?? 0, ids };
    const recommended = Math.ceil(share * basis);
    return {
      id: def.id, label: def.label, count: counts.get(def.id) ?? 0, ids, recommended,
      recommendedFrom: `recommended ceil(${percent(share)} × ${basis}) = ${recommended}, where ${basis} = ${basisText}`,
    };
  });
  const lacking = buckets.filter((bucket) => bucket.recommended !== undefined && bucket.count < bucket.recommended);
  const parts: string[] = [];
  for (const bucket of lacking) {
    parts.push(`“${bucket.label}”: ${bucket.count} of ${bucket.recommended} recommended (${bucket.recommendedFrom}).`);
  }
  let warn = lacking.length > 0;
  if (spec.id === 'aspect') {
    const other = counts.get('other') ?? 0;
    if (other / labeled > cfg.aspectOtherWarnFraction) {
      warn = true;
      parts.push(`${other} of ${countFiles(labeled)} with known size (${percent(other / labeled)}) fit none of the ${TARGET_MODEL_PRESETS[model].label} buckets (ln(w/h) deviation > ${cfg.aspectMaxLogDistance}): they will have to be cropped heavily.`);
    }
  }
  const unlabeledNote = unlabeled ? ` ${countFiles(unlabeled)} without an axis signal not counted.` : '';
  const coverageNote = `Counted ${labeled} of ${countFiles(items.length)}.`;
  return {
    id, title, value: labeled / items.length,
    display: buckets.filter((bucket) => bucket.count > 0 || bucket.recommended !== undefined).map((bucket) => `${bucket.label} ${bucket.count}`).join(' · '),
    status: warn ? 'warn' : 'ok', evaluated: true,
    explanation: warn ? `${parts.join(' ')} ${coverageNote}${unlabeledNote}` : `All recommended groups are represented. ${coverageNote}${unlabeledNote}`,
    buckets, unlabeled,
  };
};

/** Coverage axes of the project profile; insights only, they never affect readiness. */
export const measureProfileCoverage = (input: CoverageInput): QualityMetric[] =>
  PROFILE_RULES[input.projectType ?? 'general'].coverageAxes.map((axis) => axisMetric(COVERAGE_AXES[axis], input));

const baseName = (id: string) => id.split(/[\\/]/).filter(Boolean).pop() ?? id;

/** Gap hints built only from already computed results; every hint explains where its numbers come from. */
export const buildGapHints = (
  input: CoverageInput & Pick<QualityReportInput, 'triggerWord'>,
  results: { required: readonly QualityMetric[]; insights: readonly QualityMetric[]; coverage: readonly QualityMetric[] },
): QualityHint[] => {
  const hints: QualityHint[] = [];
  const rules = PROFILE_RULES[input.projectType ?? 'general'];
  for (const metric of results.coverage) {
    if (!metric.evaluated || !metric.buckets) continue;
    for (const bucket of metric.buckets) {
      if (bucket.recommended === undefined || bucket.count >= bucket.recommended) continue;
      hints.push({
        id: `gap-${metric.id}-${bucket.id}`, metricId: metric.id,
        text: `Missing “${bucket.label}” shots: ${bucket.count} of ${bucket.recommended} recommended`,
        explanation: `Count ${bucket.count} is the files in this group by the “${metric.title}” metric; ${bucket.recommendedFrom}.`,
      });
    }
  }
  const nearDuplicates = results.required.find((metric) => metric.id === 'near-duplicates');
  if (nearDuplicates?.evaluated && (nearDuplicates.value ?? 0) > 0) {
    for (const group of groupNearDuplicates(findNearDuplicates(input.items)).slice(0, 5)) {
      const name = baseName(group.kept);
      const count = group.removed.length;
      const exact = group.exact ? ` Exact copies by hash: ${group.exact}.` : '';
      hints.push({
        id: `near-duplicates-${group.kept}`, metricId: 'near-duplicates',
        text: `${plural(count, 'near-duplicate')} of “${name}”`,
        explanation: `DINOv2 similarity of at least ${T.nearDuplicates.similarity} (near-copy threshold) to “${name}”, which is kept; found ${count} of ${countFiles(input.items.length)}.${exact}`,
        action: { kind: 'remove', label: 'Mark repeats', ids: group.removed },
      });
    }
  }
  if (rules.tagPolicy.requireTrigger && !input.triggerWord?.trim()) {
    hints.push({
      id: 'trigger-missing', metricId: 'trigger', text: 'Set a trigger word',
      explanation: `For the “${input.projectType}” profile captions should include a trigger word, but none is set in Build.`,
    });
  }
  const common = results.insights.find((metric) => metric.id === 'common-tags');
  if (rules.tagPolicy.constantTags === 'prune' && common?.evaluated && common.action?.kind === 'remove' && common.action.tags?.length) {
    const tags = common.action.tags;
    hints.push({
      id: 'common-tags-prune', metricId: 'common-tags',
      text: `${plural(tags.length, 'tag')} in almost every file: ${tags.slice(0, 5).join(', ')}`,
      explanation: common.explanation, action: common.action,
    });
  }
  return hints;
};
