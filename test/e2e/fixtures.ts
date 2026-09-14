// Interface: the browser seam. Every e2e test takes these fixtures and nothing else.
//   context      -> a persistent Chromium with extension/ loaded and TZ pinned to the Baseline zone
//   baseline     -> the same Chromium without the extension, for what an unmodified browser does
//   extraArgs    -> switches this test's Chromium needs, set with test.use
//   worker       -> the extension's service worker, once it has started
//   extensionId  -> the id in the service worker's url
//   spoofer      -> drives the extension's own Settings and reads the status Coverage exposes
//   popup        -> popup.html open as a page, which is the only way a harness can reach it
//   disabled     -> a second browser with the extension loaded, for a run with it switched off
//   origins      -> test/pages and test/audit served on two origins Chrome treats as distinct sites
// The harness never passes --silent-debugger-extension-api and never uses Playwright's own time
// zone or position emulation: the Baseline comes from the real browser or a green run proves
// nothing. Geolocation permission is granted only through grantPermissions.

import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Frame,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoverageStatus } from '../../src/coverage.js';
import type { Selection } from '../../src/settings.js';

// A zone with no DST at offset -840, which no Catalog City uses, so a UTC host cannot fake a pass.
export const BASELINE_ZONE = 'Pacific/Kiritimati';
export const BASELINE_OFFSET = -840;

// Tokyo is UTC+9 the whole year, so a covered page always reports -540.
export const TOKYO_ZONE = 'Asia/Tokyo';
export const TOKYO_OFFSET = -540;

const EXTENSION_PATH = fileURLToPath(new URL('../../extension', import.meta.url));
const PAGES_PATH = fileURLToPath(new URL('../pages', import.meta.url));
const AUDIT_PATH = fileURLToPath(new URL('../audit', import.meta.url));

// What a page, frame or worker recorded in its first script, and which one said it when more than
// one kind reports to the same server.
export type FirstReading = { zone: string; offset: number; where?: string };

// Every geolocation call passes this, because a Chromium with no authorised location provider
// neither resolves nor errors on its own: without it the Baseline call never comes back.
export const GEOLOCATION_TIMEOUT = 5000;

// What one getCurrentPosition call answered, flattened so it survives the trip out of the page.
export type PositionReading =
  | {
      ok: true;
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude: number | null;
      altitudeAccuracy: number | null;
      heading: number | null;
      speed: number | null;
      timestamp: number;
      age: number;
    }
  | { ok: false; code: number; message: string };

type SpooferWorker = {
  spoofer: {
    selectCity(cityId: string): Promise<Selection>;
    clearSelection(): Promise<void>;
    setEnabled(enabled: boolean): Promise<void>;
    status(): CoverageStatus;
  };
};

export type Spoofer = {
  select(cityId: string): Promise<Selection>;
  clear(): Promise<void>;
  enable(enabled: boolean): Promise<void>;
  status(): Promise<CoverageStatus>;
};

// readings holds what every record.html load reported from its first script, in order, and
// requests every url the server really answered, so a load served from the cache can be told from
// one that went to the network.
export type Origins = { localhost: string; loopback: string; readings: FirstReading[]; requests: string[] };

export { expect };

// A browser with the extension loaded, its service worker, and the handle onto its Settings.
export type Loaded = { context: BrowserContext; worker: Worker; spoofer: Spoofer };

export const test = base.extend<{
  extraArgs: string[];
  context: BrowserContext;
  baseline: BrowserContext;
  disabled: Loaded;
  worker: Worker;
  extensionId: string;
  spoofer: Spoofer;
  popup: Page;
  origins: Origins;
}>({
  extraArgs: [[], { option: true }],
  context: async ({ extraArgs }, use) => {
    const browser = await launchExtension(extraArgs);
    await use(browser.context);
    await browser.done();
  },
  // The same browser with nothing loaded into it: what a page does without Spoofer at all.
  baseline: async ({ extraArgs }, use) => {
    const browser = await launch(extraArgs, true);
    await use(browser.context);
    await browser.done();
  },
  // A second browser with the extension in it, which the Audit switches off: the third run.
  disabled: async ({ extraArgs }, use) => {
    const browser = await launchExtension(extraArgs);
    await use(browser);
    await browser.done();
  },
  worker: async ({ context }, use) => {
    await use(await workerOf(context));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  spoofer: async ({ worker }, use) => {
    await use(spooferOf(worker));
  },
  // A tab of its own, because a harness cannot click the toolbar icon. It is a tab like any other
  // as far as Coverage is concerned, which is why the slices that count tabs account for it.
  popup: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(page);
  },
  origins: async ({}, use) => {
    const readings: FirstReading[] = [];
    const requests: string[] = [];
    const server = createServer((request, response) => {
      const asked = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(asked.href);
      if (asked.pathname === '/record') {
        readings.push({
          zone: asked.searchParams.get('zone') ?? '',
          offset: Number(asked.searchParams.get('offset')),
          ...(asked.searchParams.has('where') ? { where: asked.searchParams.get('where') as string } : {}),
        });
        response.writeHead(204);
        response.end();
        return;
      }
      const name = basename(asked.pathname) || 'index.html';
      // Two query parameters the Audit's residual measurements need: how long the server holds the
      // answer, and how long the browser may keep it.
      const latency = Number(asked.searchParams.get('latency') ?? 0);
      const cache = asked.searchParams.get('cache');
      readFile(join(AUDIT_PATH, name))
        .catch(() => readFile(join(PAGES_PATH, name)))
        .then(
          (body) => {
            setTimeout(() => {
              response.writeHead(200, {
                'content-type': contentType(name),
                ...(cache === null ? {} : { 'cache-control': `max-age=${cache}` }),
              });
              response.end(body);
            }, latency);
          },
          () => {
            response.writeHead(404);
            response.end();
          },
        );
    });
    // Both directories are served flat under one origin, so a name in both would silently shadow.
    const [audit, pages] = await Promise.all([readdir(AUDIT_PATH), readdir(PAGES_PATH)]);
    const shadowed = audit.filter((name) => pages.includes(name));
    if (shadowed.length > 0) throw new Error(`test/audit and test/pages both hold ${shadowed.join(', ')}`);
    await listen(server);
    const { port } = server.address() as AddressInfo;
    await use({ localhost: `http://localhost:${port}/`, loopback: `http://127.0.0.1:${port}/`, readings, requests });
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  },
});

