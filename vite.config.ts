import { defineConfig } from 'vite';
import { writeFileSync } from 'node:fs';

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  plugins: [{
    name: 'preserve-embedded-dist-directory',
    closeBundle() { writeFileSync('dist/.gitkeep', ''); },
  }],
});
