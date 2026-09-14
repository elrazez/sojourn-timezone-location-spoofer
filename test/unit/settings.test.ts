import { expect, test } from 'vitest';
import type { StorageAdapter } from '../../src/chrome/storage.js';
import { clearSelection, loadSettings, selectCity, setEnabled } from '../../src/settings.js';
import { metresApart } from '../oracle.js';

// Catalog coordinates, written here so the test does not read them from the code it checks.
const TOKYO = { latitude: 35.6762, longitude: 139.6503 };
const OSAKA = { latitude: 34.6937, longitude: 135.5023 };

// cos(35.6762 degrees), written out rather than computed, so the scaling is a literal like the rest.
const TOKYO_COSINE = 0.81234;

function fakeStorage(): StorageAdapter {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    onChange() {},
  };
}

test('with nothing stored there is no Selection and Spoofer is Enabled', async () => {
  expect(await loadSettings(fakeStorage())).toEqual({ selection: null, enabled: true });
});

test('a Selection round-trips exactly, City and coordinates together', async () => {
  const storage = fakeStorage();
  const selection = await selectCity(storage, 'tokyo');

  expect(selection.cityId).toBe('tokyo');
  expect((await loadSettings(storage)).selection).toEqual(selection);
});

test('selecting a City the Catalog does not have is refused', async () => {
  await expect(selectCity(fakeStorage(), 'atlantis')).rejects.toThrow('atlantis');
});

test('a cleared Selection reads back as no Selection', async () => {
  const storage = fakeStorage();
  await selectCity(storage, 'tokyo');
  await clearSelection(storage);

  expect((await loadSettings(storage)).selection).toBeNull();
});

test('the Enabled switch reads back as it was set', async () => {
  const storage = fakeStorage();
  await setEnabled(storage, false);

  expect((await loadSettings(storage)).enabled).toBe(false);
});

// Two hundred draws, because one draw says nothing about where the next one lands, and because the
// shape of two hundred of them is what tells a disc uniform by area from the ways of getting it
// wrong: a radius drawn uniform in length, or a longitude that was never scaled by the latitude.
const DRAWS = 200;

test('a selected City reports a point within 2 km of it, and never the City itself', async () => {
  const points: { latitude: number; longitude: number; away: number }[] = [];
  for (let draw = 0; draw < DRAWS; draw += 1) {
    const { coordinates } = await selectCity(fakeStorage(), 'tokyo');

    const away = metresApart(TOKYO, coordinates);
    expect(away).toBeGreaterThan(0);
    expect(away).toBeLessThanOrEqual(2000);
    expect(coordinates.accuracy).toBe(Math.round(coordinates.accuracy));
    expect(coordinates.accuracy).toBeGreaterThanOrEqual(20);
    expect(coordinates.accuracy).toBeLessThanOrEqual(100);
    points.push({ latitude: coordinates.latitude, longitude: coordinates.longitude, away });
  }

  // Half the radius holds a quarter of the area, so a quarter of the draws belong inside 1000 m.
  // A radius drawn uniform in length would put half of them there.
  const inside = points.filter((point) => point.away <= 1000).length / DRAWS;
  expect(inside).toBeGreaterThanOrEqual(0.15);
  expect(inside).toBeLessThanOrEqual(0.35);

  // The disc has to be as wide east to west as it is north to south on the ground. A degree of
  // longitude at this latitude is only cos(35.6762 degrees) as wide as a degree of latitude, so a
  // point placed on a flat projection comes out about a fifth narrow here, which a factor of 1.5
  // still admits: this bound is the one that catches a gross projection error, and the fraction
  // above is the one that catches a radius drawn uniform in length.
  const northSouth = spread(points.map((point) => point.latitude - TOKYO.latitude));
  const eastWest = spread(points.map((point) => (point.longitude - TOKYO.longitude) * TOKYO_COSINE));
  expect(eastWest / northSouth).toBeGreaterThan(1 / 1.5);
  expect(eastWest / northSouth).toBeLessThan(1.5);
});

// How wide a set of offsets about zero sits: their root mean square, in the units they came in.
function spread(offsets: number[]): number {
  return Math.sqrt(offsets.reduce((sum, offset) => sum + offset * offset, 0) / offsets.length);
}

test('a Selection missing a coordinate is no Selection at all', async () => {
  const half = [
    { cityId: 'tokyo', coordinates: { latitude: 35.68, accuracy: 42 } },
    { cityId: 'tokyo', coordinates: { latitude: 35.68, longitude: 139.65 } },
  ];
  for (const written of half) {
    const storage = fakeStorage();
    await storage.set('selection', written);

    // A tab covered from one of these would report the real position while the popup said Covered.
    expect((await loadSettings(storage)).selection).toBeNull();
  }
});

test('selecting the same City again keeps its point, and another City is given a new one', async () => {
  const storage = fakeStorage();
  const first = await selectCity(storage, 'tokyo');

  expect(await selectCity(storage, 'tokyo')).toEqual(first);

  // A different City is a point near that City, so the Jitter was drawn again and not carried over.
  const elsewhere = await selectCity(storage, 'osaka');
  expect(metresApart(OSAKA, elsewhere.coordinates)).toBeLessThanOrEqual(2000);

  // Coming back is a fresh point, because the Selection that carried the old one is gone.
  expect((await selectCity(storage, 'tokyo')).coordinates).not.toEqual(first.coordinates);

  // The Accuracy is drawn again too: over ten changes of City it cannot stay the one number.
  const accuracies = new Set<number>();
  for (let draw = 0; draw < 10; draw += 1) {
    const swapped = await selectCity(storage, draw % 2 === 0 ? 'osaka' : 'tokyo');
    accuracies.add(swapped.coordinates.accuracy);
  }
  expect(accuracies.size).toBeGreaterThan(1);
});
