import { test, expect } from './fixtures';

test('inspector follows the active owner when switching screens', async ({ page }) => {
  await page.goto('/tests/inspector-browser.html');
  await page.getByRole('button', { name: 'Prepare Inspector fixture' }).click();
  // The Analysis screen claims the inspector on mount.
  await expect(page.getByText('Owner: fixture:analysis')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Asset gallery' }).click();
  await expect(page.getByText('Owner: none')).toBeVisible();
  await expect(page.getByText('No active selection')).toBeVisible();
  await page.locator('main img').first().click();
  await expect(page.getByText('Owner: fixture:gallery')).toBeVisible();
  await page.getByRole('button', { name: 'Close Inspector' }).click();
  await expect(page.getByLabel('Inspector')).toHaveCount(0);
});
