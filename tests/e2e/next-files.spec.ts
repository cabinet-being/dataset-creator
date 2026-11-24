import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { filterCount, next, openPrepared, sessionOf, tileOf } from './nextFlow';

// Step 5.0, file actions of the next UI on inbox frames and folders: Delete a folder (Sources), Delete selected frames (grid bulk action),
// Delete and Rename in the lightbox. Fixtures: "sources" (inbox/day1/{a,b}, inbox/c, dataset/d, empty folders), "grid", "caption" (inbox/i1.png + i1.txt).
const files = (page: Page) => next<string[]>(page, api => api.files() as Promise<string[]>);
const folder = (page: Page, path: string) => page.locator(`[data-source-folder="${path}"]`);
const lightbox = (page: Page) => page.locator('[data-lightbox]');
const tile = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) });
/** Answers the next window.confirm and records its text. */
function answerConfirm(page: Page, accept: boolean) {
  const seen: string[] = [];
  page.once('dialog', dialog => { seen.push(`${dialog.type()}: ${dialog.message()}`); void (accept ? dialog.accept() : dialog.dismiss()); });
  return seen;
}

test.describe('Delete a folder in Sources', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'sources', 'Delete Folder Project');
    await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
  });

  test('the inbox root has no Delete button, every other folder has one', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Delete inbox', exact: true })).toHaveCount(0);
    for (const name of ['day1', 'empty', 'other']) await expect(page.getByRole('button', { name: `Delete ${name}`, exact: true })).toBeVisible();
  });

  test('declining the confirmation keeps the folder and its files', async ({ page }) => {
    const seen = answerConfirm(page, false);
    await page.getByRole('button', { name: 'Delete day1', exact: true }).click();
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toBe('confirm: Delete "day1"? This cannot be undone.');
    await expect(folder(page, 'inbox/day1')).toBeVisible();
    await expect(page.locator('[data-count-inbox]')).toHaveText('3');
    expect(await files(page)).toEqual(expect.arrayContaining(['inbox/day1/a.png', 'inbox/day1/b.png']));
  });

  test('confirming deletes the folder, its frames and the row', async ({ page }) => {
    const seen = answerConfirm(page, true);
    await page.getByRole('button', { name: 'Delete day1', exact: true }).click();
    await expect(folder(page, 'inbox/day1')).toHaveCount(0, { timeout: 15_000 });
    expect(seen).toHaveLength(1);
    await expect(page.locator('[data-count-inbox]')).toHaveText('1', { timeout: 15_000 });
    await expect(filterCount(page, 'all')).toHaveText('2');
    const left = await files(page);
    expect(left.filter(path => path.startsWith('inbox/day1'))).toEqual([]);
    expect(left).toEqual(expect.arrayContaining(['inbox/c.png', 'dataset/d.png']));
  });

  test('an empty folder is deleted too', async ({ page }) => {
    answerConfirm(page, true);
    await page.getByRole('button', { name: 'Delete empty', exact: true }).click();
    await expect(folder(page, 'inbox/empty')).toHaveCount(0, { timeout: 15_000 });
    await expect(folder(page, 'inbox/other')).toBeVisible();
  });

  test('a deleted folder does not stay in profile.sources', async ({ page }) => {
    // Known defect (step 5.0): deleting a folder leaves its path in profile.sources, only moves/renames rewrite it
    // (applyExplorerPathMoves in buildSessionService). Remove test.fail() when the path is dropped.
    test.fail();
    await next(page, api => { (api.setSources as (sources: string[]) => void)(['Project/inbox/day1', 'Project/inbox/other']); return null; });
    expect((await sessionOf(page)).sources).toEqual(['Project/inbox/day1', 'Project/inbox/other']);
    answerConfirm(page, true);
    await page.getByRole('button', { name: 'Delete day1', exact: true }).click();
    await expect(folder(page, 'inbox/day1')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await sessionOf(page)).sources, { timeout: 5_000 }).not.toContain('Project/inbox/day1');
    expect((await sessionOf(page)).sources, 'the other ticked folder is kept').toContain('Project/inbox/other');
  });
});

