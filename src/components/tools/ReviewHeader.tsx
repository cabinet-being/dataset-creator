import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useId, useRef, useState, type ReactNode } from 'react';
import { ArrowUpDown, Check, ChevronDown, LayoutGrid, Plus, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';

export type ReviewFilterChip = { label: string; clear: () => void };

type Props = {
  context: string;
  count: number;
  total: number;
  query: string;
  onQueryChange: (query: string) => void;
  sort: string;
  sortOptions: { value: string; label: string }[];
  onSortChange: (value: string) => void;
  thumbnailSize: number;
  onThumbnailSizeChange: (size: number) => void;
  activeFilters: ReviewFilterChip[];
  onResetFilters: () => void;
  filters: ReactNode;
  onRefresh?: () => Promise<void>;
  onAddVisible?: () => void;
  previewStatus?: ReactNode;
};

export function ReviewHeader({ context, count, total, query, onQueryChange, sort, sortOptions, onSortChange,
  thumbnailSize, onThumbnailSizeChange, activeFilters, onResetFilters, filters, onRefresh, onAddVisible, previewStatus }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const filtersId = useId();
  const filtersTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const buttonClass = 'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm transition-colors hover:bg-secondary';

  return <header className="review-header min-w-0 space-y-3" aria-label="Review controls">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h2 className="shrink-0 text-base font-semibold">Review</h2>
        <span aria-hidden="true" className="text-border">/</span>
        <span className="truncate text-sm text-muted-foreground" title={context}>{context}</span>
      </div>
      <span role="status" className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {count === total ? `${count} ${count === 1 ? 'file' : 'files'}` : `${count} of ${total} files`}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label="View options" title="View options">
            <LayoutGrid className="h-4 w-4" aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content sideOffset={6} align="end" collisionPadding={8} className="z-[2100] min-w-44 rounded-lg border border-border bg-popover p-1 shadow-lg">
              <DropdownMenu.Label className="px-3 py-2 text-xs font-medium text-muted-foreground">Thumbnail size</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={String(thumbnailSize)} onValueChange={(value) => onThumbnailSizeChange(Number(value))}>
                {[[150, 'Small'], [210, 'Medium'], [300, 'Large']].map(([size, label]) => <DropdownMenu.RadioItem key={size} value={String(size)} className="flex items-center gap-2 rounded px-3 py-2 text-sm outline-none focus:bg-secondary">
                  <span className="h-4 w-4"><DropdownMenu.ItemIndicator><Check className="h-4 w-4" /></DropdownMenu.ItemIndicator></span>{label}
                </DropdownMenu.RadioItem>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {onRefresh && <button type="button" disabled={refreshing} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50" aria-label={refreshing ? 'Refreshing files' : 'Refresh files'} title="Refresh files" onClick={async () => {
          setRefreshing(true);
          try { await onRefresh(); } finally { setRefreshing(false); }
        }}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /></button>}
      </div>
    </div>

    <div className="review-header-toolbar flex min-w-0 flex-wrap items-center gap-2">
      <div className="review-header-search relative min-w-0 flex-1 basis-48">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input ref={searchInput} type="search" aria-label="Search review files" placeholder="Search files…" title="Search by name, path or caption" value={query} onChange={(event) => onQueryChange(event.target.value)} className="h-9 w-full min-w-0 rounded-md border border-border bg-card pl-9 pr-9 text-sm placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden" />
        {query && <button type="button" aria-label="Clear search" className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-secondary" onClick={() => { onQueryChange(''); searchInput.current?.focus(); }}><X className="h-3.5 w-3.5" aria-hidden="true" /></button>}
      </div>
      <button ref={filtersTrigger} type="button" aria-expanded={filtersOpen} aria-controls={filtersId} className={`${buttonClass} border ${filtersOpen || activeFilters.length ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-card'}`} onClick={() => setFiltersOpen(!filtersOpen)}>
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />Filters
        {activeFilters.length > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded bg-primary px-1 text-[11px] font-medium text-primary-foreground">{activeFilters.length}</span>}
      </button>
      <div className="relative min-w-0 shrink-0">
        <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <select aria-label="Sort review files" value={sort} onChange={(event) => onSortChange(event.target.value)} className="h-9 max-w-full appearance-none rounded-md border border-border bg-card pl-9 pr-8 text-sm">
          {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      </div>
      {onAddVisible && <button type="button" className={`${buttonClass} bg-primary font-medium text-primary-foreground hover:bg-primary/90`} onClick={onAddVisible}><Plus className="h-4 w-4" aria-hidden="true" />Add visible</button>}
    </div>

    {activeFilters.length > 0 && <div className="flex flex-wrap items-center gap-1.5" aria-label="Active review filters">
      {activeFilters.map((filter) => <button key={filter.label} type="button" onClick={filter.clear} aria-label={`Remove filter: ${filter.label}`} title={`Remove filter: ${filter.label}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
        <span className="truncate">{filter.label}</span><X className="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>)}
      <button type="button" onClick={onResetFilters} className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground">Clear filters</button>
    </div>}

    {filtersOpen && <section id={filtersId} aria-label="Review filters" className="rounded-lg border border-border bg-card p-4" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); setFiltersOpen(false); filtersTrigger.current?.focus(); }
    }}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Filters</h3>
        <button type="button" aria-label="Close filters" onClick={() => { setFiltersOpen(false); filtersTrigger.current?.focus(); }} className="rounded p-1 text-muted-foreground hover:bg-secondary"><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      {filters}
    </section>}
    {previewStatus}
  </header>;
}
