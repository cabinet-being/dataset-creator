import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Check, ChevronDown, ChevronUp, ImageIcon, Loader2, X } from 'lucide-react';
import type { BuildReviewDecision, BuildSession } from '../../types';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import type { SimilarityFeatures } from '../../services/similarity/useSimilarityFeatures';
import type { SimilarityStrictnessId } from '../../services/similarity/similarityLevels';
import {
  getBuildClusterStatus, selectClusterActionTargets, type BuildCluster, type ClusterAction,
} from '../../services/build/buildClusterService';
import { getBuildAssetId } from '../../services/build/buildSessionService';
import { SimilarityStrictnessControl } from '../tools/SimilarityReviewTool';
import { useCommands } from '../workspace/Commands';
import { useBuildClusters } from './useBuildClusters';

type Props = {
  active: boolean;
  root: RefObject<HTMLElement>;
  features: SimilarityFeatures;
  /** Build candidates (source materials) in session order. */
  candidates: WorkspaceImage[];
  session: BuildSession;
  minShortSide: number;
  busy: boolean;
  onCommit: (entries: Array<{ item: WorkspaceImage; decision: BuildReviewDecision }>) => Promise<void> | void;
  /** Leaves the cluster view and selects the image in the list. */
  onOpenItem: (id: string) => void;
};

