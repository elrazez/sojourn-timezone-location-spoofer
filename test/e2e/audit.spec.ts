// The Audit: one report from a browser without the extension (the Baseline), one from a browser
// with Tokyo selected, and one from a browser with the extension switched off. The set of keys whose
// values differ has to be exactly the Override keys, every context in the covered report has to
// agree with every other, and the Disabled run has to be indistinguishable from the Baseline.
// Playwright's own frames and navigator.webdriver appear in both reports and cancel out. Anything
// that appears only in the covered report is a Trace.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import {
  BASELINE_ZONE,
  GEOLOCATION_TIMEOUT,
  TOKYO_OFFSET,
  TOKYO_ZONE,
  coveredPage,
  expect,
  launchExtension,
  openTab,
  getPosition,
  readFirst,
  readZone,
  test,
  type FirstReading,
  type Loaded,
  type Origins,
} from './fixtures.js';

type Report = Record<string, string>;

// Every context the plan names. One that cannot be created reads 'unavailable' under every probe
// name in both reports, which is a measurement and not a skipped key.
const CONTEXTS = [
  'page',
  'same-origin-iframe',
  'cross-origin-iframe',
  'srcdoc-iframe',
  'about-blank-iframe',
  'blob-worker',
  'module-worker',
  'shared-worker',
  'service-worker',
  'popup',
];

// The probes whose value is the Override itself. Every one of them reads the zone, directly or
// through a rendering of a fixed instant.
const TIME_PROBES = [
  'time.zone',
  'time.offset-epoch',
  'time.offset-summer',
  'time.to-string',
  'time.to-time-string',
  'time.to-locale-long',
  'time.format-to-parts',
  'time.parse-local',
  'time.temporal-zone',
  'timezone.30-parse-vs-offset',
  'timezone.31-historical-1113',
  'timezone.32-date-string-zone',
  'intl.34-long-zone-name',
  'worker.36-scope-zone',
  'spoofer.47-temporal',
  'spoofer.49-cross-signal',
  'spoofer.50-frame-coverage',
  'lies.27-phantom-realm',
];

// The position, its object shape and its JSON. The permission state is not here: it is the browser's
// own and has to read the same in both.
const GEO_PROBES = ['geo.position', 'geo.instanceof', 'geo.json-keys'];

// The two contexts the plan gives a geolocation probe to. Every list in this file is the test's own
// literal, deliberately not read back from the probe page, because a list the page also decides
// from would agree with itself whatever the page did.
const GEO_CONTEXTS = ['page', 'cross-origin-iframe'];

// The literal this test is written around: every key the Override may move, and nothing else.
const OVERRIDE_KEYS = [
  ...CONTEXTS.flatMap((context) => TIME_PROBES.map((probe) => `${context}.${probe}`)),
  ...GEO_CONTEXTS.flatMap((context) => GEO_PROBES.map((probe) => `${context}.${probe}`)),
];

const auditUrl = (origins: Origins): string =>
  `${origins.localhost}audit.html?other=${encodeURIComponent(origins.loopback)}`;

async function collect(page: Page, origins: Origins): Promise<Report> {
  await page.goto(auditUrl(origins));
  // The probes drop an 'at async' frame from a stack, and a guard keeps any frame that names the
  // extension. A synthetic stack proves the guard holds, because a stack that lost such a frame
  // would read the same in both reports and the diff would never show it.
  expect(
    await page.evaluate(() =>
      (window as unknown as { __probes: { normalise(text: string): string } }).__probes.normalise(
        'Error: spoofer\n    at async chrome-extension://abcdef/dist/background.js:1:1',
      ),
    ),
  ).toContain('at async chrome-extension://abcdef/dist/background.js');
  // A popup opens only from a real click, and this is the only one the Audit needs.
  await page.click('#open-popup');
  return page.evaluate(() => (window as unknown as { __audit: Promise<Report> }).__audit);
}

// The Baseline: a browser with no extension in it at all.
async function baselineReport(baseline: BrowserContext, origins: Origins): Promise<Report> {
  await baseline.grantPermissions(['geolocation']);
  return collect(await baseline.newPage(), origins);
}

