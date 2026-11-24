import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { filterCount, flushSave, openPrepared, sessionOf } from './nextFlow';

// Settings of the next UI (tests/next-browser.tsx): the header button and the command open the shared dialog, and the project's Similarity
// strictness is written to the profile.
const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Interface' });

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
