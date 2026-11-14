import { createHash } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { WD_TAGGER_MODEL } from '../../src/services/tagging/wdTaggerModelManifest';

const HF = /^https:\/\/huggingface\.co\//;
const URL_PAGE = '/tests/tagger-download-browser.html';
const root = (page: Page) => page.getByTestId('wd-tagger-download');
type Wd = {
  manifest: { files: { model: { url: string }; tags: { url: string } } };
  modelBytes: number[]; tagsBytes: number[];
};
const wd = (page: Page) => page.evaluate(() => {
  const w = (window as unknown as { __wd: Wd }).__wd;
  return { model: w.modelBytes, tags: w.tagsBytes };
});
const call = <T,>(page: Page, expression: string): Promise<T> => page.evaluate(`(async () => { const w = window.__wd; return ${expression}; })()`) as Promise<T>;
const fulfillBytes = (route: Route, bytes: number[], status = 200) => route.fulfill({ status, body: Buffer.from(bytes), contentType: 'application/octet-stream' });

test('panel shows name, size and license and makes no Hugging Face request without a click', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (HF.test(request.url())) requests.push(request.url()); });
  await page.goto(URL_PAGE);
  await expect(root(page)).toContainText('WD ViT Tagger v3');
  await expect(root(page)).toContainText('378.8 MB');
  await expect(root(page)).toContainText('Apache-2.0');
  await expect(page.getByTestId('wd-tagger-download-start')).toHaveText('Download WD ViT Tagger v3 (378.8 MB)');
  await page.waitForTimeout(1000);
  expect(requests).toEqual([]);
});

test('a bad response shows an alert and Retry issues a new request', async ({ page }) => {
  // A real 4xx/5xx would add browser-level console errors, which the guard rejects; HTTP statuses are covered in tests/model-download.mjs.
  let body = 'x'.repeat(10); const hits: string[] = [];
  await page.route(HF, (route) => { hits.push(route.request().url()); return route.fulfill({ status: 200, body }); });
  await page.goto(URL_PAGE);
  await page.getByTestId('wd-tagger-download-start').click();
  await expect(page.getByTestId('wd-tagger-download-error')).toContainText('Incomplete model.onnx download');
  await expect(page.getByTestId('wd-tagger-download-error')).toHaveAttribute('role', 'alert');
  expect(hits).toEqual([WD_TAGGER_MODEL.files.model.url]);
  body = 'y'.repeat(20);
  await page.getByTestId('wd-tagger-download-retry').click();
  await expect(page.getByTestId('wd-tagger-download-error')).toContainText('Incomplete model.onnx download');
  await expect.poll(() => hits.length).toBe(2);
  expect(await call(page, 'w.saved()')).toEqual({ model: null, tags: null });
});

test('Cancel during a stalled response gives cancelled state and saves nothing', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(HF, async (route) => { await gate; await route.abort().catch(() => {}); });
  await page.goto(URL_PAGE);
  await page.getByTestId('wd-tagger-download-start').click();
  await expect(page.getByTestId('wd-tagger-download-progress')).toBeVisible();
  await expect(page.getByTestId('wd-tagger-download-progress')).toHaveAttribute('aria-valuenow', '0');
  await page.getByTestId('wd-tagger-download-cancel').click();
  await expect(root(page)).toContainText('Download cancelled. Nothing was saved.');
  await expect(page.getByTestId('wd-tagger-download-error')).toHaveCount(0);
  expect(await call(page, 'w.saved()')).toEqual({ model: null, tags: null });
  release();
  await expect(page.getByTestId('wd-tagger-download-retry')).toBeVisible();
});

