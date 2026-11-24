import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { datasetNames, filterCount, next, openPrepared, sessionOf, tileOf, undoDepth, undoOnce } from './nextFlow';

// Full Assemble of the next UI over the "assemble" fixture: 13 textured 512x512 frames (SD 1.5 target, so they pass the quality check) in
// inbox/shots, one 200x200 frame that fails it, and a fake DINOv2 encoder with known vectors (tests/next-browser.tsx):
//   a1 a2 a3 = one group, b1 b2 = one group, c1..c6 singles, d1 = like c1 at Loose only, tiny = out on quality.
// Size is Auto, Strictness defaults to Balanced.
// A tall viewport keeps every tile of the virtual grid in the DOM.
test.use({ viewport: { width: 1400, height: 1800 } });
const ALL = 13;
const KEPT_AT_BALANCED = ['a1.png', 'b1.png', 'c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png', 'c6.png', 'd1.png'];

const assembleButton = (page: Page) => page.locator('[data-assemble-button]');
const reassemble = (page: Page) => page.locator('[data-reassemble]');
const idle = async (page: Page) => expect(page.locator('[data-assemble-progress]')).toHaveCount(0, { timeout: 30_000 });
const reasonOf = (page: Page, name: string) => tileOf(page, name).getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) }).getAttribute('title');

async function openAssemble(page: Page, name = 'Assemble Project') {
  await openPrepared(page, 'assemble', name, { fakeModel: true });
  await expect(filterCount(page, 'all')).toHaveText(String(ALL), { timeout: 30_000 });
}

test('Assemble shows progress, then the summary, Re-assemble and Export; one frame of each group is In', async ({ page }) => {
  await openAssemble(page);
  // Before: nothing is decided, Assemble is offered, no summary, no Export.
  await expect(assembleButton(page)).toBeEnabled();
  await expect(page.locator('[data-assemble-summary]')).toHaveCount(0);
  await expect(page.locator('[data-export]')).toHaveCount(0);
  await expect(reassemble(page)).toHaveCount(0);
  await expect(filterCount(page, 'in')).toHaveText('0');
  expect(await datasetNames(page)).toEqual([]);

  await next(page, api => api.holdEncoder());
  await assembleButton(page).click();
  const progress = page.locator('[data-assemble-progress]');
  await expect(progress).toBeVisible();
  await expect(page.locator('[data-assemble-phase]')).toHaveText('Understanding images', { timeout: 15_000 });
  await expect(progress.locator('progress')).toHaveAttribute('max', '12');
  await expect(progress).toContainText('0 / 12');
  await expect(progress.locator('[data-assemble-cancel]')).toBeVisible();
  await expect(assembleButton(page), 'no second Assemble while one runs').toHaveCount(0);
  await next(page, api => api.releaseEncoder());

  await expect(reassemble(page)).toBeVisible({ timeout: 30_000 });
  await idle(page);
  await expect(page.locator('[data-assemble-summary]')).toHaveText('13 images → 9 groups · 9 added · 3 duplicates · 1 out on quality');
  await expect(page.locator('[data-export]')).toHaveText('Export 9 pairs');
  await expect(assembleButton(page)).toHaveCount(0);

  // One frame of each group is In (the first by name of equal-quality copies), the rest are Out as duplicates, the small one on quality.
  expect(await datasetNames(page)).toEqual(KEPT_AT_BALANCED);
  await expect(filterCount(page, 'in')).toHaveText('9');
  await expect(filterCount(page, 'out')).toHaveText('4');
  for (const name of KEPT_AT_BALANCED) await expect(tileOf(page, name), name).toHaveAttribute('data-status', 'In');
  for (const name of ['a2.png', 'a3.png', 'b2.png', 'tiny.png']) await expect(tileOf(page, name), name).toHaveAttribute('data-status', 'Out');
  expect(await reasonOf(page, 'a2.png')).toMatch(/^a2\.png: Duplicate of a1\.png \(\d+% similar\)\.$/);
  expect(await reasonOf(page, 'b2.png')).toMatch(/^b2\.png: Duplicate of b1\.png/);
  expect(await reasonOf(page, 'tiny.png')).toMatch(/^tiny\.png: Quality: /);
  expect(await reasonOf(page, 'a1.png')).toBe('a1.png: Best of its group: 2 similar frames were left out.');
  const session = await sessionOf(page);
  expect(session.assembledAt).toBeTruthy();
  expect(session.records['a1.png'].locator).toBe('Project/dataset/a1.png');
  expect(session.records['a2.png'].locator, 'a duplicate stays in the inbox').toBe('Project/inbox/shots/a2.png');
});

