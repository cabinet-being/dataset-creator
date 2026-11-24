import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { datasetNames, filterCount, openPrepared, seedStatuses, sessionOf, tileOf, undoDepth, undoOnce } from './nextFlow';

// Pin, Ban, Clear override and Return to inbox on the Board of the next UI (lightbox buttons and P/B keys, grid bulk actions and P/B keys).
// Fixture "grid": dataset/in1, dataset/pin1 (Pin), inbox/q1 (quality), inbox/dup1, inbox/ns1, inbox/ban1 (Ban), inbox/new1 (no verdict).
// Every action is one Undo step; Mod+Z waits for the previous one to settle (history.busy) and for its own step to be done.
const SEED = { 'pin1.png': 'pin', 'q1.png': 'quality', 'dup1.png': { duplicateOf: 'in1.png' }, 'ns1.png': 'not-selected', 'ban1.png': 'ban' } as const;
const SEEDED_DATASET = ['in1.png', 'pin1.png'];

test.beforeEach(async ({ page }) => {
  await openPrepared(page, 'grid', 'Membership Project');
  await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
  await seedStatuses(page, SEED);
  await expect(filterCount(page, 'out')).toHaveText('4', { timeout: 10_000 });
});

const counts = async (page: Page) => Object.fromEntries(await Promise.all(['in', 'out', 'pinned', 'banned'].map(async name => [name, Number(await filterCount(page, name).textContent())])));
const overrides = async (page: Page) => Object.fromEntries(Object.entries((await sessionOf(page)).records).filter(([, record]) => record.override).map(([name, record]) => [name, record.override]));
const SEEDED_COUNTS = { in: 2, out: 4, pinned: 1, banned: 1 };
const status = (page: Page, name: string) => tileOf(page, name).getAttribute('data-status');
const tileButton = (page: Page, name: string) => tileOf(page, name).getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) });
async function select(page: Page, ...names: string[]) {
  for (const name of names) await page.getByRole('button', { name: new RegExp(`^Select ${name.replace('.', '\\.')}`) }).click();
  await expect(page.locator('[data-clear-selection]')).toContainText(`${names.length} selected`);
}
/** Names of the dataset files, retried until the files of the last action have moved. */
const inDataset = (page: Page, names: string[]) => expect.poll(() => datasetNames(page), { timeout: 15_000 }).toEqual([...names].sort());
const lightbox = (page: Page) => page.locator('[data-lightbox]');
const action = (page: Page, name: 'pin' | 'ban' | 'return') => page.locator(`[data-lightbox-actions] [data-action="${name}"]`);
const bulk = (page: Page, name: 'pin' | 'ban' | 'clear' | 'return') => page.locator(`[data-bulk-actions] [data-bulk-action="${name}"]`);
const openFrame = (page: Page, name: string) => tileButton(page, name).click().then(() => expect(lightbox(page)).toBeVisible());

/** Runs `step` and waits until it produced exactly one Undo step. */
async function oneStep(page: Page, step: () => Promise<unknown>) {
  const before = await undoDepth(page);
  await step();
  await expect.poll(() => undoDepth(page), { timeout: 20_000, message: 'one new Undo step' }).toBe(before + 1);
  await expect(page.locator('[data-lightbox-actions] button[disabled]')).toHaveCount(0);
}