// The covered report: the tab is Covered before the document that reports is loaded, or its frames
// and workers would be racing the attach rather than reporting what a covered tab observes.
async function coveredReport(context: BrowserContext, origins: Origins): Promise<Report> {
  await context.grantPermissions(['geolocation']);
  return collect(await coveredPage(context, TOKYO_ZONE), origins);
}

// Keys whose values differ, with both values, so a key that is not expected prints what moved it.
function differences(before: Report, after: Report): Map<string, [string, string]> {
  const moved = new Map<string, [string, string]>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key] ?? 'missing';
    const is = after[key] ?? 'missing';
    if (was !== is) moved.set(key, [was, is]);
  }
  return moved;
}

const short = (value: string): string => (value.length > 160 ? `${value.slice(0, 160)}...` : value);

const printDiff = (label: string, moved: Map<string, [string, string]>): void => {
  for (const [key, [was, is]] of moved) console.log(`${label} ${key}\n  baseline: ${short(was)}\n  covered:  ${short(is)}`);
};

test('the Audit diff is exactly the Override keys, every context agrees, and Disabled is the Baseline', async ({
  baseline,
  context,
  disabled,
  origins,
  spoofer,
}) => {
  test.setTimeout(240_000);
  const selection = await spoofer.select('tokyo');

  const before = await baselineReport(baseline, origins);
  const after = await coveredReport(context, origins);

  // What the run is worth: how many probe names each context answered under.
  const names = new Set(Object.keys(after).map((key) => key.slice(key.indexOf('.') + 1)));
  console.log('probe names per context');
  for (const context of CONTEXTS) {
    const answered = Object.keys(after).filter((key) => key.startsWith(`${context}.`));
    const unavailable = answered.filter((key) => after[key] === 'unavailable').length;
    console.log(`  ${context.padEnd(20)} ${answered.length} probes, ${unavailable} unavailable`);
  }
  expect(names.size).toBeGreaterThanOrEqual(50);

  // The probe page's own bar: every expected key is present in every context and no probe threw.
  const threw = (report: Report): string[] =>
    Object.entries(report)
      .filter(([, value]) => value.includes('threw '))
      .map(([key, value]) => `${key}=${short(value)}`);
  expect({ baseline: threw(before), covered: threw(after) }).toEqual({ baseline: [], covered: [] });

  // One probe per vector in docs/research/main-world-patching.md, listed beside the vector number.
  const vectors = new Map<string, string>();
  for (const name of [...names].sort()) {
    const numbered = /\.(\d\d)-/.exec(name);
    if (numbered) vectors.set(numbered[1] as string, name);
  }
  console.log('vector, probe');
  for (const number of [...vectors.keys()].sort()) console.log(`  ${number}  ${vectors.get(number)}`);
  expect([...vectors.keys()].sort()).toEqual(
    Array.from({ length: 50 }, (_, index) => String(index + 1).padStart(2, '0')),
  );

  // 1. The diff is the Override and nothing else. A context that cannot be created reads
  // 'unavailable' in both reports, so its keys cannot move and are not expected to.
  const moved = differences(before, after);
  printDiff('moved', moved);
  const expected = OVERRIDE_KEYS.filter((key) => before[key] !== 'unavailable');
  const missing = expected.filter((key) => !moved.has(key));
  const unexpected = [...moved.keys()].filter((key) => !expected.includes(key));
  console.log('Override keys expected to move:', expected.length, 'unexpected:', unexpected.length, 'did not move:', missing.length);
  expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] });

  // 2. Every context agrees with every other on the zone and on the position.
  const agreed = (probe: string): string[] =>
    [...new Set(CONTEXTS.map((context) => after[`${context}.${probe}`]).filter((value) => value !== 'unavailable'))];
  expect(agreed('time.zone')).toEqual([TOKYO_ZONE]);
  expect(agreed('time.offset-summer')).toEqual(['-540']);
  // The point every geolocation context read, against the one the extension stored for Tokyo, and
  // the four fields the Override never sends, which a covered page reads as null.
  expect(agreed('geo.position')).toEqual([
    JSON.stringify({
      latitude: selection.coordinates.latitude,
      longitude: selection.coordinates.longitude,
      accuracy: selection.coordinates.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    }),
  ]);
  expect(agreed('geo.instanceof')).toEqual(['position=true coords=true']);

  // 3. The extension loaded and switched off is the Baseline.
  const off = await disabledReport(disabled, origins);
  const stillMoved = differences(before, off);
  printDiff('disabled', stillMoved);
  expect([...stillMoved.keys()]).toEqual([]);
});

