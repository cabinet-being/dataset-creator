import { test } from './fixtures';

// document-browser embeds the live Photopea iframe and is not part of vite.browser.config.ts.
test.skip('document fixture (Photopea iframe)', () => {
  // Skipped: requires live Photopea (network) and the fixture is not built by test:browser-fixtures.
});

// workspace-browser.html only wraps an iframe of the app (../?tool=import) and needs the app dev server.
test.skip('workspace fixture (needs app dev server)', () => {
  // Skipped: not built by vite.browser.config.ts; depends on a running app dev server.
});