test.describe('lightbox', () => {
  test('P pins an inbox frame into the dataset and P again drops the Pin; Mod+Z walks both back', async ({ page }) => {
    await openFrame(page, 'new1.png');
    await expect(action(page, 'pin')).toHaveText(/Pin — always include/);
    await expect(action(page, 'return'), 'Return to inbox is only for dataset frames').toHaveCount(0);

    await oneStep(page, () => page.keyboard.press('p'));
    await expect(action(page, 'pin')).toHaveText(/Unpin/);
    await inDataset(page, [...SEEDED_DATASET, 'new1.png']);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban', 'new1.png': 'pin' });
    await expect(action(page, 'return'), 'now a dataset frame').toBeVisible();

    await oneStep(page, () => page.keyboard.press('p'));
    await expect(action(page, 'pin')).toHaveText(/Pin — always include/);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    await inDataset(page, [...SEEDED_DATASET, 'new1.png']);

    await undoOnce(page);
    await expect(action(page, 'pin')).toHaveText(/Unpin/);
    expect(await overrides(page)).toMatchObject({ 'new1.png': 'pin' });
    await undoOnce(page);
    await expect(action(page, 'pin')).toHaveText(/Pin — always include/);
    await inDataset(page, SEEDED_DATASET);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    await page.keyboard.press('Escape');
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
  });

  test('B bans an inbox frame (Unban on the second press); the buttons do the same as the keys', async ({ page }) => {
    await openFrame(page, 'new1.png');
    await expect(action(page, 'ban')).toHaveText(/Ban — never include/);
    await oneStep(page, () => action(page, 'ban').click());
    await expect(action(page, 'ban')).toHaveText(/Unban/);
    await expect(action(page, 'pin')).toHaveText(/Pin — always include/);
    expect(await overrides(page)).toMatchObject({ 'new1.png': 'ban' });
    await inDataset(page, SEEDED_DATASET);
    await oneStep(page, () => page.keyboard.press('b'));
    await expect(action(page, 'ban')).toHaveText(/Ban — never include/);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    await undoOnce(page);
    await expect(action(page, 'ban')).toHaveText(/Unban/);
    await undoOnce(page);
    await expect(action(page, 'ban')).toHaveText(/Ban — never include/);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
  });

  test('B on a dataset frame says "Remove from dataset", sends it back to the inbox as Banned and Mod+Z restores it', async ({ page }) => {
    await openFrame(page, 'in1.png');
    await expect(action(page, 'ban')).toHaveText(/Remove from dataset/);
    await expect(action(page, 'return')).toBeVisible();
    await oneStep(page, () => page.keyboard.press('b'));
    await expect(action(page, 'ban')).toHaveText(/Unban/);
    await inDataset(page, ['pin1.png']);
    expect(await overrides(page)).toMatchObject({ 'in1.png': 'ban' });
    await expect(action(page, 'return'), 'a banned inbox frame has nothing to return').toHaveCount(0);
    await undoOnce(page);
    await expect(action(page, 'ban')).toHaveText(/Remove from dataset/);
    await inDataset(page, SEEDED_DATASET);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
  });

  test('Return to inbox takes a frame out of the dataset; a Pin goes with it; Mod+Z restores both', async ({ page }) => {
    await openFrame(page, 'pin1.png');
    await expect(action(page, 'pin')).toHaveText(/Unpin/);
    await oneStep(page, () => action(page, 'return').click());
    await expect(action(page, 'return')).toHaveCount(0);
    await expect(action(page, 'pin')).toHaveText(/Pin — always include/);
    await inDataset(page, ['in1.png']);
    expect(await overrides(page), 'the Pin is dropped, the Ban stays').toEqual({ 'ban1.png': 'ban' });
    await undoOnce(page);
    await expect(action(page, 'return')).toBeVisible();
    await expect(action(page, 'pin')).toHaveText(/Unpin/);
    await inDataset(page, SEEDED_DATASET);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
  });

  test('P and B do nothing while a text field has the focus', async ({ page }) => {
    await openFrame(page, 'new1.png');
    // The overlay has no field of its own: put one in, as a later caption editor would.
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'probe'; document.querySelector('[data-lightbox]')!.appendChild(input); input.focus(); });
    await expect(page.locator('#probe')).toBeFocused();
    const depth = await undoDepth(page);
    await page.keyboard.type('pbPB');
    await expect(page.locator('#probe')).toHaveValue('pbPB');
    await page.waitForTimeout(300);
    expect(await undoDepth(page)).toBe(depth);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
  });
});

