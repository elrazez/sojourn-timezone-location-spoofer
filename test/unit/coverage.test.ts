// The Coverage reducer seam: an event list in, the commands it issues and the status it exposes
// out. Every expected command and count is a literal written here, never read back from the code.

import { expect, test } from 'vitest';
import { nextTick } from '../../src/coverage.js';
import { world, type WorldOptions } from './fakes.js';

// Tokyo is UTC+9 all year; the Catalog is the real one, so this is the zone a page reads back.
const TOKYO = 'Asia/Tokyo';
const LOS_ANGELES = 'America/Los_Angeles';
const ALERT = '#d93025';
const OFF = '#5f6368';

const started = (options: WorldOptions) => {
  const it = world(options);
  it.apply({ type: 'settings-changed' });
  return it;
};

const covering = (cityId: string, tabIds: number[], options: WorldOptions = {}) =>
  started({
    stored: { selection: { cityId }, enabled: true, ...options.stored },
    tabs: tabIds.map((id) => ({ id, loading: false })),
    ...options,
  });

test('scenario 1: the happy path covers the tab, then its frame and its worker', async () => {
  const it = covering('tokyo', [1]);

  // The badge waits for a round with nothing else in it, so no tab's Override queues behind it.
  expect(await it.settle()).toEqual([
    { type: 'rederive' },
    { type: 'attach', tabId: 1 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
    { type: 'badge', text: '', color: ALERT },
  ]);
  expect(it.status().covered).toBe(1);

  it.apply({ type: 'child-attached', tabId: 1, sessionId: 'frame' });
  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1, sessionId: 'frame' }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1, sessionId: 'frame' } },
    { type: 'resume', target: { tabId: 1, sessionId: 'frame' } },
  ]);

  it.apply({ type: 'child-attached', tabId: 1, sessionId: 'worker' });
  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1, sessionId: 'worker' }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1, sessionId: 'worker' } },
    { type: 'resume', target: { tabId: 1, sessionId: 'worker' } },
  ]);

  // Every tick re-sends the zone to every session, which is what retakes a renderer that lost it.
  it.apply({ type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'zone', target: { tabId: 1, sessionId: 'frame' }, zone: TOKYO },
    { type: 'zone', target: { tabId: 1, sessionId: 'worker' }, zone: TOKYO },
  ]);
  expect(it.status()).toEqual({
    enabled: true,
    paused: false,
    selected: true,
    covered: 1,
    pending: 0,
    restricted: 0,
    notCovered: [],
    badge: { text: '', color: ALERT },
    // Three sessions on the first pass and the same three again on the tick.
    zoneSends: 6,
  });
});

test('scenario 7: a tab closed while it is still attaching does not come back', async () => {
  const it = covering('tokyo', []);
  await it.settle();

  it.apply({ type: 'tab-created', tabId: 1 }, { type: 'tab-removed', tabId: 1 });
  // The attach was in flight when the tab went, so its answer arrives about a tab that is gone.
  it.apply({ type: 'attached', tabId: 1 });

  expect(await it.settle()).toEqual([]);
  expect(it.status().covered).toBe(0);
  expect(it.status().pending).toBe(0);
});