// The third run: the extension is loaded, a City is selected, and the switch is off, which is the
// state that has to be indistinguishable from a browser with no extension in it.
async function disabledReport(disabled: Loaded, origins: Origins): Promise<Report> {
  await disabled.spoofer.enable(false);
  await disabled.spoofer.select('tokyo');
  await disabled.context.grantPermissions(['geolocation']);
  const page = await disabled.context.newPage();
  await page.goto(origins.localhost);
  // Nothing is covered, so the page reads the real zone before the Audit is loaded into it.
  await expect.poll(() => page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(BASELINE_ZONE);
  return collect(page, origins);
}

// The residual measurements. None of them can fail the run: each is a number the brief's Residual
// Traces list names, measured here and printed by name.

// Where the numbers are written, for the README and the brief to quote.
const RESIDUALS = fileURLToPath(new URL('../audit/residuals.json', import.meta.url));

// One name per measurement the plan's step 2 lists, items 4 to 9, and the two the cached document
// adds. Written here rather than read back from the object below, so a renamed entry is a failure.
const MEASUREMENTS = [
  'back-forward-cache',
  'bar',
  'cached-document',
  'cached-document-with-latency',
  'first-position-ms',
  'first-script-gaps',
  'new-tab-page-misses',
  'pause-latency',
  'position-timestamp-age-ms',
];

const median = (numbers: number[]): number => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)] ?? 0;
const nearest = (ms: number, step: number): number => Math.round(ms / step) * step;

// What one page observed in its first script, against the Override.
const missed = (first: FirstReading | undefined): boolean => first?.zone !== TOKYO_ZONE;

// What one first script observed: the zone, and the position a call started in that same script
// came back with.
type FirstLook = FirstReading & { position: unknown };

const firstScriptPosition = (page: Page): Promise<unknown> =>
  page.evaluate(() => (window as unknown as { __firstPosition: Promise<unknown> }).__firstPosition);

// Popups this page opened, and what their first scripts observed. A popup needs a real click, and
// a race is worth more than one sample, so this opens five.
async function popupFirsts(
  context: BrowserContext,
  page: Page,
  from: string,
  target: string,
): Promise<{ loads: number; misses: number; readings: FirstLook[] }> {
  const readings: FirstLook[] = [];
  for (let load = 0; load < 5; load += 1) {
    await page.goto(`${from}opener.html?target=${target}`);
    await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
    const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
    await popup.waitForLoadState();
    readings.push({ ...(await readFirst(popup)), position: await firstScriptPosition(popup) });
    await popup.close();
  }
  return { loads: readings.length, misses: readings.filter(missed).length, readings };
}

// The two timings a child target pays for being paused at start until Spoofer resumes it.
function childTimings(page: Page, other: string): Promise<{ iframe: number; worker: number }> {
  return page.evaluate(async (where) => {
    const iframe = await new Promise<number>((done) => {
      const started = performance.now();
      const frame = document.createElement('iframe');
      frame.src = `${where}index.html?fresh=${Math.random()}`;
      frame.addEventListener('load', () => done(performance.now() - started));
      document.body.appendChild(frame);
    });
    const worker = await new Promise<number>((done) => {
      const started = performance.now();
      const url = URL.createObjectURL(new Blob(['postMessage(0)'], { type: 'text/javascript' }));
      new Worker(url).addEventListener('message', () => done(performance.now() - started));
    });
    return { iframe, worker };
  }, other);
}

// How long the first position took, whatever it was: a fix, or the timeout the Baseline runs into.
const timeToFirstPosition = (page: Page): Promise<number> =>
  page.evaluate(
    (timeout) =>
      new Promise<number>((done) => {
        const started = performance.now();
        const stop = () => done(performance.now() - started);
        navigator.geolocation.getCurrentPosition(stop, stop, { timeout });
      }),
    GEOLOCATION_TIMEOUT,
  );

