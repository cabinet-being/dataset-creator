import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

declare global { interface Window { __buildFixture: { paths: () => Record<string, string | undefined>; session?: () => { stage?: string } } } }

const STAGES = ['add', 'select', 'caption', 'check', 'export'] as const;
const datasetCount = async (page: Page) => Object.values(await page.evaluate(() => window.__buildFixture.paths())).filter((path) => /(^|\/)dataset\//.test(path ?? '')).length;
const storedStage = (page: Page) => page.evaluate(() => window.__buildFixture.session!().stage);

test.describe('build stages with materials', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting|Preparing/ })).toHaveCount(0, { timeout: 30_000 });
  });

  test('stepper has five stages, a fresh session with materials starts in Select, and a click switches the stage', async ({ page }) => {
    const stepper = page.getByTestId('build-stepper');
    await expect(stepper).toBeVisible();
    await expect(stepper.locator('[data-testid^="build-stage-"]')).toHaveCount(5);
    for (const id of STAGES) await expect(page.getByTestId(`build-stage-${id}`)).toHaveAttribute('data-state', /^(empty|in-progress|done)$/);
    await expect(page.getByTestId('build-stage-select')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('build-stage-add')).toHaveAttribute('data-state', 'done');

    await page.getByTestId('build-stage-caption').click();
    await expect(page.getByTestId('build-stage-caption')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('build-stage-select')).not.toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('build-caption-stage')).toBeVisible();
    await expect.poll(() => storedStage(page)).toBe('caption');

    await page.getByTestId('build-stage-check').click();
    await expect(page.getByTestId('build-quality-panel')).toBeVisible();
    await expect.poll(() => storedStage(page)).toBe('check');
    await page.getByTestId('build-stage-add').click();
    await expect(page.getByRole('group', { name: 'Project settings' })).toBeVisible();
    await expect.poll(() => storedStage(page)).toBe('add');
  });

  test('footer "Next" advances to the following stage', async ({ page }) => {
    await expect(page.getByTestId('build-next-stage')).toHaveText(/Next: Caption/);
    await page.getByTestId('build-next-stage').click();
    await expect(page.getByTestId('build-stage-caption')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('build-next-stage')).toHaveText(/Next: Check/);
  });

  test('saving a caption on the Caption stage updates the Caption counter', async ({ page }) => {
    const counter = page.getByTestId('build-stage-caption');
    await expect(counter).toContainText('0/3 captioned');
    await expect(counter).toHaveAttribute('data-state', 'in-progress');
    await counter.click();
    await expect(page.getByTestId('build-caption-stage')).toBeVisible();
    await page.getByLabel('Caption', { exact: true }).fill('portrait, solo');
    await page.getByRole('button', { name: 'Save caption' }).click();
    await expect(counter).toContainText('1/3 captioned', { timeout: 20_000 });
    await expect(counter).toHaveAttribute('data-state', 'in-progress');
  });
});

test('empty Select offers "Add materials" which opens the Add stage', async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare empty fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('build-stage-add')).toHaveAttribute('data-state', 'empty');
  await page.getByTestId('build-stage-select').click();
  await expect(page.getByText('No materials yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add materials →' }).click();
  await expect(page.getByTestId('build-stage-add')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('group', { name: 'Project settings' })).toBeVisible();
});

// Known defect: the default project state (src/types/entities.ts defaults.buildSession) has no `stage`, and
// reconcileBuildSession returns it unchanged, so BuildWorkspace falls back to `reconciled.stage ?? 'select'`.
test('a fresh empty project starts in the Add stage', async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare empty fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('build-stage-add')).toHaveAttribute('aria-current', 'step', { timeout: 3_000 });
});
