import type { FolderRow } from '../../lib/inboxFolders';
import { isInFolder } from '../../lib/inboxFolders';

type Props = {
  rows: FolderRow[];
  deselected: ReadonlySet<string>;
  onToggle: (folder: string) => void;
  label: string;
  emptyText: string;
  testId?: string;
};

/** Checkbox tree of folders; unchecking a folder unchecks its subfolders. */
export function FolderChecklist({ rows, deselected, onToggle, label, emptyText, testId }: Props) {
  if (!rows.length) return <p className="mt-1 text-muted-foreground">{emptyText}</p>;
  return <div role="group" aria-label={label} data-testid={testId} className="mt-1 max-h-40 overflow-auto rounded border border-border bg-background p-2">
    {rows.map((row) => {
      const family = rows.filter((other) => isInFolder(row.path, other.path));
      const checkedCount = family.filter((other) => !deselected.has(other.path)).length;
      return <label key={row.path} className="flex items-center gap-2 py-0.5" style={{ paddingLeft: row.depth * 16 }}>
        <input type="checkbox" checked={checkedCount === family.length} ref={(element) => { if (element) element.indeterminate = checkedCount > 0 && checkedCount < family.length; }} onChange={() => onToggle(row.path)} />
        <span className="truncate">{row.name}</span><span className="text-xs text-muted-foreground">{row.count}</span>
      </label>;
    })}
  </div>;
}
