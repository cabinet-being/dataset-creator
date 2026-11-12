import { test, expect } from './fixtures';

test('export tool lists the PSD fixture (offline part)', async ({ page }) => {
  await page.goto('/tests/export-browser.html');
  await page.getByRole('button', { name: 'Prepare PSD fixture' }).click();
  await expect(page.getByText('PSD → PNG via Photopea')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^Export 1$/ })).toBeEnabled();
});

test('PSD export through live Photopea @network', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/tests/export-browser.html');
  await page.getByRole('button', { name: 'Prepare PSD fixture' }).click();
  await expect(page.getByRole('button', { name: /^Export 1$/ })).toBeEnabled({ timeout: 15_000 });
  await page.getByLabel('Destination').selectOption('directory');
  await page.getByRole('button', { name: /^Export 1$/ }).click();
  // The harness has no notification host, so poll the output folder: re-inspect until the export has landed.
  const status = page.locator('p[role="status"]');
  await expect(async () => {
    await page.getByRole('button', { name: 'Inspect exported pixels and caption' }).click();
    await expect(status).toHaveText(/^(PASS|FAIL):/, { timeout: 2_000 });
  }).toPass({ timeout: 100_000 });
  await expect(status).toHaveText(/^PASS:/);
});
