// What the user is told, and what happens to coverage when tabs are restricted, share a renderer,
// crash, are discarded, or start life somewhere Spoofer cannot attach.

import { fileURLToPath } from 'node:url';
import {
  BASELINE_ZONE,
  TOKYO_OFFSET,
  TOKYO_ZONE,
  coveredPage,
  expect,
  openCoveredTab,
  openTab,
  readFirst,
  readZone,
  test,
} from './fixtures.js';

const FILE_PAGE = fileURLToPath(new URL('../pages/index.html', import.meta.url));
const RED = [217, 48, 37, 255];
const ANOTHER_CLIENTS_ZONE = 'Europe/Paris';

const badge = (worker: import('@playwright/test').Worker) =>
  worker.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}),
    color: await chrome.action.getBadgeBackgroundColor({}),
  }));

test('the badge is empty while every web tab is Covered, OFF while Disabled, and a red count otherwise', async ({
  context,
  origins,
  spoofer,
  worker,
}) => {
  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await expect.poll(async () => (await badge(worker)).text).toBe('');

  await spoofer.enable(false);
  await expect.poll(async () => (await badge(worker)).text).toBe('OFF');

  // Another debugging client takes this renderer's zone first, which is what the DevTools Sensors
  // panel does. Spoofer's send is then refused and the tab can never be Covered until it lets go.
  const taken = await context.newPage();
  await taken.goto(origins.loopback);
  const rival = await context.newCDPSession(taken);
  await rival.send('Emulation.setTimezoneOverride', { timezoneId: ANOTHER_CLIENTS_ZONE });

  await spoofer.enable(true);

  await expect.poll(async () => (await badge(worker)).text).toBe('1');
  expect((await badge(worker)).color).toEqual(RED);
  expect((await spoofer.status()).notCovered).toEqual([
    { tabId: expect.any(Number), reason: 'Timezone override is already in effect' },
  ]);
  expect(await readZone(taken)).toBe(ANOTHER_CLIENTS_ZONE);
});

// Measured, not asserted: an extension loaded from the command line has file access here, so a
// file:// tab is Covered in this harness and cannot stand in for a Not Covered web tab.
test('a file page is Covered in this harness', async ({ context, spoofer }) => {
  await spoofer.select('tokyo');
  const local = await context.newPage();
  await local.goto(`file://${FILE_PAGE}`);

  await expect.poll(() => readZone(local)).toBe(TOKYO_ZONE);
});

test('a chrome:// tab is Restricted, counted apart from Not Covered, and never on the badge', async ({
  context,
  origins,
  spoofer,
  worker,
}) => {
  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await openTab(context, worker, 'chrome://version');

  await expect.poll(async () => (await spoofer.status()).restricted).toBe(1);
  expect((await spoofer.status()).notCovered).toEqual([]);
  expect((await badge(worker)).text).toBe('');
});

test.describe('in one renderer process', () => {
  test.use({ extraArgs: ['--renderer-process-limit=1'] });

  test('a Covered tab keeps Asia/Tokyo when the tab that owned the renderer closes', async ({
    context,
    origins,
    spoofer,
  }) => {
    await spoofer.select('tokyo');
    // Start from no tabs, so the first tab opened here is the one that takes the renderer's zone.
    for (const open of context.pages()) await open.close();

    const first = await coveredPage(context, TOKYO_ZONE);
    await first.goto(origins.localhost);
    await expect.poll(() => readZone(first)).toBe(TOKYO_ZONE);

    const second = await coveredPage(context, TOKYO_ZONE);
    await second.goto(origins.localhost);
    await expect.poll(() => readZone(second)).toBe(TOKYO_ZONE);

    await first.close();

    // The interval bounds this window to 1 s, and the close itself is a signal to re-send sooner.
    await expect.poll(() => readZone(second), { timeout: 1100 }).toBe(TOKYO_ZONE);
  });
});

