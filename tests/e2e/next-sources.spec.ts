import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { flushSave, next, openPrepared, sessionOf, tileOf } from './nextFlow';

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

// Several files at once: the native file picker is replaced by handles that return small generated PNGs (as the old Explorer import test did).
const fakePicker = (page: Page, names: string[]) => page.evaluate(async fileNames => {
  const files = await Promise.all(fileNames.map(async (name, index) => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d')!; context.fillStyle = `rgb(${index * 30}, 90, 160)`; context.fillRect(0, 0, 16, 16);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return new File([blob], name, { type: 'image/png' });
  }));
  (window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => files.map(file => ({ kind: 'file', name: file.name, getFile: async () => file }));
}, names);
// The grid is virtualised and grouped by folder: scroll it until the tile is rendered.
const reveal = (page: Page, name: string) => expect(async () => {
  if (await tileOf(page, name).count() === 0) { await page.locator('[data-frame-grid]').hover(); await page.mouse.wheel(0, 400); }
  await expect(tileOf(page, name)).toBeVisible({ timeout: 1_000 });
}, name).toPass({ timeout: 20_000 });
const inboxPaths = async (page: Page) => (await next<string[]>(page, api => api.files() as Promise<string[]>)).filter(path => path.startsWith('inbox/'));

test('Add files imports several files at once into the selected folder: all are on disk and in the grid', async ({ page }) => {
  const names = Array.from({ length: 7 }, (_, index) => `imported-${index}.png`);
  await fakePicker(page, names);
  await folder(page, 'inbox/other').click();
  await page.getByRole('button', { name: 'Add files' }).click();
  await expect.poll(() => inboxPaths(page), { timeout: 30_000 }).toEqual(expect.arrayContaining(names.map(name => `inbox/other/${name}`)));
  await expect(countOf(page, 'inbox/other')).toHaveText('7', { timeout: 30_000 });
  await expect(countOf(page, 'inbox')).toHaveText('10');
  await expect(page.locator('[data-count-inbox]')).toHaveText('10');
  await expect(page.locator('[data-frame-grid] [data-filter="all"] [data-filter-count]')).toHaveText(String(4 + names.length), { timeout: 30_000 });
  for (const name of names) await reveal(page, name);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await inboxPaths(page)).filter(path => path.startsWith('inbox/other/'))).toHaveLength(7);
});

test('Add files with the inbox root active puts the files directly into inbox/', async ({ page }) => {
  const names = ['root-a.png', 'root-b.png', 'root-c.png'];
  await fakePicker(page, names);
  await page.getByRole('button', { name: 'Add files' }).click();
  await expect.poll(() => inboxPaths(page), { timeout: 30_000 }).toEqual(expect.arrayContaining(names.map(name => `inbox/${name}`)));
  await expect(page.locator('[data-count-inbox]')).toHaveText('6', { timeout: 30_000 });
  await expect(page.locator('[data-frame-grid] [data-filter="all"] [data-filter-count]')).toHaveText(String(4 + names.length), { timeout: 30_000 });
  for (const name of names) await reveal(page, name);
});

test('dropping several files on a folder row imports them all into that folder', async ({ page }) => {
  const names = ['drop-a.png', 'drop-b.png', 'drop-c.png'];
  await page.evaluate(async fileNames => {
    const transfer = new DataTransfer();
    for (const [index, name] of fileNames.entries()) {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      const context = canvas.getContext('2d')!; context.fillStyle = `rgb(${index * 60}, 120, 40)`; context.fillRect(0, 0, 16, 16);
      transfer.items.add(new File([await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))], name, { type: 'image/png' }));
    }
    const row = document.querySelector('[data-source-folder="inbox/day1"]')!;
    row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, names);
  await expect.poll(() => inboxPaths(page), { timeout: 30_000 }).toEqual(expect.arrayContaining(names.map(name => `inbox/day1/${name}`)));
  await expect(countOf(page, 'inbox/day1')).toHaveText('5', { timeout: 30_000 });
  await expect(page.locator('[data-frame-grid] [data-filter="all"] [data-filter-count]')).toHaveText(String(4 + names.length), { timeout: 30_000 });
  for (const name of names) await reveal(page, name);
});