test('a second Assemble without changes adds nothing and does not move anything', async ({ page }) => {
  await openAssemble(page);
  await assembleButton(page).click();
  await expect(reassemble(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-assemble-summary]')).toBeVisible();
  const first = await sessionOf(page);
  const depth = await undoDepth(page);

  await reassemble(page).click();
  await expect.poll(async () => (await sessionOf(page)).assembledAt, { timeout: 30_000, message: 'the second run finished' }).not.toBe(first.assembledAt);
  await idle(page);
  await expect(reassemble(page)).toBeEnabled();
  expect(await datasetNames(page)).toEqual(KEPT_AT_BALANCED);
  await expect(filterCount(page, 'in')).toHaveText('9');
  await expect(filterCount(page, 'out')).toHaveText('4');
  await expect(page.locator('[data-export]')).toHaveText('Export 9 pairs');
  expect(Object.fromEntries(Object.entries((await sessionOf(page)).records).map(([name, record]) => [name, record.locator]))).toEqual(
    Object.fromEntries(Object.entries(first.records).map(([name, record]) => [name, record.locator])));
  // The summary describes this run: the frames still in the inbox, none of them added.
  await expect(page.locator('[data-assemble-summary]')).toHaveText('4 images → 0 groups · 0 added · 3 duplicates · 1 out on quality');
  expect(await undoDepth(page), 'a run that changes nothing leaves no Undo step').toBe(depth);
});

test('Mod+Z undoes the whole Assemble in one step', async ({ page }) => {
  await openAssemble(page);
  const before = await undoDepth(page);
  await assembleButton(page).click();
  await expect(reassemble(page)).toBeVisible({ timeout: 30_000 });
  await idle(page);
  expect(await undoDepth(page), 'one history step for the whole Assemble').toBe(before + 1);
  expect(await datasetNames(page)).toHaveLength(9);

  await undoOnce(page);
  expect(await undoDepth(page)).toBe(before);
  expect(await datasetNames(page), 'every added frame is back in the inbox').toEqual([]);
  await expect(filterCount(page, 'in')).toHaveText('0');
  await expect(filterCount(page, 'all')).toHaveText(String(ALL));
  await expect(page.locator('[data-export]')).toHaveCount(0);
  await expect(assembleButton(page)).toBeVisible();
  await expect(page.locator('[data-assemble-summary]')).toHaveCount(0);
});

test('Cancel stops Assemble and leaves the project as it was', async ({ page }) => {
  await openAssemble(page);
  await next(page, api => api.holdEncoder());
  await assembleButton(page).click();
  await expect(page.locator('[data-assemble-phase]')).toHaveText('Understanding images', { timeout: 15_000 });
  await page.locator('[data-assemble-cancel]').click();
  await next(page, api => api.releaseEncoder());
  await idle(page);
  await expect(assembleButton(page)).toBeVisible({ timeout: 15_000 });
  await expect(assembleButton(page)).toBeEnabled();
  await expect(reassemble(page)).toHaveCount(0);
  await expect(page.locator('[data-assemble-summary]')).toHaveCount(0);
  await expect(page.locator('[data-export]')).toHaveCount(0);
  expect(await datasetNames(page)).toEqual([]);
  await expect(filterCount(page, 'in')).toHaveText('0');
  expect((await sessionOf(page)).assembledAt).toBeUndefined();

  // The next Assemble works as if nothing happened.
  await assembleButton(page).click();
  await expect(reassemble(page)).toBeVisible({ timeout: 30_000 });
  expect(await datasetNames(page)).toEqual(KEPT_AT_BALANCED);
});

test.describe('Strictness', () => {
  test('Loose merges d1 into the group of c1; Balanced keeps both', async ({ page }) => {
    await openAssemble(page, 'Loose Project');
    await page.locator('[data-strictness]').selectOption('loose');
    await assembleButton(page).click();
    await expect(reassemble(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-assemble-summary]')).toHaveText('13 images → 8 groups · 8 added · 4 duplicates · 1 out on quality');
    expect(await datasetNames(page)).toEqual(['a1.png', 'b1.png', 'c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png', 'c6.png']);
    expect(await reasonOf(page, 'd1.png')).toMatch(/^d1\.png: Duplicate of c1\.png/);
  });

  test('the choice is saved in the project profile and survives a reload', async ({ page }) => {
    await openAssemble(page, 'Strictness Project');
    const select = page.locator('[data-strictness]');
    await expect(select).toHaveValue('balanced');
    expect((await sessionOf(page)).strictness, 'unset means Balanced').toBeUndefined();
    await select.selectOption('strict');
    await expect.poll(async () => (await sessionOf(page)).strictness).toBe('strict');
    await expect(select).toHaveValue('strict');
    await page.evaluate('window.__next.flush()');
    await page.reload();
    await expect(page.locator('[data-recent-project="Strictness Project"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-recent-project="Strictness Project"] button').first().click();
    await expect(page.locator('[data-board]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-strictness]')).toHaveValue('strict', { timeout: 15_000 });
    expect((await sessionOf(page)).strictness).toBe('strict');
    await expect(page.locator('[data-strictness] option')).toHaveText(['Strict', 'Balanced', 'Loose']);
  });
});
