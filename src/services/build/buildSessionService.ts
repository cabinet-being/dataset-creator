import type { WorkspaceImage } from '../../lib/workspaceImages';
import { isProjectDatasetPath } from '../dataset/datasetFolderService';
import { inboxFolderOfPath } from '../../lib/inboxFolders';
import { SIMILARITY_STRICTNESS } from '../similarity/similarityLevels';
import type {
  BuildAssemblyOutcome,
  BuildImageOverride,
  BuildReviewDecision,
  BuildTriageGroup,
  BuildTriageProposal,
  BuildReviewRecord,
  BuildSession,
  BuildShortlistEntry,
  BuildStage,
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

export const BUILD_STAGES: readonly BuildStage[] = ['add', 'select', 'caption', 'check', 'export'];

export const createBuildSession = (): BuildSession => ({
  version: 2,
  stage: 'add',
  profile: { target: 60, reviewMode: 'every-item', captionRequired: true, sizeMode: 'auto' },
  cursor: 0,
  filter: 'all',
  order: [],
  records: {},
});

const TRIAGE_GROUPS = ['accepted', 'rejected', 'needs-decision'];
const BUILD_FILTERS = ['all', 'unresolved', 'errors', 'needs-decision', 'accepted', 'rejected', 'shortlisted', 'picked',
  'status-inbox', 'status-out', 'status-in-dataset', 'status-pinned', 'status-banned'] as const;

/** Triage is derived data: drop it unless it has a recognisable shape. */
const normalizeTriage = (value: unknown): BuildTriageProposal | undefined => {
  const triage = value as Partial<BuildTriageProposal> | null | undefined;
  return triage && typeof triage === 'object' && TRIAGE_GROUPS.includes(triage.group as string) && Array.isArray(triage.reasons) && typeof triage.revision === 'string'
    ? triage as BuildTriageProposal : undefined;
};

const normalizeAssembly = (value: unknown): BuildAssemblyOutcome | undefined => {
  const assembly = value as Partial<BuildAssemblyOutcome> | null | undefined;
  return assembly && typeof assembly === 'object' && (assembly.outcome === 'duplicate' || assembly.outcome === 'not-selected') && typeof assembly.revision === 'string'
    ? assembly as BuildAssemblyOutcome : undefined;
};

/** One-time v1 -> v2 migration: a manual accept becomes Pin, a skip becomes Ban; everything else is computed. `decision` is kept untouched. */
const migrateOverride = (record: BuildReviewRecord): BuildImageOverride | undefined =>
  record.decision === 'skipped' ? 'ban' : record.decision === 'accepted' && record.provenance === 'manual' ? 'pin' : undefined;

const normalizeRecord = (record: BuildReviewRecord, migrate: boolean): BuildReviewRecord => {
  const { override: rawOverride, assembly: rawAssembly, origin: rawOrigin, ...base } = record;
  const override: BuildImageOverride | undefined = migrate ? migrateOverride(record) : rawOverride === 'pin' || rawOverride === 'ban' ? rawOverride : undefined;
  const assembly = normalizeAssembly(rawAssembly);
  const triage = base.triage === undefined || normalizeTriage(base.triage) ? base.triage : undefined;
  const { triage: _triage, ...rest } = base;
  void _triage;
  return {
    ...rest,
    ...(triage ? { triage } : {}),
    ...(override ? { override } : {}),
    ...(assembly ? { assembly } : {}),
    ...(typeof rawOrigin === 'string' && rawOrigin ? { origin: rawOrigin } : {}),
  };
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
  if (input.version !== 1 && input.version !== 2) return defaults;
  const migrate = input.version === 1;
  const records = Object.fromEntries(Object.entries(input.records ?? {}).filter(([, record]) => isRecord(record)).map(([id, record]) => [id, normalizeRecord(record, migrate)]));
  const sources = Array.isArray(input.profile?.sources) ? [...new Set(input.profile.sources.filter((path): path is string => typeof path === 'string' && Boolean(path)))] : undefined;
  const strictness = SIMILARITY_STRICTNESS.find((entry) => entry.id === input.profile?.similarityStrictness)?.id;
  const filter = BUILD_FILTERS.find((value) => value === input.filter) ?? 'all';
  const reviewMode = input.profile?.reviewMode === 'uncertain-only' ? 'uncertain-only' : 'every-item';
  // Sessions saved before stages existed resume in Select when they already hold items, otherwise in Add.
  const stage = BUILD_STAGES.find((value) => value === input.stage) ?? (Object.keys(records).length ? 'select' : 'add');
  return {
    version: 2,
    stage,
    ...(input.view === 'grid' || input.view === 'clusters' ? { view: input.view } : {}),
    profile: {
      target: Math.max(0, Math.floor(Number(input.profile?.target) || defaults.profile.target)),
      reviewMode,
      captionRequired: input.profile?.captionRequired !== false,
      transform: input.profile?.transform,
      autoPipeline: input.profile?.autoPipeline !== false,
      ...(input.profile?.sizeMode === 'auto' ? { sizeMode: 'auto' as const } : {}),
      ...(sources ? { sources } : {}),
      ...(strictness ? { similarityStrictness: strictness } : {}),
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

/** Remembers the inbox folder of an image that sits in the inbox; images elsewhere keep what they had. */
const originPatch = (item: BuildCandidate, previous?: string): { origin?: string } => {
  const folder = inboxFolderOfPath(item.assetPath);
  return folder ? { origin: folder } : previous ? { origin: previous } : {};
};

const createRecord = (item: BuildCandidate, now: string, transform?: BuildTransformRecipe): BuildReviewRecord => ({
  assetId: getBuildAssetId(item),
  locator: item.assetPath,
  decision: 'unreviewed',
  application: 'idle',
  validation: 'pending',
  revision: getBuildAssetRevision(item, item.tags, transform),
  ...originPatch(item),
  updatedAt: now,
});

/** Id lookup where the first item wins, matching the former `find` semantics. */
const firstItemById = <T extends BuildCandidate>(items: readonly T[]): Map<string, T> => {
  const map = new Map<string, T>();
  for (const item of items) { const id = getBuildAssetId(item); if (!map.has(id)) map.set(id, item); }
  return map;
};

export const reconcileBuildSession = (
  current: BuildSession,
  items: BuildCandidate[],
  now = new Date().toISOString(),
  physicalItems: BuildCandidate[] = items
): BuildSession => {
  const session = normalizeBuildSession(current);
  const itemIds = items.map(getBuildAssetId);
  const knownIds = new Set(session.order);
  const order = [...session.order, ...itemIds.filter((id) => !knownIds.has(id))];
  const physicalById = firstItemById(physicalItems);
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
    const output = previous.outputAssetId ? physicalById.get(previous.outputAssetId) : undefined;
    const stale = previous.acceptedRevision !== undefined && previous.acceptedRevision !== revision;
    const outputStale = previous.decision === 'accepted' && previous.application === 'applied' && Boolean(previous.outputAssetId) &&
      (!output || !previous.outputRevision || previous.outputRevision !== getBuildAssetRevision(output, output.tags, transform) ||
        !isProjectDatasetPath(output.assetPath) || getBuildValidation(output, session.profile.captionRequired) !== 'valid');
    const validation = (stale || outputStale) && previous.decision === 'accepted' ? 'stale' : previous.validation;
    const contentRevision = getBuildContentRevision(item, transform);
    const staleTriage = previous.triage !== undefined && previous.triage.revision !== contentRevision;
    const staleAssembly = previous.assembly !== undefined && previous.assembly.revision !== contentRevision;
    const origin = originPatch(item, previous.origin).origin;
    if (previous.locator !== item.assetPath || previous.revision !== revision || previous.validation !== validation || staleTriage || staleAssembly || origin !== previous.origin) {
      const { triage: _staleTriage, assembly: _staleAssembly, origin: _origin, ...kept } = previous;
      void _staleTriage; void _staleAssembly; void _origin;
      records[assetId] = {
        ...kept,
        ...(!staleTriage && previous.triage ? { triage: previous.triage } : {}),
        ...(!staleAssembly && previous.assembly ? { assembly: previous.assembly } : {}),
        ...(origin ? { origin } : {}),
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

/** The review record of an item; a transformed output that Build created has none of its own, so it uses the record of its source. */
export const getBuildRecordForItem = (session: BuildSession, item: BuildCandidate): BuildReviewRecord | undefined => {
  const id = getBuildAssetId(item);
  return session.records[id] ?? Object.values(session.records).find((record) => record.outputAssetId === id);
};

export type ActiveShortlist<T extends BuildCandidate> = {
  /** Still valid and undecided, in rank order. */
  entries: Array<{ entry: BuildShortlistEntry; item: T }>;
  /** Pass-2 result restricted to entries that are still valid. */
  narrowed: T[];
  size: number;
};

/** The shortlist without entries whose image changed, moved into the Dataset or was decided by hand. */
export const getActiveShortlist = <T extends BuildCandidate>(session: BuildSession, items: readonly T[] | ReadonlyMap<string, T>): ActiveShortlist<T> | null => {
  const shortlist = session.auto?.shortlist;
  if (!shortlist) return null;
  const byId: ReadonlyMap<string, T> = Array.isArray(items) ? new Map((items as readonly T[]).map((item) => [getBuildAssetId(item), item])) : items as ReadonlyMap<string, T>;
  const entries = shortlist.entries.flatMap((entry) => {
    const item = byId.get(entry.id); const record = session.records[entry.id];
    if (!item || !record || isProjectDatasetPath(item.assetPath)) return [];
    if (record.decision !== 'unreviewed' && record.decision !== 'deferred') return [];
    if (entry.revision !== getBuildContentRevision(item, record.transform ?? session.profile.transform)) return [];
    return [{ entry, item }];
  }).sort((left, right) => left.entry.rank - right.entry.rank);
  const active = new Map(entries.map(({ entry, item }) => [entry.id, item]));
  const narrowed = (shortlist.narrowed?.ids ?? []).flatMap((id) => active.get(id) ?? []);
  return { entries, narrowed, size: shortlist.size };
};

export const createBuildShortlist = (
  session: BuildSession,
  result: { needed: number; requested: number; duplicates: number; mode?: 'auto'; poolCount?: number; items: Array<{ item: BuildCandidate; cluster: string; gain: number; rank: number }> },
  now = new Date().toISOString()
): BuildSession => ({
  ...session,
  auto: {
    ...session.auto, assembledAt: now, assemblyError: undefined,
    shortlist: {
      createdAt: now, needed: result.needed, size: result.requested, duplicatesRejected: result.duplicates,
      ...(result.mode ? { mode: result.mode } : {}), ...(result.poolCount !== undefined ? { poolCount: result.poolCount } : {}),
      entries: result.items.flatMap(({ item, cluster, gain, rank }) => {
        const id = getBuildAssetId(item); const record = session.records[id];
        return record ? [{ id, revision: getBuildContentRevision(item, record.transform ?? session.profile.transform), cluster, gain, rank }] : [];
      }),
    },
  },
});

export const setBuildShortlistNarrowed = (session: BuildSession, ids: string[], target: number, now = new Date().toISOString()): BuildSession => {
  const shortlist = session.auto?.shortlist;
  return shortlist ? { ...session, auto: { ...session.auto, shortlist: { ...shortlist, narrowed: { createdAt: now, target, ids } } } } : session;
};

export const clearBuildShortlist = (session: BuildSession): BuildSession => {
  if (!session.auto?.shortlist) return session;
  const { shortlist: _removed, ...auto } = session.auto;
  void _removed;
  return { ...session, auto };
};

export const selectBuildQueue = <T extends BuildCandidate>(session: BuildSession, items: T[]): T[] => {
  const byId = new Map(items.map((item) => [getBuildAssetId(item), item]));
  const active = session.filter === 'shortlisted' || session.filter === 'picked' ? getActiveShortlist(session, byId) : null;
  const shortlisted = session.filter === 'shortlisted' ? new Set(active?.entries.map(({ entry }) => entry.id))
    : session.filter === 'picked' ? new Set(active?.narrowed.map(getBuildAssetId)) : null;
  return session.order.flatMap<T>((id) => {
    const item = byId.get(id);
    const record = session.records[id];
    if (!item || !record) return [];
    if (shortlisted && !shortlisted.has(id)) return [];
    if (isStatusFilter(session.filter) && !matchesStatusFilter(session.filter, getImageStatus(record, item, record.outputAssetId ? byId.get(record.outputAssetId) : undefined), record)) return [];
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
  const firstById = firstItemById(items);
  let ready = 0; let saving = 0; let unresolved = 0; let errors = 0;
  for (const id of session.order) {
    const item = byId.get(id); const record = session.records[id];
    if (!record) { errors += 1; continue; }
    if (!item) { if (record.decision !== 'skipped') errors += 1; continue; }
    if (record.application === 'pending') saving += 1;
    if (record.application === 'failed' || record.validation === 'error') errors += 1;
    const physicalItem = record.outputAssetId
      ? firstById.get(record.outputAssetId)
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
    const locator = record.locator ? applyExplorerPathMoves(record.locator, moves) : record.locator;
    const origin = record.origin ? applyExplorerPathMoves(record.origin, moves) : record.origin;
    if (locator === record.locator && origin === record.origin) return [id, record];
    changed = true;
    return [id, { ...record, ...(locator ? { locator } : {}), ...(origin ? { origin } : {}) }];
  }));
  const sources = session.profile.sources?.map((path) => applyExplorerPathMoves(path, moves));
  const sourcesChanged = Boolean(sources && sources.some((path, index) => path !== session.profile.sources![index]));
  return changed || sourcesChanged
    ? { ...session, records, ...(sourcesChanged ? { profile: { ...session.profile, sources: [...new Set(sources)] } } : {}) } : session;
};

export const getBuildValidation = (item: BuildCandidate, captionRequired: boolean): BuildValidationStatus => {
  if (item.kind === 'video') return 'pending';
  if (captionRequired && !(item.tags?.length)) return 'pending';
  return 'valid';
};

export type ImageStatus =
  | { kind: 'in'; pinned: boolean }
  | { kind: 'out'; reason: 'ban' | 'quality' | 'duplicate' | 'not-selected'; of?: string; similarity?: number }
  | { kind: 'inbox'; pending?: boolean; needsFrames?: boolean };

/**
 * The single status of an image. Only `record.override` is set by the user; the rest is derived. First match wins:
 * Dataset membership, Ban, no verdict yet, quality rejection (unless pinned), the last Assemble outcome, otherwise inbox.
 * `outputItem` is the transformed output Build created for the image, if any.
 */
export const getImageStatus = (record: BuildReviewRecord | undefined, item: BuildCandidate, outputItem?: BuildCandidate): ImageStatus => {
  const pinned = record?.override === 'pin';
  if (isProjectDatasetPath(item.assetPath) || isProjectDatasetPath(outputItem?.assetPath)) return { kind: 'in', pinned };
  if (record?.override === 'ban') return { kind: 'out', reason: 'ban' };
  if (item.kind === 'video') return { kind: 'inbox', needsFrames: true };
  const triage = record?.triage;
  if (!triage) return { kind: 'inbox', pending: true };
  // An assembly-stage proposal replaced the quality verdict; the assembly outcome explains it instead.
  if (triage.group === 'rejected' && triage.stage === 'quality' && !pinned) return { kind: 'out', reason: 'quality' };
  const assembly = record?.assembly;
  if (assembly && !pinned && assembly.revision === triage.revision) {
    return { kind: 'out', reason: assembly.outcome, ...(assembly.of ? { of: assembly.of } : {}), ...(assembly.similarity !== undefined ? { similarity: assembly.similarity } : {}) };
  }
  return { kind: 'inbox' };
};

const isStatusFilter = (filter: BuildSession['filter']): filter is Extract<BuildSession['filter'], `status-${string}`> => filter.startsWith('status-');

const matchesStatusFilter = (filter: Extract<BuildSession['filter'], `status-${string}`>, status: ImageStatus, record: BuildReviewRecord): boolean => {
  switch (filter) {
    case 'status-inbox': return status.kind === 'inbox';
    case 'status-out': return status.kind === 'out';
    case 'status-in-dataset': return status.kind === 'in';
    case 'status-pinned': return record.override === 'pin';
    case 'status-banned': return record.override === 'ban';
  }
};
