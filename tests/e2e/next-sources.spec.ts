import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { flushSave, openPrepared, sessionOf } from './nextFlow';

// Sources panel of the next UI: folder counts (including empty folders), ticked sources persisted across a reload,
// create / rename, and moves of folders and frames updating profile.sources and origin.
// Fixture "sources": inbox/day1/{a,b}.png, inbox/c.png, dataset/d.png and empty folders inbox/empty and inbox/other.

const folder = (page: Page, path: string) => page.locator(`[data-source-folder="${path}"]`);
const countOf = (page: Page, path: string) => folder(page, path).locator('[data-source-count]');
const tick = (page: Page, name: string) => page.getByRole('checkbox', { name: `Use ${name} as a source` });

test.beforeEach(async ({ page }) => {
  await openPrepared(page, 'sources', 'Sources Project');
  await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
});

test('shows per-folder counts, empty folders and the inbox / ticked / dataset totals', async ({ page }) => {
  await expect(countOf(page, 'inbox')).toHaveText('3');
  await expect(countOf(page, 'inbox/day1')).toHaveText('2');
  await expect(folder(page, 'inbox/empty'), 'an empty folder still has a row').toBeVisible();
  await expect(countOf(page, 'inbox/empty')).toHaveText('0');
  await expect(countOf(page, 'inbox/other')).toHaveText('0');
  await expect(page.locator('[data-count-ticked]'), 'nothing is unticked yet: the whole inbox is a source').toHaveText('3');
  await expect(page.locator('[data-count-dataset]')).toHaveText('1');
  for (const name of ['inbox', 'day1', 'empty', 'other']) await expect(tick(page, name)).toBeChecked();
  expect((await sessionOf(page)).sources, 'the whole inbox is stored as "no explicit sources"').toBeUndefined();
});

test('a ticked source is saved and restored after a reload', async ({ page }) => {
  await tick(page, 'inbox').uncheck();
  await expect(page.locator('[data-count-ticked]')).toHaveText('0');
  await tick(page, 'day1').check();
  await expect(page.locator('[data-count-ticked]')).toHaveText('2');
  await expect(tick(page, 'empty')).not.toBeChecked();
  await expect.poll(async () => (await sessionOf(page)).sources).toEqual(['Project/inbox/day1']);
  await flushSave(page);

  await page.getByRole('button', { name: 'Projects' }).click();
  await page.reload();
  await expect(page.locator('[data-recent-project="Sources Project"]')).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-recent-project="Sources Project"] button').first().click();
  await expect(page.locator('[data-board]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-count-inbox]')).toHaveText('3', { timeout: 30_000 });
  await expect(tick(page, 'day1')).toBeChecked();
  await expect(tick(page, 'empty')).not.toBeChecked();
  await expect(tick(page, 'other')).not.toBeChecked();
  await expect(page.locator('[data-count-ticked]')).toHaveText('2');
  expect((await sessionOf(page)).sources).toEqual(['Project/inbox/day1']);
});

// DEFECT (see report): SourcesPanel.tsx INBOX_ROOT is 'Project/inbox' while rows use project-relative paths ('inbox'), so the
// initial active folder matches no row: New folder / Add files do nothing until a row is clicked, and the inbox root row is
// treated as a regular folder (Rename and drag are offered). test.fail() turns green when this is fixed: then remove it.
test('New folder, Add files and the root row work from the initial state (nothing clicked yet)', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Rename inbox' }), 'the inbox root itself cannot be renamed').toHaveCount(0);
  await expect(folder(page, 'inbox')).toHaveAttribute('draggable', 'false');
  await page.getByRole('button', { name: 'New folder' }).click();
  const create = page.getByRole('textbox', { name: 'New folder name' });
  await expect(create).toBeVisible({ timeout: 3_000 });
  await create.fill('fresh');
  await create.press('Enter');
  await expect(folder(page, 'inbox/fresh')).toBeVisible({ timeout: 10_000 });
});

test('creates a folder inside the inbox and renames an existing one', async ({ page }) => {
  await page.getByRole('button', { name: /^inbox \d+$/ }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  const create = page.getByRole('textbox', { name: 'New folder name' });
  await expect(create).toBeVisible();
  await create.fill('fresh');
  await create.press('Enter');
  await expect(folder(page, 'inbox/fresh')).toBeVisible({ timeout: 10_000 });
  await expect(countOf(page, 'inbox/fresh')).toHaveText('0');

  await page.getByRole('button', { name: 'Rename empty' }).click();
  const rename = page.getByRole('textbox', { name: 'Rename empty' });
  await rename.fill('renamed');
  await rename.press('Enter');
  await expect(folder(page, 'inbox/renamed')).toBeVisible({ timeout: 10_000 });
  await expect(folder(page, 'inbox/empty')).toHaveCount(0);

  // Rename of a folder with images keeps the images and moves their counts along.
  await page.getByRole('button', { name: 'Rename day1' }).click();
  const renameDay = page.getByRole('textbox', { name: 'Rename day1' });
  await renameDay.fill('day-one');
  await renameDay.press('Enter');
  await expect(folder(page, 'inbox/day-one')).toBeVisible({ timeout: 10_000 });
  await expect(countOf(page, 'inbox/day-one')).toHaveText('2');
  await expect(page.locator('[data-count-inbox]')).toHaveText('3');
  await expect.poll(async () => (await sessionOf(page)).records['a.png']?.locator).toBe('Project/inbox/day-one/a.png');
});

test('moving a ticked folder updates profile.sources', async ({ page }) => {
  await tick(page, 'inbox').uncheck();
  await tick(page, 'day1').check();
  await expect.poll(async () => (await sessionOf(page)).sources).toEqual(['Project/inbox/day1']);

  await folder(page, 'inbox/day1').dragTo(folder(page, 'inbox/other'));
  await expect(folder(page, 'inbox/other/day1')).toBeVisible({ timeout: 10_000 });
  await expect(folder(page, 'inbox/day1')).toHaveCount(0);
  await expect.poll(async () => (await sessionOf(page)).sources).toEqual(['Project/inbox/other/day1']);
  await expect(page.locator('[data-count-ticked]'), 'the moved images stay ticked').toHaveText('2');
  expect((await sessionOf(page)).records['a.png'].locator).toBe('Project/inbox/other/day1/a.png');
});

const dragA = async (page: Page) => {
  await expect.poll(async () => (await sessionOf(page)).records['a.png']?.origin).toBe('Project/inbox/day1');
  const tile = page.locator('[data-frame-tile]').filter({ has: page.getByRole('button', { name: /^a\.png,/ }) });
  await expect(tile).toBeVisible();
  await tile.dragTo(folder(page, 'inbox/other'));
  await expect(countOf(page, 'inbox/other')).toHaveText('1', { timeout: 10_000 });
};

test('moving a frame between inbox folders updates its origin', async ({ page }) => {
  await dragA(page);
  await expect(countOf(page, 'inbox/day1')).toHaveText('1');
  // The frame is identified by its new folder: its file name is checked in the next test.
  await expect.poll(async () => Object.values((await sessionOf(page)).records).filter(record => record.locator?.startsWith('Project/inbox/other/')).map(record => record.origin)).toEqual(['Project/inbox/other']);
  expect((await sessionOf(page)).records['b.png'].origin, 'the other frame keeps its origin').toBe('Project/inbox/day1');
});

test('moving a frame keeps its file name', async ({ page }) => {
  await dragA(page);
  await expect.poll(async () => (await sessionOf(page)).records['a.png']?.locator).toBe('Project/inbox/other/a.png');
});
