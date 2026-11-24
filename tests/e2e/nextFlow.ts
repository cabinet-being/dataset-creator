import type { Page } from '@playwright/test';
import { expect } from './fixtures';

// Helpers for tests/next-browser.tsx (the real NextApp over OPFS with a substituted folder picker).
export type Kind = 'sources' | 'grid' | 'big';
export type Status = 'pin' | 'ban' | 'quality' | 'not-selected' | { duplicateOf: string };
export type SessionView = { sources?: string[]; records: Record<string, { override?: string; origin?: string; locator?: string }> };

export const next = <T, A = undefined>(page: Page, run: (api: Record<string, (...args: never[]) => unknown>, arg: A) => T | Promise<T>, arg?: A) =>
  page.evaluate(`(${run.toString()})(window.__next, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

export const sessionOf = (page: Page) => next<SessionView>(page, api => api.session() as SessionView);

/** Writes a project of `kind` to OPFS, opens it through "Open folder…" and waits for the Board. */
export async function openPrepared(page: Page, kind: Kind, name: string) {
  await page.goto('/tests/next-browser.html');
  await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
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
