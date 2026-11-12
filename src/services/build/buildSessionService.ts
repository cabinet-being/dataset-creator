import type { WorkspaceImage } from '../../lib/workspaceImages';
import { isProjectDatasetPath } from '../dataset/datasetFolderService';
import type {
  BuildReviewDecision,
  BuildTriageGroup,
  BuildTriageProposal,
  BuildReviewRecord,
  BuildSession,
  BuildTransformRecipe,
  BuildValidationStatus,
} from '../../types';
import type { ExplorerPathMove } from '../../lib/datasetAssets';
import { applyExplorerPathMoves } from '../../lib/datasetAssets';

export type BuildCandidate = Pick<WorkspaceImage,
  'id' | 'sourceImageId' | 'editedAssetId' | 'assetPath' | 'fileName' | 'kind' | 'tags' | 'byteSize' | 'modifiedAt'
> & { stableId?: string };

export type BuildCounts = {
  ready: number;
  target: number;
  saving: number;
  unresolved: number;
  errors: number;
};

export const createBuildSession = (): BuildSession => ({
  version: 1,
  profile: { target: 60, reviewMode: 'every-item', captionRequired: true },
  cursor: 0,
  filter: 'all',
  order: [],
  records: {},
});

const TRIAGE_GROUPS = ['accepted', 'rejected', 'needs-decision'];
const BUILD_FILTERS = ['all', 'unresolved', 'errors', 'needs-decision', 'accepted', 'rejected'] as const;

/** Triage is derived data: drop it unless it has a recognisable shape. */
const normalizeTriage = (value: unknown): BuildTriageProposal | undefined => {
  const triage = value as Partial<BuildTriageProposal> | null | undefined;
  return triage && typeof triage === 'object' && TRIAGE_GROUPS.includes(triage.group as string) && Array.isArray(triage.reasons) && typeof triage.revision === 'string'
    ? triage as BuildTriageProposal : undefined;
};

const normalizeRecord = (record: BuildReviewRecord): BuildReviewRecord => {
  if (record.triage === undefined) return record;
  if (normalizeTriage(record.triage)) return record;
  const { triage: _discarded, ...rest } = record;
  void _discarded;
  return rest;
};

/** Manual decisions win; otherwise the automatic triage proposal (or `pending` when none). */
export const getBuildTriageGroup = (record: BuildReviewRecord): BuildTriageGroup | 'pending' => {
  if (record.decision === 'accepted') return 'accepted';
  if (record.decision === 'skipped') return 'rejected';
  if (record.decision === 'deferred') return 'needs-decision';
  return record.triage?.group ?? 'pending';
};

const isRecord = (value: unknown): value is BuildReviewRecord => Boolean(
  value && typeof value === 'object' && typeof (value as BuildReviewRecord).assetId === 'string'
);

export const normalizeBuildSession = (value: unknown): BuildSession => {
  const defaults = createBuildSession();
  if (!value || typeof value !== 'object') return defaults;
  const input = value as Partial<BuildSession>;
  if (input.version !== 1) return defaults;
  const records = Object.fromEntries(Object.entries(input.records ?? {}).filter(([, record]) => isRecord(record)).map(([id, record]) => [id, normalizeRecord(record)]));
  const filter = BUILD_FILTERS.find((value) => value === input.filter) ?? 'all';
  const minShortSide = Math.floor(Number(input.profile?.minShortSide));
  const reviewMode = input.profile?.reviewMode === 'uncertain-only' ? 'uncertain-only' : 'every-item';
  return {
    version: 1,
    profile: {
      target: Math.max(0, Math.floor(Number(input.profile?.target) || defaults.profile.target)),
      reviewMode,
      captionRequired: input.profile?.captionRequired !== false,
      transform: input.profile?.transform,
      ...(minShortSide > 0 ? { minShortSide } : {}),
      autoPipeline: input.profile?.autoPipeline !== false,
    },
    cursor: Math.max(0, Math.floor(Number(input.cursor) || 0)),
    filter,
    order: [...new Set((input.order ?? []).filter((id): id is string => typeof id === 'string'))],
    records,
    lastExport: input.lastExport,
    ...(input.auto && typeof input.auto === 'object' ? { auto: input.auto } : {}),
  };
};

export const getBuildAssetId = (item: BuildCandidate): string => {
  if (item.kind === 'edited' && item.editedAssetId) return `edited:${item.editedAssetId}`;
  if (item.sourceImageId) return `source:${item.sourceImageId}`;
  if (item.stableId) return `file:${item.stableId}`;
  return item.id;
};

