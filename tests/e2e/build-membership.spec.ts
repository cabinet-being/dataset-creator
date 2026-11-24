import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { inDataset } from './buildFlow';

// useApplyMembership (Pin, Ban, clear override, Return to inbox) driven through the MembershipProbe in tests/build-browser.tsx:
// the Build UI does not expose these actions yet, and Assemble (startAssemble) has no entry point outside the pipeline hook.
type Probe = {
  pin: (names: string[]) => Promise<boolean>; ban: (names: string[]) => Promise<boolean>; clear: (names: string[]) => Promise<void>; returnToInbox: (names: string[]) => Promise<boolean>;
  undo: () => Promise<void>; historyDepth: () => number;
  paths: () => Record<string, string | undefined>; records: () => Record<string, { decision?: string; override?: string; origin?: string }>;
};
const probe = <T,>(page: Page, run: (p: Probe) => T | Promise<T>) => page.evaluate(`(${run.toString()})(window.__membership)`) as Promise<T>;
const paths = (page: Page) => probe(page, (p) => p.paths());
const records = (page: Page) => probe(page, (p) => p.records());

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/build-browser.html');
  await page.getByRole('button', { name: 'Prepare membership fixture' }).click();
  await expect(page.getByTestId('membership-probe')).toBeVisible({ timeout: 20_000 });
});

test.describe('useApplyMembership', () => {
  test('Pin moves the image into the Dataset with a remembered origin; one Undo reverts it', async ({ page }) => {
    const before = await records(page);
    expect(before['p.png'].origin).toBe('Project/inbox/day1');
    expect(before['r.png'].origin).toBe('Project/inbox');
    expect(before['s.png'].origin, 'a Dataset member has no inbox origin').toBeUndefined();
    const depth = await probe(page, (p) => p.historyDepth());
    expect(await probe(page, (p) => p.pin(['p.png']))).toBe(true);
    expect(inDataset((await paths(page))['p.png'])).toBe(true);
    const pinned = (await records(page))['p.png'];
    expect(pinned.override).toBe('pin'); expect(pinned.decision).toBe('accepted'); expect(pinned.origin).toBe('Project/inbox/day1');
    expect(await probe(page, (p) => p.historyDepth()) - depth, 'Pin is one history step').toBe(1);
    await probe(page, (p) => p.undo());
    expect((await paths(page))['p.png']).toMatch(/(^|\/)inbox\/day1\/p\.png$/);
    const undone = (await records(page))['p.png'];
    expect(undone.override).toBeUndefined(); expect(undone.decision).toBe('unreviewed');
  });

  test('Ban of an image in the Dataset returns it to its origin folder; Undo puts it back', async ({ page }) => {
    await probe(page, (p) => p.pin(['p.png', 'r.png']));
    expect(inDataset((await paths(page))['p.png'])).toBe(true);
    expect(await probe(page, (p) => p.ban(['p.png', 'r.png']))).toBe(true);
    const after = await paths(page);
    expect(after['p.png'], 'back to the folder it came from').toMatch(/(^|\/)inbox\/day1\/p\.png$/);
    expect(after['r.png']).toMatch(/(^|\/)inbox\/r\.png$/);
    const record = (await records(page))['p.png'];
    expect(record.override).toBe('ban'); expect(record.decision).toBe('skipped');
    await probe(page, (p) => p.undo());
    expect(inDataset((await paths(page))['p.png'])).toBe(true);
    expect((await records(page))['p.png'].override).toBe('pin');
  });

  test('Ban of a Dataset member without a known origin goes to the inbox root; clear override keeps membership; Return drops a Pin', async ({ page }) => {
    await probe(page, (p) => p.ban(['s.png']));
    expect((await paths(page))['s.png']).toMatch(/(^|\/)inbox\/s\.png$/);
    expect((await records(page))['s.png'].override).toBe('ban');
    await probe(page, (p) => p.pin(['q.png']));
    await probe(page, (p) => p.clear(['q.png']));
    expect(inDataset((await paths(page))['q.png']), 'clearing an override does not move the image').toBe(true);
    expect((await records(page))['q.png'].override).toBeUndefined();
    await probe(page, (p) => p.undo());
    expect((await records(page))['q.png'].override).toBe('pin');
    await probe(page, (p) => p.returnToInbox(['q.png']));
    expect((await paths(page))['q.png']).toMatch(/(^|\/)inbox\/day1\/q\.png$/);
    const returned = (await records(page))['q.png'];
    expect(returned.override).toBeUndefined(); expect(returned.decision).toBe('unreviewed');
  });
});
