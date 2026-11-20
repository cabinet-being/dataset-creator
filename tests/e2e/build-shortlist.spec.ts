import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { captionShortlist, datasetNames, flow, idleStatus, markShortlist, shortlistBar } from './buildFlow';

type Session = { filter: string; records: Record<string, { decision: string }>; auto?: { shortlist?: { entries: unknown[]; narrowed?: unknown } } };
declare global { interface Window { __buildFixture: { session: () => Session; undo: () => Promise<void> } } }
const session = (page: Page) => page.evaluate(() => window.__buildFixture.session());
const undo = (page: Page) => page.evaluate(() => window.__buildFixture.undo());

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  // Triage finishes on its own; pass 1 needs the analyzed candidates.
  await expect(page.getByRole('group', { name: 'Triage groups' }).getByRole('button', { name: /^Rejected [1-9]/ })).toBeVisible({ timeout: 60_000 });
  await idleStatus(page);
});

test.describe('build shortlist', () => {
  test('pass 1 marks a shortlist without moving files or changing decisions', async ({ page }) => {
    const before = await flow(page).paths();
    const decisionsBefore = Object.values((await session(page)).records).map((record) => record.decision);
    const names = await markShortlist(page);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.length).toBeLessThanOrEqual(5);
    // Exact copy, tiny, flat and below-target files never reach the shortlist.
    for (const name of ['a-copy.png', 'tiny.png', 'flat.png', 'below.png']) expect(names).not.toContain(name);
    await expect(shortlistBar(page)).toContainText(`Shortlist: ${names.length} of ~6`);
    expect(await flow(page).paths()).toEqual(before);
    expect(await datasetNames(page)).toEqual([]);
    const after = await session(page);
    expect(Object.values(after.records).map((record) => record.decision)).toEqual(decisionsBefore);
    expect(Object.values(after.records).every((record) => record.decision === 'unreviewed')).toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Shortlisted filter and badges show exactly the shortlist', async ({ page }) => {
    const names = await markShortlist(page);
    await expect(page.getByLabel('Queue filter')).toHaveValue('shortlisted');
    await expect(page.getByLabel('Queue filter').locator('option[value="shortlisted"]')).toHaveText(`Shortlisted (${names.length})`);
    const filmstrip = page.getByLabel('Candidate filmstrip').getByRole('button');
    await expect(filmstrip).toHaveCount(names.length);
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(names.length);
    await page.getByLabel('Queue filter').selectOption('all');
    await expect(filmstrip).toHaveCount(9);
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(names.length);
    await page.getByRole('button', { name: new RegExp(`^Shortlist: ${names.length} of`) }).click();
    await expect(page.getByLabel('Queue filter')).toHaveValue('shortlisted');
    await page.locator('[data-testid="build-view-toggle"][data-view="grid"]').click();
    await expect(page.getByTestId('build-grid-cell')).toHaveCount(names.length);
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(names.length);
  });

  test('Narrow is disabled until shortlisted files have captions', async ({ page }) => {
    const names = await markShortlist(page);
    const narrow = shortlistBar(page).getByRole('button', { name: /^Narrow to \d+$/ });
    await expect(narrow).toBeVisible();
    await expect(narrow).toBeDisabled();
    await expect(shortlistBar(page)).toContainText(`${names.length} without captions or suggestions`);
    await expect(shortlistBar(page).getByRole('button', { name: 'Prepare caption suggestions for the shortlist' })).toBeVisible();
    await captionShortlist(page, [names[0]]);
    await expect(narrow).toBeEnabled();
  });

  test('Narrow then Apply moves exactly N files and one Undo reverts them', async ({ page }) => {
    const before = await flow(page).paths();
    const names = await markShortlist(page);
    await captionShortlist(page, names);
    await shortlistBar(page).getByRole('button', { name: 'Narrow to 3' }).click();
    const apply = shortlistBar(page).getByRole('button', { name: 'Apply 3 to the Dataset' });
    await expect(apply).toBeVisible({ timeout: 60_000 });
    // Narrowing alone still moves nothing.
    expect(await datasetNames(page)).toEqual([]);
    const chosen = await flow(page).narrowed();
    expect(chosen).toHaveLength(3);
    for (const name of chosen) expect(names).toContain(name);
    await apply.click();
    await expect.poll(() => datasetNames(page), { timeout: 60_000 }).toEqual([...chosen].sort());
    await idleStatus(page);
    await expect(shortlistBar(page)).toHaveCount(0);
    await undo(page);
    await expect.poll(() => datasetNames(page), { timeout: 60_000 }).toEqual([]);
    expect(await flow(page).paths()).toEqual(before);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Clear shortlist removes the bar, badges and filter entries', async ({ page }) => {
    await markShortlist(page);
    await shortlistBar(page).getByRole('button', { name: 'Clear shortlist' }).click();
    await expect(shortlistBar(page)).toHaveCount(0);
    await expect(page.getByTestId('build-shortlist-badge')).toHaveCount(0);
    await expect(page.getByLabel('Queue filter')).toHaveValue('all');
    expect((await session(page)).auto?.shortlist).toBeUndefined();
    expect(await datasetNames(page)).toEqual([]);
  });
});
