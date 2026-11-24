import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { next, openPrepared, projectPaths, undoDepth, undoOnce } from './nextFlow';

// Caption mode of the next UI over the "caption" fixture (tests/next-browser.tsx), trigger word "hero":
//   dataset/c1 "hero, red hair, smile", c2 "hero, Red Hair, hat", c3 "hero, red hair", c4 an empty caption file, c5 no caption file; inbox/i1 is not in the dataset.
// Captions are checked on disk (the TXT is the only source of a caption). The "advice" fixture has "red hair" in every caption of three frames.
const text = (page: Page, path: string) => next<string | null, string>(page, (api, file) => api.readText(file as never) as Promise<string | null>, path);
const missing = async (page: Page, path: string) => !(await next<string[]>(page, api => api.files() as Promise<string[]>)).includes(path);
const cards = (page: Page) => page.locator('[data-caption-card]');
const card = (page: Page, name: string) => page.locator('[data-caption-card]').filter({ has: page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) }) });
const cardButton = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')},`) });
const toolbar = (page: Page) => page.locator('[data-caption-toolbar]');
const names = (page: Page) => cards(page).evaluateAll(nodes => nodes.map(node => node.querySelector('[data-tile-id]')!.getAttribute('aria-label')!.split(',')[0]));

async function openCaption(page: Page, kind: 'caption' | 'advice' = 'caption') {
  await openPrepared(page, kind, 'Caption Project');
  await page.locator('[data-mode="caption"]').click();
  await expect(page.locator('[data-caption-mode]')).toBeVisible();
  await expect(cards(page)).toHaveCount(kind === 'caption' ? 5 : 3, { timeout: 30_000 });
}

