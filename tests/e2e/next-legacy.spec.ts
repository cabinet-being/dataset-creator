import { test, expect } from './fixtures';
import { filterCount, flushSave, next, openPrepared, sessionOf, tileOf } from './nextFlow';

// A project saved by the old UI: v1 session with stage / cursor / filter / auto.shortlist and decisions, manifest currentTool, old localStorage keys.
// Fixture "legacy": inbox/s1 skipped, dataset/m1 manually accepted, dataset/a1 accepted by the auto flow, inbox/u1 untouched.
const OLD_KEYS = ['dataset-creator-ui-mode', 'dataset-creator-workspace-v2', 'dataset-creator-workspace-layout', 'dataset-creator-docking-v1', 'dataset-creator-density', 'dataset-creator-workspace-tab', 'review-view:x'];

test('old localStorage keys are removed on start; the theme and the shortcut preferences other than bindings stay', async ({ page }) => {
  await page.goto('/tests/next-browser.html');
  await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(({ keys }) => {
    for (const key of keys) localStorage.setItem(key, 'old');
    localStorage.setItem('dataset-creator-theme', 'dark');
    localStorage.setItem('dataset-creator-shortcuts-v1', JSON.stringify({ bindings: { 'project.save': 'Mod+Q' }, other: 1 }));
  }, { keys: OLD_KEYS });
  await page.reload();
  await expect(page.locator('[data-projects-screen]')).toBeVisible({ timeout: 20_000 });
  const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
  for (const key of OLD_KEYS) expect(stored, key).not.toHaveProperty([key]);
  expect(stored['dataset-creator-theme']).toBe('dark');
  // The command provider rewrites the key in its own shape; what matters is that the old bindings are gone.
  expect(stored['dataset-creator-shortcuts-v1'] ?? '').not.toContain('Mod+Q');
  expect(JSON.parse(stored['dataset-creator-shortcuts-v1'] ?? '{}')).not.toHaveProperty('bindings');
});

test('a v1 project opens in the Board: skipped is Banned, a manual accept is Pinned, stale fields are not written back', async ({ page }) => {
  await openPrepared(page, 'legacy', 'Old Project');
  await expect(filterCount(page, 'all')).toHaveText('4', { timeout: 30_000 });
  await expect(page.locator('[data-next-project-name]')).toHaveText('Old Project');
  await expect(tileOf(page, 's1.png')).toHaveAttribute('data-status', 'Banned');
  await expect(tileOf(page, 'm1.png')).toHaveAttribute('data-status', 'Pinned');
  await await expect(tileOf(page, 'u1.png')).toHaveAttribute('data-status', 'Inbox');
  await expect(tileOf(page, 'a1.png'), 'an auto accept is not a manual one').toHaveAttribute('data-status', 'In');
  await expect(filterCount(page, 'banned')).toHaveText('1');
  await expect(filterCount(page, 'pinned')).toHaveText('1');
  const session = await sessionOf(page);
  expect(session.records['s1.png'].override).toBe('ban');
  expect(session.records['m1.png'].override).toBe('pin');
  expect(session.records['a1.png'].override).toBeUndefined();
  expect(session.records['u1.png'].override).toBeUndefined();

  await flushSave(page);
  const manifest = JSON.parse((await next<string | null>(page, api => api.readText('.datasetcreator/project.json') as Promise<string | null>))!);
  const written = manifest.project.buildSession;
  expect(written.version).toBe(2);
  for (const stale of ['stage', 'cursor', 'filter']) expect(written, stale).not.toHaveProperty(stale);
  expect(written.auto ?? {}, 'auto.shortlist is dropped').not.toHaveProperty('shortlist');
  expect(manifest.project, 'currentTool is not written back').not.toHaveProperty('currentTool');
});