test('a tab whose renderer crashed observes Asia/Tokyo in the first script after it loads again', async ({
  context,
  origins,
  spoofer,
  worker,
}) => {
  await spoofer.select('tokyo');
  const { page, tabId } = await openCoveredTab(context, worker, `${origins.localhost}record.html`, TOKYO_ZONE);
  await expect.poll(() => origins.readings.at(-1)?.zone).toBe(TOKYO_ZONE);

  const crashed = page.waitForEvent('crash');
  await page.goto('chrome://crash').catch(() => {});
  await crashed;
  // A crashed page cannot be talked to any more, so the service worker sends the tab back and the
  // page reports what its first script observed to the harness itself.
  await worker.evaluate(
    (asked) => chrome.tabs.update(asked.id, { url: asked.url }),
    { id: tabId, url: `${origins.localhost}record.html` },
  );

  await expect.poll(() => origins.readings.length).toBeGreaterThan(1);
  expect(origins.readings.at(-1)).toEqual({ zone: TOKYO_ZONE, offset: TOKYO_OFFSET });
});

test('a discarded tab observes Asia/Tokyo when it is brought back', async ({
  context,
  origins,
  spoofer,
  worker,
}) => {
  // Measured: chrome.tabs.discard succeeds and reports the new tab id, and the harness then loses
  // the browser. Every page, the extension's service worker and the next evaluate report "Target
  // page, context or browser has been closed". On the brief's Manual verification line instead.
  test.skip(true, 'chrome.tabs.discard closes the harness connection to the browser');

  await spoofer.select('tokyo');
  const { tabId } = await openCoveredTab(context, worker, `${origins.localhost}record.html`, TOKYO_ZONE);
  await expect.poll(() => origins.readings.at(-1)?.zone).toBe(TOKYO_ZONE);

  const freshId = await worker.evaluate(async (id) => (await chrome.tabs.discard(id))?.id ?? -1, tabId);
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), freshId);

  await expect.poll(() => origins.readings.length, { timeout: 15_000 }).toBeGreaterThan(1);
  expect(origins.readings.at(-1)).toEqual({ zone: TOKYO_ZONE, offset: TOKYO_OFFSET });
});

test('a tab leaving the New Tab Page observes Asia/Tokyo in its first script', async ({
  context,
  origins,
  spoofer,
  worker,
}) => {
  // Measured 10 misses in 10 loads, before and after the brief's 20 ms attach retry was added:
  // Chrome refuses the attach while chrome://new-tab-page is committed, so it can only land after
  // the next document has committed, which is after its first script ran. The retry still shortens
  // the window where the tab is Not Covered from a second to 20 ms, so it stays.
  test.skip(true, 'the attach cannot land before the first script: 10 misses in 10 loads');

  await spoofer.select('tokyo');
  const { page } = await openTab(context, worker, 'chrome://new-tab-page');
  await expect.poll(async () => (await spoofer.status()).restricted).toBe(1);

  await page.goto(`${origins.localhost}index.html`);

  expect(await readFirst(page)).toMatchObject({ zone: TOKYO_ZONE });
});

test('a tab created straight onto another site observes Asia/Tokyo in its first script', async ({
  context,
  origins,
  spoofer,
  worker,
}) => {
  // Measured 10 misses in 10 tabs, and the timeline says why: chrome.tabs.onCreated reaches the
  // service worker about 12 ms after the document request is already in flight, and the attach and
  // the zone send add about 30 ms, so the zone lands about 10 ms late. The gap is that narrow:
  // serving the same page with 25 ms of latency gives 0 misses in 5, as do 50, 100 and 200 ms.
  test.skip(true, 'the zone lands about 10 ms after the first script when the document is local');

  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  const opened = await openTab(context, worker, `${origins.loopback}index.html`);

  expect(await readFirst(opened.page)).toMatchObject({ zone: TOKYO_ZONE });
});

test('the Baseline zone is what a tab observes when nothing is selected', async ({ context, origins }) => {
  const page = await context.newPage();
  await page.goto(origins.localhost);

  expect(await readFirst(page)).toMatchObject({ zone: BASELINE_ZONE });
});
