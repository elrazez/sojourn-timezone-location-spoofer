// Every context inside a covered tab: cross-origin frames, the three worker kinds, popups, and a
// prerendered page. Each is asserted on the zone it recorded in its own first script, except the
// cross-site popup, whose first script is a measurement the brief expects to miss.

import {
  TOKYO_OFFSET,
  TOKYO_ZONE,
  coveredPage,
  expect,
  readFirst,
  readZone,
  test,
  type FirstReading,
} from './fixtures.js';

const TOKYO = { zone: TOKYO_ZONE, offset: TOKYO_OFFSET };

test('a cross-origin frame observes Asia/Tokyo in its first script', async ({ context, origins, spoofer }) => {
  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);

  await page.goto(`${origins.localhost}frames.html?child=${origins.loopback}frame.html`);

  const first = await page.waitForFunction(
    () => (window as unknown as { __frame: FirstReading | null }).__frame,
  );
  expect(await first.jsonValue()).toEqual(TOKYO);
});

test('a dedicated worker, a module worker and a service worker each observe Asia/Tokyo on their first line', async ({
  context,
  origins,
  spoofer,
}) => {
  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);

  await page.goto(`${origins.localhost}workers.html`);

  const workers = await page.evaluate(
    () => (window as unknown as { __workers: Promise<Record<string, FirstReading>> }).__workers,
  );
  expect(workers).toEqual({ dedicated: TOKYO, module: TOKYO, service: TOKYO });
});

test('a same-site popup observes Asia/Tokyo in its first script', async ({ context, origins, spoofer }) => {
  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(`${origins.localhost}opener.html?target=${origins.localhost}index.html`);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
  await popup.waitForLoadState();

  // It shares the opener's covered renderer process, so the zone is already in place.
  expect(await readFirst(popup)).toMatchObject(TOKYO);
});

test('a cross-site popup observes Asia/Tokyo once Spoofer has attached', async ({
  context,
  origins,
  spoofer,
}) => {
  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(`${origins.localhost}opener.html?target=${origins.loopback}index.html`);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
  await popup.waitForLoadState();

  // A tab session cannot pause a popup, so its first script is a measurement, not an assertion.
  console.log('cross-site popup first script read', JSON.stringify(await readFirst(popup)));
  await expect.poll(() => readZone(popup)).toBe(TOKYO_ZONE);
});

test('a prerendered page observes Asia/Tokyo when it is activated', async ({ context, origins, spoofer }) => {
  // Measured: no prerender happens here at all, with or without Spoofer. No page target with
  // subtype prerender appears, and the navigation reports activationStart 0 and type navigate, so
  // the test would pass without testing anything. On the brief's Manual verification line instead.
  test.skip(true, 'Chromium under the harness never prerenders, so activation cannot be driven');

  await spoofer.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(`${origins.localhost}prerender.html`);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await page.click('#go');
  await page.waitForURL(/prerendered/);

  expect(await readZone(page)).toBe(TOKYO_ZONE);
  expect(await readFirst(page)).toMatchObject(TOKYO);
});
