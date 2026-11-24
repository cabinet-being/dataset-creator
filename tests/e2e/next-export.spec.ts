import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { next, openPrepared, sessionOf } from './nextFlow';

// Export dialog of the next UI over the "export" fixture (tests/next-browser.tsx): dataset/e1 and e2 are 64x40 frames with a caption, e3 has no caption file; inbox/x1 is not exported.
// Files are checked on disk (OPFS) and inside the ZIP; a folder export goes to a substituted picker folder.
type Listed = { name: string; text?: string; width?: number; height?: number };
const dialog = (page: Page) => page.locator('[data-export-dialog]');
const runButton = (page: Page) => page.locator('[data-export-run]');
const zipPaths = async (page: Page) => (await next<string[]>(page, api => api.files() as Promise<string[]>)).filter(path => /^exports\/.*\.zip$/.test(path));
const zipEntries = (page: Page, path: string) => next<Listed[], string>(page, (api, file) => api.zipEntries(file as never) as Promise<Listed[]>, path);
const sizeOf = (page: Page, path: string) => next<{ width: number; height: number }, string>(page, (api, file) => api.imageSize(file as never) as Promise<{ width: number; height: number }>, path);

test.beforeEach(async ({ page }) => {
  await openPrepared(page, 'export', 'Export Project');
  await expect(page.locator('[data-export]')).toHaveText('Export 3 pairs', { timeout: 30_000 });
  await page.locator('[data-export]').click();
  await expect(dialog(page)).toBeVisible();
  await expect(runButton(page)).toBeEnabled({ timeout: 15_000 });
});

test('the dialog shows the checks and one warning line for files without a caption file', async ({ page }) => {
  await expect(dialog(page).getByRole('heading', { name: 'Export 3 pairs' })).toBeVisible();
  const checks = page.locator('[data-export-check]');
  expect(await checks.count(), 'checks of the quality report').toBeGreaterThan(0);
  for (const status of await checks.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-status')))) expect(['ok', 'warn', 'fail', 'skipped']).toContain(status);
  await expect(page.locator('[data-export-warning="plan"]')).toHaveText('1 file has no caption file and will be exported without a .txt.');
  await expect(page.locator('[data-export-warning="plan"]'), 'one line, not one per file').toHaveCount(1);
  await expect(page.locator('[data-export-format]')).toHaveValue('project');
  await expect(page.locator('[data-export-format] option')).toHaveText(['ZIP in project (exports/)', 'ZIP download', 'Folder']);
  await expect(page.locator('[data-export-resize]')).toHaveValue('off');
  await expect(page.locator('[data-export-resize-note]')).toHaveCount(0);
  await expect(page.locator('[data-export-resize] option')).toHaveText(['Original size', 'Longest side', 'SDXL buckets']);
  await expect(page.locator('[data-export-result]')).toHaveCount(0);
  expect((await sessionOf(page)).lastExport, 'nothing exported yet').toBeUndefined();
});

test('Escape and Close close the dialog while nothing runs', async ({ page }) => {
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await page.locator('[data-export]').click();
  await expect(dialog(page)).toBeVisible();
  await page.locator('[data-export-close]').click();
  await expect(dialog(page)).toHaveCount(0);
});

test('ZIP in the project: exports/<name>.zip has the images and their captions; captions are copied as they are on disk; a frame without a caption has no .txt; lastExport is recorded', async ({ page }) => {
  expect(await zipPaths(page)).toEqual([]);
  await runButton(page).click();
  await expect(page.locator('[data-export-result]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-export-result]')).toContainText('Exported 3 pairs');
  const [zip] = await zipPaths(page);
  expect(zip, 'one ZIP in exports/').toBeTruthy();
  await expect(page.locator('[data-export-path]')).toContainText('exports/');
  const entries = await zipEntries(page, zip);
  expect(entries.map(entry => entry.name)).toEqual(['e1.png', 'e1.txt', 'e2.png', 'e2.txt', 'e3.png']);
  expect(entries.find(entry => entry.name === 'e1.txt')!.text).toBe('hero, one');
  expect(entries.find(entry => entry.name === 'e2.txt')!.text).toBe('hero, two');
  for (const name of ['e1.png', 'e2.png', 'e3.png']) expect(entries.find(entry => entry.name === name), name).toMatchObject({ width: 64, height: 40 });
  await expect(page.locator('[data-export-close]')).toHaveText('Done');
  await expect.poll(async () => (await sessionOf(page)).lastExport?.entries).toBe(3);
  const last = (await sessionOf(page)).lastExport!;
  expect(last.fingerprint).toMatch(/^[0-9a-f]{64}$/); expect(Date.parse(last.completedAt)).not.toBeNaN();
  await page.locator('[data-export-close]').click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await next<string[]>(page, api => api.files() as Promise<string[]>), 'the project itself is unchanged').toEqual(expect.arrayContaining(['dataset/e1.png', 'dataset/e1.txt', 'inbox/x1.png']));
});

test('ZIP download hands the browser a .zip and records lastExport without writing to exports/', async ({ page }) => {
  await page.locator('[data-export-format]').selectOption('download');
  const download = page.waitForEvent('download');
  await runButton(page).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.zip$/);
  await expect(page.locator('[data-export-result]')).toContainText('Exported 3 pairs', { timeout: 30_000 });
  expect(await zipPaths(page)).toEqual([]);
  await expect.poll(async () => (await sessionOf(page)).lastExport?.entries).toBe(3);
});

