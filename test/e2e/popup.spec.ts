// The popup, opened as a page of its own because a harness cannot click a toolbar icon. What is
// asserted here is what a person sees and does: type, choose, switch, Resume, and read the count.
// Every label and every line is written out here, so a rename in the popup has to be agreed here.

import { BASELINE_ZONE, TOKYO_ZONE, expect, readZone, test } from './fixtures.js';

// The popup opened as a page is a tab like any other, and Chrome lets an extension attach to its
// own page, so it is Covered too. A real popup is not a tab at all: this one is the harness's.
const HARNESS_POPUP = 1;

test('slice 4: typing tok and choosing Tokyo makes the Selection Tokyo, and the next page observes it', async ({
  context,
  origins,
  popup,
  spoofer,
}) => {
  await popup.getByLabel('Search Cities').fill('tok');
  await popup.getByRole('button', { name: 'Tokyo, Japan' }).click();

  // Read back through the service worker, so this is the extension's Selection and not the popup's.
  await expect.poll(async () => (await spoofer.status()).cityId).toBe('tokyo');
  await expect(popup.getByText('Tokyo, Japan', { exact: true })).toBeVisible();

  const page = await context.newPage();
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
});

test('slice 5: the switch off reads Off, shows OFF on the badge, and hands the page back its real zone', async ({
  context,
  origins,
  popup,
  spoofer,
  worker,
}) => {
  const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
  await spoofer.select('tokyo');
  const page = await context.newPage();
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  // The switch shows what the service worker reported before it is moved, or moving it proves nothing.
  await expect(popup.getByLabel('Enabled')).toBeChecked();

  await popup.getByLabel('Enabled').uncheck();

  await expect(popup.getByText('Off', { exact: true })).toBeVisible();
  await expect.poll(badge).toBe('OFF');
  await expect.poll(() => readZone(page)).toBe(BASELINE_ZONE);

  await popup.getByLabel('Enabled').check();

  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  await expect.poll(badge).toBe('');
});

test('slice 6: the count is the open http tabs, and it grows when another is opened', async ({
  context,
  origins,
  popup,
  spoofer,
}) => {
  // Start from nothing but the popup, so the only web tabs here are the ones this test opens.
  for (const open of context.pages()) if (open !== popup) await open.close();
  await spoofer.select('tokyo');

  for (const where of [origins.localhost, origins.loopback]) {
    const page = await context.newPage();
    await page.goto(where);
    await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  }

  await expect(popup.getByText(`${2 + HARNESS_POPUP} tabs Covered`)).toBeVisible();

  const third = await context.newPage();
  await third.goto(`${origins.localhost}index.html`);

  await expect(popup.getByText(`${3 + HARNESS_POPUP} tabs Covered`)).toBeVisible();
});

test('the Paused notice offers Resume, and Resume covers the tabs again', async ({
  context,
  origins,
  popup,
  spoofer,
  worker,
}) => {
  for (const open of context.pages()) if (open !== popup) await open.close();
  await spoofer.select('tokyo');
  const page = await context.newPage();
  await page.goto(origins.localhost);
  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);

  // No harness can dismiss Chrome's bar, so this is the state dismissing it leaves behind: Paused
  // remembered in session storage, which is what a worker restart reads back. The write to local
  // storage is what makes the worker read both again.
  await worker.evaluate(async () => {
    await chrome.storage.session.set({ paused: true });
    await chrome.storage.local.set({ nudge: Date.now() });
  });

  await expect(popup.getByText('Paused', { exact: true })).toBeVisible();
  await expect.poll(() => readZone(page)).toBe(BASELINE_ZONE);
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('OFF');

  await popup.getByRole('button', { name: 'Resume' }).click();

  await expect.poll(() => readZone(page)).toBe(TOKYO_ZONE);
  await expect(popup.getByText(`${1 + HARNESS_POPUP} tabs Covered`)).toBeVisible();
});

test('slice 7: Enter takes the first result, every control has a label, and focus goes search, results, switch', async ({
  popup,
  spoofer,
}) => {
  await popup.getByLabel('Search Cities').fill('tok');
  await popup.getByLabel('Search Cities').press('Enter');

  await expect.poll(async () => (await spoofer.status()).cityId).toBe('tokyo');

  // Only Tokyo answers to its whole name, so the row between the search box and the switch is one.
  await popup.getByLabel('Search Cities').fill('tokyo');
  await expect(popup.getByRole('button', { name: 'Tokyo, Japan' })).toBeVisible();

  // Every control a person can reach answers to a name, or a screen reader announces nothing.
  for (const control of await popup.locator('input:visible, button:visible').all()) {
    await expect(control).toHaveAccessibleName(/\S/);
  }

  await popup.getByLabel('Search Cities').focus();
  await popup.keyboard.press('Tab');
  await expect(popup.getByRole('button', { name: 'Tokyo, Japan' })).toBeFocused();
  await popup.keyboard.press('Tab');
  await expect(popup.getByLabel('Enabled')).toBeFocused();
});
