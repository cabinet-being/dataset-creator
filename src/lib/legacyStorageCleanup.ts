const LEGACY_KEYS = [
  'dataset-creator-ui-mode',
  'dataset-creator-workspace-v2',
  'dataset-creator-workspace-layout',
  'dataset-creator-docking-v1',
  'dataset-creator-density',
  'dataset-creator-workspace-tab',
];
const SHORTCUTS_KEY = 'dataset-creator-shortcuts-v1';
const REVIEW_VIEW_PREFIX = 'review-view:';

/** Removes the browser settings the old interface left behind; safe to run on every start. The theme and shortcut preferences stay. */
export function cleanupLegacyStorage(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage) {
  if (!storage) return;
  try {
    for (const key of LEGACY_KEYS) storage.removeItem(key);
    const reviewKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(REVIEW_VIEW_PREFIX)) reviewKeys.push(key);
    }
    for (const key of reviewKeys) storage.removeItem(key);
    const raw = storage.getItem(SHORTCUTS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, unknown> | null;
      if (saved && typeof saved === 'object' && 'bindings' in saved) {
        const { bindings: _bindings, ...rest } = saved;
        storage.setItem(SHORTCUTS_KEY, JSON.stringify(rest));
      }
    }
  } catch { /* storage unavailable or malformed */ }
}
