import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

type InspectorSectionProps = {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const InspectorSection = ({
  title,
  children,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
}: InspectorSectionProps) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (nextOpen: boolean) => {
    if (openProp === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <section className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-6 w-full items-center gap-1 rounded px-1 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground hover:bg-secondary"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      <div hidden={!open} className="space-y-2 px-1 pb-2 pt-1">
        {children}
      </div>
    </section>
  );
};
