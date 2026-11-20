import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const openDialog = async (page: Page) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare folders fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Auto-select', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Auto-select' });
  await expect(dialog).toBeVisible();
  return dialog;
};

// The dialog creates the real semantic encoder (no injection point), so these scenarios stop before encoding.
test.describe('Auto-select dialog folder tree', () => {
  test('lists inbox folders with counts, all checked by default, and no coverage-text field', async ({ page }) => {
    const dialog = await openDialog(page);
    const tree = dialog.getByRole('group', { name: 'Include folders' });
    const row = (name: string) => tree.locator('label').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) });
    await expect(tree.locator('label')).toHaveCount(4);
    for (const [name, count] of [['inbox', '5'], ['a', '3'], ['sub', '1'], ['b', '1']] as const) {
      await expect(row(name), name).toContainText(count);
    }
    await expect(tree.getByRole('checkbox')).toHaveCount(4);
    for (const box of await tree.getByRole('checkbox').all()) await expect(box).toBeChecked();
    await expect(dialog.getByText('5 of 5 images selected')).toBeVisible();
    await expect(dialog.getByText('What should this Dataset cover?')).toHaveCount(0);
    await expect(dialog.getByLabel(/cover/i)).toHaveCount(0);
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
  });

  test('unchecking a folder excludes its subtree, shows indeterminate parents and an empty pool is refused', async ({ page }) => {
    const dialog = await openDialog(page);
    const tree = dialog.getByRole('group', { name: 'Include folders' });
    const box = (name: string) => tree.locator('label').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).getByRole('checkbox');
    await box('a').uncheck(); // a and a/sub: 3 files
    await expect(dialog.getByText('2 of 5 images selected')).toBeVisible();
    await expect(box('sub')).not.toBeChecked();
    await expect(box('b')).toBeChecked();
    expect(await box('inbox').evaluate((element: HTMLInputElement) => element.indeterminate)).toBe(true);
    await box('sub').check();
    await expect(dialog.getByText('3 of 5 images selected')).toBeVisible();
    await box('inbox').click(); // clicking an indeterminate parent re-includes the whole subtree
    await expect(dialog.getByText('5 of 5 images selected')).toBeVisible();
    await box('inbox').uncheck(); // a fully checked parent toggles the whole subtree off
    await expect(dialog.getByText('0 of 5 images selected')).toBeVisible();
    for (const name of ['inbox', 'a', 'sub', 'b']) await expect(box(name)).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Select images' }).click();
    await expect(dialog.getByRole('alert')).toContainText('No eligible new images were found in the selected inbox folders');
    await box('inbox').check();
    await expect(dialog.getByText('5 of 5 images selected')).toBeVisible();
  });
});
