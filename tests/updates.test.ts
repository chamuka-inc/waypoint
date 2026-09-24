import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkForUpdates, newerVersion, releaseTagFromURL } from '../server/updates.js';

test('release versions are compared numerically', () => {
  assert.equal(newerVersion('v0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('v0.3.1', '0.3.1'), false);
  assert.equal(newerVersion('v0.3.0', '0.3.1'), false);
  assert.equal(newerVersion('v1.0.0', '1.0.0-beta.1'), true);
  assert.throws(() => newerVersion('../../other', '0.3.1'));
});

test('release checks return a fixed repository link for newer stable versions', async () => {
  const result = await checkForUpdates(async (url, options) => {
    assert.equal(url, 'https://github.com/chamuka-inc/waypoint/releases/latest');
    assert.equal(options?.method, 'HEAD');
    assert.equal(options?.headers, undefined);
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://github.com/chamuka-inc/waypoint/releases/tag/v0.4.0' });
    return response;
  });
  assert.equal(result.available, true);
  assert.equal(result.releaseUrl, 'https://github.com/chamuka-inc/waypoint/releases/tag/v0.4.0');
});

test('release checks reject unsafe tags', async () => {
  assert.throws(() => releaseTagFromURL('https://github.com/chamuka-inc/elsewhere/releases/tag/v0.4.0'));
  assert.throws(() => releaseTagFromURL('https://another.example/chamuka-inc/waypoint/releases/tag/v0.4.0'));
  assert.throws(() => releaseTagFromURL('https://github.com/chamuka-inc/waypoint/releases/tag/v0.4.0/extra'));
});
