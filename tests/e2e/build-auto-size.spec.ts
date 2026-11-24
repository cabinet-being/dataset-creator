import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { datasetNames, expandPanel, filterRadio, flow, idleStatus, markShortlist, openStep, panel, step, waitForTriage } from './buildFlow';

// The fixture session is created by createBuildSession(), so it starts in Auto (no target). Fixture vectors: d.png ~ near.png, the rest distinct.
const sizeMode = (page: Page, name: 'Auto' | 'Target') => page.getByRole('radiogroup', { name: 'Size mode' }).getByRole('radio', { name });
const reason = (page: Page, id: 'describe' | 'pick') => page.getByTestId(`auto-step-${id}-reason`);

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await waitForTriage(page);
});

test.describe('build auto-select, Auto size mode', () => {
  test('a new session is in Auto: the switch, the header and the Sources summary show no target, and Target brings the field back', async ({ page }) => {
    await expect(panel(page)).toContainText('Dataset 0 · auto');
    await expect(page.getByTestId('build-select-status')).toContainText('Dataset 0');
    await expect(page.getByTestId('build-select-status')).not.toContainText('to add');
    await expect(page.getByTestId('build-select-status')).not.toContainText('/');
    await expect(step(page, 'sources')).toContainText('auto');
    await expect(step(page, 'sources')).not.toContainText('target');
    await openStep(page, 'sources');
    await expect(sizeMode(page, 'Auto')).toHaveAttribute('aria-checked', 'true');
    await expect(sizeMode(page, 'Target')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByLabel('Target')).toHaveCount(0);
    await expect(panel(page)).toContainText('One image per group of similar images');
    await expect(panel(page)).toContainText('one image from each group of similar images');
    await sizeMode(page, 'Target').click();
    await expect(sizeMode(page, 'Target')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Target')).toHaveValue('3');
    await expect(panel(page)).toContainText('Dataset 0 of 3');
    await expect(page.getByTestId('build-select-status')).toContainText('Dataset 0 / 3');
    await sizeMode(page, 'Auto').click();
    await expect(page.getByLabel('Target')).toHaveCount(0);
    await expect(panel(page)).toContainText('Dataset 0 · auto');
  });

  test('Find explains the groups, Pick needs no Describe, and Add moves every representative without a Target field', async ({ page }) => {
    const names = await markShortlist(page);
    // Pool: a, b, c, d, near, below (the exact copy, tiny and flat files are rejected); d and near are one group.
    expect(names).toHaveLength(5);
    expect(names.filter((name) => name === 'd.png' || name === 'near.png')).toHaveLength(1);
    await expect(page.getByTestId('auto-find-result')).toContainText('6 images → 5 groups');
    await expect(page.getByTestId('auto-find-result')).toContainText('1 similar skipped');
    await expect(page.getByTestId('auto-find-result')).not.toContainText('near-duplicate');
    await expect(filterRadio(page, 'shortlisted')).toHaveText('Candidates 5');
    // Describe is optional: Pick is ready right away and only hints that candidates are compared by appearance.
    await expect(step(page, 'describe')).toHaveAttribute('data-state', 'ready');
    await expect(step(page, 'pick')).toHaveAttribute('data-state', 'ready');
    await openStep(page, 'pick');
    await expect(reason(page, 'pick')).toContainText('compared by appearance only');
    await expect(page.getByLabel('Target')).toHaveCount(0);
    const pick = page.getByRole('button', { name: 'Pick 5' });
    await expect(pick).toBeEnabled();
    await pick.click();
    const add = page.getByRole('button', { name: 'Add 5 to the Dataset' });
    await expect(add).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('auto-pick-result')).toContainText('5 picked');
    expect(await datasetNames(page)).toEqual([]);
    expect([...await flow(page).narrowed()].sort()).toEqual([...names].sort());
    await add.click();
    await expect.poll(() => datasetNames(page), { timeout: 60_000 }).toEqual([...names].sort());
    await idleStatus(page);
    // Auto has no target to reach: the status shows the size only, and the panel stays open for another round.
    await expect(page.getByTestId('build-select-status')).toContainText('Dataset 5');
    await expect(page.getByTestId('build-select-status')).not.toContainText('Dataset 5 /');
    await expect(panel(page)).toContainText('Dataset 5 · auto');
    await expect(page.getByLabel('Target')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('changing the size mode discards the candidate list made in the other mode', async ({ page }) => {
    await markShortlist(page);
    await expect(filterRadio(page, 'shortlisted')).toHaveText('Candidates 5');
    await expandPanel(page);
    await openStep(page, 'sources');
    await sizeMode(page, 'Target').click();
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'ready');
    await expect(filterRadio(page, 'shortlisted')).toHaveText('Candidates 0');
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(0);
    expect(await flow(page).shortlist()).toEqual([]);
    // Target mode finds the old, limited list (target 3 -> 4 to 5 candidates, never an Auto-style group summary).
    const names = await markShortlist(page);
    expect(names.length).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId('auto-find-result')).toContainText('candidates');
    await expect(page.getByTestId('auto-find-result')).not.toContainText('groups');
  });
});
