import { defineConfig } from '@playwright/test';

const ci = !!process.env.CI;
// PW_PORT lets parallel checkouts (worktrees) serve fixtures without colliding.
const port = Number(process.env.PW_PORT ?? 4174);
// `npm run test:browser:network` passes `--grep @network`; an explicit CLI grep means the
// caller opted in, so the default exclusion of @network/@slow tests is lifted for that run.
const explicitGrep = process.argv.includes('--grep') || process.argv.some(arg => arg.startsWith('--grep='));

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/playwright',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  grepInvert: explicitGrep ? undefined : /@network|@slow/,
  reporter: ci ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true } }],
  webServer: {
    command: `npx vite preview --config vite.browser.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/tests/explorer-browser.html`,
    reuseExistingServer: !ci,
    timeout: 60_000,
  },
});
