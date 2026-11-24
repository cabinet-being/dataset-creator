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
        persistence: fixture('persistence'),
        captionEditor: fixture('caption-editor'),
        taggerRestore: fixture('tagger-restore'),
        semanticCache: fixture('semantic-cache'),
        taggerDownload: fixture('tagger-download'),
        video: fixture('video'),
        next: fixture('next'),
      },
    },
  },
});
