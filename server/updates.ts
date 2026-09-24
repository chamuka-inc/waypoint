import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { UpdateInfo } from '../src/types.js';

const endpoint = 'https://github.com/chamuka-inc/waypoint/releases/latest';
const releasePage = 'https://github.com/chamuka-inc/waypoint/releases/tag/';
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function releaseTagFromURL(finalURL: string, sourceURL = endpoint): string {
  const final = new URL(finalURL), source = new URL(sourceURL);
  if (final.origin !== source.origin || final.search || final.hash || !final.pathname.startsWith('/chamuka-inc/waypoint/releases/tag/')) throw new Error('Latest release did not resolve to a Waypoint release page.');
  const tag = final.pathname.slice('/chamuka-inc/waypoint/releases/tag/'.length);
  if (!versionPattern.test(tag)) throw new Error('Latest release has an invalid version.');
  return tag;
}

export function newerVersion(latest: string, current: string): boolean {
  const a = latest.match(versionPattern), b = current.match(versionPattern);
  if (!a || !b) throw new Error('Invalid release version.');
  for (let i = 1; i <= 3; i++) {
    const left = BigInt(a[i]), right = BigInt(b[i]);
    if (left !== right) return left > right;
  }
  if (!a[4]) return Boolean(b[4]);
  if (!b[4]) return false;
  return a[4] > b[4];
}

export async function checkForUpdates(fetchRelease: typeof fetch = fetch): Promise<UpdateInfo> {
  const { version: currentVersion } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string };
  const response = await fetchRelease(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Release check returned HTTP ${response.status}.`);
  const tag = releaseTagFromURL(response.url);
  const available = newerVersion(tag, currentVersion);
  return { currentVersion, latestVersion: tag.replace(/^v/, ''), available, releaseUrl: available ? releasePage + tag : '' };
}
