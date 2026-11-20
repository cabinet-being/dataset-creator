import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

type Rec = { decision: string };
declare global { interface Window { __buildFixture: { paths: () => Record<string, string | undefined>; session: () => { view?: string; records: Record<string, Rec> }; setTrigger: (word: string) => void; undo: () => Promise<void>; tags: () => Record<string, string[] | undefined> } } }

const datasetCount = async (page: Page) => Object.values(await page.evaluate(() => window.__buildFixture.paths())).filter((path) => /(^|\/)dataset\//.test(path ?? '')).length;
const cells = (page: Page) => page.getByTestId('build-grid-cell');
const toggle = (page: Page, view: string) => page.locator(`[data-testid="build-view-toggle"][data-view="${view}"]`);
const states = (page: Page) => cells(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
// The fixture mounts no workspace command layer, so Undo goes through the history store directly.
const undo = (page: Page) => page.evaluate(() => window.__buildFixture.undo());

const prepare = async (page: Page) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Suggest selection' }).click();
  await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
  await expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting|Preparing/ })).toHaveCount(0, { timeout: 30_000 });
};

test.describe('build grid view', () => {
  test.beforeEach(async ({ page }) => {
    await prepare(page);
    await page.getByLabel('Queue filter').selectOption('rejected');
    await toggle(page, 'grid').click();
    await expect(page.getByTestId('build-grid-view')).toBeVisible();
  });

  test('grid shows one cell per queue item and the Queue filter applies to it', async ({ page }) => {
    await expect(cells(page)).toHaveCount(5);
    expect(await states(page)).toEqual(Array(5).fill('rejected'));
    await expect(cells(page).first().getByTestId('build-grid-badge')).toHaveText('Rejected');
    await expect(cells(page).first()).toHaveAttribute('title', /Rejected · .+/);
    await page.getByLabel('Queue filter').selectOption('needs-decision');
    await expect(cells(page)).toHaveCount(1);
    await expect(cells(page).first()).toHaveAttribute('data-state', 'flagged');
    await expect(page.getByLabel('Candidate filmstrip')).toHaveCount(0);
  });

  test('click + A accepts one cell', async ({ page }) => {
    await page.getByLabel('Queue filter').selectOption('all');
    const total = await cells(page).count();
    const before = (await states(page)).filter((state) => state === 'accepted').length;
    await cells(page).first().click();
    await expect(cells(page).first()).toHaveAttribute('data-current', 'true');
    await page.keyboard.press('a');
    await expect(cells(page).first()).toHaveAttribute('data-state', 'accepted', { timeout: 30_000 });
    await expect(cells(page)).toHaveCount(total);
    expect((await states(page)).filter((state) => state === 'accepted').length).toBeGreaterThanOrEqual(before);
  });

  // Undo issued while the batch is still being applied must undo that batch, not the previous one.
  test('Shift-select two + X rejects both; Undo reverts both in one step', async ({ page }) => {
    await page.getByLabel('Queue filter').selectOption('all');
    const byId = (page: Page) => cells(page).evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [node.getAttribute('data-grid-cell')!, node.getAttribute('data-state')!])));
    const pickTwo = async () => {
      await cells(page).nth(0).click();
      await cells(page).nth(1).click({ modifiers: ['Shift'] });
      await expect(page.locator('[data-testid="build-grid-cell"][data-selected="true"]')).toHaveCount(2);
      return page.locator('[data-testid="build-grid-cell"][data-selected="true"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-grid-cell')!));
    };
    const idle = () => expect(page.getByRole('status').filter({ hasText: /Applying|Preparing/ })).toHaveCount(0, { timeout: 30_000 });
    const ids = await pickTwo();
    await page.keyboard.press('a');
    for (const id of ids) await expect(page.locator(`[data-grid-cell="${id}"]`)).toHaveAttribute('data-state', 'accepted', { timeout: 30_000 });
    await idle();
    const accepted = await byId(page);
    await pickTwo();
    await page.keyboard.press('x');
    for (const id of ids) await expect(page.locator(`[data-grid-cell="${id}"]`)).toHaveAttribute('data-state', 'rejected', { timeout: 30_000 });
    await idle();
    await undo(page);
    // One Undo restores both items to the state before X.
    await expect.poll(() => byId(page), { timeout: 30_000 }).toEqual(accepted);
  });

  test('Shift-select two + X rejects both', async ({ page }) => {
    await page.getByLabel('Queue filter').selectOption('all');
    await cells(page).nth(0).click();
    await cells(page).nth(1).click({ modifiers: ['Shift'] });
    const ids = await page.locator('[data-testid="build-grid-cell"][data-selected="true"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-grid-cell')!));
    expect(ids).toHaveLength(2);
    await page.keyboard.press('x');
    for (const id of ids) await expect(page.locator(`[data-grid-cell="${id}"]`)).toHaveAttribute('data-state', 'rejected', { timeout: 30_000 });
    await expect.poll(() => page.evaluate((list) => list.map((id) => window.__buildFixture.session().records[id]?.decision), ids)).toEqual(['skipped', 'skipped']);
  });

  test('Enter opens the item in List', async ({ page }) => {
    await cells(page).nth(2).click();
    await page.keyboard.press('Enter');
    await expect(toggle(page, 'list')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('build-grid-view')).toHaveCount(0);
    await expect(page.getByLabel('Candidate filmstrip').getByRole('button').nth(2)).toHaveClass(/border-primary/);
  });

  test('Grid mode persists across stage switches', async ({ page }) => {
    await page.getByTestId('build-stage-caption').click();
    await expect(page.getByTestId('build-caption-stage')).toBeVisible();
    await page.getByTestId('build-stage-select').click();
    await expect(toggle(page, 'grid')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('build-grid-view')).toBeVisible();
    expect(await page.evaluate(() => window.__buildFixture.session().view)).toBe('grid');
  });
});

