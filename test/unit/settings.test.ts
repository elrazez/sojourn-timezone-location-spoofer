import { expect, test } from 'vitest';
import type { StorageAdapter } from '../../src/chrome/storage.js';
import { clearSelection, loadSettings, selectCity, setEnabled } from '../../src/settings.js';

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

test('a Selection reads back as the City that was selected', async () => {
  const storage = fakeStorage();
  await selectCity(storage, 'tokyo');

  expect((await loadSettings(storage)).selection).toEqual({ cityId: 'tokyo' });
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
