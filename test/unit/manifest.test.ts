// What the shipped extension declares, and what its own files can reach. npm run package names the
// zip from package.json and Chrome reads the version out of the manifest, so a release where the two
// disagree installs as a version nobody can name. The other two are promises the README makes about
// the install prompt and about network activity, asserted here rather than left to review.

import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const json = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>;

test('package.json and the manifest carry the same version', () => {
  expect(json('../../extension/manifest.json').version).toBe(json('../../package.json').version);
  expect(json('../../package.json').version).toMatch(/^\d+\.\d+\.\d+$/);
});

test('the manifest asks for exactly the two permissions, no host, and one capability beyond them', () => {
  const manifest = json('../../extension/manifest.json');
  expect(manifest.permissions).toEqual(['debugger', 'storage']);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.optional_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(manifest.externally_connectable).toBeUndefined();
  expect(manifest.chrome_url_overrides).toEqual({ newtab: 'newtab.html' });
  expect(manifest.minimum_chrome_version).toBe('125');
});

// ponytail: a text scan, so a name built at runtime would walk past it; what really stops a request
// reaching anywhere is ADR-0002 and a manifest with no host permission. Upgrade path is a browser
// seam test that counts requests out of every extension context.
test('nothing the extension ships can name a network API', () => {
  const shipped = [
    ...readdirSync(new URL('../../src', import.meta.url), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `../../src/${name}`),
    // dist/ is compiled from src/, so these three are the rest of what the zip carries.
    '../../extension/newtab.html',
    '../../extension/popup.html',
    '../../extension/popup.css',
  ];
  const network = /fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/;

  expect(shipped.length).toBeGreaterThan(10);
  expect(shipped.filter((path) => network.test(read(path)))).toEqual([]);
});
