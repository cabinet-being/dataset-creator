import { QUALITY_THRESHOLDS as T, resolveMinShortSide, statusForBadFraction } from './thresholds';
import { captionText, containsTrigger, countFiles, hasCaption, percent } from './text';
import type { ImageQualityVerdict, QualityItemInput, QualityMetric, ResolutionPreset } from './types';
import { dot, normalizeVector } from './vectorMath';

export const checkCount = (count: number, target: { min: number; max: number } = T.count.defaultTarget): QualityMetric => {
  const base = { id: 'count', title: 'File count', value: count, display: `${countFiles(count)} (target ${target.min}–${target.max})`, evaluated: true } as const;
  if (count < target.min) {
    const status = count < target.min * T.count.failRatio ? 'fail' : 'warn';
    return { ...base, status, explanation: `${target.min - count} short of the target minimum: too few examples, the LoRA may not learn the concept.` };
  }
  if (count > target.max) {
    return { ...base, status: 'warn', explanation: `${count - target.max} over the target: longer training and a risk of repetition. Remove the most similar files.` };
  }
  return { ...base, status: 'ok', explanation: 'Count is within the target.' };
};

export const checkResolution = (items: readonly QualityItemInput[], preset: ResolutionPreset = 'sdxl', override?: number): QualityMetric => {
  const minSide = resolveMinShortSide(preset, override);
  const known = items.filter((item) => (item.width ?? 0) > 0 && (item.height ?? 0) > 0);
  const title = `Resolution (shorter side ≥ ${minSide}px)`;
  if (!known.length) {
    return { id: 'resolution', title, value: null, display: 'no data', status: 'warn', evaluated: false, explanation: 'Image sizes are unknown, so the check was skipped.' };
  }
  const below = known.filter((item) => Math.min(item.width!, item.height!) < minSide);
  const fraction = below.length / known.length;
  const unknown = items.length - known.length;
  const status = unknown && !below.length ? 'warn' : statusForBadFraction(fraction, T.resolution.warnFraction);
  const parts = [below.length
    ? `${countFiles(below.length)} (${percent(fraction)}) have a shorter side under ${minSide}px: the model will learn from blurry detail.`
    : `All files have a shorter side of at least ${minSide}px.`];
  if (unknown) parts.push(`Size of ${countFiles(unknown)} is unknown.`);
  return {
    id: 'resolution', title, value: fraction, display: below.length ? `${below.length} of ${known.length} too small` : 'all large enough',
    status, evaluated: true, explanation: parts.join(' '),
    action: below.length ? { kind: 'review', label: 'Replace with sharper images or remove', ids: below.map((item) => item.id) } : undefined,
  };
};

export type NearDuplicatePair = { kept: string; removed: string; similarity: number; kind: 'exact' | 'near' };

/** Greedy in item order: each item is compared with the already kept ones, like Dataset assembly. */
export const findNearDuplicates = (items: readonly QualityItemInput[], threshold: number = T.nearDuplicates.similarity): NearDuplicatePair[] => {
  const kept: { id: string; vector: Float64Array | null; hash?: string }[] = [];
  const pairs: NearDuplicatePair[] = [];
  for (const item of items) {
    const vector = normalizeVector(item.embedding);
    const exact = item.imageHash ? kept.find((other) => other.hash === item.imageHash) : undefined;
    if (exact) { pairs.push({ kept: exact.id, removed: item.id, similarity: 1, kind: 'exact' }); continue; }
    let best: { id: string; similarity: number } | null = null;
    if (vector) {
      for (const other of kept) {
        if (!other.vector) continue;
        const similarity = dot(vector, other.vector);
        if (!best || similarity > best.similarity) best = { id: other.id, similarity };
      }
    }
    if (best && best.similarity >= threshold) { pairs.push({ kept: best.id, removed: item.id, similarity: best.similarity, kind: 'near' }); continue; }
    kept.push({ id: item.id, vector, hash: item.imageHash });
  }
  return pairs;
};

export type NearDuplicateGroup = { kept: string; removed: string[]; exact: number };

/** Groups kept→removed pairs by the kept anchor; groups are ordered by size, then by first appearance. */
export const groupNearDuplicates = (pairs: readonly NearDuplicatePair[]): NearDuplicateGroup[] => {
  const groups = new Map<string, NearDuplicateGroup>();
  for (const pair of pairs) {
    const group = groups.get(pair.kept) ?? { kept: pair.kept, removed: [], exact: 0 };
    group.removed.push(pair.removed);
    if (pair.kind === 'exact') group.exact += 1;
    groups.set(pair.kept, group);
  }
  return [...groups.values()].map((group, index) => ({ group, index }))
    .sort((left, right) => right.group.removed.length - left.group.removed.length || left.index - right.index)
    .map((entry) => entry.group);
};

