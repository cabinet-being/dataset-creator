import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { filterCount, next, openPrepared, projectPaths } from './nextFlow';

// Full-screen tools above the Board: Video Frames (from Sources) and Edit in Photopea (from the lightbox).
// "video" fixture: inbox/clip.webm (4 frames of 160x90, written with the browser's own VP8 encoder) and inbox/shot.png.
// Photopea is an external site and the network guard aborts it, so only the overlay around it is observable here.
const overlay = (page: Page) => page.locator('[data-tool-overlay]');
const files = (page: Page) => next<string[]>(page, api => api.files() as Promise<string[]>);

test.describe('Video Frames', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'video', 'Video Project');
    await expect(filterCount(page, 'all')).toHaveText('1', { timeout: 30_000 });
  });

  test('a video is listed in Sources with a counter, and is not a frame', async ({ page }) => {
    const videos = page.locator('[data-sources-videos]');
    await expect(videos).toBeVisible({ timeout: 15_000 });
    await expect(videos.getByRole('heading')).toHaveText('1 video');
    await expect(videos.locator('[data-video-item]')).toHaveCount(1);
    await expect(videos.locator('[data-video-item]')).toContainText('clip.webm');
    await expect(page.locator('[data-source-videos]').first(), 'the folder row counts its videos').toHaveText('1 video');
    await expect(page.locator('[data-count-inbox]'), 'a video is not counted as an image').toHaveText('1');
    await expect(page.locator('[data-frame-tile]'), 'and is not in the grid').toHaveCount(1);
    expect(await files(page)).toContain('inbox/clip.webm');
  });

  test('a click opens the overlay; Escape and Close close it', async ({ page }) => {
    await page.locator('[data-video-item]').click();
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toHaveAttribute('aria-modal', 'true');
    await expect(overlay(page).getByRole('heading', { name: 'Video frames: clip.webm' })).toBeVisible();
    await expect(overlay(page).locator('[data-video-frames-tool]')).toBeVisible();
    await expect(page.getByLabel('Frame destination')).toHaveValue('Project/inbox/clip', { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);

    await page.locator('[data-video-item]').click();
    await expect(overlay(page)).toBeVisible();
    await page.locator('[data-overlay-close]').click();
    await expect(overlay(page)).toHaveCount(0);
    await expect(page.locator('[data-board]')).toBeVisible();
  });

  test('a saved frame goes to inbox/<video name>/ and shows up in Sources and in the grid', async ({ page }) => {
    await page.locator('[data-video-item]').click();
    const save = overlay(page).getByRole('button', { name: 'Save frame' });
    await expect(save).toBeEnabled({ timeout: 30_000 });
    expect((await files(page)).filter(path => path.startsWith('inbox/clip/'))).toEqual([]);
    await save.click();
    await expect.poll(async () => (await files(page)).filter(path => /^inbox\/clip\/.+\.png$/.test(path)).length, { timeout: 30_000 }).toBe(1);
    await page.locator('[data-overlay-close]').click();
    await expect(overlay(page)).toHaveCount(0);
    // Indexed after saving: the new folder is a source with its frame, and the frame is a tile.
    await expect(filterCount(page, 'all')).toHaveText('2', { timeout: 20_000 });
    await expect(page.locator('[data-count-inbox]')).toHaveText('2');
    await expect(page.getByRole('tree', { name: 'Inbox folders' }).getByRole('button', { name: /^clip 1$/ }), 'the new folder is a source with its frame').toBeVisible({ timeout: 15_000 });
    expect((await projectPaths(page)).filter(path => path.startsWith('Project/inbox/clip/'))).toHaveLength(1);
  });
});

test.describe('Edit in Photopea', () => {
  test.beforeEach(async ({ page }) => {
    await openPrepared(page, 'grid', 'Photopea Project');
    await expect(filterCount(page, 'all')).toHaveText('7', { timeout: 30_000 });
    await page.getByRole('button', { name: /^in1\.png,/ }).click();
    await expect(page.locator('[data-lightbox]')).toBeVisible();
  });

  test('the lightbox button opens the full-screen overlay for that frame', async ({ page }) => {
    await page.locator('[data-lightbox] [data-action="photopea"]').click();
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toHaveAttribute('data-dock-view', 'next:photopea');
    await expect(overlay(page).getByRole('heading', { name: /^Edit in Photopea: .+\.png$/ })).toBeVisible();
    await expect(overlay(page).locator('iframe'), 'the editor frame is mounted').toHaveCount(1);
  });

  test('the overlay title names the frame the way the lightbox does', async ({ page }) => {
    await page.locator('[data-lightbox] [data-action="photopea"]').click();
    await expect(overlay(page).getByRole('heading', { name: 'Edit in Photopea: in1.png' })).toBeVisible({ timeout: 3_000 });
  });

  test('Escape closes only the overlay: the lightbox below keeps its frame', async ({ page }) => {
    await page.locator('[data-lightbox] [data-action="photopea"]').click();
    await expect(overlay(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);
    await expect(page.locator('[data-lightbox]')).toBeVisible();
    await expect(page.locator('[data-lightbox-name]')).toHaveText('in1.png');
    // A second Escape now closes the lightbox.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-lightbox]')).toHaveCount(0);
  });

  test('the Close button closes only the overlay', async ({ page }) => {
    await page.locator('[data-lightbox] [data-action="photopea"]').click();
    await expect(overlay(page)).toBeVisible();
    await overlay(page).locator('[data-overlay-close]').click();
    await expect(overlay(page)).toHaveCount(0);
    await expect(page.locator('[data-lightbox]')).toBeVisible();
  });

  test('Arrow keys inside the overlay do not move the lightbox frame', async ({ page }) => {
    await page.locator('[data-lightbox] [data-action="photopea"]').click();
    await expect(overlay(page)).toBeVisible();
    await overlay(page).locator('[data-overlay-close]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-lightbox-name]')).toHaveText('in1.png');
  });

  test('Mod+S saves the project normally, but not while the Photopea document is open', async ({ page }) => {
    // A project change is written by autosave after 250 ms; Mod+S writes it at once. The write is observed for 120 ms after the key.
    await next(page, api => api.spyProjectWrites());
    const press = () => page.evaluate(async () => {
      const api = (window as unknown as { __next: { touch(): void; projectWrites(): number } }).__next;
      const before = api.projectWrites();
      api.touch();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 120));
      return api.projectWrites() - before;
    });
    await page.locator('[data-lightbox] [data-action="photopea"]').click();
    await expect(overlay(page)).toBeVisible();
    // The Photopea document registers once the editor reports it; that needs the real site, so it is registered by the stand.
    const registered = await next<string[]>(page, api => api.documentViews() as string[]);
    if (!registered.includes('next:photopea')) await next(page, api => { (api.fakeDocument as (id: string) => void)('next:photopea'); return null; });
    await expect.poll(() => next<string[]>(page, api => api.documentViews() as string[])).toContain('next:photopea');
    expect(await press(), 'Mod+S is left to the Photopea document').toBe(0);
    await page.waitForTimeout(600);

    await overlay(page).locator('[data-overlay-close]').click();
    await expect(overlay(page)).toHaveCount(0);
    await next(page, api => { (api.dropFakeDocument as () => void)(); return null; });
    expect(await press(), 'without the document Mod+S saves the project at once').toBeGreaterThan(0);
  });
});
