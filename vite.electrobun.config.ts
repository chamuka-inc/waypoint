import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import { electrobunViteAliases } from './.hutch/devkit/api/config/electrobun-vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  resolve: { alias: electrobunViteAliases(resolve(here, '.hutch/devkit')) },
  build: {
    target: 'es2022',
    rollupOptions: { input: resolve(here, 'electrobun.html') },
  },
});
