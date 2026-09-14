import { BASELINE_OFFSET, BASELINE_ZONE, expect, readOffset, readZone, test } from './fixtures.js';

// Tokyo is UTC+9 the whole year, so the offset a covered page reports is always -540.
const TOKYO_ZONE = 'Asia/Tokyo';
const TOKYO_OFFSET = -540;

test('a page opened after selecting Tokyo observes Asia/Tokyo', async ({ context, origins, select }) => {
  await select('tokyo');

  const page = await context.newPage();
  await page.goto(origins.localhost);

  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  expect(await readOffset(page)).toBe(TOKYO_OFFSET);
});

test('a tab already open when Tokyo is selected observes Asia/Tokyo without a reload', async ({
  context,
  origins,
  select,
}) => {
  const page = await context.newPage();
  await page.goto(origins.localhost);
  expect(await readZone(page)).toBe(BASELINE_ZONE);

  await select('tokyo');

  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  expect(await readOffset(page)).toBe(TOKYO_OFFSET);
});

test('with no Selection a page observes the Baseline zone', async ({ context, origins }) => {
  const page = await context.newPage();
  await page.goto(origins.localhost);
  // Nothing attaches without a Selection, so allow more than an attach would need and look again.
  await page.waitForTimeout(1000);

  expect(await readZone(page)).toBe(BASELINE_ZONE);
  expect(await readOffset(page)).toBe(BASELINE_OFFSET);
});
