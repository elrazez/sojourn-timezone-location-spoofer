import { expect, test } from 'vitest';
import type { StorageAdapter } from '../../src/chrome/storage.js';
import { clearSelection, loadSettings, selectCity, setEnabled } from '../../src/settings.js';
import { metresApart } from '../oracle.js';

// Catalog coordinates, written here so the test does not read them from the code it checks.
const TOKYO = { latitude: 35.6762, longitude: 139.6503 };
const OSAKA = { latitude: 34.6937, longitude: 135.5023 };

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

test('a selected City reports a point within 2 km of it, and never the City itself', async () => {
  // Two hundred draws, because one draw says nothing about where the next one lands.
  for (let draw = 0; draw < 200; draw += 1) {
    const { coordinates } = await selectCity(fakeStorage(), 'tokyo');

    const away = metresApart(TOKYO, coordinates);
    expect(away).toBeGreaterThan(0);
    expect(away).toBeLessThanOrEqual(2000);
    expect(coordinates.accuracy).toBe(Math.round(coordinates.accuracy));
    expect(coordinates.accuracy).toBeGreaterThanOrEqual(20);
    expect(coordinates.accuracy).toBeLessThanOrEqual(100);
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
