import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { filterCount, openPrepared, tileOf, undoOnce } from './nextFlow';

// Health panel and theme grouping of the next UI over the "assemble" fixture (see next-assemble.spec.ts): after Assemble the dataset holds
// 9 square 512x512 frames (a1 b1 c1..c6 d1); a2 a3 b2 are near copies left in the inbox, tiny is a small portrait. The fake DINOv2 vectors are
// in tests/next-browser.tsx and in the feature cache, so Health and the clusters see the same vectors as Assemble.
test.use({ viewport: { width: 1400, height: 1800 } });

const DATASET = ['a1.png', 'b1.png', 'c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png', 'c6.png', 'd1.png'];
const health = (page: Page) => page.locator('[data-health]');
const chip = (page: Page) => page.locator('[data-id-filter]');
const tileNames = (page: Page) => page.locator('[data-frame-tile]').evaluateAll(tiles => tiles.map(tile => tile.querySelector('[data-tile-id]')!.getAttribute('aria-label')!.split(',')[0]).sort());
/** "label count" of every group header of the grid. */
const headers = (page: Page) => page.locator('[data-grid-header]').evaluateAll(nodes => nodes.map(node => [...node.children].map(child => child.textContent).join(' ')));

async function assembled(page: Page, options: { fakeModel?: boolean } = { fakeModel: true }) {
  await openPrepared(page, 'assemble', 'Health Project', options);
  await expect(filterCount(page, 'all')).toHaveText('13', { timeout: 30_000 });
  await page.locator('[data-assemble-button]').click();
  await expect(page.locator('[data-reassemble]')).toBeVisible({ timeout: 30_000 });
}

test('before Assemble Health only explains what it will show', async ({ page }) => {
  await openPrepared(page, 'assemble', 'Health Project', { fakeModel: true });
  await expect(filterCount(page, 'all')).toHaveText('13', { timeout: 30_000 });
  await expect(health(page)).toBeVisible();
  await expect(page.locator('[data-health-intro]')).toContainText('Assemble the dataset to see');
  await expect(page.locator('[data-health-section]')).toHaveCount(0);
  await expect(page.locator('[data-effective-size]')).toHaveCount(0);
  await expect(page.locator('[data-grouping]'), 'no theme grouping before Assemble').toHaveCount(0);
  await expect(page.locator('[data-grid-header]').first()).toContainText('inbox/shots');
});

test('after Assemble Health shows effective size, required checks, coverage and what to do next', async ({ page }) => {
  await assembled(page);
  await expect(page.locator('[data-health-intro]')).toHaveCount(0);
  await expect(page.locator('[data-effective-size]')).toContainText(/^9 images ≈ \d+(\.\d)? distinct/, { timeout: 15_000 });
  await expect(page.locator('[data-health-section]')).toHaveCount(5);
  await expect(page.locator('[data-health-section="effective-size"]')).toBeVisible();

  const required = page.locator('[data-required-check]');
  await expect(required.first()).toBeVisible();
  const ids = await required.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-required-check')));
  expect(ids).toEqual(['count', 'resolution', 'near-duplicates', 'captions', 'trigger', 'technical']);
  await expect(page.locator('[data-required-check="resolution"]')).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('[data-required-check="captions"]')).toContainText('9 without caption');
  await expect(page.locator('[data-required-check="trigger"]')).toHaveAttribute('data-status', 'not-evaluated');

  const orientation = page.locator('[data-coverage-axis="axis-orientation"]');
  await expect(orientation).toBeVisible();
  await expect(orientation.locator('[data-coverage-bucket="square"]')).toContainText('Square');
  await expect(orientation.locator('[data-coverage-bucket="square"]')).toContainText('9');
  await expect(orientation.locator('[data-coverage-bucket="portrait"]')).toContainText(/0\s*\/\s*\d+/);

  await expect(page.locator('[data-hint="gap-axis-orientation-portrait"]')).toContainText('Missing “Portrait” shots');
  await expect(page.locator('[data-hint="trigger-missing"]')).toContainText('Set a trigger word');
  await expect(page.locator('[data-health-section="next"]')).toContainText('What to do next');
});

test('a Health item with ids filters the grid with a chip; the cross removes the filter', async ({ page }) => {
  await assembled(page);
  await expect(chip(page)).toHaveCount(0);
  expect(await tileNames(page)).toHaveLength(13);

  // Coverage bucket with frames: it is a button, an empty bucket is not.
  const orientation = page.locator('[data-coverage-axis="axis-orientation"]');
  await expect(orientation.locator('[data-coverage-bucket="portrait"] button')).toHaveCount(0);
  await orientation.locator('[data-coverage-bucket="square"] button').click();
  await expect(chip(page)).toContainText('Showing: Orientation: Square');
  await expect(page.locator('[data-frame-tile]')).toHaveCount(9);
  expect(await tileNames(page)).toEqual(DATASET);
  await expect(filterCount(page, 'all')).toHaveText('9');
  await expect(filterCount(page, 'in')).toHaveText('9');
  await expect(filterCount(page, 'out'), 'counters follow the filter').toHaveText('0');

  // The Out frames are not in this set; the status filters work inside it.
  await page.locator('[data-filter="out"]').click();
  await expect(page.locator('[data-grid-empty]')).toBeVisible();
  await page.locator('[data-filter="all"]').click();

  await page.locator('[data-clear-id-filter]').click();
  await expect(chip(page)).toHaveCount(0);
  await expect(filterCount(page, 'all')).toHaveText('13');
  await expect(page.locator('[data-frame-tile]')).toHaveCount(13);

  // A required check with frames does the same.
  await page.getByRole('button', { name: /^Show 9 frames: Captions/ }).click();
  await expect(chip(page)).toContainText('Showing: Captions');
  expect(await tileNames(page)).toEqual(DATASET);
  await page.getByRole('button', { name: 'Clear this filter' }).click();
  await expect(page.locator('[data-frame-tile]')).toHaveCount(13);
});

