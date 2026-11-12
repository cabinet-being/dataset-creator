import { test, expect } from './fixtures';

// The fixture stores two PNGs physically under dataset/ (current Dataset membership model) in OPFS.
test('caption fixture shows two captioned Dataset images', async ({ page }) => {
  await page.goto('/tests/caption-browser.html');
  await page.getByRole('button', { name: 'Load two captioned images' }).click();
  await expect(page.getByRole('button', { name: 'Load two captioned images' })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Open Dataset');
  await page.keyboard.press('Enter');
  await expect(page.getByText('2 assets · 2/2 captions')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('very-long-portrait-caption-fixture-name.png')).toBeVisible();
  await expect(page.getByText('extra-wide-panorama-caption-fixture.png')).toBeVisible();
});
