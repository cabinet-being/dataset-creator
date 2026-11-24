import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { suggestAndApply, waitForTriage, switchToTargetMode } from './buildFlow';

declare global { interface Window { __buildFixture: { connectFakeTagger: () => void } } }

const suggest = (page: Page) => page.getByTestId('build-suggest-tags');

test.describe('build caption stage suggestions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
    await switchToTargetMode(page);
    await waitForTriage(page);
    await suggestAndApply(page);
    await page.getByTestId('build-stage-caption').click();
    await expect(page.getByTestId('build-caption-stage')).toBeVisible();
  });

  test('without a model the button is disabled and the connect prompt is shown', async ({ page }) => {
    await expect(suggest(page)).toHaveText('Suggest tags for 3 images');
    await expect(suggest(page)).toBeDisabled();
    await expect(suggest(page)).toHaveAttribute('title', 'Connect a local caption model first');
    await expect(page.getByTestId('local-tagger-connect')).toContainText('Connect one to get tag suggestions');
    await expect(page.getByTestId('proposal-suggestions')).toHaveCount(0);
  });

  test('suggesting tags shows proposals for Dataset images and Merge suggestions fills the draft without saving', async ({ page }) => {
    await page.evaluate(() => window.__buildFixture.connectFakeTagger());
    await expect(page.getByTestId('local-tagger-connect')).toHaveCount(0);
    await expect(suggest(page)).toBeEnabled();
    await suggest(page).click();
    // All three Dataset images were described, so nothing is left to suggest.
    await expect(suggest(page)).toHaveText('Suggest tags for 0 images', { timeout: 60_000 });
    await expect(suggest(page)).toBeDisabled();
    await expect(suggest(page)).toHaveAttribute('title', 'Every Dataset image already has tags or a suggestion');
    const proposals = page.getByTestId('proposal-suggestions');
    await expect(proposals).toBeVisible();
    await expect(proposals).toContainText('fake_tag, fake_pose');
    await expect(proposals).not.toContainText('low_score');
    const caption = page.getByLabel('Caption', { exact: true });
    await expect(caption).toHaveValue('');
    await expect(page.getByTestId('build-stage-caption')).toContainText('0/3 captioned');
    await proposals.getByRole('button', { name: 'Merge suggestions' }).click();
    await expect(caption).toHaveValue('fake_tag, fake_pose');
    // Merging only edits the draft; saving writes the caption.
    await expect(page.getByTestId('build-stage-caption')).toContainText('0/3 captioned');
    await page.getByRole('button', { name: 'Save caption' }).click();
    await expect(page.getByTestId('build-stage-caption')).toContainText('1/3 captioned', { timeout: 20_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
