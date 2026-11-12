import { test, expect, type Page } from './fixtures';

const row = (page: Page, name: string) => page.locator(`[data-explorer-path$="/${name}"]`).first();
const menu = async (page: Page, name: string, item: string) => {
  await row(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};

test.describe('explorer mutations (current behaviour)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/explorer-browser.html');
    await page.getByRole('button', { name: 'Start Explorer fixture' }).click();
    await expect(page.locator('[data-explorer-path$="Keyboard"]').first()).toBeVisible({ timeout: 20_000 });
    if (!await row(page, 'alpha.txt').isVisible()) await page.locator('[data-explorer-path$="Keyboard"]').first().click();
    await expect(row(page, 'alpha.txt')).toBeVisible();
  });

  test('rename via context menu updates the row and the open tab', async ({ page }) => {
    await menu(page, 'alpha.txt', 'Open');
    await expect(page.getByRole('tab', { name: /alpha\.txt/ })).toBeVisible();
    await menu(page, 'alpha.txt', 'Rename');
    const input = page.getByRole('textbox', { name: 'Rename alpha.txt' });
    await input.fill('renamed.txt');
    await input.press('Enter');
    await expect(row(page, 'renamed.txt')).toBeVisible();
    await expect(row(page, 'alpha.txt')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /renamed\.txt/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /alpha\.txt/ })).toHaveCount(0);
  });

  const newFolder = async (page: Page, parent: string, name: string) => {
    await menu(page, parent, 'New Folder');
    const input = page.getByRole('textbox', { name: 'New folder name' });
    await input.fill(name);
    await input.press('Enter');
    await expect(page.locator(`[data-explorer-path$="/${parent}/${name}"]`)).toBeVisible();
  };

  test('new folder via inline input creates the folder', async ({ page }) => {
    await newFolder(page, 'Keyboard', 'Created');
    await expect(page.getByRole('textbox', { name: 'New folder name' })).toHaveCount(0);
  });

  test('copy and paste into a folder creates a copy and keeps the source', async ({ page }) => {
    await newFolder(page, 'Keyboard', 'Target');
    // The file context menu has no Copy/Duplicate entries; files use the Explorer shortcuts (Mod+C / Mod+B).
    await row(page, 'alpha.txt').click();
    await page.keyboard.press('ControlOrMeta+c');
    await menu(page, 'Target', 'Paste');
    await expect(page.locator('[data-explorer-path$="/Keyboard/Target/alpha.txt"]')).toBeVisible();
    await expect(page.locator('[data-explorer-path$="/Keyboard/alpha.txt"]')).toBeVisible();
  });

  test('duplicate creates a sibling copy', async ({ page }) => {
    await row(page, 'beta.txt').click();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator('[data-explorer-path*="/Keyboard/beta"][data-explorer-path$=".txt"]')).toHaveCount(2);
    await expect(row(page, 'beta.txt')).toBeVisible();
  });

  test('delete with confirmation removes the row and closes the open tab', async ({ page }) => {
    const messages: string[] = [];
    page.on('dialog', dialog => { messages.push(dialog.message()); void dialog.accept(); });
    await menu(page, 'gamma.txt', 'Open');
    await expect(page.getByRole('tab', { name: /gamma\.txt/ })).toBeVisible();
    await menu(page, 'gamma.txt', 'Delete');
    await expect(row(page, 'gamma.txt')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /gamma\.txt/ })).toHaveCount(0);
    expect(messages.some(message => message.includes('gamma.txt'))).toBe(true);
    await expect(row(page, 'alpha.txt')).toBeVisible();
  });

  test('keyboard navigation moves focus, opens files and expands folders', async ({ page }) => {
    const folder = page.locator('[data-explorer-path$="Keyboard"]').first();
    await row(page, 'alpha.txt').click();
    await expect(row(page, 'alpha.txt')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'beta.txt')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(row(page, 'alpha.txt')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('[data-explorer-row]').last()).toBeFocused();
    await page.keyboard.press('Home');
    // Home targets the first child of the Project root (the root row itself is not navigable).
    await expect(page.locator('[data-explorer-row]').nth(1)).toBeFocused();
    await row(page, 'beta.txt').click();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: /beta\.txt/ })).toBeVisible();
    await folder.focus();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 'alpha.txt')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'alpha.txt')).toBeVisible();
  });
});
