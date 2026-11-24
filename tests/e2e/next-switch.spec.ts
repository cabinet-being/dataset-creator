import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { datasetNames, filterCount, flushSave, next, openPrepared, seedStatuses, sessionOf, tileOf } from './nextFlow';

// Switching projects through the Projects button: the old project does not leak into the new one, and its change is saved.
// A = "grid" fixture (inbox/new1 is Pinned during the test), B = "sources" fixture (no Board statuses at all).

const overridesOf = async (page: Page) => Object.fromEntries(Object.entries((await sessionOf(page)).records).filter(([, record]) => record.override).map(([name, record]) => [name, record.override]));
const manifestOf = async (page: Page) => JSON.parse((await next<string | null>(page, api => api.readText('.datasetcreator/project.json') as Promise<string | null>))!);

test('a Pin made in A (not flushed by the test) is saved on switching and B starts clean; reopening A shows the Pin', async ({ page }) => {
  await openPrepared(page, 'grid', 'Alpha');
  await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
  await seedStatuses(page, { 'ban1.png': 'ban' });
  await page.getByRole('button', { name: /^Select new1\.png/ }).click();
  await page.locator('[data-bulk-action="pin"]').click();
  await expect(tileOf(page, 'new1.png')).toHaveAttribute('data-status', 'Pinned', { timeout: 15_000 });
  expect(await overridesOf(page)).toEqual({ 'ban1.png': 'ban', 'new1.png': 'pin' });

  // Straight to the list and to another project: no waiting for the autosave.
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.locator('[data-projects-screen]')).toBeVisible();
  await page.evaluate("window.__next.prepare('sources', 'Beta')");
  await page.getByRole('button', { name: /Open folder/ }).click();
  await expect(page.locator('[data-board]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-next-project-name]')).toHaveText('Beta');
  await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
  await expect(page.locator('[data-count-dataset]')).toHaveText('1');
  expect(await overridesOf(page), 'B holds nothing from A').toEqual({});
  expect(Object.keys((await sessionOf(page)).records).every(name => ['a.png', 'b.png', 'c.png', 'd.png'].includes(name)), 'only B files in the session').toBe(true);
  expect(await datasetNames(page)).toEqual(['d.png']);
  await flushSave(page);
  const beta = await manifestOf(page);
  expect(beta.project.name).toBe('Beta');
  expect(Object.values(beta.project.buildSession.records as Record<string, { locator: string; override?: string }>).filter(record => record.override || /new1|ban1/.test(record.locator))).toEqual([]);
  // Waiting past the autosave delay changes nothing either.
  await page.waitForTimeout(2_500);
  expect(await overridesOf(page)).toEqual({});

  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.locator('[data-recent-project="Alpha"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-recent-project="Alpha"] button').first().click();
  await expect(page.locator('[data-next-project-name]')).toHaveText('Alpha', { timeout: 30_000 });
  await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
  await expect(tileOf(page, 'new1.png')).toHaveAttribute('data-status', 'Pinned', { timeout: 15_000 });
  await expect(tileOf(page, 'ban1.png')).toHaveAttribute('data-status', 'Banned');
  expect(await overridesOf(page)).toEqual({ 'ban1.png': 'ban', 'new1.png': 'pin' });
  await expect(tileOf(page, 'a.png'), 'nothing of B in A').toHaveCount(0);
  expect(await datasetNames(page)).toContain('new1.png');
});
