import { test, expect } from './fixtures';

test.describe('explorer fixture', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/tests/explorer-browser.html'); });
  for (const [button, timeout] of [['Run marquee regressions', 15_000], ['Run Dataset folder regressions', 30_000], ['Run tool render regressions', 15_000]] as const) {
    test(button, async ({ page }) => {
      await page.getByRole('button', { name: button }).click();
      await expect(page.getByRole('status')).toHaveText(/^PASS:/, { timeout });
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  }
  test('starts the real workspace with the Keyboard folder', async ({ page }) => {
    await page.getByRole('button', { name: 'Start Explorer fixture' }).click();
    await expect(page.locator('[data-explorer-path$="Keyboard"]').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
