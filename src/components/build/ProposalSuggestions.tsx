/** Tags suggested by the local caption model for one image, with a button that merges them into the caption draft. */
export function ProposalSuggestions({ tags, onMerge }: { tags: string[]; onMerge: () => void }) {
  if (!tags.length) return null;
  return <div data-testid="proposal-suggestions" className="rounded border border-primary/30 bg-primary/5 p-2 text-xs"><p className="font-medium">Local model suggestions</p><p className="mt-1 text-muted-foreground">{tags.join(', ')}</p><button type="button" className="mt-2 rounded border border-border px-2 py-1" onClick={onMerge}>Merge suggestions</button></div>;
}