export const getBuildAssetRevision = (item: BuildCandidate, tags = item.tags, transform?: BuildTransformRecipe): string => {
  const value = JSON.stringify([
    item.kind,
    item.byteSize ?? null,
    item.modifiedAt ?? null,
    tags === undefined ? null : tags,
    transform ?? null,
  ]);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/** Image identity deliberately excludes the caption so caption edits reuse the bitmap. */
export const getBuildContentRevision = (item: BuildCandidate, transform?: BuildTransformRecipe): string =>
  getBuildAssetRevision({ ...item, tags: undefined }, undefined, transform);

export const assertBuildSourceCurrent = <T extends BuildCandidate & { imageData: Blob }>(
  expected: T,
  latest: T | undefined,
  transform: BuildTransformRecipe | undefined,
  sessionCurrent: boolean
): void => {
  if (!sessionCurrent) throw new Error('The project changed while applying the review decision.');
  if (!latest || latest.imageData !== expected.imageData ||
    getBuildContentRevision(latest, transform) !== getBuildContentRevision(expected, transform))
    throw new Error('The source changed while applying the review decision. Review it again.');
};

export const nextBuildCursor = (previousQueue: BuildCandidate[], nextQueue: BuildCandidate[], previousCursor: number, reviewedId: string): number => {
  if (!nextQueue.length) return 0;
  const nextIds = new Set(nextQueue.map(getBuildAssetId));
  const successor = previousQueue.slice(previousCursor + 1).find((item) => nextIds.has(getBuildAssetId(item)));
  if (successor) return nextQueue.findIndex((item) => getBuildAssetId(item) === getBuildAssetId(successor));
  const reviewedIndex = nextQueue.findIndex((item) => getBuildAssetId(item) === reviewedId);
  if (reviewedIndex >= 0) return Math.min(reviewedIndex + 1, nextQueue.length - 1);
  return Math.min(previousCursor, nextQueue.length - 1);
};

const createRecord = (item: BuildCandidate, now: string, transform?: BuildTransformRecipe): BuildReviewRecord => ({
  assetId: getBuildAssetId(item),
  locator: item.assetPath,
  decision: 'unreviewed',
  application: 'idle',
  validation: 'pending',
  revision: getBuildAssetRevision(item, item.tags, transform),
  updatedAt: now,
});

export const reconcileBuildSession = (
  current: BuildSession,
  items: BuildCandidate[],
  now = new Date().toISOString(),
  physicalItems: BuildCandidate[] = items
): BuildSession => {
  const session = normalizeBuildSession(current);
  const itemIds = items.map(getBuildAssetId);
  const order = [...session.order, ...itemIds.filter((id) => !session.order.includes(id))];
  const records = { ...session.records };
  for (const item of items) {
    const assetId = getBuildAssetId(item);
    const previous = records[assetId];
    const transform = previous?.transform ?? session.profile.transform;
    const revision = getBuildAssetRevision(item, item.tags, transform);
    if (!previous) {
      records[assetId] = createRecord(item, now, transform);
      continue;
    }
    const output = previous.outputAssetId ? physicalItems.find((candidate) => getBuildAssetId(candidate) === previous.outputAssetId) : undefined;
    const stale = previous.acceptedRevision !== undefined && previous.acceptedRevision !== revision;
    const outputStale = previous.decision === 'accepted' && previous.application === 'applied' && Boolean(previous.outputAssetId) &&
      (!output || !previous.outputRevision || previous.outputRevision !== getBuildAssetRevision(output, output.tags, transform) ||
        !isProjectDatasetPath(output.assetPath) || getBuildValidation(output, session.profile.captionRequired) !== 'valid');
    const validation = (stale || outputStale) && previous.decision === 'accepted' ? 'stale' : previous.validation;
    const staleTriage = previous.triage !== undefined && previous.triage.revision !== getBuildContentRevision(item, transform);
    if (previous.locator !== item.assetPath || previous.revision !== revision || previous.validation !== validation || staleTriage) {
      const { triage: _staleTriage, ...kept } = previous;
      void _staleTriage;
      records[assetId] = {
        ...(staleTriage ? kept : previous),
        locator: item.assetPath,
        revision,
        validation,
        updatedAt: stale ? now : previous.updatedAt,
      };
    }
  }
  const cursor = Math.min(session.cursor, Math.max(0, order.length - 1));
  if (order.length === session.order.length && cursor === session.cursor && order.every((id, index) => id === session.order[index]) &&
    Object.keys(records).every((id) => records[id] === session.records[id])) return current;
  return { ...session, order, records, cursor };
};

export const updateBuildDecision = (
  session: BuildSession,
  assetId: string,
  decision: BuildReviewDecision,
  updates: Partial<BuildReviewRecord> = {},
  now = new Date().toISOString()
): BuildSession => {
  const previous = session.records[assetId];
  if (!previous) return session;
  const accepted = decision === 'accepted';
  return {
    ...session,
    records: {
      ...session.records,
      [assetId]: {
        ...previous,
        ...updates,
        decision,
        acceptedRevision: accepted ? updates.acceptedRevision ?? previous.revision : undefined,
        provenance: accepted ? updates.provenance ?? 'manual' : undefined,
        application: updates.application ?? (accepted ? previous.application : 'idle'),
        validation: updates.validation ?? (accepted ? previous.validation : 'pending'),
        error: updates.error,
        updatedAt: now,
      },
    },
  };
};

export const selectBuildQueue = <T extends BuildCandidate>(session: BuildSession, items: T[]): T[] => {
  const byId = new Map(items.map((item) => [getBuildAssetId(item), item]));
  return session.order.flatMap<T>((id) => {
    const item = byId.get(id);
    const record = session.records[id];
    if (!item || !record) return [];
    if (session.filter === 'errors' && record.application !== 'failed' && record.validation !== 'error') return [];
    if (session.filter === 'unresolved' && record.decision !== 'unreviewed' && record.decision !== 'deferred' && record.validation !== 'stale' && !(record.decision === 'accepted' && record.validation === 'pending')) return [];
    if (session.filter === 'unresolved' && record.decision === 'unreviewed' && record.triage?.group === 'rejected') return [];
    if (session.filter === 'needs-decision' && !['needs-decision', 'pending'].includes(getBuildTriageGroup(record))) return [];
    if (session.filter === 'accepted' && getBuildTriageGroup(record) !== 'accepted') return [];
    if (session.filter === 'rejected' && getBuildTriageGroup(record) !== 'rejected') return [];
    if (session.profile.reviewMode === 'uncertain-only' && session.filter === 'all' && record.decision === 'accepted' && record.validation === 'valid') return [];
    if (session.profile.reviewMode === 'uncertain-only' && session.filter === 'all' && record.decision === 'unreviewed' && record.triage?.group === 'rejected') return [];
    return [item];
  });
};

export const getBuildCounts = (session: BuildSession, items: BuildCandidate[]): BuildCounts => {
  const byId = new Map(items.map((item) => [getBuildAssetId(item), item]));
  let ready = 0; let saving = 0; let unresolved = 0; let errors = 0;
  for (const id of session.order) {
    const item = byId.get(id); const record = session.records[id];
    if (!record) { errors += 1; continue; }
    if (!item) { if (record.decision !== 'skipped') errors += 1; continue; }
    if (record.application === 'pending') saving += 1;
    if (record.application === 'failed' || record.validation === 'error') errors += 1;
    const physicalItem = record.outputAssetId
      ? items.find((candidate) => getBuildAssetId(candidate) === record.outputAssetId)
      : item;
    const outputValid = !record.outputAssetId || Boolean(physicalItem && record.outputRevision &&
      record.outputRevision === getBuildAssetRevision(physicalItem, physicalItem.tags, record.transform ?? session.profile.transform));
    const isReady = record.decision === 'accepted' && record.application === 'applied' && record.validation === 'valid' &&
      record.acceptedRevision === record.revision && isProjectDatasetPath(physicalItem?.assetPath) &&
      getBuildValidation(physicalItem ?? item, session.profile.captionRequired) === 'valid' &&
      outputValid;
    if (isReady) ready += 1;
    const triageRejected = record.decision === 'unreviewed' && record.triage?.group === 'rejected';
    if ((record.decision === 'unreviewed' && !triageRejected) || record.decision === 'deferred' || record.validation === 'stale' ||
      (record.decision === 'accepted' && record.application !== 'failed' && !isReady)) unresolved += 1;
  }
  return { ready, target: session.profile.target, saving, unresolved, errors };
};

export const applyBuildSessionPathMoves = (session: BuildSession, moves: ExplorerPathMove[]): BuildSession => {
  let changed = false;
  const records = Object.fromEntries(Object.entries(session.records).map(([id, record]) => {
    if (!record.locator) return [id, record];
    const locator = applyExplorerPathMoves(record.locator, moves);
    if (locator === record.locator) return [id, record];
    changed = true;
    return [id, { ...record, locator }];
  }));
  return changed ? { ...session, records } : session;
};

export const getBuildValidation = (item: BuildCandidate, captionRequired: boolean): BuildValidationStatus => {
  if (item.kind === 'video') return 'pending';
  if (captionRequired && !(item.tags?.length)) return 'pending';
  return 'valid';
};
