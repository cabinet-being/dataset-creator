import { test, expect } from './fixtures';

test('Open Project switches between two isolated projects', async ({ page }) => {
  await page.goto('/tests/project-switch-browser.html');
  await page.getByRole('button', { name: 'Prepare two isolated projects' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Next Open project' })).toHaveText('Next Open project: A', { timeout: 20_000 });
  const open = async () => {
    await page.getByRole('menuitem', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: /Open Project Directory/ }).click();
  };
  await open();
  await expect(page.locator('[data-explorer-path$="A.txt"]').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Choose B for next Open' }).click();
  await open();
  await expect(page.locator('[data-explorer-path$="B.txt"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-explorer-path$="A.txt"]')).toHaveCount(0);
});
