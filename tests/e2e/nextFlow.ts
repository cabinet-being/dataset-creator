import type { Page } from '@playwright/test';
import { expect } from './fixtures';

// Helpers for tests/next-browser.tsx (the real NextApp over OPFS with a substituted folder picker).
export type Kind = 'sources' | 'grid' | 'big' | 'assemble';
export type Status = 'pin' | 'ban' | 'quality' | 'not-selected' | { duplicateOf: string };
export type SessionView = { sources?: string[]; strictness?: string; assembledAt?: string; records: Record<string, { override?: string; origin?: string; locator?: string }> };

export const next = <T, A = undefined>(page: Page, run: (api: Record<string, (...args: never[]) => unknown>, arg: A) => T | Promise<T>, arg?: A) =>
  page.evaluate(`(${run.toString()})(window.__next, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

export const sessionOf = (page: Page) => next<SessionView>(page, api => api.session() as SessionView);

/** Writes a project of `kind` to OPFS, opens it through "Open folder…" and waits for the Board. */
export async function openPrepared(page: Page, kind: Kind, name: string, options: { fakeModel?: boolean } = {}) {
  await page.goto('/tests/next-browser.html');
  await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
  if (options.fakeModel) await page.evaluate('window.__next.fakeModelPresent()');
  await page.evaluate(`window.__next.prepare(${JSON.stringify(kind)}, ${JSON.stringify(name)})`);
  await page.getByRole('button', { name: /Open folder/ }).click();
  await expect(page.locator('[data-board]')).toBeVisible({ timeout: 30_000 });
}

/** Count shown on a filter chip of the grid. */
export const filterCount = (page: Page, filter: string) => page.locator(`[data-frame-grid] [data-filter="${filter}"] [data-filter-count]`);

export async function seedStatuses(page: Page, spec: Record<string, Status>) {
  await page.evaluate(`window.__next.seedStatuses(${JSON.stringify(spec)})`);
}

/** Writes pending autosave data to disk so a reload sees what the test changed. */
export const flushSave = (page: Page) => page.evaluate('window.__next.flush()');

/** The tile of a frame by file name. */
export const tileOf = (page: Page, name: string) => page.locator('[data-frame-tile]').filter({ has: page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) }) });

export const undoDepth = (page: Page) => next<number>(page, api => api.undoDepth() as number);
export const projectPaths = (page: Page) => next<string[]>(page, api => api.paths() as string[]);

/** Paths of the files in `dataset/`, by file name. */
export async function datasetNames(page: Page) {
  return (await projectPaths(page)).filter(path => /^Project\/dataset\//.test(path)).map(path => path.split('/').pop()!).sort();
}

/** Mod+Z once the history is free (a membership action keeps `history.busy` until its files are moved), then waits for the undo to finish. */
export async function undoOnce(page: Page) {
  await expect.poll(() => next<boolean>(page, api => api.historyBusy() as boolean), { timeout: 20_000 }).toBe(false);
  const before = await undoDepth(page);
  await page.keyboard.press('Control+z');
  await expect.poll(() => undoDepth(page), { timeout: 20_000 }).toBe(before - 1);
  await expect.poll(() => next<boolean>(page, api => api.historyBusy() as boolean), { timeout: 20_000 }).toBe(false);
}