test('a hint action selects the flagged frames through the same chip', async ({ page }) => {
  await assembled(page);
  await expect(page.locator('[data-hint-action]')).toHaveCount(0);
  // Pinning a copy of a1 puts two near copies into the dataset: the Near-duplicates check fails and proposes the repeat.
  await tileOf(page, 'a2.png').getByRole('button', { name: /^a2\.png,/ }).focus();
  await page.keyboard.press('p');
  await expect(tileOf(page, 'a2.png')).toHaveAttribute('data-status', 'Pinned');
  await expect(page.locator('[data-hint-action]').first()).toBeVisible({ timeout: 20_000 });
  const label = (await page.locator('[data-hint-action]').first().innerText()).trim();
  await page.locator('[data-hint-action]').first().click();
  await expect(chip(page)).toContainText(`Showing: ${label}`);
  const shown = await tileNames(page);
  expect(shown.length, 'only the flagged frames').toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(13);
  expect(shown.some(name => ['a1.png', 'a2.png'].includes(name))).toBe(true);
  await page.locator('[data-clear-id-filter]').click();
  await expect(page.locator('[data-frame-tile]')).toHaveCount(13);
});

test('without the DINOv2 model Health asks for the download instead of guessing the effective size', async ({ page }) => {
  await assembled(page, { fakeModel: false });
  await expect(page.getByTestId('health-model-download')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-effective-size]')).toHaveCount(0);
  await expect(page.locator('[data-health-section="required"]')).toBeVisible();
  await expect(page.locator('[data-coverage-axis="axis-orientation"]')).toBeVisible();
});

test.describe('theme grouping', () => {
  test('after Assemble the grid groups frames into themes and Folders restores the folder groups', async ({ page }) => {
    await assembled(page);
    await expect(page.locator('[data-grouping="themes"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await expect.poll(() => headers(page), { timeout: 15_000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^Theme 1 \d+$/), expect.stringMatching(/^Other frames \d+$/)]));
    const themed = await headers(page);
    // a1 a2 a3 and b1 b2 are themes at Balanced (c1 and d1 are 0.908 alike, below its 0.93); everything else is in none.
    expect(themed).toEqual(['Theme 1 3', 'Theme 2 2', 'Other frames 8']);
    expect(await page.locator('[data-frame-tile]').count()).toBe(13);

    await page.locator('[data-grouping="folders"]').click();
    await expect(page.locator('[data-grouping="folders"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await headers(page)).toEqual(['dataset 9', 'inbox/shots 4']);
    await page.locator('[data-grouping="themes"]').click();
    expect(await headers(page)).toEqual(themed);
  });

  test('Strict has no themes: the groups are repeats; Loose merges c1 and d1 into a theme with more members', async ({ page }) => {
    await assembled(page);
    await page.locator('[data-strictness]').selectOption('strict');
    await expect.poll(() => headers(page), { timeout: 15_000 }).toEqual(['Repeats 1 3', 'Repeats 2 2', 'Other frames 8']);
    await page.locator('[data-strictness]').selectOption('balanced');
    await expect.poll(() => headers(page), { timeout: 15_000 }).toEqual(['Theme 1 3', 'Theme 2 2', 'Other frames 8']);
    await page.locator('[data-strictness]').selectOption('loose');
    await expect.poll(() => headers(page), { timeout: 15_000 }).toEqual(['Theme 1 3', 'Theme 2 2', 'Theme 3 2', 'Other frames 6']);
  });

  test('Mod+Z of Assemble returns Health to its explanation and the dataset frames to the inbox', async ({ page }) => {
    await assembled(page);
    await expect(page.locator('[data-effective-size]')).toBeVisible({ timeout: 15_000 });
    await undoOnce(page);
    await expect(page.locator('[data-health-intro]')).toBeVisible();
    // (Whether the grid keeps its theme groups from the last run is not asserted; either way the folder view shows the inbox only.)
    if (await page.locator('[data-grouping="folders"]').count()) await page.locator('[data-grouping="folders"]').click();
    await expect.poll(() => headers(page)).toEqual(['inbox/shots 13']);
  });

  test('Mod+Z of Assemble removes the Themes/Folders switch and the grid is grouped by folders again (stale clusters are dropped)', async ({ page }) => {
    await assembled(page);
    await expect(page.locator('[data-grouping="themes"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    expect(await headers(page)).toEqual(['Theme 1 3', 'Theme 2 2', 'Other frames 8']);
    await undoOnce(page);
    await expect(page.locator('[data-grouping]'), 'no clusters, no switch').toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => headers(page), { timeout: 15_000 }).toEqual(['inbox/shots 13']);
    // Assembling again brings the themes back.
    await page.locator('[data-assemble-button]').click();
    await expect(page.locator('[data-reassemble]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-grouping="themes"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await expect.poll(() => headers(page), { timeout: 15_000 }).toEqual(['Theme 1 3', 'Theme 2 2', 'Other frames 8']);
  });
});
