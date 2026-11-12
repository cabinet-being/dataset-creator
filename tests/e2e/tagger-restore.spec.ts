import { test, expect } from './fixtures';

test('saved local tagger files survive a reload', async ({ page }) => {
  await page.goto('/tests/tagger-restore-browser.html');
  await Promise.all([page.waitForEvent('load'), page.locator('#save').click()]);
  await expect(page.locator('#result')).toHaveText(/^PASS:/, { timeout: 15_000 });
});
