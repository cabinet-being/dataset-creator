import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

declare global { interface Window { __buildFixture: { paths: () => Record<string, string | undefined>; tags?: () => Record<string, string[] | undefined> } } }

const datasetCount = async (page: Page) => Object.values(await page.evaluate(() => window.__buildFixture.paths())).filter((path) => /(^|\/)dataset\//.test(path ?? '')).length;
const metric = (page: Page, id: string) => page.getByTestId('build-quality-panel').locator(`[data-metric="${id}"]`);

test.describe('build quality report', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting|Preparing/ })).toHaveCount(0, { timeout: 30_000 });
  });

  test('Check stage shows the report and it reacts to trigger word and Dataset changes', async ({ page }) => {
    const check = page.getByTestId('build-stage-check');
    await expect(check).toHaveAttribute('data-state', /^(empty|in-progress|done)$/);
    await expect(page.getByTestId('build-quality-panel')).toHaveCount(0);
    await check.click();
    await expect(page.getByTestId('build-quality-panel')).toBeVisible();
    for (const id of ['count', 'captions', 'trigger']) await expect(metric(page, id)).toHaveCount(1);

    // Without DINOv2 (no network) embedding-based insights are not evaluated, never a false pass.
    await expect(page.getByTestId('build-quality-panel').locator('[data-status="not-evaluated"]').first()).toBeVisible();

    // Target 3 and 3 Dataset images: count is satisfied.
    await expect(metric(page, 'count')).toHaveAttribute('data-status', 'ok');
    await expect(metric(page, 'count')).toContainText('3');
    await expect(metric(page, 'captions')).toHaveAttribute('data-status', 'fail'); // fixture images have no captions
    await expect(metric(page, 'trigger')).toHaveAttribute('data-status', 'not-evaluated'); // no trigger word yet

    // A trigger word absent from captions makes the trigger check fail (Settings lives on Select).
    await page.getByTestId('build-stage-select').click();
    await expect(page.getByTestId('build-quality-panel')).toHaveCount(0);
    await page.locator('[data-build-settings] summary').click();
    // The trigger word is applied on Enter or blur only.
    const triggerInput = page.getByLabel('Trigger word');
    await triggerInput.fill('zxqtrigger');
    await triggerInput.press('Enter');
    await page.getByTestId('build-stage-check').click();
    await expect(metric(page, 'trigger')).toHaveAttribute('data-status', 'fail');
    await expect(check).not.toHaveAttribute('data-state', 'done');

    // Accepting a rejected proposal adds a file to the Dataset: count display changes.
    const before = await metric(page, 'count').innerText();
    await page.getByTestId('build-stage-select').click();
    await page.getByLabel('Queue filter').selectOption('rejected');
    await page.getByLabel('Candidate filmstrip').getByRole('button').first().click();
    await page.getByRole('button', { name: 'Accept · A' }).click();
    await expect.poll(() => datasetCount(page), { timeout: 30_000 }).toBe(4);
    await page.getByTestId('build-stage-check').click();
    await expect.poll(() => metric(page, 'count').innerText(), { timeout: 15_000 }).not.toBe(before);
    await expect(metric(page, 'count')).toContainText('4');

    await page.getByTestId('build-stage-select').click();
    await expect(page.getByTestId('build-quality-panel')).toHaveCount(0);
  });

  test('Finish leads to the Export stage (pinned to the Dataset) and Check holds the report', async ({ page }) => {
    // Confirm the auto-accepted proposals and reject the undecided one so Finish is allowed.
    await page.getByRole('button', { name: 'Reject all 1' }).click();
    await page.getByLabel('Queue filter').selectOption('accepted');
    // Auto-accepted items still need a caption and an explicit review in every-item mode.
    const filmstrip = page.getByLabel('Candidate filmstrip').getByRole('button');
    await expect(filmstrip).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await filmstrip.nth(index).click();
      await page.getByLabel('Caption', { exact: true }).fill(`tag${index}, portrait`);
      await page.getByRole('button', { name: 'Accept · A' }).click();
    }
    await expect(page.getByRole('status').filter({ hasText: /Ready 3 \/ target 3/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(page.getByTestId('build-stage-export')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('build-finish-quality')).toHaveCount(0);
    await expect(page.getByTestId('build-quality-panel')).toHaveCount(0);
    // Export is pinned to the Dataset: no Source selector, heading says so.
    await expect(page.getByRole('heading', { name: 'Export Dataset' })).toBeVisible();
    await expect(page.getByLabel('Source', { exact: true })).toHaveCount(0);
    await page.getByTestId('build-stage-check').click();
    await expect(metric(page, 'count')).toHaveCount(1);
    await expect(metric(page, 'captions')).toHaveCount(1);
  });

  test('Settings opens and holds the rare controls including Trigger word', async ({ page }) => {
    const settings = page.locator('[data-build-settings]');
    await expect(settings.getByLabel('Trigger word')).toBeHidden();
    await settings.locator('summary').click();
    await expect(settings.getByLabel('Trigger word')).toBeVisible();
    await expect(settings.getByLabel('Project type', { exact: true })).toBeVisible();
  });
});

