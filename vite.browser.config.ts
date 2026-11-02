import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const fixture = (name: string) => resolve(import.meta.dirname, `tests/${name}-browser.html`);

export default defineConfig({
  plugins: [react()],
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
      },
    },
  },
});
