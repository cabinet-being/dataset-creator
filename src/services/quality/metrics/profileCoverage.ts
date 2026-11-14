import { COVERAGE_AXES, DEFAULT_TARGET_MODEL, PROFILE_RULES, TARGET_MODEL_PRESETS } from '../../../lib/projectProfilePresets';
import type { CoverageAxisId, CoverageAxisSpec } from '../../../lib/projectProfilePresets';
import { findNearDuplicates, groupNearDuplicates } from './requiredChecks';
import { QUALITY_THRESHOLDS as T } from './thresholds';
import { countFiles, normalizeTag, percent, plural, resolveItemTags } from './text';
import type { QualityBucket, QualityHint, QualityItemInput, QualityMetric, QualityMetricId, QualityReportInput } from './types';

type CoverageInput = Pick<QualityReportInput, 'items' | 'projectType' | 'resolutionPreset' | 'target'>;

/** Genitive noun used in "axis not evaluated" texts. */
const SIGNAL_NOUN: Record<CoverageAxisId, string> = {
  framing: 'кадрування', orientation: 'розміру', setting: 'фону й місця', lighting: 'освітлення', subject: 'суб’єкта', aspect: 'розміру',
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
  const title = `Покриття: ${spec.label}`;
  const notEvaluated = (display: string, explanation: string): QualityMetric =>
    ({ id, title, value: null, display, status: 'ok', evaluated: false, explanation });
  if (items.length < cfg.minItems) {
    return notEvaluated('замало файлів', `Вісь не оцінено: у наборі ${countFiles(items.length)}, потрібно щонайменше ${cfg.minItems}.`);
  }
  const model = input.resolutionPreset ?? DEFAULT_TARGET_MODEL;
  const assign = (item: QualityItemInput): string | null =>
    spec.id === 'orientation' ? orientationBucket(item) : spec.id === 'aspect' ? aspectBucket(item, model) : tagBucket(spec, item);
  const bucketDefs: { id: string; label: string }[] = spec.id === 'aspect'
    ? [...TARGET_MODEL_PRESETS[model].buckets.map((bucket) => ({ id: bucket.id, label: `${bucket.width}×${bucket.height}` })), { id: 'other', label: 'Інші пропорції' }]
    : spec.buckets.map((bucket) => ({ id: bucket.id, label: bucket.label }));
  const counts = new Map<string, number>();
  let labeled = 0;
  for (const item of items) {
    const bucket = assign(item);
    if (bucket === null) continue;
    labeled += 1;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const unlabeled = items.length - labeled;
  if (labeled / items.length < cfg.minLabeledFraction) {
    const signal = spec.source === 'dimensions' ? `розміри відомі лише для ${labeled}` : `теги ${SIGNAL_NOUN[spec.id]} є лише в ${labeled}`;
    return { ...notEvaluated('замало даних', `Вісь не оцінено: ${signal} з ${items.length} файлів (потрібно щонайменше ${percent(cfg.minLabeledFraction)}).`), unlabeled };
  }
  const shares = cfg.bucketMinShare[spec.id] ?? {};
  const basis = Math.max(items.length, input.target?.min ?? T.count.defaultTarget.min);
  const basisText = `max(${items.length} файлів, ціль ${input.target?.min ?? T.count.defaultTarget.min})`;
  const buckets: QualityBucket[] = bucketDefs.map((def) => {
    const share = shares[def.id];
    if (!share) return { id: def.id, label: def.label, count: counts.get(def.id) ?? 0 };
    const recommended = Math.ceil(share * basis);
    return {
      id: def.id, label: def.label, count: counts.get(def.id) ?? 0, recommended,
      recommendedFrom: `рекомендовано ceil(${percent(share)} × ${basis}) = ${recommended}, де ${basis} = ${basisText}`,
    };
  });
  const lacking = buckets.filter((bucket) => bucket.recommended !== undefined && bucket.count < bucket.recommended);
  const parts: string[] = [];
  for (const bucket of lacking) {
    parts.push(`«${bucket.label}»: ${bucket.count} з рекомендованих ${bucket.recommended} (${bucket.recommendedFrom}).`);
  }
  let warn = lacking.length > 0;
  if (spec.id === 'aspect') {
    const other = counts.get('other') ?? 0;
    if (other / labeled > cfg.aspectOtherWarnFraction) {
      warn = true;
      parts.push(`${other} з ${labeled} файлів із відомим розміром (${percent(other / labeled)}) не підходять до жодного бакета ${TARGET_MODEL_PRESETS[model].label} (відхилення ln(w/h) > ${cfg.aspectMaxLogDistance}): їх доведеться сильно обрізати.`);
    }
  }
  const unlabeledNote = unlabeled ? ` ${countFiles(unlabeled)} без ознаки осі не враховано.` : '';
  const coverageNote = `Враховано ${labeled} з ${items.length} файлів.`;
  return {
    id, title, value: labeled / items.length,
    display: buckets.filter((bucket) => bucket.count > 0 || bucket.recommended !== undefined).map((bucket) => `${bucket.label} ${bucket.count}`).join(' · '),
    status: warn ? 'warn' : 'ok', evaluated: true,
    explanation: warn ? `${parts.join(' ')} ${coverageNote}${unlabeledNote}` : `Усі рекомендовані групи представлені. ${coverageNote}${unlabeledNote}`,
    buckets, unlabeled,
  };
};

/** Coverage axes of the project profile; insights only, they never affect readiness. */
export const measureProfileCoverage = (input: CoverageInput): QualityMetric[] =>
  PROFILE_RULES[input.projectType ?? 'general'].coverageAxes.map((axis) => axisMetric(COVERAGE_AXES[axis], input));

const baseName = (id: string) => id.split(/[\\/]/).filter(Boolean).pop() ?? id;
const DUPLICATES = ['майже-дублікат', 'майже-дублікати', 'майже-дублікатів'] as const;

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
        text: `Бракує кадрів «${bucket.label}»: є ${bucket.count} з рекомендованих ${bucket.recommended}`,
        explanation: `Кількість ${bucket.count} — файли групи за метрикою «${metric.title}»; ${bucket.recommendedFrom}.`,
      });
    }
  }
  const nearDuplicates = results.required.find((metric) => metric.id === 'near-duplicates');
  if (nearDuplicates?.evaluated && (nearDuplicates.value ?? 0) > 0) {
    for (const group of groupNearDuplicates(findNearDuplicates(input.items)).slice(0, 5)) {
      const name = baseName(group.kept);
      const count = group.removed.length;
      const exact = group.exact ? ` З них ${group.exact} точні копії за хешем.` : '';
      hints.push({
        id: `near-duplicates-${group.kept}`, metricId: 'near-duplicates',
        text: `${count} ${plural(count, DUPLICATES)} кадру «${name}»`,
        explanation: `Схожість DINOv2 щонайменше ${T.nearDuplicates.similarity} (поріг near-copy) із «${name}», який залишається; знайдено ${count} з ${input.items.length} файлів.${exact}`,
        action: { kind: 'remove', label: 'Позначити повтори', ids: group.removed },
      });
    }
  }
  if (rules.tagPolicy.requireTrigger && !input.triggerWord?.trim()) {
    hints.push({
      id: 'trigger-missing', metricId: 'trigger', text: 'Задайте тригер-слово',
      explanation: `Для профілю «${input.projectType}» підписи мають мати тригер-слово, а в Build його не задано.`,
    });
  }
  const common = results.insights.find((metric) => metric.id === 'common-tags');
  if (rules.tagPolicy.constantTags === 'prune' && common?.evaluated && common.action?.kind === 'remove' && common.action.tags?.length) {
    const tags = common.action.tags;
    hints.push({
      id: 'common-tags-prune', metricId: 'common-tags',
      text: `${tags.length} ${plural(tags.length, ['тег', 'теги', 'тегів'])} у майже всіх файлах: ${tags.slice(0, 5).join(', ')}`,
      explanation: common.explanation, action: common.action,
    });
  }
  return hints;
};
