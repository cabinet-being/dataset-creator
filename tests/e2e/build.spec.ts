import { test, expect } from './fixtures';

test('build workspace shows two candidate frames', async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare Build fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Candidate filmstrip').getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

type Fixture = { session: () => { records: Record<string, { decision: string; triage?: { group: string; reasons: { code: string }[] } }> }; paths: () => Record<string, string | undefined> };
declare global { interface Window { __buildFixture: Fixture } }

const counter = (page: import('@playwright/test').Page, label: string) =>
  page.getByRole('group', { name: 'Triage groups' }).getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
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
    await page.getByRole('button', { name: 'Suggest selection' }).click();
  });

  test('triages, assembles the Dataset and leaves rejected sources untouched', async ({ page }) => {
    // 9 sources: 5 distinct sharp (one near-duplicate by fake vectors), 1 exact copy, tiny, flat, below-target.
    // Target 3: 3 selected into Dataset; tiny, flat, exact copy, near duplicate and one not-selected are rejected; below-target needs a decision.
    await expectCounters(page, 1, 3, 5);
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting/ })).toHaveCount(0, { timeout: 30_000 });

    // Focus switches to the needs-decision queue after the pass; the single item is the below-target image.
    await expect(page.getByLabel('Queue filter')).toHaveValue('needs-decision');
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
    for (const name of ['tiny.png', 'flat.png', 'below.png']) expect(paths[name]).toMatch(new RegExp(`(^|/)inbox/${name}$`));

    const records = Object.values(await reasonsByName(page));
    const codes = (code: string) => records.filter((record) => record.codes.includes(code)).length;
    expect(codes('too-small')).toBe(1);
    expect(codes('blurry')).toBe(1);
    expect(codes('exact-duplicate')).toBe(1);
    expect(codes('near-duplicate')).toBe(1);
    expect(codes('not-selected')).toBe(1);
    expect(codes('below-target-resolution')).toBe(1);
    expect(records.filter((record) => record.decision === 'accepted')).toHaveLength(3);
    expect(records.filter((record) => record.group === 'rejected' && record.decision === 'unreviewed')).toHaveLength(5);
  });

  test('shows rejection reasons in the aside', async ({ page }) => {
    await expectCounters(page, 1, 3, 5);
    await page.getByLabel('Queue filter').selectOption('rejected');
    const filmstrip = page.getByLabel('Candidate filmstrip').getByRole('button');
    await expect(filmstrip).toHaveCount(5);
    const seen = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      await filmstrip.nth(index).click();
      const box = page.locator('aside [data-triage-box]');
      await expect(box).toContainText('Proposal: rejected');
      seen.add((await box.locator('li').allTextContents()).join(' | '));
    }
    const all = [...seen].join('\n');
    expect(all).toMatch(/far below the 1024px minimum/);
    expect(all).toMatch(/Image is blurry/);
    expect(all).toMatch(/Exact duplicate of another image/);
    expect(all).toMatch(/Near duplicate \(\d+% similar\)/);
    expect(all).toMatch(/Not selected/);
  });

  test('manual accept of a rejected proposal moves it into the Dataset', async ({ page }) => {
    await expectCounters(page, 1, 3, 5);
    await page.getByLabel('Queue filter').selectOption('rejected');
    const filmstrip = page.getByLabel('Candidate filmstrip').getByRole('button');
    await expect(filmstrip).toHaveCount(5);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await filmstrip.first().click();
    await page.getByRole('button', { name: 'Accept · A' }).click();
    await expectCounters(page, 1, 4, 4);
    await expect.poll(() => datasetCount(page), { timeout: 30_000 }).toBe(4);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('batch Reject all and Accept all override proposals on the needs-decision group', async ({ page }) => {
    await expectCounters(page, 1, 3, 5);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await expect(page.getByLabel('Queue filter')).toHaveValue('needs-decision');
    await page.getByRole('button', { name: 'Reject all 1' }).click();
    await expectCounters(page, 0, 3, 6);
    expect((await pathsOf(page))['below.png']).toMatch(/inbox\/below\.png$/);

    // Accept all acts on the whole visible group: 5 rejected proposals plus the explicitly skipped item.
    await page.getByLabel('Queue filter').selectOption('rejected');
    await expect(page.getByRole('button', { name: 'Accept all 6' })).toBeEnabled();
    await page.getByRole('button', { name: 'Accept all 6' }).click();
    await expectCounters(page, 0, 9, 0);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(9);
    expect((await pathsOf(page))['below.png']).toMatch(/(^|\/)dataset\/below\.png$/);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('changing Min short side re-triages without errors', async ({ page }) => {
    await expectCounters(page, 1, 3, 5);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await page.locator('[data-build-settings] summary').click();
    await page.getByLabel('Model', { exact: true }).selectOption('sd15');
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting/ })).toHaveCount(0, { timeout: 30_000 });
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

  test('entering Select runs triage only; assembly starts from Suggest selection', async ({ page }) => {
    // Triage is automatic: rejected proposals (tiny, flat, exact copy) appear without any click.
    await expect(counter(page, 'Rejected')).not.toHaveText('Rejected 0', { timeout: 60_000 });
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting/ })).toHaveCount(0, { timeout: 30_000 });
    expect(await datasetCount(page)).toBe(0);
    expect(Object.values(await reasonsByName(page)).filter((record) => record.decision === 'accepted')).toHaveLength(0);
    const suggest = page.getByRole('button', { name: 'Suggest selection' });
    await expect(suggest).toBeEnabled();
    await suggest.click();
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await expectCounters(page, 1, 3, 5);
  });

  test('X then X/A keep working without clicking, and changing the queue filter keeps shortcuts', async ({ page }) => {
    await page.getByRole('button', { name: 'Suggest selection' }).click();
    await expectCounters(page, 1, 3, 5);
    await expect.poll(() => datasetCount(page), { timeout: 60_000 }).toBe(3);
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting|Preparing/ })).toHaveCount(0, { timeout: 30_000 });
    await page.getByLabel('Queue filter').selectOption('all');
    await page.getByLabel('Candidate filmstrip').getByRole('button').first().click();
    const snapshot = async () => JSON.stringify(Object.entries(await reasonsByName(page)).map(([id, x]) => [id, x.decision]).sort());
    const press = async (key: string) => { const before = await snapshot(); await page.keyboard.press(key); await expect.poll(snapshot, { message: `key ${key} must change a decision` }).not.toBe(before); await expect(page.getByRole('button', { name: 'Reject · X' })).toBeEnabled(); };
    await press('x');
    await press('x'); // focus must not have fallen to body after the first reject; the cursor moved on
    await press('x');

    // Changing the filter moves focus to a select; shortcuts must still reach the workspace afterwards.
    await page.getByLabel('Queue filter').selectOption('rejected');
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
