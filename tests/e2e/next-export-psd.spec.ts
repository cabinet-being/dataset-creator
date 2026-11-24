import { test, expect } from './fixtures';
import { next, openPrepared, sessionOf } from './nextFlow';

// Offline PSD export through the Export dialog. Photopea is replaced by a stub page served for https://www.photopea.com/:
// it speaks the same postMessage protocol as convertPsdToPng ('done' after load, the PSD buffer, 'done', "saveToOE", a PNG buffer back),
// so the plan, the conversion call, the ZIP and the caption are real while no network is used. The live service is not covered here.
const STUB = `<!doctype html><meta charset="utf-8"><script>
let received = 0;
const png = () => new Promise(resolve => {
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
  const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 16, 24); context.fillStyle = '#0000ff'; context.fillRect(16, 0, 16, 24);
  canvas.toBlob(blob => blob.arrayBuffer().then(resolve), 'image/png');
});
window.addEventListener('message', async event => {
  if (event.data instanceof ArrayBuffer) { received = event.data.byteLength; parent.postMessage('done', '*'); return; }
  if (typeof event.data === 'string' && event.data.includes('saveToOE')) { const buffer = await png(); parent.postMessage(buffer, '*', [buffer]); }
});
parent.postMessage('done', '*');
</script>`;

test('a PSD in the dataset is counted, converted to PNG and exported with its caption (stubbed Photopea)', async ({ page }) => {
  const requests: string[] = [];
  await page.route('https://www.photopea.com/**', route => { requests.push(route.request().url()); return route.fulfill({ contentType: 'text/html', body: STUB }); });
  await openPrepared(page, 'psd', 'Psd Project');
  await expect(page.locator('[data-export]')).toHaveText('Export 1 pair', { timeout: 30_000 });
  await page.locator('[data-export]').click();
  await expect(page.locator('[data-export-dialog]')).toBeVisible();
  await expect(page.locator('[data-export-run]')).toBeEnabled({ timeout: 15_000 });
  await page.locator('[data-export-run]').click();
  await expect(page.locator('[data-export-result]')).toContainText('Exported 1 pair', { timeout: 30_000 });
  expect(requests.length, 'the converter iframe asked for Photopea').toBeGreaterThan(0);

  const zips = (await next<string[]>(page, api => api.files() as Promise<string[]>)).filter(path => /^exports\/.*\.zip$/.test(path));
  expect(zips).toHaveLength(1);
  const entries = await next<{ name: string; text?: string; width?: number; height?: number }[], string>(page, (api, file) => api.zipEntries(file as never) as never, zips[0]);
  expect(entries.map(entry => entry.name)).toEqual(['sentinel.png', 'sentinel.txt']);
  expect(entries[0], 'the PSD became a PNG').toMatchObject({ width: 32, height: 24 });
  expect(entries[1].text).toBe('sentinel, psd');
  await expect.poll(async () => (await sessionOf(page)).lastExport?.entries).toBe(1);
  expect(await next<string[]>(page, api => api.files() as Promise<string[]>), 'the project keeps its PSD').toContain('dataset/sentinel.psd');
});
