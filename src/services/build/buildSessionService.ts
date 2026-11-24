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
  BuildTransformRecipe,
  BuildValidationStatus,
} from '../../types';
import { createBuildSession } from '../../types';

export { createBuildSession };
import type { ExplorerPathMove } from '../../lib/datasetAssets';
import { applyExplorerPathMoves } from '../../lib/datasetAssets';

export type BuildCandidate = Pick<WorkspaceImage,
  'id' | 'sourceImageId' | 'editedAssetId' | 'assetPath' | 'fileName' | 'kind' | 'tags' | 'byteSize' | 'modifiedAt'
> & { stableId?: string };

const TRIAGE_GROUPS = ['accepted', 'rejected', 'needs-decision'];

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

/** `auto.shortlist` belonged to the removed pick flow; it is dropped on load. */
const normalizeAuto = (auto: NonNullable<BuildSession['auto']>): NonNullable<BuildSession['auto']> => {
  const { shortlist: _shortlist, ...rest } = auto as NonNullable<BuildSession['auto']> & { shortlist?: unknown };
  void _shortlist;
  return rest;
};

export const normalizeBuildSession = (value: unknown): BuildSession => {
  const defaults = createBuildSession();
  if (!value || typeof value !== 'object') return defaults;
  const input = value as Partial<BuildSession>;
  if (input.version !== 1 && input.version !== 2) return defaults;
  const migrate = input.version === 1;
  const records = Object.fromEntries(Object.entries(input.records ?? {}).filter(([, record]) => isRecord(record)).map(([id, record]) => [id, normalizeRecord(record, migrate)]));
  const sources = Array.isArray(input.profile?.sources) ? [...new Set(input.profile.sources.filter((path): path is string => typeof path === 'string' && Boolean(path)))] : undefined;
  const strictness = SIMILARITY_STRICTNESS.find((entry) => entry.id === input.profile?.similarityStrictness)?.id;
  return {
    version: 2,
    profile: {
      target: Math.max(0, Math.floor(Number(input.profile?.target) || defaults.profile.target)),
      captionRequired: input.profile?.captionRequired !== false,
      transform: input.profile?.transform,
      ...(input.profile?.sizeMode === 'auto' ? { sizeMode: 'auto' as const } : {}),
      ...(sources ? { sources } : {}),
      ...(strictness ? { similarityStrictness: strictness } : {}),
    },
    order: [...new Set((input.order ?? []).filter((id): id is string => typeof id === 'string'))],
    records,
    lastExport: input.lastExport,
    ...(input.auto && typeof input.auto === 'object' ? { auto: normalizeAuto(input.auto) } : {}),
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
  if (order.length === session.order.length && order.every((id, index) => id === session.order[index]) &&
    Object.keys(records).every((id) => records[id] === session.records[id])) return current;
  return { ...session, order, records };
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

/** Drops deleted folders (and anything under them) from the Sources the session was built from. */
export const removeBuildSessionSources = (session: BuildSession, deletedPaths: string[]): BuildSession => {
  const sources = session.profile.sources;
  if (!sources) return session;
  const kept = sources.filter((path) => !deletedPaths.some((deleted) => path === deleted || path.startsWith(`${deleted}/`)));
  return kept.length === sources.length ? session : { ...session, profile: { ...session.profile, sources: kept } };
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
