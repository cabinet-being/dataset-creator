import { expect, type Page } from '@playwright/test';

type Flow = {
  paths: () => Record<string, string | undefined>;
  shortlist: () => string[];
  narrowed: () => string[];
  setTags: (names: string[], tags: string[] | undefined) => void;
};
const flow = (page: Page) => ({
  paths: () => page.evaluate(() => (window as unknown as { __buildFixture: Flow }).__buildFixture.paths()),
  shortlist: () => page.evaluate(() => (window as unknown as { __buildFixture: Flow }).__buildFixture.shortlist()),
  narrowed: () => page.evaluate(() => (window as unknown as { __buildFixture: Flow }).__buildFixture.narrowed()),
  setTags: (names: string[], tags: string[] | undefined) => page.evaluate(([list, value]) => (window as unknown as { __buildFixture: Flow }).__buildFixture.setTags(list as string[], value as string[] | undefined), [names, tags] as const),
});

export const inDataset = (path: string | undefined) => /(^|\/)dataset\//.test(path ?? '');
export const datasetNames = async (page: Page) => Object.entries(await flow(page).paths()).filter(([, path]) => inDataset(path)).map(([name]) => name).sort();
export const panel = (page: Page) => page.getByTestId('build-auto-select');
/** Expands the collapsed Auto-select panel (it collapses itself after the picks were added and when the Dataset reaches the target). */
export const expandPanel = async (page: Page) => {
  if (await panel(page).getAttribute('data-expanded') !== 'true') await panel(page).getByRole('button', { name: /^Auto-select/ }).click();
  await expect(panel(page)).toHaveAttribute('data-expanded', 'true');
};
export const step = (page: Page, id: 'sources' | 'find' | 'describe' | 'pick') => page.getByTestId(`auto-step-${id}`);
/** Opens a step's controls through its "Change" / "Open" button (a no-op when it is already open). */
export const openStep = async (page: Page, id: 'sources' | 'find' | 'describe' | 'pick') => {
  const toggle = step(page, id).getByRole('button', { name: /^(Change|Open)$/ });
  if (await toggle.count()) await toggle.click();
};
export const filterRadio = (page: Page, filter: string) => page.locator(`[role="radio"][data-filter="${filter}"]`);
/** Counter of the queue filter (for example `Flagged 1`); the radio name is "<label> <count>". */
export const counter = (page: Page, label: string) => page.getByRole('radiogroup', { name: 'Queue filter' }).getByRole('radio', { name: new RegExp(`^${label} \\d+$`) });
export const selectFilter = (page: Page, filter: string) => filterRadio(page, filter).click();
export const idleStatus = (page: Page) => expect(page.getByRole('status').filter({ hasText: /Analyzing|Finding|Describing|Picking|Adding|Working|Suggesting|Applying/ })).toHaveCount(0, { timeout: 30_000 });
/** Quality triage runs on its own after entering Select; Find stays locked until it finishes. */
export const waitForTriage = async (page: Page) => {
  await expect(counter(page, 'Rejected')).toHaveText(/^Rejected [1-9]/, { timeout: 60_000 });
  await idleStatus(page);
};

/** Pass 1: "Find candidates" until the step is done (fixture: 9 sources, target 3, so the shortlist has 4 files). */
export const markShortlist = async (page: Page) => {
  const find = page.getByRole('button', { name: 'Find candidates' });
  await expect(find).toBeEnabled({ timeout: 60_000 });
  await find.click();
  await expect(step(page, 'find')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await idleStatus(page);
  return flow(page).shortlist();
};

/** The fixture has no tagger: gives every shortlisted file a distinct caption (plus a shared "solo" that pass 2 ignores). */
export const captionShortlist = async (page: Page, names?: string[]) => {
  const list = names ?? await flow(page).shortlist();
  for (const name of list) await flow(page).setTags([name], ['solo', `tag_${name.replace('.png', '')}`]);
  return list;
};

/** Find -> captions -> "Pick N" -> "Add N to the Dataset"; returns the names that moved. Captions of the moved files are removed unless `keepCaptions`. */
export const suggestAndApply = async (page: Page, { keepCaptions = false }: { keepCaptions?: boolean } = {}) => {
  const shortlist = await markShortlist(page);
  await captionShortlist(page, shortlist);
  const pick = page.getByRole('button', { name: /^Pick \d+$/ });
  await expect(pick).toBeEnabled({ timeout: 20_000 });
  await pick.click();
  const apply = page.getByRole('button', { name: /^Add \d+ to the Dataset$/ });
  await expect(apply).toBeVisible({ timeout: 60_000 });
  await apply.click();
  await expect.poll(async () => (await datasetNames(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await idleStatus(page);
  // No manual collapse: the panel closes itself once the picks were added.
  await expect(panel(page)).toHaveAttribute('data-expanded', 'false');
  const moved = await datasetNames(page);
  if (!keepCaptions) await flow(page).setTags(moved, undefined);
  return moved;
};
export { flow };
