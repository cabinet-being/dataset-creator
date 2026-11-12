import type { BuildReviewRecord, BuildSession, BuildTriageGroup, BuildTriageProposal, BuildTriageReason } from '../../types';
import { isProjectDatasetPath } from '../dataset/datasetFolderService';
import type { DatasetAssemblyPlan } from '../dataset/datasetAssemblyService';
import { summarizeImageQuality, type ImageQualityReport } from '../quality/imageQuality';
import { getBuildAssetId, getBuildTriageGroup, type BuildCandidate } from './buildSessionService';

export type BuildTriageCounts = { accepted: number; rejected: number; needsDecision: number; pending: number };

export const classifyQualityTriage = (input: {
  item: BuildCandidate;
  report?: ImageQualityReport;
  digest?: string;
  duplicateOf?: string;
  inDataset: boolean;
  revision: string;
  now: string;
}): BuildTriageProposal => {
  const { item, report, digest, duplicateOf, inDataset, revision, now } = input;
  const base = { stage: 'quality' as const, revision, createdAt: now, ...(digest ? { digest } : {}) };
  const quality = report ? summarizeImageQuality(report) : undefined;
  if (item.kind === 'video') return { ...base, group: 'needs-decision', reasons: [{ code: 'video', message: 'Videos need a manual decision' }] };
  if (!report) return { ...base, group: 'needs-decision', reasons: [{ code: 'unmeasured', message: 'Image could not be measured' }] };
  const reasons: BuildTriageReason[] = [];
  if (duplicateOf) reasons.push({ code: 'exact-duplicate', message: 'Exact duplicate of another image' });
  const rejects = report.flags.filter((flag) => flag.severity === 'reject');
  const reviews = report.flags.filter((flag) => flag.severity === 'review');
  for (const flag of [...rejects, ...reviews]) reasons.push({ code: flag.code, message: flag.message });
  let group: BuildTriageGroup = duplicateOf || rejects.length ? 'rejected' : reviews.length ? 'needs-decision' : 'accepted';
  if (group === 'accepted') reasons.push({ code: 'quality-ok', message: 'Resolution, sharpness and exposure look fine' });
  // Never propose silently dropping something that is already in the Dataset.
  if (group === 'rejected' && inDataset) group = 'needs-decision';
  return { ...base, group, reasons, quality, ...(duplicateOf ? { duplicateOf } : {}) };
};

/** Keeper is the first Dataset member with a digest, otherwise the first entry in the given order. */
export const findExactDuplicates = (entries: Array<{ assetId: string; digest: string; inDataset: boolean }>): Map<string, string> => {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) groups.set(entry.digest, [...(groups.get(entry.digest) ?? []), entry]);
  const duplicates = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group.find((entry) => entry.inDataset) ?? group[0];
    for (const entry of group) if (entry !== keeper) duplicates.set(entry.assetId, keeper.assetId);
  }
  return duplicates;
};

const withTriage = (session: BuildSession, assetId: string, proposal: BuildTriageProposal): BuildSession => {
  const record = session.records[assetId];
  if (!record || record.decision !== 'unreviewed') return session;
  return { ...session, records: { ...session.records, [assetId]: { ...record, triage: proposal } } };
};

export const applyTriageProposal = (session: BuildSession, assetId: string, proposal: BuildTriageProposal): BuildSession =>
  withTriage(session, assetId, proposal);

