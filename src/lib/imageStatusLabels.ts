import type { BuildReviewRecord } from '../types';
import type { ImageStatus } from '../services/build/buildSessionService';

export type StatusTone = 'in' | 'pinned' | 'out' | 'banned' | 'inbox';

export type StatusLabel = {
  /** Short text of the badge; the colour is never the only carrier of the status. */
  badge: string;
  tone: StatusTone;
  /** Out and Banned images are shown dimmed. */
  muted: boolean;
  /** One sentence for the tooltip and the lightbox. */
  reason: string;
};

export type BoardFilter = 'all' | 'in' | 'out' | 'pinned' | 'banned';
export const BOARD_FILTERS: readonly BoardFilter[] = ['all', 'in', 'out', 'pinned', 'banned'];

/** Same meaning as the `status-*` Build filters, evaluated on an already computed status. */
export const matchesBoardFilter = (filter: BoardFilter, status: ImageStatus, record: BuildReviewRecord | undefined): boolean => {
  switch (filter) {
    case 'all': return true;
    case 'in': return status.kind === 'in';
    case 'out': return status.kind === 'out';
    case 'pinned': return record?.override === 'pin';
    case 'banned': return record?.override === 'ban';
  }
};

/** For every kept image, how many others Assemble left out as its duplicates (reverse of `assembly.of`). */
export const buildKeptDuplicateCounts = (records: Readonly<Record<string, BuildReviewRecord>>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const record of Object.values(records)) {
    const kept = record.assembly?.outcome === 'duplicate' ? record.assembly.of : undefined;
    if (kept) counts.set(kept, (counts.get(kept) ?? 0) + 1);
  }
  return counts;
};

type DescribeOptions = {
  record?: BuildReviewRecord;
  /** Result of `buildKeptDuplicateCounts` for this image's asset id. */
  keptDuplicates?: number;
  /** Display name of an asset id, for "Duplicate of …". */
  nameOf?: (assetId: string) => string | undefined;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Badge text, tone and explanation of an image status, from the status, `triage.reasons` and `assembly.of`. */
export const describeImageStatus = (status: ImageStatus, { record, keptDuplicates = 0, nameOf }: DescribeOptions = {}): StatusLabel => {
  switch (status.kind) {
    case 'in': {
      if (status.pinned) return { badge: 'Pinned', tone: 'pinned', muted: false, reason: 'Pinned by you: stays in the dataset when you assemble again.' };
      const reason = keptDuplicates > 0
        ? `Best of its group: ${plural(keptDuplicates, 'similar frame was', 'similar frames were')} left out.`
        : 'In the dataset.';
      return { badge: 'In', tone: 'in', muted: false, reason };
    }
    case 'out': {
      if (status.reason === 'ban') return { badge: 'Banned', tone: 'banned', muted: true, reason: 'Banned by you: never added to the dataset.' };
      if (status.reason === 'quality') {
        const messages = record?.triage?.reasons.map(reason => reason.message).filter(Boolean) ?? [];
        return { badge: 'Out', tone: 'out', muted: true, reason: messages.length ? `Quality: ${messages.join('; ')}.` : 'Did not pass the quality check.' };
      }
      if (status.reason === 'duplicate') {
        const name = status.of ? nameOf?.(status.of) : undefined;
        const similarity = status.similarity !== undefined ? ` (${Math.round(status.similarity * 100)}% similar)` : '';
        return { badge: 'Out', tone: 'out', muted: true, reason: `Duplicate of ${name ?? 'a better frame'}${similarity}.` };
      }
      return { badge: 'Out', tone: 'out', muted: true, reason: 'Not selected: Assemble kept frames that cover the dataset better.' };
    }
    case 'inbox':
      if (status.needsFrames) return { badge: 'Inbox', tone: 'inbox', muted: false, reason: 'Video: extract frames to use it.' };
      if (status.pending) return { badge: 'Inbox', tone: 'inbox', muted: false, reason: 'Not analyzed yet.' };
      return { badge: 'Inbox', tone: 'inbox', muted: false, reason: 'Waiting for Assemble.' };
  }
};