test.describe('build caption stage', () => {
  test.beforeEach(async ({ page }) => {
    await prepare(page);
    await page.getByTestId('build-stage-caption').click();
    await expect(page.getByTestId('build-caption-stage')).toBeVisible();
  });

  test('Missing filter shows only items without a caption', async ({ page }) => {
    const count = page.getByTestId('build-caption-count');
    await expect(count).toHaveText('3 items');
    await page.getByLabel('Caption', { exact: true }).fill('solo');
    await page.getByRole('button', { name: 'Save caption' }).click();
    await expect(page.getByTestId('build-stage-caption')).toContainText('1/3 captioned', { timeout: 20_000 });
    await page.getByTestId('build-caption-filter').selectOption('missing');
    await expect(count).toHaveText('2 of 3 items');
    await expect(page.getByText('No caption', { exact: true })).toHaveCount(2);
    await page.getByTestId('build-caption-filter').selectOption('has');
    await expect(count).toHaveText('1 of 3 items');
  });

  test('Ctrl+Enter saves and moves to the next item without a caption', async ({ page }) => {
    const counter = page.getByTestId('build-stage-caption');
    const name = page.locator('aside p.truncate');
    const first = await name.innerText();
    const box = page.getByLabel('Caption', { exact: true });
    await box.fill('portrait');
    await box.press('Control+Enter');
    await expect(counter).toContainText('1/3 captioned', { timeout: 20_000 });
    await expect(name).not.toHaveText(first);
    await expect(box).toHaveValue('');
    await expect(page.getByTestId('build-stage-caption')).toHaveAttribute('aria-current', 'step');
  });

  test('trigger chip shows the trigger word', async ({ page }) => {
    await page.evaluate(() => window.__buildFixture.setTrigger('ohwx'));
    await expect(page.getByTestId('build-caption-trigger')).toHaveText('ohwx');
  });

  test('bulk Add tag to two selected items and Undo', async ({ page }) => {
    const tiles = page.locator('section[aria-label="Dataset items"] ul button');
    await tiles.nth(0).click();
    await tiles.nth(1).click({ modifiers: ['Shift'] });
    const group = page.getByRole('group', { name: 'Bulk caption tag' });
    await expect(group).toContainText('2 selected');
    await group.getByLabel('Tag').fill('bulk');
    await group.getByRole('button', { name: 'Add tag to selected' }).click();
    const tagged = () => page.evaluate(() => Object.values(window.__buildFixture.tags()).filter((tags) => tags?.includes('bulk')).length);
    await expect.poll(tagged, { timeout: 20_000 }).toBe(2);
    await page.getByTestId('build-caption-count').click();
    await undo(page);
    await expect.poll(tagged, { timeout: 20_000 }).toBe(0);
  });
});