test.describe('build quality profile coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare coverage fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => datasetCount(page), { timeout: 30_000 }).toBe(10);
    await page.getByTestId('build-stage-check').click();
    await expect(page.getByTestId('build-quality-panel')).toBeVisible();
  });
  const panel = (page: Page) => page.getByTestId('build-quality-panel');
  const tagsOf = (page: Page) => page.evaluate(() => window.__buildFixture.tags!());

  test('character coverage axis, gap hint and removing a common tag; Style keeps it', async ({ page }) => {
    const coverage = panel(page).locator('[data-section="profile-coverage"]');
    await expect(coverage).toBeVisible();
    await expect(coverage.locator('[data-metric="axis-framing"]')).toHaveAttribute('data-status', 'warn');
    await expect(coverage.locator('[data-metric="axis-framing"]')).not.toHaveAttribute('data-status', 'not-evaluated');
    const hints = panel(page).locator('[data-section="hints"]');
    await expect(hints.locator('[data-hint^="gap-axis-framing-"]').first()).toBeVisible();
    await expect(hints.locator('[data-hint="trigger-missing"]')).toBeVisible();

    const prune = hints.locator('[data-hint="common-tags-prune"]');
    await expect(prune).toBeVisible();
    expect(Object.values(await tagsOf(page)).every((tags) => tags?.includes('solo'))).toBe(true);
    page.once('dialog', (dialog) => { expect(dialog.message()).toContain('solo'); void dialog.accept(); });
    await prune.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(async () => Object.values(await tagsOf(page)).some((tags) => tags?.includes('solo')), { timeout: 30_000 }).toBe(false);
    const after = Object.values(await tagsOf(page));
    expect(after).toHaveLength(10);
    expect(after.every((tags) => tags?.includes('full body') || tags?.includes('close-up') || tags?.includes('upper body'))).toBe(true);
    await expect(hints.locator('[data-hint="common-tags-prune"]')).toHaveCount(0);
  });

  test('switching Project type to Style no longer offers common-tag removal', async ({ page }) => {
    await expect(panel(page).locator('[data-hint="common-tags-prune"]')).toBeVisible();
    await page.getByTestId('build-stage-add').click();
    await page.getByLabel('Project type', { exact: true }).selectOption('style');
    await page.getByTestId('build-stage-check').click();
    await expect(panel(page).locator('[data-hint="common-tags-prune"]')).toHaveCount(0);
    await expect(panel(page).locator('[data-hint="trigger-missing"]')).toHaveCount(0);
    await expect(panel(page).locator('[data-metric="axis-framing"]')).toHaveCount(0);
    expect(Object.values(await tagsOf(page)).every((tags) => tags?.includes('solo'))).toBe(true);
  });
});
