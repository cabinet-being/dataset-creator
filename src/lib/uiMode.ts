export type UiMode = 'classic' | 'next';

export const UI_MODE_STORAGE_KEY = 'dataset-creator-ui-mode';

const toMode = (value: string | null | undefined): UiMode | null =>
  value === 'next' || value === 'classic' ? value : null;

/** `?ui=` wins over the stored setting; classic is the default. */
export function resolveUiMode(search: string, stored: string | null | undefined): UiMode {
  return toMode(new URLSearchParams(search).get('ui')) ?? toMode(stored) ?? 'classic';
}

export function readUiMode(): UiMode {
  let stored: string | null = null;
  try { stored = localStorage.getItem(UI_MODE_STORAGE_KEY); } catch { /* storage unavailable */ }
  return resolveUiMode(typeof location === 'undefined' ? '' : location.search, stored);
}

/** Persists the choice; the caller reloads so only one UI is ever mounted. A `?ui=` URL parameter is dropped so it cannot override it. */
export function setUiMode(mode: UiMode, reload: () => void = () => location.reload()) {
  try { localStorage.setItem(UI_MODE_STORAGE_KEY, mode); } catch { /* storage unavailable */ }
  const url = new URL(location.href);
  if (url.searchParams.has('ui')) {
    url.searchParams.delete('ui');
    history.replaceState(history.state, '', url);
  }
  reload();
}