test.describe('Delete frames in the grid and the lightbox', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'grid', 'Delete Frames Project');
    await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
  });

  test('the bulk Delete removes the selected inbox frames after a confirmation', async ({ page }) => {
    await tileOf(page, 'q1.png').getByRole('button', { name: /^Select q1\.png/ }).click();
    await tileOf(page, 'new1.png').getByRole('button', { name: /^Select new1\.png/ }).click();
    await expect(page.locator('[data-clear-selection]')).toContainText('2 selected');
    const seen = answerConfirm(page, true);
    await page.locator('[data-bulk-action="delete"]').click();
    await expect(filterCount(page, 'all')).toHaveText('5', { timeout: 15_000 });
    expect(seen).toEqual(['confirm: Delete 2 items? This cannot be undone.']);
    await expect(tile(page, 'q1.png')).toHaveCount(0);
    await expect(tile(page, 'new1.png')).toHaveCount(0);
    await expect(page.locator('[data-clear-selection]'), 'the selection is cleared').toHaveCount(0);
    const left = await files(page);
    expect(left.filter(path => /inbox\/(q1|new1)\./.test(path))).toEqual([]);
    expect(left).toEqual(expect.arrayContaining(['inbox/dup1.png', 'inbox/ns1.png', 'inbox/ban1.png']));
  });

  test('declining the bulk confirmation changes nothing', async ({ page }) => {
    await tileOf(page, 'q1.png').getByRole('button', { name: /^Select q1\.png/ }).click();
    const seen = answerConfirm(page, false);
    await page.locator('[data-bulk-action="delete"]').click();
    await expect.poll(() => seen.length).toBe(1);
    await expect(filterCount(page, 'all')).toHaveText('7');
    await expect(tile(page, 'q1.png')).toBeVisible();
    expect(await files(page)).toContain('inbox/q1.png');
  });

  test('a Dataset frame is not deleted by the bulk action', async ({ page }) => {
    await tileOf(page, 'in1.png').getByRole('button', { name: /^Select in1\.png/ }).click();
    await expect(page.locator('[data-bulk-action="delete"]'), 'only inbox frames can be deleted').toBeDisabled();
  });

  test('Delete in the lightbox removes the frame, and the lightbox closes or moves to a neighbour', async ({ page }) => {
    await tile(page, 'q1.png').click();
    await expect(lightbox(page)).toBeVisible();
    await expect(page.locator('[data-lightbox-name]')).toHaveText('q1.png');
    const seen = answerConfirm(page, true);
    await lightbox(page).locator('[data-action="delete"]').click();
    await expect(filterCount(page, 'all')).toHaveText('6', { timeout: 15_000 });
    expect(seen).toEqual(['confirm: Delete "q1.png"? This cannot be undone.']);
    // The lightbox must not keep showing the deleted frame.
    await expect(page.locator('[data-lightbox-name]').filter({ hasText: 'q1.png' })).toHaveCount(0);
    expect(await files(page)).not.toContain('inbox/q1.png');
    await expect(tile(page, 'q1.png')).toHaveCount(0);
  });

  test('declining Delete in the lightbox keeps the frame open', async ({ page }) => {
    await tile(page, 'q1.png').click();
    answerConfirm(page, false);
    await lightbox(page).locator('[data-action="delete"]').click();
    await expect(page.locator('[data-lightbox-name]')).toHaveText('q1.png');
    await expect(filterCount(page, 'all')).toHaveText('7');
    expect(await files(page)).toContain('inbox/q1.png');
  });

  test('a Dataset frame has no Delete or Rename in the lightbox', async ({ page }) => {
    await tile(page, 'in1.png').click();
    await expect(lightbox(page)).toBeVisible();
    await expect(lightbox(page).locator('[data-lightbox-files]')).toHaveCount(0);
  });
});

test.describe('Rename a frame file in the lightbox', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'caption', 'Rename Frame Project');
    await expect(filterCount(page, 'all')).toHaveText('6', { timeout: 30_000 });
    await tile(page, 'i1.png').click();
    await expect(lightbox(page)).toBeVisible();
    await expect(page.locator('[data-lightbox-name]')).toHaveText('i1.png');
  });

  test('the new name shows in the lightbox and the grid; the path, the session and the TXT follow', async ({ page }) => {
    expect(await files(page)).toEqual(expect.arrayContaining(['inbox/i1.png', 'inbox/i1.txt']));
    expect((await sessionOf(page)).records['i1.png']?.locator).toBe('Project/inbox/i1.png');
    await lightbox(page).locator('[data-action="rename"]').click();
    const input = page.locator('[data-lightbox-rename-input]');
    await expect(input).toBeFocused();
    await input.fill('renamed.png');
    await input.press('Enter');
    await expect(page.locator('[data-lightbox-name]')).toHaveText('renamed.png', { timeout: 15_000 });
    await expect(input).toHaveCount(0);
    await expect.poll(() => files(page)).toEqual(expect.arrayContaining(['inbox/renamed.png', 'inbox/renamed.txt']));
    const after = await files(page);
    expect(after.filter(path => path.startsWith('inbox/i1.'))).toEqual([]);
    expect(await next<string | null>(page, api => (api.readText as (path: string) => Promise<string | null>)('inbox/renamed.txt'))).toBe('hero, red hair');
    expect(await projectPathsOf(page)).toContain('Project/inbox/renamed.png');
    expect(await projectPathsOf(page)).not.toContain('Project/inbox/i1.png');
    await expect.poll(async () => (await sessionOf(page)).records['renamed.png']?.locator, { timeout: 10_000 }).toBe('Project/inbox/renamed.png');
    expect((await sessionOf(page)).records['i1.png'], 'no record keeps the old name').toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(lightbox(page)).toHaveCount(0);
    await expect(tile(page, 'renamed.png')).toBeVisible();
    await expect(tile(page, 'i1.png')).toHaveCount(0);
    await expect(filterCount(page, 'all')).toHaveText('6');
  });

  test('Escape cancels the rename and keeps the lightbox open', async ({ page }) => {
    await lightbox(page).locator('[data-action="rename"]').click();
    const input = page.locator('[data-lightbox-rename-input]');
    await input.fill('never.png');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(lightbox(page), 'Escape only cancels the edit').toBeVisible();
    await expect(page.locator('[data-lightbox-name]')).toHaveText('i1.png');
    await page.waitForTimeout(300);
    const after = await files(page);
    expect(after).toEqual(expect.arrayContaining(['inbox/i1.png', 'inbox/i1.txt']));
    expect(after.filter(path => path.includes('never'))).toEqual([]);
  });
});

const projectPathsOf = (page: Page) => next<string[]>(page, api => api.paths() as string[]);
