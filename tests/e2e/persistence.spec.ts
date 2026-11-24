import { test, expect } from './fixtures';

test('project persistence survives reload and version restore', async ({ page }) => {
  await page.goto('/tests/persistence-browser.html');
  await page.getByRole('button', { name: 'Write fixture' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: /^Reload this page|^FAIL:/ })).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('listitem').filter({ hasText: /^FAIL:/ })).toHaveCount(0);
  expect(await page.getByRole('listitem').filter({ hasText: /^PASS:/ }).count()).toBeGreaterThanOrEqual(4);

  await page.reload();
  await page.getByRole('button', { name: 'Reopen saved fixture' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: /^PASS: reopened 2/ })).toHaveCount(1);

  await page.getByRole('button', { name: 'Check version restore' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: /^PASS: version restore/ })).toHaveCount(1);
  await expect(page.getByRole('listitem').filter({ hasText: /^FAIL:/ })).toHaveCount(0);
});

test('Dataset folder regressions (membership by path, export plan, removed files)', async ({ page }) => {
  await page.goto('/tests/persistence-browser.html');
  await page.getByRole('button', { name: 'Run Dataset folder regressions' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: /^PASS:/ })).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('listitem').filter({ hasText: /^FAIL:/ })).toHaveCount(0);
});
