import { test, expect } from './fixtures';
import { counter, filterRadio, idleStatus, markShortlist, panel, selectFilter, step, suggestAndApply } from './buildFlow';

test('build workspace shows two candidate frames', async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare Build fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Candidate filmstrip').getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

type Fixture = { session: () => { records: Record<string, { decision: string; triage?: { group: string; reasons: { code: string }[] } }> }; paths: () => Record<string, string | undefined> };
declare global { interface Window { __buildFixture: Fixture } }

const expectCounters = (page: import('@playwright/test').Page, needs: number, accepted: number, rejected: number) => Promise.all([
  expect(counter(page, 'Flagged')).toHaveText(`Flagged ${needs}`, { timeout: 60_000 }),
  expect(counter(page, 'Accepted')).toHaveText(`Accepted ${accepted}`, { timeout: 60_000 }),
  expect(counter(page, 'Rejected')).toHaveText(`Rejected ${rejected}`, { timeout: 60_000 }),
]);
const datasetCount = async (page: import('@playwright/test').Page) => Object.values(await pathsOf(page)).filter((path) => /(^|\/)dataset\//.test(path ?? '')).length;
const pathsOf = (page: import('@playwright/test').Page) => page.evaluate(() => window.__buildFixture.paths());
const reasonsByName = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const session = window.__buildFixture.session();
  return Object.fromEntries(Object.entries(session.records).map(([id, record]) => [id, { decision: record.decision, group: record.triage?.group, codes: record.triage?.reasons.map((reason) => reason.code) ?? [] }]));
});

