import { expect, test } from 'vitest';
import type { StorageAdapter } from '../../src/chrome/storage.js';
import { loadSelection, selectCity } from '../../src/settings.js';

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

test('with nothing stored there is no Selection', async () => {
  expect(await loadSelection(fakeStorage())).toBeNull();
});

test('a Selection reads back as the City that was selected', async () => {
  const storage = fakeStorage();
  await selectCity(storage, 'tokyo');

  expect(await loadSelection(storage)).toEqual({ cityId: 'tokyo' });
});

test('selecting a City the Catalog does not have is refused', async () => {
  await expect(selectCity(fakeStorage(), 'atlantis')).rejects.toThrow('atlantis');
});
