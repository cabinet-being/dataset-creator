import { test, expect } from './fixtures';

test('gallery benchmark renders six rows without horizontal overflow', async ({ page }) => {
  await page.goto('/tests/ui-browser.html');
  await page.getByRole('button', { name: 'Run gallery benchmark' }).click();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(6, { timeout: 50_000 });
  await expect(page.getByRole('button', { name: 'Run gallery benchmark' })).toBeEnabled({ timeout: 50_000 });
  for (let index = 0; index < 6; index++) await expect(rows.nth(index).locator('td').nth(5)).toHaveText('false');
});
