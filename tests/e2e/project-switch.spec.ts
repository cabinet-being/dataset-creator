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

test('New Project writes the chosen type and target model (manifest)', async ({ page }) => {
  await page.goto('/tests/project-switch-browser.html');
  await page.getByRole('button', { name: 'Prepare empty parent for new project' }).click();
  await page.getByRole('menuitem', { name: 'File', exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /New Project Directory/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  await expect(dialog.getByRole('radio', { name: /General/ })).toBeChecked();
  await expect(dialog.getByLabel('Target model')).toHaveValue('sdxl');
  await dialog.getByLabel('Project name').fill('Profile Project');
  await dialog.getByRole('radio', { name: /Style/ }).check();
  await dialog.getByLabel('Target model').selectOption('sd15');
  await dialog.getByRole('button', { name: 'Choose location and create' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => page.evaluate(async () => {
    try { const manifest = await (window as unknown as { __newProject: { manifest: (name: string) => Promise<{ project: Record<string, unknown> }> } }).__newProject.manifest('Profile Project'); return `${manifest.project.projectType}/${manifest.project.targetModel}`; } catch { return 'pending'; }
  }), { timeout: 20_000 }).toBe('style/sd15');
  await expect(page.getByRole('tab', { name: /Build Dataset/ }).and(page.locator('[aria-selected="true"]'))).toBeVisible({ timeout: 20_000 });
  // BuildProfileControls render only once the project has candidates, so an empty new project cannot show the selects.
});
