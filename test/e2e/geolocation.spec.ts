// What navigator.geolocation reports in a covered page, and what the same call reports in a browser
// with no Sojourn in it. Every call passes the suite's explicit timeout, because a Chromium with no
// authorised location provider neither resolves nor errors on its own.

import {
  BASELINE_ZONE,
  GEOLOCATION_TIMEOUT,
  TOKYO_ZONE,
  coveredPage,
  expect,
  getPosition,
  readZone,
  test,
  type PositionReading,
  type Sojourn,
} from './fixtures.js';
import type { Page } from '@playwright/test';
import { metresApart } from '../oracle.js';
import type { Coordinates } from '../../src/chrome/debugger.js';

// The City this test selected, as the coordinates the extension stored for it.
const selected = async (sojourn: Sojourn, cityId: string): Promise<Coordinates> =>
  (await sojourn.select(cityId)).coordinates;

// What a covered page must read back for those coordinates: the three numbers, and null for the
// four fields the Override never sends.
const readingOf = (where: Coordinates) => ({
  ok: true,
  latitude: where.latitude,
  longitude: where.longitude,
  accuracy: where.accuracy,
  altitude: null,
  altitudeAccuracy: null,
  heading: null,
  speed: null,
  timestamp: expect.any(Number),
  age: expect.any(Number),
});

