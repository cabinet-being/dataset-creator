import { Ban, Check, Minus, Pin } from 'lucide-react';
import type { StatusLabel, StatusTone } from '../../lib/imageStatusLabels';
import { cn } from '../../lib/utils';

const TONE_CLASS: Record<StatusTone, string> = {
  in: 'bg-primary text-primary-foreground',
  pinned: 'bg-primary text-primary-foreground',
  out: 'bg-background/90 text-muted-foreground ring-1 ring-border',
  banned: 'bg-background/90 text-muted-foreground ring-1 ring-border line-through',
  inbox: 'bg-background/90 text-foreground ring-1 ring-border',
};

const ICON = { in: Check, pinned: Pin, out: Minus, banned: Ban, inbox: null } as const;

/** Status as text plus an icon, so it never relies on colour alone. */
export function StatusBadge({ label, className }: { label: Pick<StatusLabel, 'badge' | 'tone'>; className?: string }) {
  const Icon = ICON[label.tone];
  return <span data-status-badge={label.badge} data-tone={label.tone}
    className={cn('inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium', TONE_CLASS[label.tone], className)}>
    {Icon && <Icon aria-hidden className="h-3 w-3" />}{label.badge}
  </span>;
}
