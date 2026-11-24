import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { filterCount, flushSave, openPrepared, sessionOf } from './nextFlow';

// Settings of the next UI (tests/next-browser.tsx): the header button and the command open the shared dialog, the project's Similarity strictness is
// written to the profile, and the interface switch stores the choice in localStorage and reloads. The stand always mounts NextApp, so after the
// reload only the stored mode and the URL are observable, not the other UI.
const STORAGE_KEY = 'dataset-creator-ui-mode';
const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Interface' });
const stored = (page: Page) => page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);

async function projectsScreen(page: Page, search = '') {
  await page.goto(`/tests/next-browser.html${search}`);
  await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
}

test.describe('on the Projects screen', () => {
  test('the Settings button opens the dialog without the project strictness; Escape closes it', async ({ page }) => {
    await projectsScreen(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByLabel('Similarity strictness'), 'no project, no strictness').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Video Frames' }), 'the next UI has no tool tabs').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Caption' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('the Settings command from the palette opens the dialog', async ({ page }) => {
    await projectsScreen(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').or(page.getByRole('textbox')).first().fill('Settings');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
  });

  test('Classic UI stores the choice, drops ?ui= from the URL and reloads', async ({ page }) => {
    await projectsScreen(page, '?ui=next');
    expect(await stored(page)).toBeNull();
    await page.getByRole('button', { name: 'Settings' }).click();
    const marker = await page.evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; return 1; });
    expect(marker).toBe(1);
    const reloaded = page.waitForEvent('load');
    await page.getByRole('switch', { name: 'Classic UI' }).click();
    await reloaded;
    await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker), 'the page really reloaded').toBeUndefined();
    expect(await stored(page)).toBe('classic');
    expect(new URL(page.url()).search, '?ui=next would override the stored choice').toBe('');
    // The dialog now offers the way back.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('switch', { name: 'Try the new UI' })).toBeVisible();
  });

  test('with the new UI stored (no URL parameter) the switch says Classic UI; "Try the new UI" stores next', async ({ page }) => {
    await projectsScreen(page);
    await page.evaluate(key => localStorage.setItem(key, 'next'), STORAGE_KEY);
    await page.reload();
    await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('switch', { name: 'Classic UI' })).toBeVisible();
    const reloaded = page.waitForEvent('load');
    await page.getByRole('switch', { name: 'Classic UI' }).click();
    await reloaded;
    expect(await stored(page)).toBe('classic');
    await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    const again = page.waitForEvent('load');
    await page.getByRole('switch', { name: 'Try the new UI' }).click();
    await again;
    expect(await stored(page)).toBe('next');
  });
});

test.describe('on the Board', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'grid', 'Settings Project');
    await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
  });

  test('the header button and the command open the dialog with the project strictness', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByLabel('Similarity strictness')).toHaveValue('balanced');
    await expect(page.getByLabel('Similarity strictness').locator('option')).toHaveText(['Strict', 'Balanced', 'Loose']);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').or(page.getByRole('textbox')).first().fill('Settings');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
  });

  test('Strictness is written to the project profile, follows the header select, and survives a reload', async ({ page }) => {
    expect((await sessionOf(page)).strictness, 'unset means Balanced').toBeUndefined();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Similarity strictness').selectOption('strict');
    await expect.poll(async () => (await sessionOf(page)).strictness).toBe('strict');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-strictness]'), 'the header select shows the same value').toHaveValue('strict');

    // The other way round: the header select moves the dialog value.
    await page.locator('[data-strictness]').selectOption('loose');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Similarity strictness')).toHaveValue('loose');
    await page.getByLabel('Similarity strictness').selectOption('strict');
    await expect.poll(async () => (await sessionOf(page)).strictness).toBe('strict');
    await page.keyboard.press('Escape');

    await flushSave(page);
    await page.reload();
    await expect(page.locator('[data-recent-project="Settings Project"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-recent-project="Settings Project"] button').first().click();
    await expect(page.locator('[data-board]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-strictness]')).toHaveValue('strict', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Similarity strictness')).toHaveValue('strict');
  });

});

test('Classic UI on the Board stores the choice, reloads to the Projects screen and keeps the project in the recent list', async ({ page }) => {
  await page.addInitScript(key => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, 'next'); } catch { /* cross-origin frame */ } }, STORAGE_KEY);
  await openPrepared(page, 'grid', 'Switch Project');
  await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Settings' }).click();
  await flushSave(page);
  const reloaded = page.waitForEvent('load');
  await page.getByRole('switch', { name: 'Classic UI' }).click();
  await reloaded;
  expect(await stored(page)).toBe('classic');
  await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-recent-project="Switch Project"]')).toBeVisible({ timeout: 20_000 });
});
