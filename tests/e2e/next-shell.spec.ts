import { test, expect } from './fixtures';
import { next } from './nextFlow';

// Projects screen and shell of the next UI (tests/next-browser.tsx): preset creation, recent projects, return to the list, reopening after reload.

const createProject = async (page: import('@playwright/test').Page, name: string, type: string, model: string) => {
  await page.locator('[data-new-project-name]').fill(name);
  await page.locator(`[data-project-type="${type}"]`).click();
  await page.locator(`[data-target-model="${model}"]`).click();
  await page.getByRole('button', { name: 'Choose folder and create' }).click();
  await expect(page.locator('[data-board]')).toBeVisible({ timeout: 30_000 });
};

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/next-browser.html');
  await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-recent-empty]')).toBeVisible();
  await page.evaluate('window.__next.useEmptyParent()');
});

test('creating a project writes name, type and model, opens the Board and lists it under recent projects', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Choose folder and create' })).toBeDisabled();
  await expect(page.locator('[data-project-type="character"]')).toHaveAttribute('aria-checked', 'true');
  await createProject(page, 'Styled Project', 'style', 'sd15');
  await expect(page.locator('[data-next-project-name]')).toHaveText('Styled Project');
  await expect(page.locator('[data-project-chip]')).toContainText('Style');
  await expect.poll(() => page.evaluate(async () => {
    try { const manifest = await (window as unknown as { __next: { manifest: (name: string) => Promise<{ project: Record<string, unknown> }> } }).__next.manifest('Styled Project'); return `${manifest.project.name}/${manifest.project.projectType}/${manifest.project.targetModel}`; } catch { return 'pending'; }
  }), { timeout: 20_000 }).toBe('Styled Project/style/sd15');

  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.locator('[data-projects-screen]')).toBeVisible();
  const row = page.locator('[data-recent-project="Styled Project"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText('Style');
  await expect(row).toContainText('0 frames in dataset');
});

test('the Projects button returns to the list and a recent project reopens, also after a reload', async ({ page }) => {
  await createProject(page, 'Reopen Me', 'concept', 'flux');
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.locator('[data-recent-project="Reopen Me"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-board]')).toHaveCount(0);

  await page.locator('[data-recent-project="Reopen Me"] button').first().click();
  await expect(page.locator('[data-next-project-name]')).toHaveText('Reopen Me', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.locator('[data-projects-screen]')).toBeVisible();

  await page.reload();
  const row = page.locator('[data-recent-project="Reopen Me"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('Concept');
  await row.locator('button').first().click();
  await expect(page.locator('[data-next-project-name]')).toHaveText('Reopen Me', { timeout: 30_000 });
  await expect(page.locator('[data-project-chip]')).toContainText('Concept');
});

test('a recent project can be removed from the list', async ({ page }) => {
  await createProject(page, 'Forget Me', 'general', 'sdxl');
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.locator('[data-recent-project="Forget Me"]')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Remove Forget Me from recent projects' }).click();
  await expect(page.locator('[data-recent-empty]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-recent-empty]')).toBeVisible({ timeout: 20_000 });
});

test('Mod+Z does not fail on the Projects screen or on the Board', async ({ page }) => {
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-projects-screen]')).toBeVisible();
  await createProject(page, 'Undo Probe', 'general', 'sdxl');
  await page.locator('[data-board]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('[data-board]')).toBeVisible();
  expect(await next(page, api => api.undoDepth() as number)).toBeGreaterThanOrEqual(0);
});

test('recent projects: newest edit first, at most 12 kept, the oldest are dropped', async ({ page }) => {
  await page.evaluate('window.__next.rememberFolders(14)');
  const listed = await next(page, api => api.listRecent() as Promise<{ id: string; name: string; lastEditedAt: string }[]>);
  expect(listed).toHaveLength(12);
  expect(listed.map(entry => entry.name)).toEqual(Array.from({ length: 12 }, (_, index) => `Recent ${13 - index}`));
  expect(listed.some(entry => entry.name === 'Recent 0' || entry.name === 'Recent 1'), 'the two oldest entries are evicted').toBe(false);

  await page.reload();
  await expect(page.locator('[data-recent-list] > li')).toHaveCount(12, { timeout: 20_000 });
  await expect(page.locator('[data-recent-list] > li').first()).toHaveAttribute('data-recent-project', 'Recent 13');
  await expect(page.locator('[data-recent-list] > li').last()).toHaveAttribute('data-recent-project', 'Recent 2');

  await page.evaluate(`window.__next.forgetRecent(${JSON.stringify(listed[3].id)})`);
  const after = await next(page, api => api.listRecent() as Promise<{ name: string }[]>);
  expect(after).toHaveLength(11);
  expect(after.some(entry => entry.name === listed[3].name)).toBe(false);
});
