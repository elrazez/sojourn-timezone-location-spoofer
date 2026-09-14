// Interface: the Selection and the Enabled switch, loaded and saved through a storage adapter.
//   loadSettings(storage)       -> the stored Selection and switch; a fresh install is Enabled with
//                                  no Selection, which covers nothing and shows no bar
//   selectCity(storage, cityId) -> persists and returns the new Selection; rejects when the id is
//                                  not in the Catalog
//   clearSelection(storage)     -> back to a fresh install's no Selection
//   setEnabled(storage, on)     -> persists the switch
//   loadPaused / savePaused     -> Paused, in session storage, so a worker restart keeps it and a
//                                  browser restart clears it
// Invariants: there is at most one Selection. It carries the City id alone for now; the Jitter and
// the Accuracy that CONTEXT.md gives a Selection arrive in phase 04 as its coordinates.
// Change notification is the storage adapter's onChange; Settings does not wrap it.

import { getCity } from './catalog.js';
import type { Coordinates } from './chrome/debugger.js';
import type { StorageAdapter } from './chrome/storage.js';

export type Selection = { cityId: string; coordinates?: Coordinates };

export type Settings = { selection: Selection | null; enabled: boolean };

const SELECTION_KEY = 'selection';
const ENABLED_KEY = 'enabled';
const PAUSED_KEY = 'paused';

export async function loadSettings(storage: StorageAdapter): Promise<Settings> {
  const [stored, enabled] = await Promise.all([storage.get(SELECTION_KEY), storage.get(ENABLED_KEY)]);
  return { selection: isSelection(stored) ? stored : null, enabled: enabled !== false };
}

export async function selectCity(storage: StorageAdapter, cityId: string): Promise<Selection> {
  if (!getCity(cityId)) throw new Error(`No City with id ${cityId}`);
  const selection: Selection = { cityId };
  await storage.set(SELECTION_KEY, selection);
  return selection;
}

export async function clearSelection(storage: StorageAdapter): Promise<void> {
  await storage.set(SELECTION_KEY, null);
}

export async function setEnabled(storage: StorageAdapter, enabled: boolean): Promise<void> {
  await storage.set(ENABLED_KEY, enabled);
}

export async function loadPaused(session: StorageAdapter): Promise<boolean> {
  return (await session.get(PAUSED_KEY)) === true;
}

export async function savePaused(session: StorageAdapter, paused: boolean): Promise<void> {
  await session.set(PAUSED_KEY, paused);
}

function isSelection(value: unknown): value is Selection {
  return typeof value === 'object' && value !== null && typeof (value as Selection).cityId === 'string';
}
