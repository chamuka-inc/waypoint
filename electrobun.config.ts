import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name: 'Waypoint',
    identifier: 'app.waypoint.career',
    version: '0.1.0',
    description: 'A private desktop workspace for evidence-led career research and opportunity planning',
  },
  build: {
    mainProcess: 'bun',
    bun: { entrypoint: 'desktop/main.ts' },
    copy: {
      'dist/electrobun.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
    },
    buildFolder: 'build-electrobun',
    artifactFolder: 'artifacts',
    watchIgnore: ['dist/**'],
    mac: { bundleCEF: false, codesign: false, notarize: false },
    win: { bundleCEF: false },
    linux: { bundleCEF: false },
  },
  runtime: { exitOnLastWindowClosed: true },
  release: {
    baseUrl: 'https://github.com/chamuka-inc/waypoint/releases/latest/download/',
    generatePatch: false,
  },
} satisfies ElectrobunConfig;
