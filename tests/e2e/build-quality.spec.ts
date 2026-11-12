import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

declare global { interface Window { __buildFixture: { paths: () => Record<string, string | undefined> } } }

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

  test('toggle opens the report and it reacts to trigger word and Dataset changes', async ({ page }) => {
    const toggle = page.getByTestId('build-quality-toggle');
    await expect(toggle).toHaveText(/^Quality: /);
    await expect(toggle).toHaveAttribute('data-readiness', /^(ok|warn|fail)$/);
    await expect(page.getByTestId('build-quality-panel')).toHaveCount(0);
    await toggle.click();
    await expect(page.getByTestId('build-quality-panel')).toBeVisible();
    for (const id of ['count', 'captions', 'trigger']) await expect(metric(page, id)).toHaveCount(1);

    // Without DINOv2 (no network) embedding-based insights are not evaluated, never a false pass.
    await expect(page.getByTestId('build-quality-panel').locator('[data-status="not-evaluated"]').first()).toBeVisible();

    // Target 3 and 3 Dataset images: count is satisfied.
    await expect(metric(page, 'count')).toHaveAttribute('data-status', 'ok');
    await expect(metric(page, 'count')).toContainText('3');
    await expect(metric(page, 'captions')).toHaveAttribute('data-status', 'fail'); // fixture images have no captions
    await expect(metric(page, 'trigger')).toHaveAttribute('data-status', 'not-evaluated'); // no trigger word yet

    // A trigger word absent from captions makes the trigger check fail.
    await page.getByLabel('Trigger word').fill('zxqtrigger');
    await expect(metric(page, 'trigger')).toHaveAttribute('data-status', 'fail');
    await expect(toggle).not.toHaveAttribute('data-readiness', 'ok');

    // Accepting a rejected proposal adds a file to the Dataset: count display changes.
    const before = await metric(page, 'count').innerText();
    await page.getByLabel('Queue filter').selectOption('rejected');
    await page.getByLabel('Candidate filmstrip').getByRole('button').first().click();
    await page.getByRole('button', { name: 'Accept · A' }).click();
    await expect.poll(() => datasetCount(page), { timeout: 30_000 }).toBe(4);
    await expect.poll(() => metric(page, 'count').innerText(), { timeout: 15_000 }).not.toBe(before);
    await expect(metric(page, 'count')).toContainText('4');

    await toggle.click();
    await expect(page.getByTestId('build-quality-panel')).toHaveCount(0);
  });

  test('Finish shows the report above Export when export is allowed', async ({ page }) => {
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
    const finish = page.getByTestId('build-finish-quality');
    await expect(finish).toBeVisible();
    await expect(finish.locator('[data-metric="count"]')).toHaveCount(1);
    await expect(finish.locator('[data-metric="captions"]')).toHaveCount(1);
  });
});
