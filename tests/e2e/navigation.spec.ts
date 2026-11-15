import { test, expect, type Page } from './fixtures';

const ADVANCED_TOOLS = ['Import', 'Video Frames', 'Similar images', 'Photopea', 'Similarity map', 'Browse files', 'Caption', 'Export'];

async function openProjectA(page: Page) {
  await page.goto('/tests/project-switch-browser.html');
  await page.getByRole('button', { name: 'Prepare two isolated projects' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Next Open project' })).toHaveText('Next Open project: A', { timeout: 20_000 });
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /Open Project Directory/ }).click();
  await expect(page.locator('[data-explorer-path$="A.txt"]').first()).toBeVisible({ timeout: 20_000 });
}

test('opening a project activates the Build tab', async ({ page }) => {
  await openProjectA(page);
  await expect(page.getByRole('tab', { name: /Build Dataset/ }).and(page.locator('[aria-selected="true"]'))).toBeVisible();
});

test('Tools menu keeps Build/Dataset primary and groups the rest under Advanced', async ({ page }) => {
  await openProjectA(page);
  await page.getByRole('menubar', { name: 'Main menu' }).getByRole('menuitem', { name: 'Tools', exact: true }).click();
  const menu = page.getByRole('menu');
  const advanced = menu.getByRole('group', { name: 'Advanced' });
  await expect(advanced).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Build Dataset' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Dataset', exact: true })).toBeVisible();
  await expect(advanced.getByRole('menuitemradio', { name: 'Build Dataset' })).toHaveCount(0);
  await expect(advanced.getByRole('menuitem', { name: 'Dataset', exact: true })).toHaveCount(0);
  for (const label of ADVANCED_TOOLS) {
    await expect(advanced.getByRole('menuitemradio', { name: label, exact: true }), label).toBeVisible();
  }
});

test('Dataset board hides secondary tools under Advanced and Add files opens its own tab', async ({ page }) => {
  await openProjectA(page);
  await page.getByRole('menubar', { name: 'Main menu' }).getByRole('menuitem', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Dataset', exact: true }).click();
  const advanced = page.getByTestId('dataset-advanced-tools');
  await expect(advanced).toBeVisible();
  await expect(advanced.getByRole('button', { name: 'Browse files' })).toBeHidden();
  await advanced.getByText('Advanced', { exact: true }).click();
  for (const label of ['Browse files', 'Caption', 'Similarity map', 'Export']) {
    await expect(advanced.getByRole('button', { name: label, exact: true }), label).toBeVisible();
  }
  await page.getByRole('button', { name: 'Add files', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Add files to Dataset/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Similar images/ })).toHaveCount(0);
});