export const applyAssemblyTriage = (
  session: BuildSession,
  plan: Pick<DatasetAssemblyPlan, 'selected' | 'duplicatePairs' | 'rejectedCandidates' | 'stoppedBecause'>,
  assetIdByKey: Map<string, string>,
  now: string
): BuildSession => {
  let next = session;
  const make = (assetId: string, proposal: Omit<BuildTriageProposal, 'stage' | 'revision' | 'createdAt' | 'quality' | 'digest'>): BuildSession => {
    const previous = next.records[assetId]?.triage;
    return withTriage(next, assetId, {
      ...proposal, stage: 'assembly', revision: previous?.revision ?? '', createdAt: now,
      ...(previous?.quality ? { quality: previous.quality } : {}), ...(previous?.digest ? { digest: previous.digest } : {}),
    });
  };
  const reasonText: Record<string, string> = {
    'target-reached': 'target reached', 'range-max': 'range maximum reached', 'max-new': 'new-image limit reached',
    saturated: 'coverage saturated', exhausted: 'pool exhausted', 'insufficient-pool': 'pool too small',
  };
  const handled = new Set<string>();
  for (const step of plan.selected) {
    const assetId = assetIdByKey.get(step.key);
    if (!assetId) continue;
    handled.add(assetId);
    next = make(assetId, { group: 'accepted', reasons: [{ code: 'selected', message: step.reason }] });
  }
  for (const pair of plan.duplicatePairs) {
    const assetId = assetIdByKey.get(pair.rejected);
    if (!assetId || handled.has(assetId)) continue;
    handled.add(assetId);
    const duplicateOf = assetIdByKey.get(pair.kept) ?? pair.kept;
    next = pair.kind === 'exact'
      ? make(assetId, { group: 'rejected', reasons: [{ code: 'exact-duplicate', message: 'Exact duplicate of another image' }], duplicateOf, similarity: pair.similarity })
      : make(assetId, { group: 'rejected', reasons: [{ code: 'near-duplicate', message: `Near duplicate (${Math.round(pair.similarity * 100)}% similar)` }], duplicateOf, similarity: pair.similarity });
  }
  for (const entry of plan.rejectedCandidates) {
    if (entry.reason !== 'not-selected') continue;
    const assetId = assetIdByKey.get(entry.path);
    if (!assetId || handled.has(assetId)) continue;
    handled.add(assetId);
    next = make(assetId, { group: 'rejected', reasons: [{ code: 'not-selected', message: `Not selected: ${reasonText[plan.stoppedBecause] ?? plan.stoppedBecause}` }] });
  }
  return next;
};

export { getBuildTriageGroup };

export const getBuildTriageCounts = (session: BuildSession, items: BuildCandidate[]): BuildTriageCounts => {
  const ids = new Set(items.map(getBuildAssetId));
  const counts: BuildTriageCounts = { accepted: 0, rejected: 0, needsDecision: 0, pending: 0 };
  for (const id of session.order) {
    const record = session.records[id];
    if (!record || !ids.has(id)) continue;
    const group = getBuildTriageGroup(record);
    if (group === 'accepted') counts.accepted += 1;
    else if (group === 'rejected') counts.rejected += 1;
    else if (group === 'needs-decision') counts.needsDecision += 1;
    else counts.pending += 1;
  }
  return counts;
};

const inOrder = <T extends BuildCandidate>(session: BuildSession, items: T[]): Array<{ item: T; record: BuildReviewRecord }> => {
  const byId = new Map(items.map((item) => [getBuildAssetId(item), item]));
  return session.order.flatMap((id) => {
    const item = byId.get(id); const record = session.records[id];
    return item && record ? [{ item, record }] : [];
  });
};

export const selectTriageTargets = <T extends BuildCandidate>(session: BuildSession, items: T[]): T[] =>
  inOrder(session, items).filter(({ record }) => record.decision === 'unreviewed' && !record.triage).map(({ item }) => item);

export const selectAssemblyCandidates = <T extends BuildCandidate>(session: BuildSession, items: T[]): T[] =>
  inOrder(session, items)
    .filter(({ item, record }) => record.decision === 'unreviewed' && record.triage?.group === 'accepted' && record.triage.stage === 'quality' && !isProjectDatasetPath(item.assetPath))
    .map(({ item }) => item);

export const createAssemblyKey = (target: number, items: BuildCandidate[], session: BuildSession): string =>
  `${target}|${items.map((item) => {
    const assetId = getBuildAssetId(item);
    return `${assetId}:${session.records[assetId]?.triage?.revision ?? session.records[assetId]?.revision ?? ''}`;
  }).sort().join(',')}`;
