import { BASELINE_OFFSET, BASELINE_ZONE, expect, readOffset, readZone, test } from './fixtures.js';

test('the extension service worker answers with its runtime id', async ({ worker, extensionId }) => {
  expect(await worker.evaluate(() => chrome.runtime.id)).toBe(extensionId);
});

test('the harness Baseline is Pacific/Kiritimati at offset -840', async ({ context, origins }) => {
  const page = await context.newPage();
  await page.goto(origins.localhost);

  expect(await readZone(page)).toBe(BASELINE_ZONE);
  expect(await readOffset(page)).toBe(BASELINE_OFFSET);
});