test.describe('Caption mode', () => {
  test('the mode switch shows only the frames of dataset/ with their caption state', async ({ page }) => {
    await openPrepared(page, 'caption', 'Caption Project');
    await expect(page.locator('[data-mode="select"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-frame-tile]'), 'Select mode shows the inbox frame too').toHaveCount(6, { timeout: 30_000 });
    await expect(page.locator('[data-caption-mode]')).toHaveCount(0);

    await page.locator('[data-mode="caption"]').click();
    await expect(page.locator('[data-mode="caption"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-mode="select"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(cards(page)).toHaveCount(5, { timeout: 15_000 });
    expect((await names(page)).sort()).toEqual(['c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png']);
    await expect(page.locator('[data-board-grid]'), 'the Select grid is replaced').toHaveCount(0);
    await expect(page.locator('[data-caption-summary]')).toContainText('5 in dataset/ · 1 without a caption');
    await expect(card(page, 'c4.png').locator('[data-caption-state="empty"]')).toHaveText('empty caption');
    await expect(card(page, 'c5.png').locator('[data-caption-state="missing"]')).toHaveText('no caption');
    await expect(card(page, 'c1.png').locator('[data-chip="trigger"]')).toHaveText('hero');
    await expect(card(page, 'c1.png').locator('[data-chip="tag"]')).toHaveText(['red hair', 'smile']);
    await expect(page.locator('[data-tag-frequency="red hair"]')).toContainText('3/5');
    await expect(page.locator('[data-caption-auto]'), 'Auto-caption needs a connected model').toBeDisabled();

    await page.locator('[data-mode="select"]').click();
    await expect(page.locator('[data-frame-tile]')).toHaveCount(6);
  });

  test('Ctrl-click toggles, Shift-click selects a range, a plain click opens the lightbox', async ({ page }) => {
    await openCaption(page);
    const order = await names(page);
    await cardButton(page, order[0]).click({ modifiers: ['Control'] });
    await expect(card(page, order[0])).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('[data-clear-selection]')).toHaveText('1 selected · Clear');
    await cardButton(page, order[3]).click({ modifiers: ['Shift'] });
    for (const [index, name] of order.entries()) await expect(card(page, name), name).toHaveAttribute('data-selected', index <= 3 ? 'true' : 'false');
    await expect(page.locator('[data-caption-add]')).toHaveText('Add to 4');
    await cardButton(page, order[1]).click({ modifiers: ['Control'] });
    await expect(card(page, order[1]), 'Ctrl-click removes from the selection').toHaveAttribute('data-selected', 'false');
    await expect(page.locator('[data-clear-selection]')).toHaveText('3 selected · Clear');
    await expect(page.locator('[data-lightbox]'), 'modifier clicks never open the lightbox').toHaveCount(0);
    await page.getByRole('button', { name: `Select ${order[4]}` }).click();
    await expect(card(page, order[4])).toHaveAttribute('data-selected', 'true');
    await page.locator('[data-clear-selection]').click();
    for (const name of order) await expect(card(page, name)).toHaveAttribute('data-selected', 'false');
    await cardButton(page, order[2]).click();
    await expect(page.locator('[data-lightbox]')).toBeVisible();
    await expect(page.locator('[data-lightbox-name]')).toHaveText(order[2]);
  });

  test('bulk add and remove of a tag are one Undo step each and ignore case', async ({ page }) => {
    await openCaption(page);
    const depth = await undoDepth(page);
    await expect(page.locator('[data-caption-add]'), 'nothing selected, nothing to add to').toBeDisabled();
    for (const name of ['c1.png', 'c2.png', 'c4.png']) await cardButton(page, name).click({ modifiers: ['Control'] });
    await toolbar(page).getByLabel('Add tag to selected').fill('Smile');
    await expect(page.locator('[data-caption-add]')).toHaveText('Add to 3');
    await page.locator('[data-caption-add]').click();
    await expect.poll(() => text(page, 'dataset/c1.txt')).toBe('hero, red hair, Smile\n');
    expect(await text(page, 'dataset/c2.txt')).toBe('hero, Red Hair, hat, Smile\n');
    expect(await text(page, 'dataset/c4.txt'), 'an empty caption receives the tag').toBe('hero, Smile\n');
    expect(await text(page, 'dataset/c3.txt'), 'unselected frames are untouched').toBe('hero, red hair');
    await expect(card(page, 'c4.png').locator('[data-chip="tag"]')).toHaveText(['Smile']);
    await expect(toolbar(page).getByLabel('Add tag to selected'), 'the field is cleared after a successful add').toHaveValue('');
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);

    await undoOnce(page);
    expect(await text(page, 'dataset/c1.txt')).toBe('hero, red hair, smile');
    expect(await text(page, 'dataset/c2.txt')).toBe('hero, Red Hair, hat');
    expect(await text(page, 'dataset/c4.txt')).toBe('');
    await expect(card(page, 'c4.png').locator('[data-caption-state="empty"]')).toBeVisible();

    // Remove works on the selection; the count is the frames that have the tag (any case).
    await page.locator('[data-clear-selection]').click();
    await toolbar(page).getByLabel('Remove tag').fill('RED HAIR');
    await expect(page.locator('[data-caption-remove]')).toHaveText('Remove from 3');
    await cardButton(page, 'c1.png').click({ modifiers: ['Control'] });
    await expect(page.locator('[data-caption-remove]')).toHaveText('Remove from 1');
    await cardButton(page, 'c4.png').click({ modifiers: ['Control'] });
    await expect(page.locator('[data-caption-remove]'), 'c4 has no tags, so it does not count').toHaveText('Remove from 1');
    await page.locator('[data-caption-remove]').click();
    await expect.poll(() => text(page, 'dataset/c1.txt')).toBe('hero, smile\n');
    expect(await text(page, 'dataset/c2.txt')).toBe('hero, Red Hair, hat');
    expect(await text(page, 'dataset/c4.txt'), 'a frame without the tag is not rewritten').toBe('');
    await undoOnce(page);
    expect(await text(page, 'dataset/c1.txt')).toBe('hero, red hair, smile');

    // With nothing selected Remove goes through every caption of the dataset, in one step.
    await page.locator('[data-clear-selection]').click();
    await toolbar(page).getByLabel('Remove tag').fill('red hair');
    await expect(page.locator('[data-caption-remove]')).toHaveText('Remove from 3');
    await page.locator('[data-caption-remove]').click();
    await expect.poll(() => text(page, 'dataset/c3.txt')).toBe('hero\n');
    expect(await text(page, 'dataset/c1.txt')).toBe('hero, smile\n'); expect(await text(page, 'dataset/c2.txt')).toBe('hero, hat\n');
    expect(await missing(page, 'dataset/c5.txt'), 'a missing caption stays missing').toBe(true);
    await undoOnce(page);
    expect(await text(page, 'dataset/c3.txt')).toBe('hero, red hair');
    expect(await text(page, 'dataset/c2.txt')).toBe('hero, Red Hair, hat');
    await expect(page.locator('[data-tag-frequency="red hair"]')).toContainText('3/5');
  });

  test('a tag from the statistics fills the Remove field', async ({ page }) => {
    await openCaption(page);
    await page.locator('[data-tag-frequency="hat"]').click();
    await expect(toolbar(page).getByLabel('Remove tag')).toHaveValue('hat');
    await expect(page.locator('[data-caption-remove]')).toHaveText('Remove from 1');
  });

  test('changing the trigger word rewrites the captions of dataset/ and is one Undo step', async ({ page }) => {
    await openCaption(page);
    const depth = await undoDepth(page);
    const input = toolbar(page).getByLabel('Trigger word');
    await expect(input).toHaveValue('hero');
    await input.fill('villain');
    await input.press('Enter');
    await expect.poll(() => text(page, 'dataset/c1.txt')).toBe('villain, red hair, smile\n');
    await page.locator('[data-caption-summary]').click(); // Mod+Z in a text field is the field's own undo
    expect(await text(page, 'dataset/c3.txt')).toBe('villain, red hair\n');
    expect(await text(page, 'inbox/i1.txt'), 'only dataset/ is rewritten').toBe('hero, red hair');
    await expect(card(page, 'c1.png').locator('[data-chip="trigger"]')).toHaveText('villain');
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    await undoOnce(page);
    expect(await text(page, 'dataset/c1.txt')).toBe('hero, red hair, smile');
    await expect(card(page, 'c1.png').locator('[data-chip="trigger"]')).toHaveText('hero');
    await expect(input).toHaveValue('hero');
  });

  test('profile advice names the constant traits and removes them in one step; Undo brings them back', async ({ page }) => {
    await openCaption(page, 'advice');
    const advice = page.locator('[data-caption-advice]');
    await expect(advice).toBeVisible({ timeout: 15_000 });
    await expect(advice).toContainText('“red hair” on 3/3');
    await expect(advice).toContainText('Remove constant traits');
    await expect(advice).not.toContainText('smile');
    const depth = await undoDepth(page);
    await page.locator('[data-caption-advice-apply]').click();
    await expect.poll(() => text(page, 'dataset/m3.txt')).toBe('hero\n');
    expect(await text(page, 'dataset/m1.txt')).toBe('hero, smile\n'); expect(await text(page, 'dataset/m2.txt')).toBe('hero, hat\n');
    await expect(advice, 'with the tags gone the advice goes too').toHaveCount(0);
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    await undoOnce(page);
    expect(await text(page, 'dataset/m1.txt')).toBe('hero, red hair, smile'); expect(await text(page, 'dataset/m3.txt')).toBe('hero, red hair');
    await expect(advice).toBeVisible({ timeout: 15_000 });
  });

  test('without suggestions nothing can be applied; the mixed fixture has no advice', async ({ page }) => {
    await openCaption(page);
    await expect(page.locator('[data-caption-apply]')).toHaveCount(0);
    await expect(page.locator('[data-caption-advice]'), 'red hair is in 3 of 5 captions, below the 90% threshold').toHaveCount(0);
  });

  test.describe('model suggestions', () => {
    const seed = (page: Page) => next<unknown, Record<string, string[]>>(page, (api, spec) => api.seedProposals(spec as never), { 'c1.png': ['p1'], 'c3.png': ['p3a', 'p3b'], 'c4.png': ['p4'], 'c5.png': ['p5', 'Hero'] });

    test('without overwrite only frames without a caption get theirs; [] and a missing file both count; the trigger word is not a tag', async ({ page }) => {
      await openCaption(page);
      await seed(page);
      const apply = page.locator('[data-caption-apply]');
      await expect(apply).toHaveText('Apply 2 suggestions', { timeout: 15_000 });
      await expect(page.locator('[data-caption-overwrite]')).not.toBeChecked();
      const depth = await undoDepth(page);
      await apply.click();
      await expect.poll(() => text(page, 'dataset/c4.txt')).toBe('hero, p4\n');
      expect(await text(page, 'dataset/c5.txt'), 'created from the suggestion, "Hero" dropped as the trigger').toBe('hero, p5\n');
      expect(await text(page, 'dataset/c1.txt'), 'a caption that exists is kept').toBe('hero, red hair, smile');
      expect(await text(page, 'dataset/c3.txt')).toBe('hero, red hair');
      await expect(card(page, 'c5.png').locator('[data-chip="tag"]')).toHaveText(['p5']);
      await expect(apply, 'applied suggestions are not offered again').toHaveCount(0);
      await expect.poll(() => undoDepth(page)).toBe(depth + 1);
      await undoOnce(page);
      expect(await text(page, 'dataset/c4.txt')).toBe('');
      expect(await missing(page, 'dataset/c5.txt')).toBe(true);
      await expect(apply).toHaveText('Apply 2 suggestions');
    });

    test('with overwrite the suggestions replace existing captions too', async ({ page }) => {
      await openCaption(page);
      await seed(page);
      await page.locator('[data-caption-overwrite]').check();
      const apply = page.locator('[data-caption-apply]');
      await expect(apply).toHaveText('Apply 4 suggestions', { timeout: 15_000 });
      await apply.click();
      await expect.poll(() => text(page, 'dataset/c1.txt')).toBe('hero, p1\n');
      expect(await text(page, 'dataset/c3.txt')).toBe('hero, p3a, p3b\n'); expect(await text(page, 'dataset/c4.txt')).toBe('hero, p4\n');
      expect(await text(page, 'dataset/c2.txt'), 'no suggestion, no change').toBe('hero, Red Hair, hat');
      await undoOnce(page);
      expect(await text(page, 'dataset/c1.txt')).toBe('hero, red hair, smile'); expect(await text(page, 'dataset/c3.txt')).toBe('hero, red hair');
    });
  });
});

