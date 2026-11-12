import { test, expect } from './fixtures';

test('build workspace shows two candidate frames', async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare Build fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Candidate filmstrip').getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