test('a covered page reports the Selection coordinates, with every other field null', async ({
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  const where = await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  expect(await getPosition(page)).toEqual(readingOf(where));
});

// What the page saw of the objects themselves, rather than of the numbers inside them.
type Shape = { position: boolean; coords: boolean; json: string };

test('the position is a real GeolocationPosition whose JSON carries the same seven keys', async ({
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  const where = await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  const shape = await page.evaluate(
    (timeout) =>
      new Promise<Shape>((done) => {
        navigator.geolocation.getCurrentPosition(
          (position) =>
            done({
              position: position instanceof GeolocationPosition,
              coords: position.coords instanceof GeolocationCoordinates,
              json: 'toJSON' in GeolocationPosition.prototype ? JSON.stringify(position) : 'absent',
            }),
          (error) => done({ position: false, coords: false, json: `error ${error.code}` }),
          { timeout },
        );
      }),
    GEOLOCATION_TIMEOUT,
  );

  expect(shape.position).toBe(true);
  expect(shape.coords).toBe(true);
  // toJSON arrived in Chrome 126 and the harness runs 153, so the other branch is for a floor build.
  if (shape.json === 'absent') console.log('GeolocationPosition.prototype.toJSON is absent here');
  else
    expect(JSON.parse(shape.json)).toEqual({
      timestamp: expect.any(Number),
      coords: {
        latitude: where.latitude,
        longitude: where.longitude,
        accuracy: where.accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
    });
});

// What a watch heard first: the point, or the error code that came instead.
type Watched = { latitude: number; longitude: number; accuracy: number; error: number | null };

function watchOnce(page: Page): Promise<Watched> {
  return page.evaluate(
    (timeout) =>
      new Promise<Watched>((done) => {
        const watch = navigator.geolocation.watchPosition(
          (position) => {
            navigator.geolocation.clearWatch(watch);
            done({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              error: null,
            });
          },
          (error) => {
            navigator.geolocation.clearWatch(watch);
            done({ latitude: 0, longitude: 0, accuracy: 0, error: error.code });
          },
          { timeout },
        );
      }),
    GEOLOCATION_TIMEOUT,
  );
}

test('watchPosition hands the same point to its first callback, and two tabs agree', async ({
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  const where = await selected(sojourn, 'tokyo');
  const here = await coveredPage(context, TOKYO_ZONE);
  await here.goto(origins.localhost);
  await expect.poll(() => readZone(here)).toBe(TOKYO_ZONE);
  const there = await coveredPage(context, TOKYO_ZONE);
  await there.goto(origins.loopback);
  await expect.poll(() => readZone(there)).toBe(TOKYO_ZONE);

  const watched = { ...where, error: null };
  expect(await watchOnce(here)).toEqual(watched);
  // Another tab, on the other site, so this is two tab sessions agreeing and not one.
  expect(await watchOnce(there)).toEqual(watched);
});

// A cross-origin frame inside this page, with or without the allow attribute that hands it the
// permission. The marker keeps two frames in one page apart.
async function framed(page: Page, src: string, allow: boolean): Promise<PositionReading> {
  await page.evaluate(async (asked) => {
    const frame = document.createElement('iframe');
    if (asked.allow) frame.allow = 'geolocation';
    frame.src = asked.src;
    const loaded = new Promise((done) => frame.addEventListener('load', done, { once: true }));
    document.body.appendChild(frame);
    await loaded;
  }, { src, allow });
  const frame = page.frames().find((inside) => inside.url() === src);
  if (!frame) throw new Error(`no frame at ${src}`);
  return getPosition(frame);
}

test('a cross-origin frame allowed geolocation reads the same point, and one that is not is refused as it is without Sojourn', async ({
  baseline,
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  await baseline.grantPermissions(['geolocation']);
  const where = await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  expect(await framed(page, `${origins.loopback}index.html?allowed`, true)).toEqual(readingOf(where));

  // The same frame without the attribute, against the same frame in a browser with no Sojourn.
  const plain = await baseline.newPage();
  await plain.goto(origins.localhost);
  const blocked = await framed(page, `${origins.loopback}index.html?blocked`, false);
  console.log('cross-origin frame with no allow attribute', JSON.stringify(blocked));
  expect(blocked).toEqual(await framed(plain, `${origins.loopback}index.html?blocked`, false));
});

test('with no permission the call is denied, exactly as it is without Sojourn', async ({
  baseline,
  context,
  origins,
  sojourn,
}) => {
  // Nothing is granted here: headless Chromium denies rather than showing a prompt.
  await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  const plain = await baseline.newPage();
  await plain.goto(origins.localhost);

  const denied = await getPosition(page);

  expect(denied).toMatchObject({ ok: false, code: 1 });
  expect(denied).toEqual(await getPosition(plain));
});

// The state a page reads, which the Override never touches.
const permissionState = (page: Page): Promise<string> =>
  page.evaluate(() => navigator.permissions.query({ name: 'geolocation' }).then((status) => status.state));

test('the geolocation permission state a page reads is the browser own, before and after a grant', async ({
  baseline,
  context,
  origins,
  sojourn,
}) => {
  await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  const plain = await baseline.newPage();
  await plain.goto(origins.localhost);

  expect(await permissionState(page)).toBe('prompt');
  expect(await permissionState(page)).toBe(await permissionState(plain));

  await context.grantPermissions(['geolocation']);
  await baseline.grantPermissions(['geolocation']);

  expect(await permissionState(page)).toBe('granted');
  expect(await permissionState(page)).toBe(await permissionState(plain));
});

test('changing the City changes the point the next call in an open tab returns', async ({
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  const tokyo = await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  expect(await getPosition(page)).toMatchObject({ latitude: tokyo.latitude, longitude: tokyo.longitude });

  const angeles = await selected(sojourn, 'los-angeles');

  await expect
    .poll(async () => {
      const fix = await getPosition(page);
      return fix.ok ? fix.latitude : null;
    })
    .toBe(angeles.latitude);
  expect(await getPosition(page)).toMatchObject({
    longitude: angeles.longitude,
    accuracy: angeles.accuracy,
  });
});

// Tokyo's Catalog coordinates, written here so this test does not read them from the Catalog.
const TOKYO = { latitude: 35.6762, longitude: 139.6503 };

test('the zone and the point a covered page observes are the same City', async ({
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);

  expect(await readZone(page)).toBe(TOKYO_ZONE);
  const fix = await getPosition(page);

  if (!fix.ok) throw new Error(`the covered page was refused with code ${fix.code}`);
  expect(metresApart(TOKYO, fix)).toBeLessThan(3000);
});

// Every callback one watch heard, in order: a position carries a latitude, an error a code.
type Heard = { latitude: number | null; code: number | null };

type Watching = { __heard: Heard[] };

function startWatching(page: Page): Promise<void> {
  return page.evaluate((timeout) => {
    const heard: Heard[] = [];
    (window as unknown as Watching).__heard = heard;
    navigator.geolocation.watchPosition(
      (position) => heard.push({ latitude: position.coords.latitude, code: null }),
      (error) => heard.push({ latitude: null, code: error.code }),
      { timeout },
    );
  }, GEOLOCATION_TIMEOUT);
}

const heardBy = (page: Page): Promise<Heard[]> =>
  page.evaluate(() => (window as unknown as Watching).__heard);

test('a watch hears the new City across a re-send, after the one error Chrome flushes first', async ({
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  const tokyo = await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await startWatching(page);
  await expect.poll(async () => (await heardBy(page)).length).toBeGreaterThan(0);
  expect((await heardBy(page))[0]).toEqual({ latitude: tokyo.latitude, code: null });

  const angeles = await selected(sojourn, 'los-angeles');

  await expect
    .poll(async () => (await heardBy(page)).some((entry) => entry.latitude === angeles.latitude))
    .toBe(true);
  const heard = await heardBy(page);
  console.log('watch heard across a City change', JSON.stringify(heard));
  // Measured, and the reason the brief's 30 s refresh is gone: Chrome answers the watch's pending
  // query with a POSITION_UNAVAILABLE before it hands over the new point. A City change is the only
  // re-send left, so a watch hears this once per City and never on its own.
  expect(heard).toEqual([
    { latitude: tokyo.latitude, code: null },
    { latitude: null, code: 2 },
    { latitude: angeles.latitude, code: null },
  ]);

  // Two ticks later nothing more has been heard, which is what says the periodic refresh is gone.
  await page.waitForTimeout(2200);
  expect(await heardBy(page)).toEqual(heard);

  // And the Residual Trace that leaves: while this watch holds the one outstanding query, a fresh
  // call waits for a position change the frozen Override never makes, and times out instead.
  expect(await getPosition(page)).toEqual({ ok: false, code: 3, message: 'Timeout expired' });
});

const LEFT_OPEN = 35_000;

test('a covered page left open reports a position no older than 31 s', async ({
  context,
  origins,
  sojourn,
}) => {
  // Measured 35095 ms after 35 s, and it grows with the document: only a re-send moves the
  // timestamp, and a re-send hands every active watch a POSITION_UNAVAILABLE first, which the test
  // above measures. The brief's contingency dropped the 30 s refresh for that reason, so the age is
  // a Residual Trace instead of a bound. A document that navigates starts again from zero.
  test.skip(true, 'the 30 s refresh is gone, so the age grows with the document: 35095 ms at 35 s');

  await context.grantPermissions(['geolocation']);
  await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await page.waitForTimeout(LEFT_OPEN);
  const fix = await getPosition(page);

  if (!fix.ok) throw new Error(`the covered page was refused with code ${fix.code}`);
  expect(fix.age).toBeLessThanOrEqual(31_000);
});

test('Disabling hands the page back what a browser with no Sojourn answers, and Enabling covers it again', async ({
  baseline,
  context,
  origins,
  sojourn,
}) => {
  await context.grantPermissions(['geolocation']);
  await baseline.grantPermissions(['geolocation']);
  const where = await selected(sojourn, 'tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  expect(await getPosition(page)).toMatchObject({ ok: true, latitude: where.latitude });

  await sojourn.enable(false);
  await expect.poll(() => readZone(page)).toBe(BASELINE_ZONE);

  // This is what says whether detaching is enough, and so whether the Disable path needs the fifth
  // protocol method the brief allows: a page with no Sojourn in the browser at all is the answer.
  const plain = await baseline.newPage();
  await plain.goto(origins.localhost);
  const withoutSojourn = await getPosition(plain);
  console.log('geolocation with no extension loaded', JSON.stringify(withoutSojourn));
  expect(await getPosition(page)).toEqual(withoutSojourn);

  await sojourn.enable(true);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  await expect.poll(async () => (await getPosition(page)).ok).toBe(true);
  expect(await getPosition(page)).toMatchObject({ ok: true, latitude: where.latitude });
});