test('scenario 10: with no Selection nothing attaches and no bar appears', async () => {
  const it = started({ stored: { enabled: true }, tabs: [{ id: 1, loading: false }, { id: 2, loading: false }] });

  expect(await it.settle()).toEqual([{ type: 'rederive' }, { type: 'badge', text: '', color: ALERT }]);

  it.apply({ type: 'tab-created', tabId: 3 }, { type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([]);
  // No tab is due the Override, so no tab is Covered, Not Covered or Pending.
  expect(it.status()).toEqual({
    enabled: true,
    paused: false,
    selected: false,
    covered: 0,
    pending: 0,
    restricted: 0,
    notCovered: [],
    badge: { text: '', color: ALERT },
    zoneSends: 0,
  });
});

test('scenario 2: Cancel pauses every tab, and only Resume brings them back', async () => {
  const it = covering('tokyo', [1, 2]);
  await it.settle();
  expect(it.status().covered).toBe(2);

  it.apply(
    { type: 'detached', tabId: 1, reason: 'canceled_by_user' },
    { type: 'detached', tabId: 2, reason: 'canceled_by_user' },
  );
  expect(await it.settle()).toEqual([
    { type: 'badge', text: 'OFF', color: OFF },
    { type: 'remember-paused', paused: true },
  ]);

  // A second passes and Spoofer still does not attach on its own.
  it.apply({ type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([]);
  expect(it.status().covered).toBe(0);
  expect(it.status().paused).toBe(true);

  it.apply({ type: 'resumed' });
  expect(await it.settle()).toEqual([
    { type: 'attach', tabId: 1 },
    { type: 'attach', tabId: 2 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
    { type: 'zone', target: { tabId: 2 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 2 } },
    { type: 'badge', text: '', color: ALERT },
    { type: 'remember-paused', paused: false },
  ]);
  expect(it.status().covered).toBe(2);
  // Paused belongs to the session area, which a browser restart clears, and the Selection to local.
  expect(it.areas()).toEqual({
    local: { selection: { cityId: 'tokyo' }, enabled: true },
    session: { paused: false },
  });
});

test('scenario 3: Disabled detaches all three tabs, Enabled covers them again', async () => {
  const it = covering('tokyo', [1, 2, 3]);
  await it.settle();

  it.apply({ type: 'derived', selection: { cityId: 'tokyo' }, enabled: false, paused: false, tabs: tabs([1, 2, 3]) });
  expect(await it.settle()).toEqual([
    { type: 'detach', tabId: 1 },
    { type: 'detach', tabId: 2 },
    { type: 'detach', tabId: 3 },
    { type: 'badge', text: 'OFF', color: OFF },
  ]);
  expect(it.status().covered).toBe(0);

  it.apply({ type: 'derived', selection: { cityId: 'tokyo' }, enabled: true, paused: false, tabs: tabs([1, 2, 3]) });
  expect(await it.settle()).toEqual([
    { type: 'attach', tabId: 1 },
    { type: 'attach', tabId: 2 },
    { type: 'attach', tabId: 3 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
    { type: 'zone', target: { tabId: 2 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 2 } },
    { type: 'zone', target: { tabId: 3 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 3 } },
    { type: 'badge', text: '', color: ALERT },
  ]);
  expect(it.status().covered).toBe(3);
});

test('scenario 5: a worker restart finds the sessions it already holds and keeps them Covered', async () => {
  const it = covering('tokyo', [1, 2]);
  it.refuse(
    { command: 'attach', tabId: 1, error: 'Another debugger is already attached to the tab with id: 1.' },
    { command: 'attach', tabId: 2, error: 'Another debugger is already attached to the tab with id: 2.' },
  );

  expect(await it.settle()).toEqual([
    { type: 'rederive' },
    { type: 'attach', tabId: 1 },
    { type: 'attach', tabId: 2 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
    { type: 'zone', target: { tabId: 2 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 2 } },
    { type: 'badge', text: '', color: ALERT },
  ]);
  expect(it.status().covered).toBe(2);
  expect(it.zoneOf({ tabId: 1 })).toBe(TOKYO);
});

test('a tab another client held at worker start is attached again once that client has gone', async () => {
  const it = covering('tokyo', [1]);
  // Chrome answers the attach with the sentence that means the session is already this extension's,
  // but the sends then land nowhere, which is how a rival client holding the tab looks from here.
  it.refuse(
    { command: 'attach', error: 'Another debugger is already attached to the tab with id: 1.' },
    { command: 'zone', error: 'Debugger is not attached to the tab with id: 1.' },
  );

  expect(await it.settle()).toEqual([
    { type: 'rederive' },
    { type: 'attach', tabId: 1 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
    { type: 'badge', text: '1', color: ALERT },
  ]);
  expect(it.status().notCovered).toEqual([
    { tabId: 1, reason: 'Debugger is not attached to the tab with id: 1.' },
  ]);

  // The rival lets go, and the next tick is what finds out.
  it.allow('attach');
  it.allow('zone');
  it.apply({ type: 'tick', now: 1000 });

  expect(await it.settle()).toEqual([
    { type: 'attach', tabId: 1 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
    { type: 'badge', text: '', color: ALERT },
  ]);
  expect(it.status().covered).toBe(1);
});

test('scenario 4: a City change that clashes in a shared renderer lands on the next tick', async () => {
  const it = covering('tokyo', [1, 2, 3]);
  await it.settle();

  // Tab 2 does not hold its renderer's zone, so Chrome refuses it until the holder has moved.
  it.refuse({ command: 'zone', tabId: 2, error: 'Timezone override is already in effect' });
  it.apply({ type: 'derived', selection: { cityId: 'los-angeles' }, enabled: true, paused: false, tabs: tabs([1, 2, 3]) });

  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1 }, zone: LOS_ANGELES },
    { type: 'zone', target: { tabId: 2 }, zone: LOS_ANGELES },
    { type: 'zone', target: { tabId: 3 }, zone: LOS_ANGELES },
    { type: 'badge', text: '1', color: ALERT },
  ]);
  expect(it.status().notCovered).toEqual([{ tabId: 2, reason: 'Timezone override is already in effect' }]);

  it.allow('zone');
  it.apply({ type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1 }, zone: LOS_ANGELES },
    { type: 'zone', target: { tabId: 2 }, zone: LOS_ANGELES },
    { type: 'zone', target: { tabId: 3 }, zone: LOS_ANGELES },
    { type: 'badge', text: '', color: ALERT },
  ]);
  expect(it.status().covered).toBe(3);
});

test('scenario 6: a zone another client holds leaves the tab Not Covered and on the badge', async () => {
  const it = covering('tokyo', [1]);
  it.refuse({ command: 'zone', error: 'Timezone override is already in effect' });

  await it.settle();
  expect(it.status().notCovered).toEqual([{ tabId: 1, reason: 'Timezone override is already in effect' }]);
  expect(it.status().badge).toEqual({ text: '1', color: ALERT });

  it.apply({ type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([{ type: 'zone', target: { tabId: 1 }, zone: TOKYO }]);
  expect(it.status().covered).toBe(0);
});

test('scenario 8: when a shared renderer loses the tab that owned its zone, the rest re-send', async () => {
  const it = covering('tokyo', [1, 2]);
  await it.settle();

  // Closing tab 1 releases the override for the whole renderer process, with no event to say so.
  it.apply({ type: 'tab-removed', tabId: 1 });

  expect(await it.settle()).toEqual([{ type: 'zone', target: { tabId: 2 }, zone: TOKYO }]);
  expect(it.status().covered).toBe(1);
});

test('scenario 9: a tab that navigates somewhere forbidden is Restricted, and covered again after', async () => {
  const it = covering('tokyo', [1]);
  await it.settle();

  it.refuse({ command: 'attach', error: 'Cannot access a chrome:// URL' });
  it.apply({ type: 'detached', tabId: 1, reason: 'target_closed' });

  expect(await it.settle()).toEqual([{ type: 'attach', tabId: 1 }]);
  expect(it.status()).toMatchObject({ covered: 0, restricted: 1, notCovered: [], badge: { text: '', color: ALERT } });

  it.allow('attach');
  it.apply({ type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([
    { type: 'attach', tabId: 1 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
  ]);
  expect(it.status().covered).toBe(1);
});

test('a file page that cannot be attached counts on the badge once it has finished loading', async () => {
  const it = covering('tokyo', [1]);
  it.refuse({ command: 'attach', error: 'Cannot navigate to a file URL without local file access.' });
  await it.settle();

  expect(it.status()).toMatchObject({
    restricted: 0,
    notCovered: [{ tabId: 1, reason: 'Cannot navigate to a file URL without local file access.' }],
    badge: { text: '1', color: ALERT },
  });
});

test('a tab that is still loading is Pending, never counted against Spoofer', async () => {
  const it = started({ stored: { selection: { cityId: 'tokyo' }, enabled: true }, tabs: [{ id: 1, loading: true }] });
  it.refuse({ command: 'attach', error: 'Cannot attach to this target.' });
  await it.settle();

  // The popup and the badge have to agree: neither counts a tab that has not finished loading.
  expect(it.status()).toMatchObject({ pending: 1, notCovered: [], badge: { text: '', color: ALERT } });

  it.apply({ type: 'tab-status', tabId: 1, loading: false });
  await it.settle();
  expect(it.status()).toMatchObject({
    pending: 0,
    notCovered: [{ tabId: 1, reason: 'Cannot attach to this target.' }],
    badge: { text: '1', color: ALERT },
  });
});

test('switching Enabled back on is the other way out of Paused', async () => {
  const it = covering('tokyo', [1]);
  await it.settle();

  it.apply({ type: 'detached', tabId: 1, reason: 'canceled_by_user' });
  await it.settle();
  expect(it.status().paused).toBe(true);

  // Paused was written down, so it comes back on every read until the switch clears it.
  it.apply({ type: 'derived', selection: { cityId: 'tokyo' }, enabled: false, paused: true, tabs: tabs([1]) });
  expect(it.status().paused).toBe(true);

  it.apply({ type: 'derived', selection: { cityId: 'tokyo' }, enabled: true, paused: true, tabs: tabs([1]) });
  expect(it.status().paused).toBe(false);
  expect(await it.settle()).toEqual([
    { type: 'attach', tabId: 1 },
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1 } },
    { type: 'badge', text: '', color: ALERT },
    { type: 'remember-paused', paused: false },
  ]);
  expect(it.status().covered).toBe(1);
});

test('a re-derive that fails is recorded and asked for again on the next tick', async () => {
  const it = started({ storageFails: 'Storage is unavailable' });

  expect(await it.settle()).toEqual([{ type: 'rederive' }]);
  expect(it.status().error).toBe('Storage is unavailable');

  it.apply({ type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([{ type: 'rederive' }]);
});

function tabs(ids: number[]) {
  return ids.map((id) => ({ id, loading: false }));
}

test('the position goes to the tab and not to the contexts inside it, and refreshes on the refresh rule', async () => {
  const near = { latitude: 35.68, longitude: 139.65, accuracy: 42 };
  const it = started({
    stored: { selection: { cityId: 'tokyo', coordinates: near }, enabled: true },
    tabs: [{ id: 1, loading: false }],
  });
  await it.settle();

  it.apply({ type: 'child-attached', tabId: 1, sessionId: 'frame' });
  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1, sessionId: 'frame' }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1, sessionId: 'frame' } },
    { type: 'resume', target: { tabId: 1, sessionId: 'frame' } },
  ]);

  // A new document in the tab is due the position again.
  it.apply({ type: 'tab-status', tabId: 1, loading: true });
  expect(await it.settle()).toEqual([{ type: 'geolocation', tabId: 1, coordinates: near }]);

  // A tick inside the refresh window re-sends the zone and leaves the position alone.
  it.apply({ type: 'tick', now: 1000 });
  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1 }, zone: TOKYO },
    { type: 'zone', target: { tabId: 1, sessionId: 'frame' }, zone: TOKYO },
  ]);

  it.apply({ type: 'tick', now: 31_000 });
  expect(await it.settle()).toContainEqual({ type: 'geolocation', tabId: 1, coordinates: near });
});

