import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      // core ships TypeScript source: bundle it. better-sqlite3 (native) stays external.
      externalizeDeps: { exclude: ['@command-center/core'] },
      outDir: 'out/main',
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    plugins: [react(), tailwindcss()],
  },
});
