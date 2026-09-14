// Interface: the Selection, loaded and saved through a storage adapter.
//   loadSelection(storage)      -> the stored Selection, or null when the user has picked no City
//   selectCity(storage, cityId) -> persists and returns the new Selection; rejects when the id is
//                                  not in the Catalog
// Invariants: there is at most one Selection. It carries the City id alone for now; the Jitter and
// the Accuracy that CONTEXT.md gives a Selection are generated here in phase 04, and Enabled and
// Paused are stored here once something can set them.
// Change notification is the storage adapter's onChange; Settings does not wrap it.

import { getCity } from './catalog.js';
import type { StorageAdapter } from './chrome/storage.js';

export type Selection = { cityId: string };

const SELECTION_KEY = 'selection';

export async function loadSelection(storage: StorageAdapter): Promise<Selection | null> {
  const stored = await storage.get(SELECTION_KEY);
  return isSelection(stored) ? stored : null;
}

export async function selectCity(storage: StorageAdapter, cityId: string): Promise<Selection> {
  if (!getCity(cityId)) throw new Error(`No City with id ${cityId}`);
  const selection: Selection = { cityId };
  await storage.set(SELECTION_KEY, selection);
  return selection;
}

function isSelection(value: unknown): value is Selection {
  return typeof value === 'object' && value !== null && typeof (value as Selection).cityId === 'string';
}
