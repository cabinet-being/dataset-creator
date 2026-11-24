import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { flushSave, next, openPrepared } from './nextFlow';

// Step 5.0, project level actions of the next UI: rename (window.prompt), Versions, Activity and Project settings.
type Profile = { name: string; projectType: string; targetModel: string; characterTraits?: { tag: string; mode: string }[]; transform?: { mode: string; width: number; height: number; allowUpscale?: boolean; crop?: unknown } };
const profile = (page: Page) => next<Profile>(page, api => api.profile() as Profile);
const files = (page: Page) => next<string[]>(page, api => api.files() as Promise<string[]>);
const palette = async (page: Page, command: string) => {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').or(page.getByRole('textbox')).first().fill(command);
  await page.keyboard.press('Enter');
};

test.describe('Rename project', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'sources', 'Old Name');
    await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
  });

  test('the header and the Recent list show the new name', async ({ page }) => {
    await expect(page.locator('[data-next-project-name]')).toHaveText('Old Name');
    const prompts: string[] = [];
    page.once('dialog', dialog => { prompts.push(`${dialog.type()}: ${dialog.message()} [${dialog.defaultValue()}]`); void dialog.accept('  Brand New  '); });
    await page.locator('[data-next-project-name]').click();
    await expect(page.locator('[data-next-project-name]')).toHaveText('Brand New');
    expect(prompts).toEqual(['prompt: Project name [Old Name]']);
    expect((await profile(page)).name).toBe('Brand New');
    await flushSave(page);
    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.locator('[data-projects-screen]')).toBeVisible();
    await expect(page.locator('[data-recent-project="Brand New"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-recent-project="Old Name"]')).toHaveCount(0);
  });

  test('cancelling the prompt or keeping the name changes nothing', async ({ page }) => {
    page.once('dialog', dialog => void dialog.dismiss());
    await page.locator('[data-next-project-name]').click();
    page.once('dialog', dialog => void dialog.accept('Old Name'));
    await page.locator('[data-next-project-name]').click();
    page.once('dialog', dialog => void dialog.accept('   '));
    await page.locator('[data-next-project-name]').click();
    await expect(page.locator('[data-next-project-name]')).toHaveText('Old Name');
    expect((await profile(page)).name).toBe('Old Name');
  });

  test('the Rename project command from the palette asks for a name', async ({ page }) => {
    page.once('dialog', dialog => void dialog.accept('From Palette'));
    await palette(page, 'Rename project');
    await expect(page.locator('[data-next-project-name]')).toHaveText('From Palette');
  });
});

test.describe('Versions', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'sources', 'Versions Project');
    await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(page.locator('[data-versions-dialog]')).toBeVisible();
  });
  const save = async (page: Page, name: string) => {
    await page.getByLabel('Version name').fill(name);
    await page.locator('[data-version-save]').click();
    await expect(page.locator('[data-version]').filter({ hasText: name })).toBeVisible({ timeout: 15_000 });
  };

  test('a saved version shows in the list; Save is disabled without a name', async ({ page }) => {
    await expect(page.locator('[data-versions-empty]')).toBeVisible();
    await expect(page.locator('[data-version-save]')).toBeDisabled();
    await save(page, 'Before cleanup');
    await expect(page.locator('[data-versions-empty]')).toHaveCount(0);
    await expect(page.getByLabel('Version name'), 'the field is cleared').toHaveValue('');
    await expect(page.locator('[data-version]').filter({ hasText: 'Before cleanup' })).toContainText('current');
    await save(page, 'Second');
    await expect(page.locator('[data-version]')).toHaveCount(2);
    await expect(page.getByRole('list', { name: 'Saved versions' }).locator('li').first(), 'the newest version is first').toContainText('Second');
  });

  test('Restore asks for confirmation; declining keeps the state, accepting brings the deleted folder back', async ({ page }) => {
    await save(page, 'Snapshot');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('[data-versions-dialog]')).toHaveCount(0);
    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: 'Delete day1', exact: true }).click();
    await expect(page.locator('[data-source-folder="inbox/day1"]')).toHaveCount(0, { timeout: 15_000 });
    expect((await files(page)).filter(path => path.startsWith('inbox/day1'))).toEqual([]);

    await page.getByRole('button', { name: 'Versions', exact: true }).click();
    const messages: string[] = [];
    page.once('dialog', dialog => { messages.push(dialog.message()); void dialog.dismiss(); });
    await page.getByRole('button', { name: 'Restore Snapshot' }).click();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toBe('Restore project version "Snapshot"? Current changes will be replaced.');
    expect((await files(page)).filter(path => path.startsWith('inbox/day1')), 'declined: nothing restored').toEqual([]);

    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: 'Restore Snapshot' }).click();
    await expect.poll(async () => (await files(page)).filter(path => path.startsWith('inbox/day1')).sort(), { timeout: 20_000 }).toEqual(['inbox/day1/a.png', 'inbox/day1/b.png']);
    await expect(page.locator('[data-source-folder="inbox/day1"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 20_000 });
  });

  test('the Project versions command opens the dialog', async ({ page }) => {
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('[data-versions-dialog]')).toHaveCount(0);
    await palette(page, 'Project versions');
    await expect(page.locator('[data-versions-dialog]')).toBeVisible();
  });
});