test.describe('caption in the lightbox', () => {
  const editor = (page: Page) => page.locator('[data-lightbox-caption-editor] textarea');
  const save = (page: Page) => page.locator('[data-lightbox-caption-save]');
  const shown = (page: Page) => page.locator('[data-lightbox-name]');

  test('the caption is editable, Save writes the TXT with the trigger word and is one Undo step', async ({ page }) => {
    await openCaption(page);
    await cardButton(page, 'c1.png').click();
    await expect(shown(page)).toHaveText('c1.png');
    await expect(editor(page)).toHaveValue('red hair, smile');
    await expect(save(page), 'nothing changed yet').toBeDisabled();
    const depth = await undoDepth(page);
    await editor(page).fill('red hair, smile, edited');
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect.poll(() => text(page, 'dataset/c1.txt')).toBe('hero, red hair, smile, edited\n');
    await expect(save(page)).toBeDisabled();
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);

    // Ctrl+Enter saves too; a frame without a caption file gets one.
    await page.locator('[data-lightbox-close]').click();
    await cardButton(page, 'c5.png').click();
    await expect(page.locator('[data-lightbox-caption]')).toHaveText('No caption yet');
    await editor(page).fill('typed');
    await editor(page).press('Control+Enter');
    await expect.poll(() => text(page, 'dataset/c5.txt')).toBe('hero, typed\n');
  });

  test('an unsaved draft is saved when moving with the arrow keys and with Next and Previous', async ({ page }) => {
    await openCaption(page);
    // The grid order is the lightbox order (newest first in this fixture); c1-c3 are neighbours with captions: [x, y, z] = their order.
    const order = await names(page);
    const [x, y, z] = order.filter(name => /^c[123]\.png$/.test(name));
    expect(order.indexOf(y) - order.indexOf(x), 'the three captioned frames are neighbours').toBe(1); expect(order.indexOf(z) - order.indexOf(y)).toBe(1);
    const file = (name: string) => `dataset/${name.replace('.png', '.txt')}`;
    const original = Object.fromEntries(await Promise.all([x, y, z].map(async name => [name, ((await text(page, file(name))) ?? '').replace(/\n$/, '')])));
    const tagsOf = (name: string) => original[name].replace(/^hero, /, '');
    await cardButton(page, x).click();
    await expect(shown(page)).toHaveText(x);
    await editor(page).fill(`${tagsOf(x)}, arrow draft`);
    // Arrows inside the text box move the cursor; they move the frame only from outside it.
    await editor(page).press('ArrowRight');
    await expect(shown(page)).toHaveText(x);
    await shown(page).click();
    await page.keyboard.press('ArrowRight');
    await expect(shown(page)).toHaveText(y);
    await expect.poll(() => text(page, file(x))).toBe(`${original[x]}, arrow draft\n`);
    await expect(editor(page), 'the next frame shows its own caption').toHaveValue(tagsOf(y));

    await editor(page).fill(`${tagsOf(y)}, button draft`);
    await page.locator('[data-lightbox-next]').click();
    await expect(shown(page)).toHaveText(z);
    await expect.poll(() => text(page, file(y))).toBe(`${original[y]}, button draft\n`);

    await editor(page).fill(`${tagsOf(z)}, previous draft`);
    await page.locator('[data-lightbox-prev]').click();
    await expect(shown(page)).toHaveText(y);
    await expect.poll(() => text(page, file(z))).toBe(`${original[z]}, previous draft\n`);
    await expect(editor(page)).toHaveValue(`${tagsOf(y)}, button draft`);

    // The saved drafts are still there when walking back; an unchanged caption is not rewritten.
    await expect.poll(() => undoDepth(page)).toBe(3);
    await shown(page).click();
    await page.keyboard.press('ArrowLeft');
    await expect(shown(page)).toHaveText(x);
    await expect(editor(page)).toHaveValue(`${tagsOf(x)}, arrow draft`);
    await page.keyboard.press('ArrowRight');
    await expect(shown(page)).toHaveText(y);
    expect(await undoDepth(page), 'moving without edits writes nothing').toBe(3);
  });

  test('closing with Escape keeps the saved caption of the shown frame in the card', async ({ page }) => {
    await openCaption(page);
    await cardButton(page, 'c3.png').click();
    await editor(page).fill('red hair, from lightbox');
    await save(page).click();
    await expect.poll(() => text(page, 'dataset/c3.txt')).toBe('hero, red hair, from lightbox\n');
    await shown(page).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-lightbox]')).toHaveCount(0);
    await expect(card(page, 'c3.png').locator('[data-chip="tag"]')).toHaveText(['red hair', 'from lightbox']);
    expect(await projectPaths(page)).toContain('Project/dataset/c3.png');
  });
});
