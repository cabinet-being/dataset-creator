import { test, expect } from './fixtures';

for (const [button, tool] of [['Test Caption', 'tagging'], ['Test Analysis', 'analysis']] as const) {
  test(`${tool} tool honours entire project and explicit empty selection`, async ({ page }) => {
    await page.goto('/tests/scope-browser.html');
    await page.getByRole('button', { name: 'Load scope fixture' }).click();
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByRole('status')).toHaveText(`${tool} / entire project`, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Empty selection' }).click();
    await expect(page.getByRole('status')).toHaveText(`${tool} / explicit empty selection`);
    await page.getByRole('button', { name: 'Entire project' }).click();
    await expect(page.getByRole('status')).toHaveText(`${tool} / entire project`);
  });
}
