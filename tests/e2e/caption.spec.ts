import { test, expect } from './fixtures';

// Smoke only: the fixture is visual. It sets legacy project.dataset.assetIds (known, out of scope).
test('caption fixture mounts the App without errors', async ({ page }) => {
  await page.goto('/tests/caption-browser.html');
  await page.getByRole('button', { name: 'Load two captioned images' }).click();
  await expect(page.getByRole('button', { name: 'Load two captioned images' })).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
});
