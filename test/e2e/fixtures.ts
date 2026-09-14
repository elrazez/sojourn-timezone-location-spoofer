// Interface: the browser seam. Every e2e test takes these fixtures and nothing else.
//   context      -> a persistent Chromium with extension/ loaded and TZ pinned to the Baseline zone
//   worker       -> the extension's service worker, once it has started
//   extensionId  -> the id in the service worker's url
//   select(id)   -> makes a real Selection by calling the extension's own Settings module
//   origins      -> test/pages served on two origins that Chrome treats as distinct sites
// The harness never passes --silent-debugger-extension-api, timezoneId, geolocation, or
// setGeolocation: the Baseline has to come from the real browser or a green run proves nothing.

import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A zone with no DST at offset -840, which no Catalog City uses, so a UTC host cannot fake a pass.
export const BASELINE_ZONE = 'Pacific/Kiritimati';
export const BASELINE_OFFSET = -840;

const EXTENSION_PATH = fileURLToPath(new URL('../../extension', import.meta.url));
const PAGES_PATH = fileURLToPath(new URL('../pages', import.meta.url));

type SpooferWorker = { spoofer: { selectCity(cityId: string): Promise<unknown> } };

export type Origins = { localhost: string; loopback: string };

export const test = base.extend<{
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  select: (cityId: string) => Promise<void>;
  origins: Origins;
}>({
  context: async ({}, use) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'spoofer-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
      env: { ...process.env, TZ: BASELINE_ZONE },
    });
    await use(context);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  select: async ({ worker }, use) => {
    await use(async (cityId) => {
      await worker.evaluate((id) => (globalThis as unknown as SpooferWorker).spoofer.selectCity(id), cityId);
    });
  },
  origins: async ({}, use) => {
    const server = createServer((request, response) => {
      const name = basename(new URL(request.url ?? '/', 'http://pages').pathname) || 'index.html';
      readFile(join(PAGES_PATH, name)).then(
        (body) => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(body);
        },
        () => {
          response.writeHead(404);
          response.end();
        },
      );
    });
    await listen(server);
    const { port } = server.address() as AddressInfo;
    await use({ localhost: `http://localhost:${port}/`, loopback: `http://127.0.0.1:${port}/` });
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  },
});

export { expect } from '@playwright/test';

export function readZone(page: Page): Promise<string> {
  return page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export function readOffset(page: Page): Promise<number> {
  return page.evaluate(() => new Date().getTimezoneOffset());
}

function listen(server: Server): Promise<void> {
  return new Promise((ready) => server.listen(0, () => ready()));
}
