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

test('Project home shows for an open project without editors, Continue opens Build, File > Project home overlays and Back closes it', async ({ page }) => {
  await page.goto('/tests/project-switch-browser.html');
  await page.getByRole('button', { name: 'Prepare two isolated projects' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Next Open project' })).toHaveText('Next Open project: A', { timeout: 20_000 });
  const fileMenu = async (name: RegExp) => {
    await page.getByRole('menuitem', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name }).click();
  };
  await fileMenu(/Open Project Directory/);
  await expect(page.locator('[data-explorer-path$="A.txt"]').first()).toBeVisible({ timeout: 20_000 });

  const home = page.getByTestId('project-home');
  // Opening a project also opens the Build tab; closing it leaves no active editor, which shows Project home.
  await expect(page.getByRole('tab', { name: /Build Dataset/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Close Build Dataset' }).click();
  await expect(home).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('project-home-save')).toBeVisible();
  for (const id of ['add', 'select', 'caption', 'check', 'export']) await expect(page.getByTestId(`project-home-stage-${id}`)).toBeVisible();
  await expect(page.getByTestId('project-home-stage-add')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('project-home-continue')).toHaveText('Continue: Add');

  // Continue opens Build on the first incomplete stage (Add for a project without images).
  await page.getByTestId('project-home-continue').click();
  await expect(page.getByRole('tab', { name: /Build Dataset/ }).and(page.locator('[aria-selected="true"]'))).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('build-stage-add')).toHaveAttribute('aria-current', 'step');
  await expect(home).toHaveCount(0);

  // With an editor open, Home is an overlay reachable from File and closable with Back to editor.
  await fileMenu(/Project home/);
  await expect(home).toBeVisible();
  await page.getByRole('button', { name: 'Back to editor' }).click();
  await expect(home).toHaveCount(0);
  await expect(page.getByTestId('build-stepper')).toBeVisible();
});