// Away to the other site and back, which is where the back/forward cache either holds the document
// or says why it could not.
async function backForward(context: BrowserContext, origins: Origins): Promise<unknown> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __pageshow: boolean[] }).__pageshow = [];
    addEventListener('pageshow', (event) =>
      (window as unknown as { __pageshow: boolean[] }).__pageshow.push(event.persisted),
    );
  });
  // The Audit page itself, because it is the one holding a service worker, a shared worker and an
  // open popup, which are the documented reasons a document is kept out of the cache.
  await collect(page, origins);
  await page.goto(origins.loopback);
  await page.goBack();
  const heard = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & {
      notRestoredReasons?: unknown;
    };
    return {
      pageshow: (window as unknown as { __pageshow?: boolean[] }).__pageshow ?? null,
      notRestoredReasons: JSON.stringify(navigation.notRestoredReasons ?? null),
    };
  });
  await page.close();
  return heard;
}

// Ten tabs opened straight onto one url by the service worker, and how many first scripts missed.
async function loadsInto(context: BrowserContext, worker: import('@playwright/test').Worker, url: string, times: number): Promise<number> {
  let misses = 0;
  for (let load = 0; load < times; load += 1) {
    const opened = await openTab(context, worker, url);
    await opened.page.waitForLoadState();
    if (missed(await readFirst(opened.page).catch(() => undefined))) misses += 1;
    await opened.page.close();
  }
  return misses;
}