// A browser with the extension loaded, headless unless a measurement needs the window furniture.
export async function launchExtension(
  args: string[] = [],
  headless = true,
): Promise<Loaded & { done: () => Promise<void> }> {
  const browser = await launch(
    [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, ...args],
    headless,
  );
  const worker = await workerOf(browser.context);
  return { context: browser.context, worker, spoofer: spooferOf(worker), done: browser.done };
}

const workerOf = async (context: BrowserContext): Promise<Worker> =>
  context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

function spooferOf(worker: Worker): Spoofer {
  return {
    // The Selection comes back out of storage, not out of the call, so a test compares a page
    // against what the extension stored rather than against what one function returned.
    select: async (cityId) => {
      await worker.evaluate((id) => (globalThis as unknown as SpooferWorker).spoofer.selectCity(id), cityId);
      return worker.evaluate(async () => (await chrome.storage.local.get('selection')).selection as Selection);
    },
    clear: async () => {
      await worker.evaluate(() => (globalThis as unknown as SpooferWorker).spoofer.clearSelection());
    },
    enable: async (enabled) => {
      await worker.evaluate((on) => (globalThis as unknown as SpooferWorker).spoofer.setEnabled(on), enabled);
    },
    status: () => worker.evaluate(() => (globalThis as unknown as SpooferWorker).spoofer.status()),
  };
}



// A tab opened by the service worker itself, so it never sits at about:blank under the harness's
// control and its first document is the one under test.
export async function openTab(
  context: BrowserContext,
  worker: Worker,
  url: string,
): Promise<{ page: Page; tabId: number }> {
  const [page, tabId] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate(async (where) => (await chrome.tabs.create({ url: where })).id ?? -1, url),
  ]);
  return { page, tabId };
}

// A tab the service worker opened at about:blank, covered, and only then sent to its url: the way
// a person opens a tab and then goes somewhere.
export async function openCoveredTab(
  context: BrowserContext,
  worker: Worker,
  url: string,
  zone: string,
): Promise<{ page: Page; tabId: number }> {
  const { page, tabId } = await openTab(context, worker, 'about:blank');
  await expect.poll(() => readZone(page)).toBe(zone);
  await worker.evaluate(
    (asked) => chrome.tabs.update(asked.id, { url: asked.url }),
    { id: tabId, url },
  );
  return { page, tabId };
}

// A new tab, covered before it is navigated: the Override has to be in place on the tab session
// before a document starts, or the first script of a frame or worker inside it is a race.
export async function coveredPage(context: BrowserContext, zone: string): Promise<Page> {
  const page = await context.newPage();
  await expect.poll(() => readZone(page)).toBe(zone);
  return page;
}

export function readZone(page: Page): Promise<string> {
  return page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export function readOffset(page: Page): Promise<number> {
  return page.evaluate(() => new Date().getTimezoneOffset());
}

// What the page recorded in the inline script at the top of its head.
export function readFirst(page: Page): Promise<FirstReading> {
  return page.evaluate(() => (window as unknown as { __first: FirstReading }).__first);
}

// One getCurrentPosition call in a page or a frame, with the timeout every call in this suite uses.
export function getPosition(where: Page | Frame): Promise<PositionReading> {
  return where.evaluate(
    (timeout) =>
      new Promise<PositionReading>((done) => {
        navigator.geolocation.getCurrentPosition(
          (position) =>
            done({
              ok: true,
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              altitude: position.coords.altitude,
              altitudeAccuracy: position.coords.altitudeAccuracy,
              heading: position.coords.heading,
              speed: position.coords.speed,
              timestamp: position.timestamp,
              age: Date.now() - position.timestamp,
            }),
          (error) => done({ ok: false, code: error.code, message: error.message }),
          { timeout },
        );
      }),
    GEOLOCATION_TIMEOUT,
  );
}

async function launch(
  args: string[],
  headless = true,
): Promise<{ context: BrowserContext; done: () => Promise<void> }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'spoofer-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args,
    headless,
    ...(headless ? {} : { viewport: null }),
    env: { ...process.env, TZ: BASELINE_ZONE },
  });
  return {
    context,
    done: async () => {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

function contentType(name: string): string {
  return extname(name) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
}

function listen(server: Server): Promise<void> {
  return new Promise((ready) => server.listen(0, () => ready()));
}
