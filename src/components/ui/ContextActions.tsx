import type { ComponentType, MouseEvent, ReactNode } from 'react';

export type ContextAction = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  title?: string;
  variant?: 'default' | 'primary' | 'destructive';
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
};

export type ContextActionGroup = ContextAction[];

type ContextActionGroupsProps = {
  groups: ContextActionGroup[];
  mode?: 'menu' | 'inspector' | 'toolbar';
};

export const ContextActionGroups = ({ groups, mode = 'menu' }: ContextActionGroupsProps): ReactNode => {
  if (mode === 'toolbar') {
    return (
      <div className="flex flex-wrap gap-2">
        {groups.flat().map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              title={action.title}
              onClick={action.onSelect}
              className={`inline-flex items-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors ${
                action.variant === 'primary'
                  ? 'bg-primary text-primary-foreground hover:opacity-90'
                  : action.variant === 'destructive'
                    ? 'border border-destructive/30 text-destructive hover:bg-destructive/10'
                    : 'border border-border hover:bg-secondary'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{action.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  if (mode === 'inspector') {
    return (
      <div className="grid gap-2">
        {groups.flat().map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              title={action.title}
              onClick={action.onSelect}
              className={`flex w-full items-center gap-2 rounded border px-2 py-2 text-left font-medium transition-colors ${
                action.variant === 'primary'
                  ? 'border-primary bg-primary text-primary-foreground hover:opacity-90'
                  : action.variant === 'destructive'
                  ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
                  : 'border-border bg-background hover:bg-secondary'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{action.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <>
      {groups.map((group, groupIndex) => (
        <div key={group.map((action) => action.id).join('-') || groupIndex}>
          {groupIndex > 0 && group.length > 0 ? <div className="my-1 h-px bg-border" /> : null}
          {group.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                title={action.title}
                onClick={action.onSelect}
                className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left ${
                  action.variant === 'destructive'
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'hover:bg-secondary'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
};
