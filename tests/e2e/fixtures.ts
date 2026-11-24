import { test as base, expect } from '@playwright/test';

// External URLs that non-@network tests may request; they are still aborted (never hit the
// network) but are not counted as violations. Keep narrow and justified.
const ALLOWED_EXTERNAL: RegExp[] = [
  // The real App mounts a hidden Photopea iframe on startup (document tools). Only the iframe
  // root document is tolerated; live Photopea behaviour is covered by the @network tests.
  /^https:\/\/www\.photopea\.com\/$/,
];

const isLocal = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    return !/^https?:$/.test(protocol) || hostname === '127.0.0.1' || hostname === 'localhost';
  } catch { return true; }
};

// Per-test allowlist of console.error regex sources (default none). A test that deliberately stubs a
// resource (e.g. an empty .wasm) opts in via test.use({ expectedConsoleErrors: [...] }).
export const test = base.extend<{ guard: void; expectedConsoleErrors: string[] }>({
  expectedConsoleErrors: [[] as string[], { option: true }],
  guard: [async ({ page, expectedConsoleErrors }, use, testInfo) => {
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(`pageerror: ${error.stack ?? error.message}`));
    page.on('console', message => { if (message.type() === 'error' && !expectedConsoleErrors.some(rule => new RegExp(rule).test(message.text()))) problems.push(`console.error: ${message.text()}`); });
    const blocked = (url: string) => !isLocal(url);
    if (!testInfo.title.includes('@network') && !testInfo.titlePath.some(part => part.includes('@network'))) {
      await page.route(url => blocked(url.toString()), route => {
        const url = route.request().url();
        if (!ALLOWED_EXTERNAL.some(rule => rule.test(url))) problems.push(`external request blocked: ${route.request().method()} ${url}`);
        return route.abort();
      });
    }
    await use();
    expect(problems, 'browser errors / external requests during test').toEqual([]);
  }, { auto: true }],
});
export { expect };
