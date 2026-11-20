import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const openDialog = async (page: Page) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare assembly dialog fixture' }).click();
  const dialog = page.getByRole('dialog', { name: 'Auto-select' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
};

const openPanel = async (page: Page) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare folders fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId('build-auto-select');
  await expect(panel).toBeVisible();
  return panel;
};

// The dialog is still used from the Dataset board; the fixture mounts it directly because the Build fixture has no board.
// It creates the real semantic encoder (no injection point), so these scenarios stop before encoding.
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

  test('asks before downloading the DINOv2 model and Cancel dismisses the prompt without an error', async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Select images' }).click();
    const prompt = dialog.getByRole('alert').filter({ hasText: 'DINOv2' });
    await expect(prompt).toContainText('~88 MB', { timeout: 30_000 });
    await expect(prompt.getByRole('button', { name: 'Download and continue' })).toBeVisible();
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Select images' })).toBeVisible();
  });
});

test.describe('Auto-select panel folder selection', () => {
  test('lists inbox folders with counts and keeps the Sources step ready until images are selected', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.locator('[data-testid="auto-step-sources"]').getByRole('button', { name: 'Change' }).click();
    const tree = panel.getByTestId('auto-source-folders');
    const row = (name: string) => tree.locator('label').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) });
    await expect(tree.locator('label')).toHaveCount(4);
    for (const [name, count] of [['inbox', '5'], ['a', '3'], ['sub', '1'], ['b', '1']] as const) await expect(row(name), name).toContainText(count);
    for (const box of await tree.getByRole('checkbox').all()) await expect(box).toBeChecked();
    await expect(panel.getByTestId('auto-source-counts')).toContainText('5 images');
    await expect(panel.getByTestId('auto-step-sources')).toHaveAttribute('data-state', 'done');
  });

  test('unchecking folders updates the image count; unchecking everything reports it on Sources and Find', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.locator('[data-testid="auto-step-sources"]').getByRole('button', { name: 'Change' }).click();
    const tree = panel.getByTestId('auto-source-folders');
    const box = (name: string) => tree.locator('label').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).getByRole('checkbox');
    await box('a').uncheck();
    await expect(panel.getByTestId('auto-source-counts')).toContainText('2 images');
    await expect(box('sub')).not.toBeChecked();
    expect(await box('inbox').evaluate((element: HTMLInputElement) => element.indeterminate)).toBe(true);
    await box('inbox').click();
    await expect(panel.getByTestId('auto-source-counts')).toContainText('5 images');
    await box('inbox').uncheck();
    await expect(panel.getByTestId('auto-source-counts')).toContainText('0 images');
    await expect(panel.getByTestId('auto-step-sources')).toHaveAttribute('data-state', 'ready');
    await expect(panel.getByTestId('auto-step-sources-reason').first()).toHaveText('No images in the selected folders');
    await expect(panel.getByTestId('auto-step-find')).toHaveAttribute('data-state', 'locked');
    await expect(panel.getByTestId('auto-step-find-reason')).toHaveText('No images in the selected folders');
  });
});