test.describe('grid', () => {
  test('bulk Pin moves the selection into the dataset in one step and Mod+Z reverts it with its counters', async ({ page }) => {
    await select(page, 'q1.png', 'new1.png');
    await expect(page.locator('[data-bulk-actions]')).toBeVisible();
    await expect(bulk(page, 'clear'), 'nothing to clear').toBeDisabled();
    await expect(bulk(page, 'return'), 'nothing in the dataset').toBeDisabled();
    await oneStep(page, () => bulk(page, 'pin').click());
    await expect(page.locator('[data-bulk-actions]'), 'the selection is cleared').toHaveCount(0);
    await inDataset(page, ['in1.png', 'new1.png', 'pin1.png', 'q1.png']);
    expect(await counts(page)).toEqual({ in: 4, out: 3, pinned: 3, banned: 1 });
    for (const name of ['q1.png', 'new1.png', 'pin1.png']) expect(await status(page, name), name).toBe('Pinned');

    await undoOnce(page);
    await inDataset(page, SEEDED_DATASET);
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
    expect(await status(page, 'q1.png')).toBe('Out');
    expect(await status(page, 'new1.png')).toBe('Inbox');
  });

  test('bulk Ban bans the selection and sends dataset frames back; Mod+Z reverts it', async ({ page }) => {
    await select(page, 'in1.png', 'new1.png');
    await oneStep(page, () => bulk(page, 'ban').click());
    await inDataset(page, ['pin1.png']);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban', 'in1.png': 'ban', 'new1.png': 'ban' });
    expect(await counts(page)).toEqual({ in: 1, out: 6, pinned: 1, banned: 3 });
    expect(await status(page, 'in1.png')).toBe('Banned');
    await undoOnce(page);
    await inDataset(page, SEEDED_DATASET);
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
    expect(await status(page, 'in1.png')).toBe('In');
  });

  test('bulk Clear override drops Pin and Ban without moving files; Mod+Z brings them back', async ({ page }) => {
    await select(page, 'pin1.png', 'ban1.png', 'new1.png');
    await expect(bulk(page, 'clear')).toBeEnabled();
    await oneStep(page, () => bulk(page, 'clear').click());
    expect(await overrides(page)).toEqual({});
    await inDataset(page, SEEDED_DATASET);
    expect(await counts(page)).toMatchObject({ pinned: 0, banned: 0, in: 2 });
    expect(await status(page, 'pin1.png')).toBe('In');
    expect(await status(page, 'ban1.png')).not.toBe('Banned');
    await undoOnce(page);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
    expect(await status(page, 'pin1.png')).toBe('Pinned');
    expect(await status(page, 'ban1.png')).toBe('Banned');
  });

  test('bulk Return to inbox empties the dataset selection (a Pin is dropped); Mod+Z restores it', async ({ page }) => {
    await select(page, 'in1.png', 'pin1.png', 'q1.png');
    await oneStep(page, () => bulk(page, 'return').click());
    await inDataset(page, []);
    expect(await overrides(page)).toEqual({ 'ban1.png': 'ban' });
    expect(await counts(page)).toMatchObject({ in: 0, pinned: 0, banned: 1 });
    expect(await status(page, 'in1.png')).toBe('Inbox');
    await undoOnce(page);
    await inDataset(page, SEEDED_DATASET);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
  });

  test('P and B act on the frame under the cursor and toggle; Mod+Z reverts each', async ({ page }) => {
    await tileButton(page, 'new1.png').focus();
    await oneStep(page, () => page.keyboard.press('p'));
    expect(await status(page, 'new1.png')).toBe('Pinned');
    expect(await counts(page)).toEqual({ in: 3, out: 4, pinned: 2, banned: 1 });
    expect(await overrides(page)).toMatchObject({ 'new1.png': 'pin' });

    await tileButton(page, 'new1.png').focus();
    await oneStep(page, () => page.keyboard.press('p'));
    expect(await overrides(page), 'the same key again clears the Pin').toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    expect(await status(page, 'new1.png')).toBe('In');

    await tileButton(page, 'q1.png').focus();
    await oneStep(page, () => page.keyboard.press('b'));
    expect(await status(page, 'q1.png')).toBe('Banned');
    expect(await counts(page)).toMatchObject({ banned: 2 });
    await undoOnce(page);
    expect(await status(page, 'q1.png')).toBe('Out');
    await undoOnce(page);
    expect(await overrides(page)).toMatchObject({ 'new1.png': 'pin' });
    await undoOnce(page);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    await inDataset(page, SEEDED_DATASET);
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
  });

  test('P and B act on the whole selection, not on the cursor, and toggle when every frame already has the override', async ({ page }) => {
    await select(page, 'q1.png', 'ns1.png');
    await tileButton(page, 'new1.png').focus();
    await oneStep(page, () => page.keyboard.press('b'));
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban', 'q1.png': 'ban', 'ns1.png': 'ban' });
    expect(await status(page, 'new1.png'), 'the cursor frame was not touched').toBe('Inbox');
    expect(await counts(page)).toMatchObject({ banned: 3 });

    // A mixed selection (one Ban, one not) sets; a selection that is all Ban clears.
    await select(page, 'ban1.png', 'q1.png');
    await tileButton(page, 'q1.png').focus();
    await oneStep(page, () => page.keyboard.press('b'));
    expect(await overrides(page), 'all selected frames had the Ban: it is cleared').toEqual({ 'pin1.png': 'pin', 'ns1.png': 'ban' });
    await undoOnce(page);
    await undoOnce(page);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
  });

  test('P and B do nothing while a text field has the focus', async ({ page }) => {
    await expect(page.locator('[data-size-mode]')).toBeEnabled();
    await page.locator('[data-size-mode]').selectOption('target');
    const field = page.locator('[data-target-size]');
    await expect(field).toBeVisible();
    await field.focus();
    const depth = await undoDepth(page);
    await page.keyboard.press('p');
    await page.keyboard.press('b');
    // A text field inside the grid itself (a later filter or caption box): the key handler of the grid must skip it.
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'probe'; document.querySelector('[data-frame-grid]')!.appendChild(input); input.focus(); });
    await page.keyboard.type('pbPB');
    await expect(page.locator('#probe')).toHaveValue('pbPB');
    await page.waitForTimeout(300);
    expect(await undoDepth(page)).toBe(depth);
    expect(await overrides(page)).toEqual({ 'pin1.png': 'pin', 'ban1.png': 'ban' });
    expect(await counts(page)).toEqual(SEEDED_COUNTS);
  });
});
