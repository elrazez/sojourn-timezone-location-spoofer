// The popup's view seam: what the service worker reported plus what the user typed, in; the strings
// and rows the DOM paints, out. Every expected string is written here from CONTEXT.md's words, never
// read back from the code, so a rename in the popup has to be agreed here first.

import { expect, test } from 'vitest';
import type { CoverageStatus } from '../../src/coverage.js';
import { view } from '../../src/popup-view.js';

const ALERT = '#d93025';

// A status with Tokyo selected and nothing wrong in it, which each test then bends one way.
const reported = (bent: Partial<CoverageStatus> = {}): CoverageStatus => ({
  enabled: true,
  paused: false,
  cityId: 'tokyo',
  covered: 0,
  pending: 0,
  restricted: 0,
  notCovered: [],
  badge: { text: '', color: ALERT },
  zoneSends: 0,
  ...bent,
});

test('slice 1: Paused offers Resume, Disabled reads Off and offers neither, and a Restricted tab is not Covered', () => {
  const paused = view(reported({ paused: true }), '');
  expect(paused.state).toBe('Paused');
  expect(paused.paused).toBe(true);

  // Paused survives the switch going off, and while it is off there is nothing to Resume to.
  const off = view(reported({ enabled: false, paused: true }), '');
  expect(off.state).toBe('Off');
  expect(off.paused).toBe(false);

  const covering = view(reported({ covered: 3, restricted: 1 }), '');
  expect(covering.state).toBe('3 tabs Covered');
  expect(covering.restricted).toBe('1 tab Restricted');
  expect(covering.selection).toBe('Tokyo, Japan');

  // A fresh install has no tab due the Override, so it says why rather than counting nothing.
  const fresh = view(reported({ cityId: null }), '');
  expect(fresh.state).toBe('No Selection');
  expect(fresh.selection).toBe('');
});

test('slice 2: tok lists Tokyo first, an empty query lists no City, and a miss is an empty state', () => {
  const found = view(reported(), 'tok');
  expect(found.results[0]).toEqual({ cityId: 'tokyo', name: 'Tokyo, Japan' });
  expect(found.empty).toBe(false);

  // The Catalog answers an empty query with every City, which is not a list to put in a popup.
  expect(view(reported(), '').results).toEqual([]);
  expect(view(reported(), '').empty).toBe(false);

  const missed = view(reported(), 'atlantis');
  expect(missed.results).toEqual([]);
  expect(missed.empty).toBe(true);

  // One letter matches most of the Catalog, and a list nobody can tab past is worse than a short one.
  expect(view(reported(), 'a').results).toHaveLength(8);
});

test('slice 3: a Not Covered tab reads with its reason when Chrome named one, and generically otherwise', () => {
  const named = view(reported({ notCovered: [{ tabId: 1, reason: 'Timezone override is already in effect' }] }), '');
  expect(named.notCovered).toBe('1 tab Not Covered: another debugging client holds the time zone');

  // The sentence Chrome answers a file:// tab with, which Coverage reports as Not Covered and not
  // as Restricted, so this reason is one a person really sees.
  const local = view(
    reported({ notCovered: [{ tabId: 1, reason: 'Cannot navigate to a file URL without local file access.' }] }),
    '',
  );
  expect(local.notCovered).toBe('1 tab Not Covered: Spoofer has no access to local files');

  // The same one tab, refused with a sentence Chrome has many of and a person can do nothing with.
  const strange = view(reported({ notCovered: [{ tabId: 1, reason: 'Xyzzy went wrong' }] }), '');
  expect(strange.notCovered).toBe('1 tab Not Covered: Chrome refused the Override');

  // Two tabs refused two ways say both, and two refused the same way say it once.
  const both = view(
    reported({
      notCovered: [
        { tabId: 1, reason: 'Timezone override is already in effect' },
        { tabId: 2, reason: 'Xyzzy went wrong' },
        { tabId: 3, reason: 'Nothing anyone has seen before' },
      ],
    }),
    '',
  );
  expect(both.notCovered).toBe(
    '3 tabs Not Covered: another debugging client holds the time zone, Chrome refused the Override',
  );

  expect(view(reported(), '').notCovered).toBe('');
});