export const checkNearDuplicates = (items: readonly QualityItemInput[]): QualityMetric => {
  const title = 'Near-duplicates';
  const withSignal = items.filter((item) => normalizeVector(item.embedding) || item.imageHash);
  if (!withSignal.length) {
    return { id: 'near-duplicates', title, value: null, display: 'no vectors', status: 'warn', evaluated: false, explanation: 'Files have no DINOv2 vectors yet, so duplicates were not checked.' };
  }
  const pairs = findNearDuplicates(items);
  const fraction = pairs.length / items.length;
  const missing = items.length - withSignal.length;
  const status = missing && !pairs.length ? 'warn' : statusForBadFraction(fraction, T.nearDuplicates.warnFraction);
  const parts = [pairs.length
    ? `${countFiles(pairs.length)} nearly repeat others (similarity ≥ ${T.nearDuplicates.similarity}): they push the model to overfit to specific shots.`
    : 'No near-duplicates found.'];
  if (missing) parts.push(`${countFiles(missing)} without a vector not checked.`);
  return {
    id: 'near-duplicates', title, value: pairs.length, display: pairs.length ? `${pairs.length} redundant` : 'none',
    status, evaluated: true, explanation: parts.join(' '),
    action: pairs.length ? { kind: 'remove', label: 'Remove repeats', ids: pairs.map((pair) => pair.removed) } : undefined,
  };
};

export const checkCaptions = (items: readonly QualityItemInput[]): QualityMetric => {
  const missing = items.filter((item) => !hasCaption(item));
  const fraction = items.length ? missing.length / items.length : 0;
  return {
    id: 'captions', title: 'Captions', value: fraction,
    display: missing.length ? `${missing.length} without caption` : 'all captioned',
    status: statusForBadFraction(fraction, T.captions.warnFraction), evaluated: true,
    explanation: missing.length
      ? `${countFiles(missing.length)} without a caption: the trainer will see only the trigger or empty text.`
      : 'Every file has a caption.',
    action: missing.length ? { kind: 'caption', label: 'Add captions', ids: missing.map((item) => item.id) } : undefined,
  };
};

export const checkTrigger = (items: readonly QualityItemInput[], triggerWord = ''): QualityMetric => {
  const trigger = triggerWord.trim();
  if (!trigger) {
    return { id: 'trigger', title: 'Trigger word', value: null, display: 'not set', status: 'ok', evaluated: false, explanation: 'No trigger word is set, so the check was skipped.' };
  }
  const missing = items.filter((item) => item.triggerPresent === undefined ? !containsTrigger(captionText(item), trigger) : !item.triggerPresent);
  const fraction = items.length ? missing.length / items.length : 0;
  return {
    id: 'trigger', title: `Trigger “${trigger}”`, value: 1 - fraction,
    display: `${percent(1 - fraction)} of captions`,
    status: statusForBadFraction(fraction, T.trigger.warnFraction), evaluated: true,
    explanation: missing.length
      ? `${countFiles(missing.length)} lack the trigger word: the concept will not bind to it reliably.`
      : 'The trigger word is in every caption.',
    action: missing.length ? { kind: 'caption', label: 'Add trigger', ids: missing.map((item) => item.id) } : undefined,
  };
};

export const checkTechnical = (items: readonly QualityItemInput[], verdicts?: readonly ImageQualityVerdict[]): QualityMetric => {
  const title = 'Technical quality';
  if (!verdicts) {
    return { id: 'technical', title, value: null, display: 'not checked', status: 'warn', evaluated: false, explanation: 'The technical check (blur, noise, artifacts) has not been run yet.' };
  }
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const bad = items.filter((item) => byId.get(item.id)?.verdict === 'bad');
  const doubtful = items.filter((item) => byId.get(item.id)?.verdict === 'warn');
  const unchecked = items.filter((item) => !byId.has(item.id));
  const fraction = items.length ? bad.length / items.length : 0;
  const base = statusForBadFraction(fraction, T.technical.warnFraction);
  const status = base === 'ok' && unchecked.length ? 'warn' : base;
  const reasons = [...new Set(bad.flatMap((item) => byId.get(item.id)?.reasons ?? []))].slice(0, 4);
  const parts = [bad.length
    ? `${countFiles(bad.length)} (${percent(fraction)}) technically poor${reasons.length ? `: ${reasons.join(', ')}` : ''}.`
    : 'No technically poor files.'];
  if (doubtful.length) parts.push(`${countFiles(doubtful.length)} more are doubtful.`);
  if (unchecked.length) parts.push(`${countFiles(unchecked.length)} not checked.`);
  return {
    id: 'technical', title, value: fraction, display: bad.length ? `${percent(fraction)} poor` : 'no problems',
    status, evaluated: true, explanation: parts.join(' '),
    action: bad.length ? { kind: 'remove', label: 'Remove poor files', ids: bad.map((item) => item.id) } : undefined,
  };
};