test('verified download is stored with sha256/source; restore detects tampered bytes', async ({ page }) => {
  await page.route('**/*.wasm', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/wasm' }));
  const bytes = await (async () => { await page.goto(URL_PAGE); return wd(page); })();
  const urls = await call<{ model: string; tags: string }>(page, '({ model: w.manifest.files.model.url, tags: w.manifest.files.tags.url })');
  await page.route(HF, (route) => fulfillBytes(route, route.request().url() === urls.model ? bytes.model : bytes.tags));
  const ok = await call<boolean>(page, 'w.download()');
  // Tiny fake bytes are not a valid ONNX model, so connecting fails after a successful verified save.
  expect(ok).toBe(false);
  const saved = await call<{ model: { sha256: string; source: string; size: number; hasHandle: boolean }; tags: { sha256: string; source: string; size: number } }>(page, 'w.saved()');
  expect(saved.model).toMatchObject({ name: 'model.onnx', source: 'download', size: bytes.model.length, hasHandle: false });
  expect(saved.tags).toMatchObject({ name: 'selected_tags.csv', source: 'download', size: bytes.tags.length });
  expect(saved.model.sha256).toBe(createHash('sha256').update(Buffer.from(bytes.model)).digest('hex'));
  expect(saved.tags.sha256).toBe(createHash('sha256').update(Buffer.from(bytes.tags)).digest('hex'));
  const states = await call<{ status: string; completed: number; total: number; error?: string }[]>(page, 'w.states()');
  const names = states.map((s) => s.status);
  expect(names[0]).toBe('downloading');
  expect(names).toContain('saving');
  expect(Math.max(...states.filter((s) => s.status === 'downloading').map((s) => s.completed))).toBe(bytes.model.length + bytes.tags.length);
  expect(states.at(-1)?.status).toBe('error');
  expect(states.at(-1)?.error).not.toMatch(/integrity/);
  // Corrupt stored bytes (sha256 kept): restore must refuse with an integrity error.
  await call(page, 'w.tamper()');
  const restored = await call<{ connected: boolean; message: string }>(page, 'w.restore()');
  expect(restored.connected).toBe(false);
  expect(restored.message).toContain('model.onnx failed its integrity check');
});

test('wrong bytes fail the integrity check, show Retry and save nothing; Retry works after the route is fixed', async ({ page }) => {
  await page.route('**/*.wasm', (route) => route.fulfill({ status: 200, body: '', contentType: 'application/wasm' }));
  await page.goto(URL_PAGE);
  const bytes = await wd(page);
  const urls = await call<{ model: string; tags: string }>(page, '({ model: w.manifest.files.model.url, tags: w.manifest.files.tags.url })');
  let corrupt = true;
  await page.route(HF, (route) => {
    const model = route.request().url() === urls.model;
    const body = model ? bytes.model.slice() : bytes.tags;
    if (corrupt && model) body[0] ^= 0xff;
    return fulfillBytes(route, body);
  });
  expect(await call<boolean>(page, 'w.download()')).toBe(false);
  expect((await call<{ error?: string }[]>(page, 'w.states()')).at(-1)?.error).toContain('model.onnx failed its integrity check');
  expect(await call(page, 'w.saved()')).toEqual({ model: null, tags: null });
  corrupt = false;
  await call(page, 'w.download()');
  const saved = await call<{ model: { source: string } | null }>(page, 'w.saved()');
  expect(saved.model?.source).toBe('download');
});

// Hits the real Hugging Face to confirm the pinned selected_tags.csv matches the manifest.
test('pinned selected_tags.csv matches the manifest @network', async ({ request }) => {
  test.setTimeout(60_000);
  const asset = WD_TAGGER_MODEL.files.tags;
  const response = await request.get(asset.url, { timeout: 30_000 }).catch(() => undefined);
  test.skip(!response, 'Hugging Face is not reachable');
  expect(response!.ok()).toBe(true);
  const body = await response!.body();
  expect(body.length).toBe(asset.bytes);
  expect(createHash('sha256').update(body).digest('hex')).toBe(asset.sha256);
  const head = await request.head(WD_TAGGER_MODEL.files.model.url, { timeout: 30_000 });
  expect(head.ok()).toBe(true);
});
