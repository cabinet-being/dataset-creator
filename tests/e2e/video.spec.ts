import { test, expect } from './fixtures';

test.beforeEach(async ({ page }) => { await page.goto('/tests/video-browser.html'); });

test('VFR WebM fixture decodes with exact timestamps', async ({ page }) => {
  await page.getByRole('button', { name: 'Create VFR fixture' }).click();
  await expect(page.getByRole('status')).toHaveText(/^PASS: WebM/, { timeout: 30_000 });
});

test('rotated MP4 fixture', async ({ page }) => {
  const h264 = await page.evaluate(async () => {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 320, height: 180, bitrate: 1_000_000 });
      return !!support.supported;
    } catch { return false; }
  });
  test.skip(!h264, 'Chromium used by Playwright has no H.264 (avc) WebCodecs encoder, so the MP4 fixture cannot be created');
  await page.getByRole('button', { name: 'Test rotated MP4' }).click();
  await expect(page.getByRole('status')).toHaveText(/^PASS: MP4 rotation/, { timeout: 30_000 });
});

test('one-hour streaming decode @slow', async ({ page }) => {
  test.setTimeout(600_000);
  await page.getByRole('button', { name: 'Test one-hour streaming' }).click();
  await expect(page.getByRole('status')).toHaveText(/^PASS: one-hour/, { timeout: 540_000 });
});

test('real DINOv2 model checks @network', async ({ page }) => {
  test.setTimeout(600_000);
  await page.getByRole('button', { name: 'Create VFR fixture' }).click();
  await expect(page.getByRole('status')).toHaveText(/^PASS: WebM/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Run real model checks' }).click();
  await expect(page.getByRole('status')).toHaveText(/^PASS: real DINOv2/, { timeout: 540_000 });
});
