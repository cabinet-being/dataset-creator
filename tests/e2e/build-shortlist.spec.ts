import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { captionShortlist, counter, datasetNames, expandPanel, filterRadio, openStep, flow, idleStatus, markShortlist, panel, selectFilter, step, waitForTriage } from './buildFlow';

type Session = { filter: string; records: Record<string, { decision: string }>; auto?: { shortlist?: { entries: unknown[]; narrowed?: unknown } } };
declare global { interface Window { __buildFixture: { session: () => Session; undo: () => Promise<void>; connectFakeTagger: () => void } } }
const session = (page: Page) => page.evaluate(() => window.__buildFixture.session());
const undo = (page: Page) => page.evaluate(() => window.__buildFixture.undo());
const reason = (page: Page, id: 'sources' | 'find' | 'describe' | 'pick') => page.getByTestId(`auto-step-${id}-reason`);

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  // Triage finishes on its own; Find candidates stays locked until the analysis is done.
  await waitForTriage(page);
});

test.describe('build auto-select panel', () => {
  test('the panel starts expanded with four steps; only Find is ready and later steps explain why they are locked', async ({ page }) => {
    await expect(panel(page)).toHaveAttribute('data-expanded', 'true');
    await expect(panel(page).locator('[data-testid^="auto-step-"][data-state]')).toHaveCount(4);
    await expect(step(page, 'sources')).toHaveAttribute('data-state', 'done');
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'ready');
    await expect(step(page, 'describe')).toHaveAttribute('data-state', 'locked');
    await expect(reason(page, 'describe')).toHaveText('Find candidates first');
    await expect(step(page, 'pick')).toHaveAttribute('data-state', 'locked');
    await expect(reason(page, 'pick')).toHaveText('Find candidates first');
    // Compact: Sources is a one-line summary, Find is the open step; folders and Target appear under Change.
    await expect(step(page, 'sources')).toContainText('9 images');
    await expect(step(page, 'sources')).toContainText('target 3');
    await expect(page.getByTestId('auto-source-folders')).toHaveCount(0);
    await expect(page.getByLabel('Target')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find candidates' })).toBeEnabled();
    await openStep(page, 'sources');
    await expect(page.getByTestId('auto-source-counts')).toContainText('9 images');
    await expect(page.getByTestId('auto-source-folders').getByRole('checkbox')).toHaveCount(1);
    await expect(page.getByLabel('Target')).toHaveValue('3');
    await expect(page.getByRole('button', { name: 'Start over' })).toBeDisabled();
  });

  test('Find is locked with a reason when the target is reached or no folder is selected', async ({ page }) => {
    await openStep(page, 'sources');
    await page.getByTestId('auto-source-folders').getByRole('checkbox').first().uncheck();
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'locked');
    await expect(reason(page, 'find')).toHaveText('No images in the selected folders');
    await expect(step(page, 'sources')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('button', { name: 'Find candidates' })).toHaveCount(0); // a locked step offers no button
    await page.getByTestId('auto-source-folders').getByRole('checkbox').first().click(); // the Sources step closes itself once images are selected
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'ready');
    await openStep(page, 'sources');
    await page.getByLabel('Target').fill('0');
    await expandPanel(page); // reaching the target collapses the panel, even through the Target input
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'locked');
    await expect(reason(page, 'find')).toContainText('already has 0 of 0');
    await openStep(page, 'sources');
    await page.getByLabel('Target').fill('3');
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'ready');
  });

  test('Find marks candidates without moving files or changing decisions', async ({ page }) => {
    const before = await flow(page).paths();
    const decisionsBefore = Object.values((await session(page)).records).map((record) => record.decision);
    const names = await markShortlist(page);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.length).toBeLessThanOrEqual(5);
    // Exact copy, tiny and flat files (rejected by quality triage) never reach the candidate list. below.png is only
    // flagged "needs decision", and the pool is everything not rejected, so it may be a candidate.
    for (const name of ['a-copy.png', 'tiny.png', 'flat.png']) expect(names).not.toContain(name);
    await expect(page.getByTestId('auto-find-result')).toContainText(`${names.length} candidates`);
    expect(await flow(page).paths()).toEqual(before);
    expect(await datasetNames(page)).toEqual([]);
    const after = await session(page);
    expect(Object.values(after.records).map((record) => record.decision)).toEqual(decisionsBefore);
    expect(Object.values(after.records).every((record) => record.decision === 'unreviewed')).toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Pick needs descriptions first; Describe needs a caption model.
    await expect(step(page, 'describe')).toHaveAttribute('data-state', 'ready');
    await expect(step(page, 'describe').getByTestId('local-tagger-connect')).toBeVisible();
    await expect(step(page, 'pick')).toHaveAttribute('data-state', 'locked');
    await expect(reason(page, 'pick')).toHaveText('Describe candidates first');
  });

  test('Candidates filter and badges show exactly the candidates', async ({ page }) => {
    const names = await markShortlist(page);
    const radio = filterRadio(page, 'shortlisted');
    await expect(radio).toHaveText(`Candidates ${names.length}`);
    await radio.click();
    await expect(radio).toHaveAttribute('aria-checked', 'true');
    const filmstrip = page.getByLabel('Candidate filmstrip').getByRole('button');
    await expect(filmstrip).toHaveCount(names.length);
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(names.length);
    await expect(page.getByTestId('build-shortlist-badge').first()).toHaveText('Candidate');
    await selectFilter(page, 'all');
    await expect(filmstrip).toHaveCount(9);
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(names.length);
    await page.getByRole('button', { name: 'Show candidates' }).click();
    await expect(radio).toHaveAttribute('aria-checked', 'true');
    await page.locator('[data-testid="build-view-toggle"][data-view="grid"]').click();
    await expect(page.getByTestId('build-grid-cell')).toHaveCount(names.length);
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(names.length);
  });

  test('Tag candidates with a connected model, then Pick and Add move exactly N files and one Undo reverts them', async ({ page }) => {
    const before = await flow(page).paths();
    const names = await markShortlist(page);
    await page.evaluate(() => window.__buildFixture.connectFakeTagger());
    await expect(page.getByTestId('local-tagger-connect')).toHaveCount(0);
    await page.getByRole('button', { name: `Tag ${names.length} candidates` }).click();
    await expect(step(page, 'describe')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
    await expect(page.getByTestId('auto-describe-result')).toContainText(`All ${names.length} described`);
    await idleStatus(page);
    // Suggestions are proposals only: no caption was written and nothing moved.
    expect(await flow(page).paths()).toEqual(before);
    await expect(step(page, 'pick')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: 'Pick 3' }).click();
    const add = page.getByRole('button', { name: 'Add 3 to the Dataset' });
    await expect(add).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('auto-pick-result')).toContainText('3 picked');
    // Picking alone still moves nothing.
    expect(await datasetNames(page)).toEqual([]);
    const chosen = await flow(page).narrowed();
    expect(chosen).toHaveLength(3);
    for (const name of chosen) expect(names).toContain(name);
    await expect(filterRadio(page, 'picked')).toHaveText('Picks 3');
    await add.click();
    await expect.poll(() => datasetNames(page), { timeout: 60_000 }).toEqual([...chosen].sort());
    await idleStatus(page);
    await expect(page.getByTestId('build-select-status')).toContainText('Dataset 3 / 3');
    await undo(page);
    await expect.poll(() => datasetNames(page), { timeout: 60_000 }).toEqual([]);
    expect(await flow(page).paths()).toEqual(before);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Start over asks before discarding picks and then removes candidates, badges and filter entries', async ({ page }) => {
    const names = await markShortlist(page);
    await captionShortlist(page, names);
    await page.getByRole('button', { name: 'Pick 3' }).click();
    await expect(page.getByRole('button', { name: 'Add 3 to the Dataset' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByText('Discard 3 picks and the candidate list?')).toBeVisible();
    await page.getByRole('button', { name: 'Keep' }).click();
    await expect(page.getByRole('button', { name: 'Add 3 to the Dataset' })).toBeVisible();
    await page.getByRole('button', { name: 'Start over' }).click();
    await page.getByRole('button', { name: 'Start over' }).click(); // the confirmation's own button
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(0);
    await expect(filterRadio(page, 'shortlisted')).toHaveCount(0);
    await expect(filterRadio(page, 'picked')).toHaveCount(0);
    await expect(filterRadio(page, 'all')).toHaveAttribute('aria-checked', 'true');
    expect((await session(page)).auto?.shortlist).toBeUndefined();
    expect(await datasetNames(page)).toEqual([]);
  });

  test('when every candidate was decided by hand the steps read done, not "0 of N"', async ({ page }) => {
    const names = await markShortlist(page);
    await selectFilter(page, 'shortlisted');
    await page.getByRole('button', { name: `Accept all ${names.length}` }).click();
    // Reaching the target collapses the panel; open it again to read the steps.
    await expect(filterRadio(page, 'shortlisted')).toHaveText('Candidates 0', { timeout: 60_000 });
    await expect.poll(async () => (await datasetNames(page)).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(names.length);
    await idleStatus(page);
    await expandPanel(page);
    for (const id of ['find', 'describe', 'pick'] as const) await expect(step(page, id)).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('auto-find-result')).toHaveText(/All candidates have already been reviewed/);
    await expect(page.getByTestId('auto-describe-result')).toHaveText('Nothing left to describe');
    await expect(page.getByTestId('auto-pick-result')).toHaveText('Nothing left to pick');
    await expect(panel(page)).not.toContainText(/\b0 of \d+/);
    await expect(page.getByRole('button', { name: /^Pick \d+$/ })).toHaveCount(0);
    await expect(counter(page, 'Accepted')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('at 1280x720 the panel collapses itself after Add and Accept on a Flagged item is clickable', async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
    const names = await markShortlist(page);
    await page.evaluate(() => window.__buildFixture.connectFakeTagger());
    await page.getByRole('button', { name: `Tag ${names.length} candidates` }).click();
    await expect(step(page, 'describe')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Pick 3' }).click();
    await page.getByRole('button', { name: 'Add 3 to the Dataset' }).click();
    await expect.poll(async () => (await datasetNames(page)).length, { timeout: 60_000 }).toBe(3);
    await idleStatus(page);
    // No manual collapse: the panel closes itself and leaves room for the review area.
    await expect(panel(page)).toHaveAttribute('data-expanded', 'false');
    await selectFilter(page, 'needs-decision');
    await expect(page.getByLabel('Candidate filmstrip').getByRole('button')).toHaveCount(1);
    const accept = page.getByRole('button', { name: 'Accept · A' });
    await accept.click({ timeout: 10_000 });
    await expect(counter(page, 'Flagged')).toHaveText('Flagged 0', { timeout: 30_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
