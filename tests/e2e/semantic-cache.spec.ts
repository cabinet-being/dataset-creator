import { test, expect } from './fixtures';

test('persisted embeddings survive a reload and cached encodes need no model', async ({ page }) => {
  await page.goto('/tests/semantic-cache-browser.html');
  await Promise.all([page.waitForEvent('load'), page.locator('#save').click()]);
  await page.locator('#verify').click();
  await expect(page.locator('#result')).toHaveText(/^PASS:/, { timeout: 30_000 });
  await page.locator('#clear').click();
  await expect(page.locator('#result')).toHaveText('Cleared.');
});
