import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { filterCount, openPrepared, seedStatuses } from './nextFlow';

// Read-only lightbox of the next UI over the "grid" fixture: open by click, arrows follow the filtered grid order,
// Esc closes and returns focus to the tile, keys do not leak to the grid cursor under the overlay.

const names = (page: Page) => page.locator('[data-frame-tile]').evaluateAll(tiles => tiles.map(tile => tile.querySelector('[data-tile-id]')!.getAttribute('aria-label')!.split(',')[0]));
const tileButton = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) });
const lightbox = (page: Page) => page.locator('[data-lightbox]');
const shown = (page: Page) => page.locator('[data-lightbox-name]');
const focusedTile = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')?.split(',')[0] ?? `<${document.activeElement?.tagName}>`);

test.beforeEach(async ({ page }) => {
  await openPrepared(page, 'grid', 'Lightbox Project');
  await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
  await seedStatuses(page, { 'pin1.png': 'pin', 'q1.png': 'quality', 'dup1.png': { duplicateOf: 'in1.png' }, 'ns1.png': 'not-selected', 'ban1.png': 'ban' });
  await expect(filterCount(page, 'out')).toHaveText('4', { timeout: 10_000 });
});

test('a click opens the frame with its status, reason, size and folder', async ({ page }) => {
  await tileButton(page, 'dup1.png').click();
  await expect(lightbox(page)).toBeVisible();
  await expect(lightbox(page)).toHaveAttribute('aria-modal', 'true');
  await expect(shown(page)).toHaveText('dup1.png');
  await expect(page.locator('[data-lightbox-reason]')).toHaveText('Duplicate of in1.png (97% similar).');
  await expect(page.locator('[data-lightbox-folder]')).toHaveText('inbox');
  await expect(page.locator('[data-lightbox-size]')).toContainText('8 × 8');
  await expect(page.locator('[data-lightbox-caption]')).toHaveText('No caption yet');
  await expect(page.locator('[data-lightbox-image]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-lightbox-close]')).toBeFocused();
});

test('arrow keys walk the filtered order only', async ({ page }) => {
  await page.locator('[data-frame-grid] [data-filter="out"]').click();
  await expect(page.locator('[data-frame-tile]')).toHaveCount(4);
  const order = await names(page);
  expect(order.sort()).toEqual(['ban1.png', 'dup1.png', 'ns1.png', 'q1.png']);
  const inGrid = await names(page);

  await tileButton(page, inGrid[0]).click();
  await expect(shown(page)).toHaveText(inGrid[0]);
  await expect(lightbox(page)).toContainText('1 / 4');
  await expect(page.locator('[data-lightbox-prev]')).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(shown(page), 'no wrap-around at the start').toHaveText(inGrid[0]);
  for (let index = 1; index < inGrid.length; index += 1) {
    await page.keyboard.press('ArrowRight');
    await expect(shown(page)).toHaveText(inGrid[index]);
    await expect(lightbox(page)).toContainText(`${index + 1} / 4`);
  }
  await expect(page.locator('[data-lightbox-next]')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(shown(page), 'no wrap-around at the end').toHaveText(inGrid[3]);
  await page.keyboard.press('ArrowLeft');
  await expect(shown(page)).toHaveText(inGrid[2]);
  // Frames outside the filter (In, Inbox) are never visited.
  for (const name of ['in1.png', 'pin1.png', 'new1.png']) expect(inGrid).not.toContain(name);
});

test('arrows follow the unfiltered grid order across groups', async ({ page }) => {
  const order = await names(page);
  expect(order).toHaveLength(7);
  await tileButton(page, order[0]).click();
  for (let index = 1; index < order.length; index += 1) {
    await page.keyboard.press('ArrowRight');
    await expect(shown(page)).toHaveText(order[index]);
  }
});

test('Escape and the close button close the overlay and focus returns to the tile that opened it', async ({ page }) => {
  const order = await names(page);
  await tileButton(page, order[1]).click();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect.poll(() => focusedTile(page)).toBe(order[1]);
  await expect(page.locator('[data-tile-id]:focus')).toHaveAttribute('tabindex', '0');

  await tileButton(page, order[0]).click();
  await page.locator('[data-lightbox-close]').click();
  await expect(lightbox(page)).toHaveCount(0);
  await expect.poll(() => focusedTile(page)).toBe(order[0]);
});

// DEFECT (see report), expectation taken from FrameGrid.closeLightbox, which sets the cursor and the reveal to the frame that is
// shown when the overlay closes. Instead Lightbox's unmount focuses the original opener (its `opener?.focus()`), and the grid's
// focus effect does not re-run because cursorId already equals the shown frame. Remove test.fail() when this is settled.
test('after browsing with arrows, Escape puts focus on the frame that was shown last', async ({ page }) => {
  test.fail(true, 'DEFECT: focus returns to the opener tile, not to the frame shown when the overlay closed');
  const order = await names(page);
  await tileButton(page, order[1]).click();
  await page.keyboard.press('ArrowRight');
  await expect(shown(page)).toHaveText(order[2]);
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect.poll(() => focusedTile(page), { timeout: 3_000 }).toBe(order[2]);
});

test('keys under the overlay do not move the grid cursor', async ({ page }) => {
  const order = await names(page);
  await tileButton(page, order[2]).click();
  await expect(shown(page)).toHaveText(order[2]);
  for (const key of ['ArrowDown', 'ArrowUp', 'End', 'Home']) await page.keyboard.press(key);
  await expect(shown(page), 'the overlay ignores keys it does not own').toHaveText(order[2]);
  await page.keyboard.press('ArrowRight');
  await expect(shown(page), 'one press moves exactly one frame (the grid does not move a second time)').toHaveText(order[3]);
  await page.keyboard.press('ArrowLeft');
  await expect(shown(page)).toHaveText(order[2]);
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect.poll(() => focusedTile(page)).toBe(order[2]);
});

test('after closing, arrow keys move the grid cursor again', async ({ page }) => {
  const order = await names(page);
  await tileButton(page, order[0]).click();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect.poll(() => focusedTile(page)).toBe(order[0]);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focusedTile(page)).toBe(order[1]);
  await expect(lightbox(page)).toHaveCount(0);
});
