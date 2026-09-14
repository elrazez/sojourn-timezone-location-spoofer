import {
  BASELINE_OFFSET,
  BASELINE_ZONE,
  TOKYO_OFFSET,
  TOKYO_ZONE,
  expect,
  readFirst,
  readOffset,
  readZone,
  test,
} from './fixtures.js';

// Los Angeles is UTC-8 in January, so a covered page reports 480 on the date the page records.
const LOS_ANGELES_ZONE = 'America/Los_Angeles';
const LOS_ANGELES_OFFSET = 480;

test('a page opened after selecting Tokyo observes Asia/Tokyo', async ({ context, origins, spoofer }) => {
  await spoofer.select('tokyo');

  const page = await context.newPage();
  await page.goto(origins.localhost);

  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  expect(await readOffset(page)).toBe(TOKYO_OFFSET);
});

test('a tab already open when Tokyo is selected observes Asia/Tokyo without a reload', async ({
  context,
  origins,
  spoofer,
}) => {
  const page = await context.newPage();
  await page.goto(origins.localhost);
  expect(await readZone(page)).toBe(BASELINE_ZONE);

  await spoofer.select('tokyo');

  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  expect(await readOffset(page)).toBe(TOKYO_OFFSET);
});

test('with no Selection a page observes the Baseline zone', async ({ context, origins, spoofer }) => {
  const page = await context.newPage();
  await page.goto(origins.localhost);

  // A discriminating transition rather than a wait: Spoofer proves it can move this page, and only
  // then is the Baseline reading evidence that no Selection means no coverage.
  await spoofer.select('tokyo');
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await spoofer.clear();
  await expect.poll(() => readZone(page)).toBe(BASELINE_ZONE);
  expect(await readOffset(page)).toBe(BASELINE_OFFSET);
});

test('a covered tab keeps Asia/Tokyo across a navigation to another site', async ({
  context,
  origins,
  spoofer,
}) => {
  await spoofer.select('tokyo');
  const page = await context.newPage();
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await page.goto(origins.loopback);

  // The new document is in another renderer process, and its very first script must already see it.
  expect(await readFirst(page)).toMatchObject({ zone: TOKYO_ZONE, offset: TOKYO_OFFSET });
});

test('Disabled hands the page back its real zone, and Enabled covers it again, with no reload', async ({
  context,
  origins,
  spoofer,
}) => {
  await spoofer.select('tokyo');
  const page = await context.newPage();
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await spoofer.enable(false);
  await expect.poll(() => readZone(page)).toBe(BASELINE_ZONE);
  expect(await readOffset(page)).toBe(BASELINE_OFFSET);

  await spoofer.enable(true);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  expect(await readOffset(page)).toBe(TOKYO_OFFSET);
});

test('changing the City from Tokyo to Los Angeles reaches an open tab with no reload', async ({
  context,
  origins,
  spoofer,
}) => {
  await spoofer.select('tokyo');
  const page = await context.newPage();
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  await spoofer.select('los-angeles');

  await expect.poll(() => readZone(page)).toBe(LOS_ANGELES_ZONE);
  // 15 January 2026 is outside every DST transition week, so this offset is a fixed literal.
  expect(
    await page.evaluate(() => new Date(Date.UTC(2026, 0, 15, 3, 0, 0)).getTimezoneOffset()),
  ).toBe(LOS_ANGELES_OFFSET);
});

test('a covered page prints Japan Standard Time in Date.toString', async ({ context, origins, spoofer }) => {
  await spoofer.select('tokyo');
  const page = await context.newPage();
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  const printed = await page.evaluate(() => new Date().toString());

  expect(printed.endsWith('GMT+0900 (Japan Standard Time)')).toBe(true);
});
