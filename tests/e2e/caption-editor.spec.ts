import { test, expect } from './fixtures';

test.describe('caption editor fixture', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/tests/caption-editor-browser.html'); });
  test('initial value', async ({ page }) => {
    await expect(page.getByLabel('Caption value')).toHaveText('subject_token, blue_eyes, portrait');
  });
  test('duplicate and missing-trigger warnings', async ({ page }) => {
    await page.getByRole('button', { name: 'Show duplicate example' }).click();
    await expect(page.getByText('Duplicate: blue_eyes')).toBeVisible();
    await page.getByRole('button', { name: 'Show missing trigger' }).click();
    await expect(page.getByText('Required: subject_token')).toBeVisible();
  });
  test('autocomplete accepts a suggestion with Tab', async ({ page }) => {
    const editor = page.getByRole('combobox', { name: 'Caption' });
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(', blue_h');
    await expect(page.getByRole('option', { name: /blue_hair/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Caption value')).toContainText('blue_hair');
  });
});