test.describe('Activity', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'sources', 'Activity Project');
    await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
  });

  for (const via of ['the status bar Output button', 'the Activity command'] as const) {
    test(`opens from ${via}, lists entries, and Clear empties the log`, async ({ page }) => {
      if (via === 'the Activity command') await palette(page, 'Activity'); else await page.getByRole('button', { name: 'Output', exact: true }).click();
      const dialog = page.locator('[data-activity-dialog]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Activity' })).toBeVisible();
      const log = page.getByRole('log', { name: 'Activity log' });
      await expect(log).toContainText('Workspace ready');
      await expect(log, 'opening the project logged something').toContainText(/Project|project/);
      expect(await log.locator('p').count()).toBeGreaterThan(1);
      await dialog.locator('[data-activity-clear]').click();
      await expect(log).toContainText('No activity yet.');
      await expect(log).not.toContainText('Workspace ready');
      await expect(dialog.locator('[data-activity-clear]')).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });
  }
});

test.describe('Project settings', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'sources', 'Settings Project');
    await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
  });
  const dialog = (page: Page) => page.locator('[data-project-settings]');
  const open = async (page: Page) => { await page.locator('[data-project-chip]').click(); await expect(dialog(page)).toBeVisible(); };

  test('the chip shows the type and model; changing them updates the chip and the project', async ({ page }) => {
    await expect(page.locator('[data-project-chip]')).toHaveText('Character · SDXL · min 1024 px');
    await open(page);
    await dialog(page).getByLabel('Project type').selectOption('style');
    await dialog(page).getByLabel('Model').selectOption('sd15');
    expect(await profile(page)).toMatchObject({ projectType: 'style', targetModel: 'sd15' });
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('[data-project-chip]')).toHaveText('Style · SD 1.5 · min 512 px');
    // The change is written: it survives a flush and a reload of the project.
    await flushSave(page);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.locator('[data-recent-project="Settings Project"] button').first().click();
    await expect(page.locator('[data-board]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-project-chip]')).toHaveText('Style · SD 1.5 · min 512 px');
  });

  test('Character traits are offered for the character type only', async ({ page }) => {
    await open(page);
    const traits = dialog(page).getByRole('group', { name: 'Character traits' });
    await expect(traits).toBeVisible();
    await traits.getByLabel('Trait tag').fill('blue_eyes');
    await traits.getByRole('button', { name: 'Add trait' }).click();
    await expect(traits.getByLabel('Mode for blue_eyes')).toHaveValue('include');
    expect((await profile(page)).characterTraits).toEqual([{ tag: 'blue_eyes', mode: 'include' }]);
    await dialog(page).getByLabel('Project type').selectOption('concept');
    await expect(traits).toHaveCount(0);
    await dialog(page).getByLabel('Project type').selectOption('character');
    await expect(traits, 'the traits are kept while the type was another one').toBeVisible();
    await expect(traits.getByLabel('Mode for blue_eyes')).toBeVisible();
  });

  test('the Project settings command opens the dialog', async ({ page }) => {
    await palette(page, 'Project settings');
    await expect(dialog(page)).toBeVisible();
  });

  test('Output transform: None removes it, Fit 512 writes a fit recipe, Center crop 768 a crop', async ({ page }) => {
    await open(page);
    const select = dialog(page).getByLabel('Output transform');
    await select.selectOption('fit-512');
    expect((await profile(page)).transform).toEqual({ mode: 'fit', width: 512, height: 512, allowUpscale: false });
    await select.selectOption('crop-768');
    expect((await profile(page)).transform).toEqual({ mode: 'crop', width: 768, height: 768, allowUpscale: false });
    await select.selectOption('none');
    expect((await profile(page)).transform, 'None means no transform at all').toBeUndefined();
    await expect(select).toHaveValue('none');
    await select.selectOption('fit-512');
    await expect(select).toHaveValue('fit-512');
  });

  test('a custom transform shows as Custom and is not overwritten by opening or closing the dialog', async ({ page }) => {
    const custom = { mode: 'crop', width: 640, height: 384, allowUpscale: true };
    await next(page, (api, arg) => { (api.setTransform as (transform: unknown) => void)(arg); return null; }, custom);
    await open(page);
    const select = dialog(page).getByLabel('Output transform');
    await expect(select).toHaveValue('custom');
    await expect(select.locator('option:checked')).toHaveText('Custom (crop 640×384)');
    await expect(select.locator('option[value="custom"]')).toBeDisabled();
    // Changing the type does not touch the transform either.
    await dialog(page).getByLabel('Project type').selectOption('general');
    await page.getByRole('button', { name: 'Close' }).click();
    await open(page);
    await expect(select).toHaveValue('custom');
    expect((await profile(page)).transform).toEqual(custom);
    // A preset can still be chosen explicitly.
    await select.selectOption('fit-512');
    expect((await profile(page)).transform).toEqual({ mode: 'fit', width: 512, height: 512, allowUpscale: false });
  });

  test('a preset-like recipe that allows upscaling counts as Custom', async ({ page }) => {
    await next(page, (api, arg) => { (api.setTransform as (transform: unknown) => void)(arg); return null; }, { mode: 'fit', width: 512, height: 512, allowUpscale: true });
    await open(page);
    await expect(dialog(page).getByLabel('Output transform')).toHaveValue('custom');
  });
});
