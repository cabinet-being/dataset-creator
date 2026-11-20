type Props = { onConfirm: () => void; onCancel: () => void; testId?: string };

/** Inline confirmation shown before the DINOv2 image model is downloaded. */
export function ModelDownloadPrompt({ onConfirm, onCancel, testId }: Props) {
  return <div role="alert" data-testid={testId} className="flex flex-wrap items-center gap-2 rounded bg-amber-500/15 px-2 py-1 text-xs">
    <span>Needs the DINOv2 image model (~88 MB, downloaded once).</span>
    <button type="button" className="underline" onClick={onConfirm}>Download and continue</button>
    <button type="button" className="underline" onClick={onCancel}>Cancel</button>
  </div>;
}
