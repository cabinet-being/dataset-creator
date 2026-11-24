import { test, expect } from './fixtures';
import { selectFilter, suggestAndApply, switchToTargetMode } from './buildFlow';
import type { Page } from '@playwright/test';

type Record = { decision: string; application?: string; triage?: { group: string } };
declare global { interface Window { __buildFixture: { session: () => { records: Record<string, Record> }; paths: () => Record<string, string | undefined> } } }

const sessionDecisions = (page: Page) => page.evaluate(() => Object.fromEntries(Object.entries(window.__buildFixture.session().records).map(([id, record]) => [id, record.decision])));
const datasetNames = async (page: Page) => Object.entries(await page.evaluate(() => window.__buildFixture.paths()))
  .filter(([, path]) => /(^|\/)dataset\//.test(path ?? '')).map(([name]) => name).sort();
const toggle = (page: Page, view: 'list' | 'clusters') => page.locator(`[data-testid="build-view-toggle"][data-view="${view}"]`);
const nearCard = (page: Page) => page.locator('[data-testid="build-cluster-card"][data-cluster-kind="near-duplicate"]');
const countDecisions = async (page: Page) => {
  const all = Object.values(await sessionDecisions(page));
  return { accepted: all.filter((value) => value === 'accepted').length, skipped: all.filter((value) => value === 'skipped').length };
};

test.describe('build clusters view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/build-browser.html');
    await page.getByRole('button', { name: 'Prepare auto pipeline fixture' }).click();
    await expect(page.getByRole('heading', { name: 'Build Dataset' })).toBeVisible({ timeout: 20_000 });
    await switchToTargetMode(page);
    await suggestAndApply(page);
    await expect(page.getByRole('status').filter({ hasText: /Analyzing|Finding|Describing|Picking|Adding|Working/ })).toHaveCount(0, { timeout: 30_000 });
    await toggle(page, 'clusters').click();
    await expect(toggle(page, 'clusters')).toHaveAttribute('aria-pressed', 'true');
  });

  test('without DINOv2 only exact copies are grouped and themes explain why they are missing', async ({ page }) => {
    await expect(page.getByTestId('build-cluster-view')).toBeVisible();
    await expect(page.getByTestId('build-cluster-needs-dinov2')).toBeVisible();
    await expect(page.getByTestId('build-cluster-vendi')).toHaveCount(0);
    await expect(nearCard(page)).toHaveCount(1);
    await expect(nearCard(page)).toHaveAttribute('data-cluster-size', '2');
    await expect(page.locator('[data-testid="build-cluster-card"][data-cluster-kind="theme"]')).toHaveCount(0);
    await expect(nearCard(page).getByTestId('build-cluster-size')).toContainText('2 images');
    await expect(nearCard(page).getByTestId('build-cluster-status')).toContainText(/Accepted \d+ · rejected \d+ · undecided \d+ · in Dataset \d+/);
    // Candidate list is replaced by the cluster view.
    await expect(page.getByLabel('Candidate filmstrip')).toHaveCount(0);
    await expect(page.getByTestId('build-cluster-view')).toContainText('Without DINOv2 only exact duplicates');
  });

  test('Keep best accepts one copy and rejects the other', async ({ page }) => {
    const card = nearCard(page);
    await card.getByTestId('build-cluster-expand').click();
    const members = card.getByTestId('build-cluster-member');
    await expect(members).toHaveCount(2);
    const names = await members.locator('p.truncate').allInnerTexts();
    expect(names.map((name) => name.replace(' · representative', '')).sort()).toEqual(['a-copy.png', 'a.png']);

    const before = await countDecisions(page);
    await card.getByTestId('build-cluster-keep-best').click();
    await expect.poll(async () => (await page.locator('[data-testid="build-cluster-member"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-decision')))).sort(), { timeout: 30_000 })
      .toEqual(['accepted', 'skipped']);
    const after = await countDecisions(page);
    expect(after.accepted + after.skipped).toBeGreaterThanOrEqual(before.accepted + before.skipped);

    // Session records: exactly one of the pair accepted, the other skipped; Dataset holds the kept copy only.
    await expect(card.getByTestId('build-cluster-status')).toContainText(/Accepted 1 · rejected 1 · undecided 0/);
    await expect.poll(async () => {
      const names = await datasetNames(page);
      return [names.includes('a.png'), names.includes('a-copy.png')].filter(Boolean).length;
    }, { timeout: 30_000 }).toBe(1);
    await expect(card.getByTestId('build-cluster-status')).toContainText(/in Dataset 1/);
    // Cluster stays stable after decisions (key ignores decisions): still one card of two.
    await expect(nearCard(page)).toHaveCount(1);
    await expect(nearCard(page)).toHaveAttribute('data-cluster-size', '2');
  });

  test('Reject all and Accept all buttons decide every member', async ({ page }) => {
    const card = nearCard(page);
    await card.getByTestId('build-cluster-expand').click();
    await card.getByTestId('build-cluster-reject').click();
    await expect.poll(() => card.getByTestId('build-cluster-member').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-decision'))), { timeout: 30_000 })
      .toEqual(['skipped', 'skipped']);
    await card.getByTestId('build-cluster-accept').click();
    await expect.poll(() => card.getByTestId('build-cluster-member').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-decision'))), { timeout: 30_000 })
      .toEqual(['accepted', 'accepted']);
  });

  test('X in clusters mode rejects the focused cluster, A accepts the cluster (not the list item), J is safe with one cluster', async ({ page }) => {
    const decisionsBefore = await sessionDecisions(page);
    await nearCard(page).click(); // focus the cluster
    await page.keyboard.press('j'); // single cluster: stays
    await expect(nearCard(page)).toHaveAttribute('data-focused', 'true');
    await nearCard(page).getByTestId('build-cluster-expand').click();

    await page.keyboard.press('x');
    await expect.poll(() => nearCard(page).getByTestId('build-cluster-member').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-decision'))), { timeout: 30_000 })
      .toEqual(['skipped', 'skipped']);

    await expect(nearCard(page).getByTestId('build-cluster-accept')).toBeEnabled({ timeout: 30_000 }); // commit finished
    // A accepts the whole cluster (both members), not only a single "current" list item.
    await page.keyboard.press('a');
    await expect.poll(() => nearCard(page).getByTestId('build-cluster-member').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-decision'))), { timeout: 30_000 })
      .toEqual(['accepted', 'accepted']);
    const decisionsAfter = await sessionDecisions(page);
    const changed = Object.keys(decisionsAfter).filter((id) => decisionsAfter[id] !== decisionsBefore[id]);
    expect(changed.length, 'at most the two cluster members changed; list current item untouched').toBeLessThanOrEqual(2);
    const undecided = await page.evaluate(() => Object.values(window.__buildFixture.session().records).filter((record) => record.triage?.group === 'needs-decision').map((record) => record.decision));
    expect(undecided, 'the needs-decision item (list current) stays unreviewed').toEqual(['unreviewed']);
  });

  test('B keeps the best; Open in list returns to List with the item selected', async ({ page }) => {
    await nearCard(page).click();
    await page.keyboard.press('b');
    await expect.poll(async () => {
      const values = Object.values(await sessionDecisions(page));
      return values.filter((value) => value === 'accepted').length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);

    await nearCard(page).getByTestId('build-cluster-expand').click();
    const member = nearCard(page).getByTestId('build-cluster-member').first();
    const name = (await member.locator('p.truncate').innerText()).replace(' · representative', '');
    await member.getByTestId('build-cluster-member-open').click();
    await expect(toggle(page, 'list')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('build-cluster-view')).toHaveCount(0);
    await expect(page.getByLabel('Candidate filmstrip')).toBeVisible();
    await expect(page.locator('aside').getByText(name, { exact: true }).first()).toBeVisible();
  });

  test('switching back to List restores list shortcuts and Accept acts on the current item', async ({ page }) => {
    await toggle(page, 'list').click();
    await expect(page.getByLabel('Candidate filmstrip')).toBeVisible();
    await expect(page.getByTestId('build-cluster-view')).toHaveCount(0);
    const before = await sessionDecisions(page);
    await selectFilter(page, 'needs-decision'); // the only undecided item (below.png)
    await page.getByLabel('Candidate filmstrip').getByRole('button').first().click();
    await page.getByRole('button', { name: 'Accept · A' }).click();
    await expect.poll(async () => {
      const after = await sessionDecisions(page);
      return Object.keys(after).filter((id) => after[id] !== before[id]).length;
    }, { timeout: 30_000 }).toBe(1);
    expect(Object.values(await sessionDecisions(page)).filter((value) => value === 'accepted').length).toBeGreaterThan(0);
  });
});