test('Folder: the files are written into the chosen folder and Show lists them', async ({ page }) => {
  await next(page, api => api.useExportFolder());
  await page.locator('[data-export-format]').selectOption('directory');
  await runButton(page).click();
  await expect(page.locator('[data-export-result]')).toContainText('Exported 3 pairs', { timeout: 30_000 });
  const listed = await next<Listed[]>(page, api => api.exportFolderFiles() as Promise<Listed[]>);
  // The export lands in a sub-folder of the chosen one; the names inside are the same as in a ZIP.
  expect(listed.map(entry => entry.name.split('/').pop())).toEqual(['e1.png', 'e1.txt', 'e2.png', 'e2.txt', 'e3.png']);
  expect(listed.filter(entry => entry.name.endsWith('.png')).every(entry => entry.width === 64 && entry.height === 40)).toBe(true);
  await page.locator('[data-export-show]').click();
  await expect(page.locator('[data-export-files] li'), 'Show lists the exported images').toHaveText([/e1\.png$/, /e2\.png$/, /e3\.png$/]);
  await expect(page.locator('[data-export-show]')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await sessionOf(page)).lastExport?.entries).toBe(3);
});

test('Resize to the longest side shrinks the exported copies only; the originals and the fingerprint show it', async ({ page }) => {
  await page.locator('[data-export-resize]').selectOption('longest');
  await expect(page.locator('[data-export-resize-note]')).toContainText('the images in the project stay as they are');
  const pixels = page.getByLabel('Longest side in pixels');
  await expect(pixels).toHaveValue('1024');
  await pixels.fill('32');
  await runButton(page).click();
  await expect(page.locator('[data-export-result]')).toBeVisible({ timeout: 30_000 });
  const [zip] = await zipPaths(page);
  const entries = await zipEntries(page, zip);
  for (const name of ['e1.png', 'e2.png', 'e3.png']) expect(entries.find(entry => entry.name === name), name).toMatchObject({ width: 32, height: 20 });
  expect(entries.find(entry => entry.name === 'e1.txt')!.text, 'captions are not touched by the resize').toBe('hero, one');
  for (const name of ['e1', 'e2', 'e3']) expect(await sizeOf(page, `dataset/${name}.png`), `${name} in the project`).toEqual({ width: 64, height: 40 });
  await expect.poll(async () => (await sessionOf(page)).lastExport?.entries).toBe(3);
  const resized = (await sessionOf(page)).lastExport!.fingerprint;

  // The same frames at their size are another plan.
  await page.locator('[data-export-close]').click();
  await page.locator('[data-export]').click();
  await expect(runButton(page)).toBeEnabled({ timeout: 15_000 });
  await runButton(page).click();
  await expect(page.locator('[data-export-result]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await sessionOf(page)).lastExport?.fingerprint).not.toBe(resized);
});

test('a longest side that does not shrink anything leaves the copies as they are', async ({ page }) => {
  await page.locator('[data-export-resize]').selectOption('longest');
  await page.getByLabel('Longest side in pixels').fill('4096');
  await runButton(page).click();
  await expect(page.locator('[data-export-result]')).toBeVisible({ timeout: 30_000 });
  const [zip] = await zipPaths(page);
  for (const entry of (await zipEntries(page, zip)).filter(item => item.name.endsWith('.png'))) expect(entry, entry.name).toMatchObject({ width: 64, height: 40 });
});

test('the model bucket resize makes the copies smaller without enlarging them', async ({ page }) => {
  await page.locator('[data-export-resize]').selectOption('bucket');
  await expect(page.locator('[data-export-resize-note]')).toBeVisible();
  await runButton(page).click();
  await expect(page.locator('[data-export-result]')).toBeVisible({ timeout: 30_000 });
  const [zip] = await zipPaths(page);
  // 64x40 is far below every SDXL bucket, so nothing is enlarged.
  for (const entry of (await zipEntries(page, zip)).filter(item => item.name.endsWith('.png'))) expect(entry, entry.name).toMatchObject({ width: 64, height: 40 });
});

test('Cancel stops a running export: no ZIP, no lastExport, and Escape does not close the dialog meanwhile', async ({ page }) => {
  await page.locator('[data-export-resize]').selectOption('longest');
  await page.getByLabel('Longest side in pixels').fill('32');
  await next(page, api => api.holdBitmaps());
  await runButton(page).click();
  const progress = page.locator('[data-export-progress]');
  await expect(progress).toBeVisible({ timeout: 15_000 });
  await expect(progress).toContainText('0/3');
  await expect(runButton(page)).toBeDisabled();
  await expect(page.locator('[data-export-close]')).toBeDisabled();
  await expect(page.locator('[data-export-format]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog(page), 'a running export keeps the dialog open').toBeVisible();

  await page.locator('[data-export-cancel]').click();
  await next(page, api => api.releaseBitmaps());
  await expect(progress).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('[data-export-result]')).toHaveCount(0);
  await expect(runButton(page)).toBeEnabled();
  expect(await zipPaths(page), 'a cancelled export leaves no ZIP').toEqual([]);
  expect((await sessionOf(page)).lastExport).toBeUndefined();

  // Exporting again works.
  await runButton(page).click();
  await expect(page.locator('[data-export-result]')).toBeVisible({ timeout: 30_000 });
  expect((await zipPaths(page)).length).toBe(1);
  await expect.poll(async () => (await sessionOf(page)).lastExport?.entries).toBe(3);
});
