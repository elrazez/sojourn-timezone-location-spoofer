// The probe that decides whether the reconcile interval is page-visible. A covered page and a
// covered worker sample the zone and the offset 100 times a second for 5 s, across at least four
// re-sends, and must see exactly one value and hear no timezonechange event. A red result means the
// re-send is a Trace, and the brief's contingency drops the interval.

import { TOKYO_OFFSET, TOKYO_ZONE, coveredPage, expect, readZone, test } from './fixtures.js';

type Samples = { zones: string[]; offsets: number[]; events: number; hasEvent: boolean };

const SAMPLE_FOR = 5000;
const EVERY = 10;

test('a covered page and a covered worker see one zone and no timezonechange across five reconciles', async ({
  context,
  origins,
  sojourn,
}) => {
  await sojourn.select('tokyo');
  const page = await coveredPage(context, TOKYO_ZONE);
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  const before = (await sojourn.status()).zoneSends;
  const [inPage, inWorker] = await page.evaluate(
    async ([span, every]) => {
      const sample = () => ({
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: new Date().getTimezoneOffset(),
      });

      const watchPage = () =>
        new Promise<Samples>((done) => {
          const zones = new Set<string>();
          const offsets = new Set<number>();
          let events = 0;
          addEventListener('timezonechange', () => {
            events += 1;
          });
          const tick = setInterval(() => {
            const now = sample();
            zones.add(now.zone);
            offsets.add(now.offset);
          }, every);
          setTimeout(() => {
            clearInterval(tick);
            done({ zones: [...zones], offsets: [...offsets], events, hasEvent: 'ontimezonechange' in window });
          }, span);
        });

      const body = `
        const zones = new Set(); const offsets = new Set(); let events = 0;
        addEventListener('timezonechange', () => { events += 1; });
        const tick = setInterval(() => {
          zones.add(Intl.DateTimeFormat().resolvedOptions().timeZone);
          offsets.add(new Date().getTimezoneOffset());
        }, ${every});
        setTimeout(() => {
          clearInterval(tick);
          postMessage({ zones: [...zones], offsets: [...offsets], events, hasEvent: 'ontimezonechange' in self });
        }, ${span});
      `;
      const worker = new Worker(URL.createObjectURL(new Blob([body], { type: 'text/javascript' })));
      const watchWorker = new Promise<Samples>((done) => {
        worker.addEventListener('message', (event) => done(event.data as Samples));
      });

      return Promise.all([watchPage(), watchWorker]);
    },
    [SAMPLE_FOR, EVERY] as const,
  );

  const resends = (await sojourn.status()).zoneSends - before;

  // Recorded either way, because whether Chrome fires the event at all is part of the answer.
  console.log('flicker probe', JSON.stringify({ inPage, inWorker, resends }));

  // What makes the single value evidence: the zone really was re-sent underneath the samples.
  expect(resends).toBeGreaterThanOrEqual(4);
  expect(inPage.zones).toEqual([TOKYO_ZONE]);
  expect(inPage.offsets).toEqual([TOKYO_OFFSET]);
  expect(inWorker.zones).toEqual([TOKYO_ZONE]);
  expect(inWorker.offsets).toEqual([TOKYO_OFFSET]);

  // Chromium does not ship timezonechange, so these zero counts say the listener heard nothing
  // from an event that cannot fire here, not that a firing event was missed.
  expect(inPage.hasEvent).toBe(false);
  expect(inWorker.hasEvent).toBe(false);
  expect(inPage.events).toBe(0);
  expect(inWorker.events).toBe(0);
});
