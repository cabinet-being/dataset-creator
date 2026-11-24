import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { filterCount, openPrepared, seedStatuses, sessionOf } from './nextFlow';

// Frame grid of the next UI: filters with counters, status badges and reasons, folder groups and windowing.
// Fixture "grid" (8x8 PNGs): dataset/in1, dataset/pin1 (Pin), inbox/q1 (quality), inbox/dup1 (duplicate of in1),
// inbox/ns1 (not selected), inbox/ban1 (Ban), inbox/new1 (no verdict).
const GRID_STATUSES = { 'pin1.png': 'pin', 'q1.png': 'quality', 'dup1.png': { duplicateOf: 'in1.png' }, 'ns1.png': 'not-selected', 'ban1.png': 'ban' } as const;

const tileNames = (page: Page) => page.locator('[data-frame-tile]').evaluateAll(tiles => tiles.map(tile => tile.querySelector('[data-tile-id]')!.getAttribute('aria-label')!.split(',')[0]));
const filter = (page: Page, name: string) => page.locator(`[data-frame-grid] [data-filter="${name}"]`);
const tile = (page: Page, name: string) => page.locator('[data-frame-tile]').filter({ has: page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) }) });

test.describe('statuses and filters', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'grid', 'Grid Project');
    await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
    await seedStatuses(page, GRID_STATUSES);
    await expect(filterCount(page, 'out')).toHaveText('4', { timeout: 10_000 });
  });

  test('filter chips count every status', async ({ page }) => {
    const counts = Object.fromEntries(await Promise.all(['all', 'in', 'out', 'pinned', 'banned'].map(async name => [name, await filterCount(page, name).textContent()])));
    expect(counts).toEqual({ all: '7', in: '2', out: '4', pinned: '1', banned: '1' });
    await expect(filter(page, 'all')).toHaveAttribute('aria-pressed', 'true');
  });

  test('each filter shows only its frames and keeps the dataset group first', async ({ page }) => {
    expect((await tileNames(page)).sort()).toEqual(['ban1.png', 'dup1.png', 'in1.png', 'new1.png', 'ns1.png', 'pin1.png', 'q1.png']);
    await expect(page.locator('[data-grid-header]').first()).toContainText('dataset');
    await expect(page.locator('[data-grid-header]').nth(1)).toContainText('inbox');

    const expected: Record<string, string[]> = {
      in: ['in1.png', 'pin1.png'], out: ['ban1.png', 'dup1.png', 'ns1.png', 'q1.png'], pinned: ['pin1.png'], banned: ['ban1.png'],
      all: ['ban1.png', 'dup1.png', 'in1.png', 'new1.png', 'ns1.png', 'pin1.png', 'q1.png'],
    };
    for (const name of ['in', 'out', 'pinned', 'banned', 'all']) {
      await filter(page, name).click();
      await expect(filter(page, name)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-frame-tile]')).toHaveCount(expected[name].length);
      expect((await tileNames(page)).sort(), `filter ${name}`).toEqual(expected[name]);
    }
  });

  test('badges and reasons describe each status in words', async ({ page }) => {
    const badge: Record<string, string> = { 'in1.png': 'In', 'pin1.png': 'Pinned', 'q1.png': 'Out', 'dup1.png': 'Out', 'ns1.png': 'Out', 'ban1.png': 'Banned', 'new1.png': 'Inbox' };
    for (const [name, text] of Object.entries(badge)) {
      await expect(tile(page, name), name).toHaveAttribute('data-status', text);
      await expect(tile(page, name).locator('[data-status-badge], span').filter({ hasText: new RegExp(`^${text}$`) }).first(), `${name} badge text`).toBeVisible();
    }
    const reasonOf = (name: string) => tile(page, name).getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) }).getAttribute('title');
    expect(await reasonOf('in1.png')).toBe('in1.png: Best of its group: 1 similar frame was left out.');
    expect(await reasonOf('dup1.png')).toBe('dup1.png: Duplicate of in1.png (97% similar).');
    expect(await reasonOf('q1.png')).toBe('q1.png: Quality: Too small.');
    expect(await reasonOf('ns1.png')).toMatch(/^ns1\.png: Not selected/);
    expect(await reasonOf('ban1.png')).toMatch(/^ban1\.png: Banned by you/);
    expect(await reasonOf('pin1.png')).toMatch(/^pin1\.png: Pinned by you/);
    expect(await reasonOf('new1.png')).toMatch(/^new1\.png: (Not analyzed yet|Waiting for Assemble)/);
    // Out and Banned frames are dimmed, kept ones are not.
    await expect(tile(page, 'q1.png').locator('img')).toHaveClass(/opacity-40/);
    await expect(tile(page, 'in1.png').locator('img')).not.toHaveClass(/opacity-40/);
  });

  test('a selection hidden by the filter is not counted', async ({ page }) => {
    await filter(page, 'banned').click();
    await expect(page.locator('[data-frame-tile]')).toHaveCount(1);
    await tile(page, 'ban1.png').getByRole('button', { name: /^Select ban1\.png/ }).click();
    await expect(page.locator('[data-clear-selection]')).toContainText('1 selected');
    await filter(page, 'in').click();
    await expect(page.locator('[data-clear-selection]'), 'a selection hidden by the filter is not counted').toHaveCount(0);
  });
});

test('windowing keeps the DOM small for 300 frames and scrolling shows other ones', async ({ page }) => {
  await openPrepared(page, 'big', 'Big Project');
  await expect(filterCount(page, 'all')).toHaveText('300', { timeout: 60_000 });
  await expect(page.locator('[data-frame-tile]').first()).toBeVisible();
  // The grid order changes once the reconciled session (its `order`) is written back (see the report), so snapshot after that.
  await expect.poll(async () => Object.keys((await sessionOf(page)).records).length, { timeout: 20_000 }).toBe(300);
  await expect.poll(async () => (await tileNames(page)).join(), { timeout: 5_000 }).not.toBe('');
  await page.waitForTimeout(500);
  const before = await tileNames(page);
  expect(before.length, 'only the window is in the DOM').toBeGreaterThan(0);
  expect(before.length, `${before.length} tiles rendered of 300`).toBeLessThan(80);
  await expect(page.locator('[data-grid-header]')).toHaveCount(1);

  const scroller = page.locator('[data-virtual-grid]');
  const edge = await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollHeight; });
  expect(edge, 'the scroll height reflects all 300 frames, not just the window').toBeGreaterThan(300 / 6 * 168);
  await expect.poll(async () => { const names = await tileNames(page); return names.length > 0 && names.every(name => !before.includes(name)); }, { timeout: 10_000, message: 'the end of the list shares no tile with the start' }).toBe(true);
  const end = await tileNames(page);
  expect(end.length).toBeLessThan(80);
  // Thumbnails exist only for the window: images in the DOM never exceed the rendered tiles.
  expect(await page.locator('[data-frame-tile] img').count()).toBeLessThanOrEqual(end.length);

  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await expect.poll(async () => { const names = await tileNames(page); return names.length > 0 && names.every(name => !before.includes(name) && !end.includes(name)); }, { timeout: 10_000 }).toBe(true);
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(async () => (await tileNames(page)).join()).toBe(before.join());
});