test('the next tick comes fast while a tab is loading and unattached, and is bounded', async () => {
  const it = covering('tokyo', []);
  await it.settle();
  expect(nextTick(it.state())).toBe(1000);

  it.refuse({ command: 'attach', error: 'Cannot access a chrome:// URL' });
  it.apply({ type: 'tab-created', tabId: 1 });
  await it.settle();
  expect(nextTick(it.state())).toBe(20);

  // A tab that has been loading for half a minute is wedged, not worth polling twenty times a second.
  it.apply({ type: 'tick', now: 30_000 });
  expect(nextTick(it.state())).toBe(1000);
});

test('a child whose zone is refused is still released, and the refusal is its last send result', async () => {
  const it = covering('tokyo', [1]);
  await it.settle();

  it.refuse({ command: 'zone', sessionId: 'frame', error: 'Timezone override is already in effect' });
  it.apply({ type: 'child-attached', tabId: 1, sessionId: 'frame' });

  // The resume goes out whatever the zone answered: a child left paused never runs at all.
  expect(await it.settle()).toEqual([
    { type: 'zone', target: { tabId: 1, sessionId: 'frame' }, zone: TOKYO },
    { type: 'auto-attach', target: { tabId: 1, sessionId: 'frame' } },
    { type: 'resume', target: { tabId: 1, sessionId: 'frame' } },
    { type: 'badge', text: '1', color: ALERT },
  ]);
  expect(it.status().notCovered).toEqual([
    { tabId: 1, reason: 'Timezone override is already in effect' },
  ]);
});