const itemName = (item: WorkspaceImage) => item.originalFileName || item.fileName;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Reviews Build candidates in groups of similar images instead of one by one. */
export function BuildClusterView({ active, root, features, candidates, session, minShortSide, busy, onCommit, onOpenItem }: Props) {
  const [strictness, setStrictness] = useState<SimilarityStrictnessId>('balanced');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | undefined>();
  const itemsById = useMemo(() => new Map(candidates.map((item) => [item.id, item])), [candidates]);
  const ids = useMemo(() => candidates.filter((item) => item.kind !== 'video').map((item) => item.id), [candidates]);
  const { result, state, progress, error } = useBuildClusters({ active, ids, features, strictness });
  const near = result?.nearDuplicateGroups ?? [];
  const themes = result?.themes ?? [];
  const flat = useMemo(() => [...near, ...themes], [near, themes]);
  const focusIndex = Math.max(0, flat.findIndex((cluster) => cluster.id === focusId));
  const focused = flat[focusIndex];

  const previewItems = useMemo(() => {
    const wanted = new Set<string>();
    for (const cluster of flat) {
      wanted.add(cluster.medoidId);
      if (expanded.has(cluster.id)) for (const id of cluster.memberIds) wanted.add(id);
    }
    return [...wanted].flatMap((id) => { const item = itemsById.get(id); return item ? [item] : []; });
  }, [expanded, flat, itemsById]);
  const previews = useWorkspacePreviewUrls(previewItems);

  const act = (cluster: BuildCluster | undefined, action: ClusterAction) => {
    if (!cluster || busy) return;
    const entries = selectClusterActionTargets(cluster, itemsById, session, action, minShortSide);
    if (entries.length) void onCommit(entries);
  };
  const toggle = (cluster: BuildCluster | undefined) => {
    if (!cluster) return;
    setExpanded((value) => { const next = new Set(value); if (next.has(cluster.id)) next.delete(cluster.id); else next.add(cluster.id); return next; });
  };
  const move = (step: number) => { const next = flat[Math.max(0, Math.min(flat.length - 1, focusIndex + step))]; if (next) setFocusId(next.id); };

  useCommands([
    { id: 'build.cluster.next', label: 'Build clusters: Next cluster', shortcut: 'J', active, disabled: focusIndex >= flat.length - 1, run: () => move(1) },
    { id: 'build.cluster.previous', label: 'Build clusters: Previous cluster', shortcut: 'K', active, disabled: focusIndex <= 0, run: () => move(-1) },
    { id: 'build.cluster.accept', label: 'Build clusters: Accept all', shortcut: 'A', active, disabled: busy || !focused, run: () => act(focused, 'accept') },
    { id: 'build.cluster.reject', label: 'Build clusters: Reject all', shortcut: 'X', active, disabled: busy || !focused, run: () => act(focused, 'reject') },
    { id: 'build.cluster.keep-best', label: 'Build clusters: Keep best', shortcut: 'B', active, disabled: busy || !focused, run: () => act(focused, 'keep-best') },
    { id: 'build.cluster.expand', label: 'Build clusters: Expand or collapse', shortcut: 'Enter', active, disabled: !focused, run: () => toggle(focused) },
  ], () => root.current);

  const cardRefs = useRef(new Map<string, HTMLElement>());
  useEffect(() => { if (focused) cardRefs.current.get(focused.id)?.scrollIntoView?.({ block: 'nearest' }); }, [focused?.id]);

  const renderCard = (cluster: BuildCluster) => {
    const status = getBuildClusterStatus(cluster, itemsById, session);
    const medoid = itemsById.get(cluster.medoidId);
    const open = expanded.has(cluster.id);
    const isFocused = focused?.id === cluster.id;
    return <article
      key={cluster.id}
      ref={(node) => { if (node) cardRefs.current.set(cluster.id, node); else cardRefs.current.delete(cluster.id); }}
      data-testid="build-cluster-card"
      data-cluster-id={cluster.id}
      data-cluster-kind={cluster.kind}
      data-cluster-size={cluster.memberIds.length}
      data-focused={isFocused}
      aria-label={`${cluster.kind === 'theme' ? 'Theme' : 'Near-duplicate'} cluster of ${plural(cluster.memberIds.length, 'image')}`}
      onClick={() => setFocusId(cluster.id)}
      className={`rounded-lg border p-3 ${isFocused ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
    >
      <div className="flex gap-3">
        <div className="flex h-28 w-36 shrink-0 items-center justify-center overflow-hidden rounded bg-secondary">
          {medoid && previews[medoid.id] ? <img src={previews[medoid.id]} alt={itemName(medoid)} className="h-full w-full object-cover" /> : <ImageIcon className="h-6 w-6 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1 space-y-2 text-xs">
          <p className="font-medium" data-testid="build-cluster-size">{plural(cluster.memberIds.length, 'image')} · {Math.round(cluster.avgSimilarity * 100)}% similar</p>
          <p className="text-muted-foreground" data-testid="build-cluster-status">
            Accepted {status.accepted} · rejected {status.rejected} · undecided {status.undecided} · in Dataset {status.inDataset}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="build-cluster-accept" disabled={busy} onClick={(event) => { event.stopPropagation(); act(cluster, 'accept'); }} className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40">Accept all · A</button>
            <button type="button" data-testid="build-cluster-reject" disabled={busy} onClick={(event) => { event.stopPropagation(); act(cluster, 'reject'); }} className="rounded border border-border px-2 py-1 disabled:opacity-40">Reject all · X</button>
            <button type="button" data-testid="build-cluster-keep-best" disabled={busy} onClick={(event) => { event.stopPropagation(); act(cluster, 'keep-best'); }} className="rounded border border-border px-2 py-1 disabled:opacity-40">Keep best · B</button>
            <button type="button" data-testid="build-cluster-expand" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setFocusId(cluster.id); toggle(cluster); }} className="flex items-center gap-1 rounded border border-border px-2 py-1">
              {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{open ? 'Collapse' : 'Expand'}
            </button>
          </div>
        </div>
      </div>
      {open && <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
        {cluster.memberIds.map((id) => {
          const item = itemsById.get(id);
          if (!item) return null;
          const record = session.records[getBuildAssetId(item)];
          return <li key={id} data-testid="build-cluster-member" data-member-id={id} data-decision={record?.decision ?? 'unreviewed'} className="space-y-1 rounded border border-border p-1 text-[11px]">
            <div className="h-20 overflow-hidden rounded bg-secondary">{previews[id] ? <img src={previews[id]} alt={itemName(item)} className="h-full w-full object-cover" /> : null}</div>
            <p className="truncate" title={itemName(item)}>{itemName(item)}{id === cluster.medoidId ? ' · representative' : ''}</p>
            <p className="text-muted-foreground capitalize">{record?.decision === 'unreviewed' || !record ? (record?.triage?.group ?? 'pending').replace('-', ' ') : record.decision}</p>
            <div className="flex gap-1">
              <button type="button" aria-label={`Accept ${itemName(item)}`} data-testid="build-cluster-member-accept" disabled={busy || item.kind === 'video'} onClick={() => void onCommit([{ item, decision: 'accepted' }])} className="rounded bg-primary p-1 text-primary-foreground disabled:opacity-40"><Check className="h-3 w-3" /></button>
              <button type="button" aria-label={`Reject ${itemName(item)}`} data-testid="build-cluster-member-reject" disabled={busy} onClick={() => void onCommit([{ item, decision: 'skipped' }])} className="rounded border border-border p-1 disabled:opacity-40"><X className="h-3 w-3" /></button>
              <button type="button" data-testid="build-cluster-member-open" onClick={() => onOpenItem(id)} className="rounded border border-border px-1 underline">Open in list</button>
            </div>
          </li>;
        })}
      </ul>}
    </article>;
  };

  const vendi = result?.vendi;
  return <div data-testid="build-cluster-view" className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
    <div className="flex flex-wrap items-start gap-4">
      <SimilarityStrictnessControl value={strictness} onChange={setStrictness} features={features} className="max-w-sm flex-1" />
      <div className="space-y-1 text-xs text-muted-foreground">
        {state === 'computing' && <p role="status" data-testid="build-cluster-progress" className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Grouping {plural(progress.total, 'image')}…</p>}
        {state === 'error' && <p role="alert" className="text-destructive">{error}</p>}
        {vendi && <p data-testid="build-cluster-vendi">Near-duplicates: {plural(near.length, 'group')}, {vendi.removable} redundant; effective size (Vendi, DINOv2) {vendi.before.toFixed(1)} → {vendi.after.toFixed(1)} if one per group is kept.</p>}
        <p>Keys: J/K next or previous cluster · A accept all · X reject all · B keep best · Enter expand.</p>
      </div>
    </div>

    <section aria-label="Near-duplicates" className="space-y-2">
      <h2 className="text-sm font-semibold">Near-duplicates ({near.length})</h2>
      {features.basis !== 'dinov2' && <p className="text-xs text-muted-foreground">Without DINOv2 only exact duplicates (identical files) are grouped.</p>}
      {state === 'ready' && !near.length && <p data-testid="build-cluster-empty-near" className="text-xs text-muted-foreground">No near-duplicate groups found.</p>}
      <div className="grid gap-3">{near.map(renderCard)}</div>
    </section>

    <section aria-label="Theme clusters" className="space-y-2">
      <h2 className="text-sm font-semibold">Theme clusters ({themes.length})</h2>
      {features.basis !== 'dinov2'
        ? <p data-testid="build-cluster-needs-dinov2" className="text-xs text-muted-foreground">Theme clusters need DINOv2 image features. Download the model above to group images by subject and scene.</p>
        : strictness === 'strict'
          ? <p className="text-xs text-muted-foreground">Strict shows only near-duplicates. Move the slider towards Loose to group images by theme.</p>
          : state === 'ready' && !themes.length && <p className="text-xs text-muted-foreground">No theme clusters at this strictness.</p>}
      {!!result?.unclusteredIds.length && <p className="text-xs text-muted-foreground" data-testid="build-cluster-unclustered">{plural(result.unclusteredIds.length, 'image')} not in any theme cluster.</p>}
      <div className="grid gap-3">{themes.map(renderCard)}</div>
    </section>
  </div>;
}