test('the residual measurements', async ({ baseline, context, origins, spoofer, worker }) => {
  test.setTimeout(420_000);
  await context.grantPermissions(['geolocation']);
  await baseline.grantPermissions(['geolocation']);
  await spoofer.select('tokyo');
  const covered = await coveredPage(context, TOKYO_ZONE);

  // 4. First-script gaps: the popups, the prerendered page, and the shared worker's first line.
  const sameSite = await popupFirsts(context, covered, origins.localhost, `${origins.localhost}first.html`);
  const crossSite = await popupFirsts(context, covered, origins.localhost, `${origins.loopback}first.html`);
  await covered.goto(`${origins.localhost}shared.html`);
  await expect.poll(() => origins.readings.some((reading) => reading.where === 'shared-worker')).toBe(true);
  const sharedWorker = origins.readings.find((reading) => reading.where === 'shared-worker');
  await covered.goto(`${origins.localhost}prerender.html`);
  await expect.poll(() => readZone(covered)).toBe(TOKYO_ZONE);
  await covered.click('#go');
  await covered.waitForURL(/prerendered/);
  const prerendered = {
    first: await readFirst(covered),
    // The page was never prerendered, so this is the position after it was navigated to.
    'position after activation': await getPosition(covered),
    // activationStart is 0 for a page that was never prerendered, which is the answer here.
    activationStart: await covered.evaluate(
      () => (performance.getEntriesByType('navigation')[0] as unknown as { activationStart: number }).activationStart,
    ),
  };

  // 5. The New Tab Page, twenty loads, and the first ten of them apart.
  const newTabPage: boolean[] = [];
  for (let load = 0; load < 20; load += 1) {
    const opened = await openTab(context, worker, 'chrome://new-tab-page');
    await opened.page.goto(`${origins.localhost}index.html`);
    newTabPage.push(missed(await readFirst(opened.page).catch(() => undefined)));
    await opened.page.close();
  }

  // The cached document, and the same page with the server holding the answer for 25 ms.
  const cachedUrl = `${origins.localhost}record.html?cache=3600`;
  const latencyUrl = `${origins.localhost}record.html?cache=3600&latency=25`;
  const served = (url: string): number => origins.requests.filter((asked) => asked === url).length;
  const cachedRuns = [];
  for (const [name, url] of [['cached-document', cachedUrl], ['cached-document-with-latency', latencyUrl]]) {
    await covered.goto(url);
    await expect.poll(() => readZone(covered)).toBe(TOKYO_ZONE);
    const before = served(url);
    const misses = await loadsInto(context, worker, url, 10);
    cachedRuns.push([name, { loads: 10, misses, serverRequests: served(url) - before }] as const);
  }

  // 8. Pause latency, medians over five runs, against the Baseline.
  const plain = await baseline.newPage();
  await plain.goto(origins.localhost);
  const timings = { covered: [] as { iframe: number; worker: number }[], baseline: [] as { iframe: number; worker: number }[] };
  await covered.goto(origins.localhost);
  await expect.poll(() => readZone(covered)).toBe(TOKYO_ZONE);
  for (let run = 0; run < 5; run += 1) {
    timings.covered.push(await childTimings(covered, origins.loopback));
    timings.baseline.push(await childTimings(plain, origins.loopback));
  }

  // 9. The milliseconds to the first position, rounded to the nearest 50.
  const position = {
    covered: nearest(await timeToFirstPosition(covered), 50),
    baseline: nearest(await timeToFirstPosition(plain), 50),
  };

  // The timestamp is the moment of the last send, so it ages with the document. The plan asks for
  // it here because phase 04's contingency dropped the 30 s refresh that would have bounded it.
  const atOnce = await getPosition(covered);
  await covered.waitForTimeout(3000);
  const afterThree = await getPosition(covered);
  const ageing = {
    'at once': atOnce.ok ? atOnce.age : `error ${atOnce.code}`,
    'after 3 s': afterThree.ok ? afterThree.age : `error ${afterThree.code}`,
  };

  // 7. The back/forward cache, in both runs.
  const bfcache = { covered: await backForward(context, origins), baseline: await backForward(baseline, origins) };

  // 6. The bar, which only a headed browser has.
  const bar = await measureBar(origins);

  const residuals = {
    'first-script-gaps': {
      'same-site popup': sameSite,
      'cross-site popup': crossSite,
      'shared worker first line': sharedWorker ?? 'never reported',
      prerendered,
      override: { zone: TOKYO_ZONE, offset: TOKYO_OFFSET },
    },
    'new-tab-page-misses': {
      loads: newTabPage.length,
      misses: newTabPage.filter(Boolean).length,
      'first ten loads': newTabPage.slice(0, 10).filter(Boolean).length,
    },
    bar,
    'back-forward-cache': bfcache,
    'pause-latency': {
      'cross-origin iframe load, median ms': {
        covered: median(timings.covered.map((one) => one.iframe)),
        baseline: median(timings.baseline.map((one) => one.iframe)),
      },
      'dedicated worker first message, median ms': {
        covered: median(timings.covered.map((one) => one.worker)),
        baseline: median(timings.baseline.map((one) => one.worker)),
      },
      runs: 5,
    },
    'first-position-ms': position,
    'position-timestamp-age-ms': ageing,
    ...Object.fromEntries(cachedRuns),
  };

  await writeFile(RESIDUALS, `${JSON.stringify(residuals, null, 2)}\n`);
  for (const [name, measured] of Object.entries(residuals)) {
    console.log(`residual ${name}: ${JSON.stringify(measured)}`);
  }
  // Read back from the file, because the file is what the next phase and the README quote.
  const written = JSON.parse(await readFile(RESIDUALS, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(written).sort()).toEqual(MEASUREMENTS);
});

// One headed run with no fixed viewport, which is the only way the debugging bar can take height
// from the page. A machine with no display says so instead.
async function measureBar(origins: Origins): Promise<unknown> {
  let headed: Awaited<ReturnType<typeof launchExtension>> | undefined;
  try {
    headed = await launchExtension([], false);
  } catch (error) {
    return { ran: false, why: error instanceof Error ? error.message : String(error) };
  }
  try {
    const page = await headed.context.newPage();
    await page.goto(origins.localhost);
    const before = await page.evaluate(() => {
      const heard = { resizes: 0 };
      (window as unknown as { __resizes: { resizes: number } }).__resizes = heard;
      addEventListener('resize', () => {
        heard.resizes += 1;
      });
      return { innerHeight: window.innerHeight, resizes: heard.resizes };
    });
    // Attaching is what shows the bar, and a Selection is what makes Spoofer attach.
    await headed.spoofer.select('tokyo');
    await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
    const read = () =>
      page.evaluate(() => ({
        innerHeight: window.innerHeight,
        resizes: (window as unknown as { __resizes: { resizes: number } }).__resizes.resizes,
      }));
    const attached = await read();
    await page.waitForTimeout(6000);
    const later = await read();
    return { ran: true, before, attached, 'after 6 s': later, 'innerHeight delta': later.innerHeight - before.innerHeight };
  } finally {
    await headed.done();
  }
}
