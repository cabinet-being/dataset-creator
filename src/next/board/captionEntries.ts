import type { WorkspaceImage } from '../../lib/workspaceImages';
import { getBuildRecordForItem } from '../../services/build/buildSessionService';
import { applyCharacterTraits } from '../../services/tagging/characterTraits';
import { normalizeTag } from '../../services/quality/metrics/text';
import type { BuildSession, CharacterTrait } from '../../types';

/** Missing tags (no caption file) and `tags: []` (an empty caption) are different states. */
export type CaptionState = 'missing' | 'empty' | 'tagged';

export const getCaptionState = (item: Pick<WorkspaceImage, 'tags'>): CaptionState =>
  item.tags === undefined ? 'missing' : item.tags.length === 0 ? 'empty' : 'tagged';

/** Ids from `anchorId` to `targetId` inclusive, in list order; just the target when the anchor is not in the list. */
export const idsBetween = (ids: readonly string[], anchorId: string | null, targetId: string): string[] => {
  const from = anchorId ? ids.indexOf(anchorId) : -1;
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return to < 0 ? [] : [targetId];
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
};

/** The model suggestion of an item (character traits applied); empty when it is missing or made for another revision of the image. */
export const proposalTagsFor = (session: BuildSession, item: WorkspaceImage, traits: readonly CharacterTrait[]): string[] => {
  const record = getBuildRecordForItem(session, item);
  return record?.proposal && record.proposal.revision === record.revision ? applyCharacterTraits(record.proposal.tags, traits) : [];
};

/**
 * Items whose caption becomes their suggestion: only items with a suggestion, and, unless `overwrite`, only those without
 * a caption (missing or empty). The trigger word is never part of tags.
 */
export const planProposalApply = (items: readonly WorkspaceImage[], proposalFor: (item: WorkspaceImage) => string[], overwrite: boolean, triggerWord = ''): { item: WorkspaceImage; tags: string[] }[] => {
  const trigger = normalizeTag(triggerWord);
  const plan: { item: WorkspaceImage; tags: string[] }[] = [];
  for (const item of items) {
    if (!overwrite && item.tags?.length) continue;
    const tags = proposalFor(item).filter(tag => !trigger || normalizeTag(tag) !== trigger);
    if (tags.length) plan.push({ item, tags });
  }
  return plan;
};