test.describe('build auto pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
    // Pass 1 shortlist -> captions -> Narrow -> Apply: 3 files reach the Dataset in one batch.
    await suggestAndApply(page);
  });

  test('triages, assembles the Dataset and leaves rejected sources untouched', async ({ page }) => {
    // 9 sources: 5 distinct sharp (one near-duplicate by fake vectors), 1 exact copy, tiny, flat, below-target.
    // Triage rejects tiny, flat and the exact copy; below-target needs a decision. Target 3: pass 1 shortlists 4 of the
    // distinct sharp files (the near duplicate never joins), pass 2 narrows to 3 and applies them.
    await expectCounters(page, 1, 5, 3);
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Finding|Describing|Picking|Adding|Working/ })).toHaveCount(0, { timeout: 30_000 });
    await expect(panel(page)).toContainText('Dataset 3 of 3');

    await selectFilter(page, 'needs-decision');
    await expect(page.locator('aside').getByText('below.png', { exact: true })).toBeVisible();
    await expect(page.locator('aside [data-triage-box]')).toContainText('Proposal: needs decision');
    await expect(page.locator('aside [data-triage-box]')).toContainText('below');

    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    const paths = await pathsOf(page);
    const inDataset = Object.entries(paths).filter(([, path]) => /(^|\/)dataset\//.test(path ?? ''));
    expect(inDataset).toHaveLength(3);
    const rest = Object.entries(paths).filter(([, path]) => !/(^|\/)dataset\//.test(path ?? ''));
    expect(rest).toHaveLength(6);
    for (const [name, path] of rest) expect(path, `${name} must stay in inbox`).toMatch(/(^|\/)inbox\//);
    for (const name of ['tiny.png', 'flat.png', 'below.png', 'a-copy.png']) expect(paths[name]).toMatch(new RegExp(`(^|/)inbox/${name}$`));

    const records = Object.values(await reasonsByName(page));
    const codes = (code: string) => records.filter((record) => record.codes.includes(code)).length;
    expect(codes('too-small')).toBe(1);
    expect(codes('blurry')).toBe(1);
    expect(codes('exact-duplicate')).toBe(1);
    expect(codes('below-target-resolution')).toBe(1);
    expect(records.filter((record) => record.decision === 'accepted')).toHaveLength(3);
    expect(records.filter((record) => record.group === 'rejected' && record.decision === 'unreviewed')).toHaveLength(3);
  });

  test('shows rejection reasons in the aside', async ({ page }) => {
    await expectCounters(page, 1, 5, 3);
    await selectFilter(page, 'rejected');
    const filmstrip = page.getByLabel('Candidate filmstrip').getByRole('button');
    await expect(filmstrip).toHaveCount(3);
    const seen = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      await filmstrip.nth(index).click();
      const box = page.locator('aside [data-triage-box]');
      await expect(box).toContainText('Proposal: rejected');
      seen.add((await box.locator('li').allTextContents()).join(' | '));
    }
    const all = [...seen].join('\n');
    expect(all).toMatch(/far below the 1024px minimum/);
    expect(all).toMatch(/Image is blurry/);
    expect(all).toMatch(/Exact duplicate of another image/);
  });

  test('manual accept of a rejected proposal moves it into the Dataset', async ({ page }) => {
    await expectCounters(page, 1, 5, 3);
    await selectFilter(page, 'rejected');
    const filmstrip = page.getByLabel('Candidate filmstrip').getByRole('button');
    await expect(filmstrip).toHaveCount(3);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await filmstrip.first().click();
    await page.getByRole('button', { name: 'Accept · A' }).click();
    await expectCounters(page, 1, 6, 2);
    await expect.poll(() => datasetCount(page), { timeout: 30_000 }).toBe(4);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('batch Reject all and Accept all override proposals on the needs-decision group', async ({ page }) => {
    await expectCounters(page, 1, 5, 3);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await selectFilter(page, 'needs-decision');
    await page.getByRole('button', { name: 'Reject all 1' }).click();
    await expectCounters(page, 0, 5, 4);
    expect((await pathsOf(page))['below.png']).toMatch(/inbox\/below\.png$/);

    // Accept all acts on the whole visible group: 3 rejected proposals plus the explicitly skipped item.
    await selectFilter(page, 'rejected');
    await expect(page.getByRole('button', { name: 'Accept all 4' })).toBeEnabled();
    await page.getByRole('button', { name: 'Accept all 4' }).click();
    await expectCounters(page, 0, 9, 0);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(7);
    expect((await pathsOf(page))['below.png']).toMatch(/(^|\/)dataset\/below\.png$/);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('bulk Accept all moves every file and one Undo reverts all of them', async ({ page }) => {
    await expectCounters(page, 1, 5, 3);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    const before = await pathsOf(page);
    await selectFilter(page, 'rejected');
    await expect(page.getByRole('button', { name: 'Accept all 3' })).toBeEnabled();
    await page.getByRole('button', { name: 'Accept all 3' }).click();
    await expectCounters(page, 1, 8, 0);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(6);
    await page.evaluate(() => (window as unknown as { __buildFixture: { undo: () => Promise<void> } }).__buildFixture.undo());
    await expectCounters(page, 1, 5, 3);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    expect(await pathsOf(page)).toEqual(before);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('bulk Reject all of accepted items moves every file out and one Undo reverts all of them', async ({ page }) => {
    await expectCounters(page, 1, 5, 3);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    const before = await pathsOf(page);
    await selectFilter(page, 'accepted');
    await expect(page.getByRole('button', { name: 'Reject all 5' })).toBeEnabled();
    await page.getByRole('button', { name: 'Reject all 5' }).click();
    await expectCounters(page, 1, 0, 8);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(0);
    await page.evaluate(() => (window as unknown as { __buildFixture: { undo: () => Promise<void> } }).__buildFixture.undo());
    await expectCounters(page, 1, 5, 3);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    expect(await pathsOf(page)).toEqual(before);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('changing Min short side re-triages without errors', async ({ page }) => {
    await expectCounters(page, 1, 5, 3);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByLabel('Model', { exact: true }).selectOption('sd15');
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Finding|Describing|Picking|Adding|Working/ })).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => Object.values(await reasonsByName(page)).filter((record) => record.codes.includes('below-target-resolution')).length, { timeout: 30_000 }).toBe(0);
    const records = Object.values(await reasonsByName(page));
    expect(records.filter((record) => record.group === 'needs-decision')).toHaveLength(0);
    expect(await datasetCount(page)).toBe(3);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('build without auto assembly', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  });

  test('entering Select runs triage only; Find candidates only marks candidates', async ({ page }) => {
    // Triage is automatic: rejected proposals (tiny, flat, exact copy) appear without any click.
    await expect(counter(page, 'Rejected')).not.toHaveText('Rejected 0', { timeout: 60_000 });
    await idleStatus(page);
    expect(await datasetCount(page)).toBe(0);
    expect(Object.values(await reasonsByName(page)).filter((record) => record.decision === 'accepted')).toHaveLength(0);
    await expect(step(page, 'find')).toHaveAttribute('data-state', 'ready');
    await expect(filterRadio(page, 'shortlisted')).toHaveCount(0);
    const names = await markShortlist(page);
    expect(names.length).toBeGreaterThanOrEqual(3);
    await expect(filterRadio(page, 'shortlisted')).toHaveText(`Candidates ${names.length}`);
    // Pass 1 moves nothing and decides nothing; the Dataset only grows after Pick and Add.
    expect(await datasetCount(page)).toBe(0);
    expect(Object.values(await reasonsByName(page)).filter((record) => record.decision !== 'unreviewed')).toHaveLength(0);
    await expectCounters(page, 1, 5, 3);
  });

  test('X then X/A keep working without clicking, and changing the queue filter keeps shortcuts', async ({ page }) => {
    await markShortlist(page);
    await expectCounters(page, 1, 5, 3);
    await idleStatus(page);
    await selectFilter(page, 'all');
    await page.getByLabel('Candidate filmstrip').getByRole('button').first().click();
    const snapshot = async () => JSON.stringify(Object.entries(await reasonsByName(page)).map(([id, x]) => [id, x.decision]).sort());
    const press = async (key: string) => { const before = await snapshot(); await page.keyboard.press(key); await expect.poll(snapshot, { message: `key ${key} must change a decision` }).not.toBe(before); await expect(page.getByRole('button', { name: 'Reject · X' })).toBeEnabled(); };
    await press('x');
    await press('x'); // focus must not have fallen to body after the first reject; the cursor moved on
    await press('x');

    // Changing the filter moves focus to a radio button; shortcuts must still reach the workspace afterwards.
    await selectFilter(page, 'rejected');
    await press('a');
    await press('a');
  });

  // Skipped: editing a trait with existing suggestions needs the real local tagger; the fixture injects only a fake DINOv2 encoder.
});

test.describe('character traits', () => {
  test('character project adds, switches and removes a trait', async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare empty fixture' }).click();
    const group = page.getByRole('group', { name: 'Character traits' });
    await expect(group).toBeVisible({ timeout: 20_000 });
    await group.getByLabel('Trait tag').fill('Blue Eyes');
    await group.getByRole('button', { name: 'Add trait' }).click();
    await expect(group.getByText('blue_eyes', { exact: true })).toBeVisible();
    const mode = group.getByLabel('Mode for blue_eyes');
    await expect(mode).toHaveValue('include');
    await mode.selectOption('omit');
    await expect(mode).toHaveValue('omit');
    await group.getByLabel('Trait tag').fill('blue_eyes');
    await group.getByLabel('Trait tag').press('Enter');
    await expect(group.getByLabel('Mode for blue_eyes')).toHaveCount(1);
    await group.getByRole('button', { name: 'Remove blue_eyes' }).click();
    await expect(group.getByText('blue_eyes', { exact: true })).toHaveCount(0);
  });

  test('other project types do not show the trait editor', async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare style fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('group', { name: 'Character traits' })).toHaveCount(0);
  });
});
