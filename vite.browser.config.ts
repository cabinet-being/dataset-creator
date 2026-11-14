import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const fixture = (name: string) => resolve(import.meta.dirname, `tests/${name}-browser.html`);

export default defineConfig({
  plugins: [react()],
  // Fixtures only: the profiling build makes <Profiler onRender> fire in this production bundle
  // (tests/tool-render-checks.tsx counts renders). The app build is unaffected.
  resolve: {
    alias: [
      { find: /^react-dom\/client$/, replacement: 'react-dom/profiling' },
      { find: /^react-dom$/, replacement: 'react-dom/profiling' },
    ],
  },
  build: {
    outDir: 'dist/browser-fixtures',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        explorer: fixture('explorer'),
        export: fixture('export'),
        persistence: fixture('persistence'),
        caption: fixture('caption'),
        captionEditor: fixture('caption-editor'),
        projectSwitch: fixture('project-switch'),
        build: fixture('build'),
        inspector: fixture('inspector'),
        taggerRestore: fixture('tagger-restore'),
        taggerDownload: fixture('tagger-download'),
        scope: fixture('scope'),
        ui: fixture('ui'),
        video: fixture('video'),
      },
    },
  },
});
