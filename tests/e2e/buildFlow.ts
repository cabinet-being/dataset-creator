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
export const shortlistBar = (page: Page) => page.getByTestId('build-shortlist-bar');
export const idleStatus = (page: Page) => expect(page.getByRole('status').filter({ hasText: /Analyzing|Selecting|Preparing|Applying/ })).toHaveCount(0, { timeout: 30_000 });

/** Pass 1: "Suggest selection" until the shortlist bar appears (fixture: 9 sources, target 3, so the shortlist has 4 files). */
export const markShortlist = async (page: Page) => {
  await page.getByRole('button', { name: 'Suggest selection' }).click();
  await expect(shortlistBar(page)).toBeVisible({ timeout: 60_000 });
  await idleStatus(page);
  return flow(page).shortlist();
};

/** The fixture has no tagger: gives every shortlisted file a distinct caption (plus a shared "solo" that pass 2 ignores). */
export const captionShortlist = async (page: Page, names?: string[]) => {
  const list = names ?? await flow(page).shortlist();
  for (const name of list) await flow(page).setTags([name], ['solo', `tag_${name.replace('.png', '')}`]);
  return list;
};

/** Pass 1 -> captions -> "Narrow to N" -> "Apply N to the Dataset"; returns the names that moved. Captions of the moved files are removed unless `keepCaptions`. */
export const suggestAndApply = async (page: Page, { keepCaptions = false }: { keepCaptions?: boolean } = {}) => {
  const shortlist = await markShortlist(page);
  await captionShortlist(page, shortlist);
  const narrow = shortlistBar(page).getByRole('button', { name: /^Narrow to \d+$/ });
  await expect(narrow).toBeEnabled({ timeout: 20_000 });
  await narrow.click();
  const apply = shortlistBar(page).getByRole('button', { name: /^Apply \d+ to the Dataset$/ });
  await expect(apply).toBeVisible({ timeout: 60_000 });
  await apply.click();
  await expect.poll(async () => (await datasetNames(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await idleStatus(page);
  const moved = await datasetNames(page);
  if (!keepCaptions) await flow(page).setTags(moved, undefined);
  return moved;
};
export { flow };
