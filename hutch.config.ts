export default {
  electrobun: { version: '2.0.1' },
  packageManager: 'npm',
  scripts: {
    prepare: ['hutch', 'electrobun', 'prepare'],
    'ui:build': 'hutch electrobun prepare && hutch pm exec -- vite build --config vite.electrobun.config.ts',
    start: 'hutch run ui:build && hutch electrobun dev',
    dev: 'hutch run ui:build && hutch electrobun dev --watch',
    build: 'hutch run ui:build && hutch electrobun build --env=stable',
    'build:canary': 'hutch run ui:build && hutch electrobun build --env=canary',
  },
};
