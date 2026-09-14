// Interface: the Selection and the Enabled switch, loaded and saved through a storage adapter.
//   loadSettings(storage)       -> the stored Selection and switch; a fresh install is Enabled with
//                                  no Selection, which covers nothing and shows no bar
//   selectCity(storage, cityId) -> persists and returns the new Selection; rejects when the id is
//                                  not in the Catalog
//   clearSelection(storage)     -> back to a fresh install's no Selection
//   setEnabled(storage, on)     -> persists the switch
//   loadPaused / savePaused     -> Paused, in session storage, so a worker restart keeps it and a
//                                  browser restart clears it
// Invariants: there is at most one Selection. It carries the City id and the coordinates every
// context reads: the City's point moved by the Jitter, with the Accuracy beside it. Both are
// generated here and nowhere else, so no two contexts can disagree about them.
// Change notification is the storage adapter's onChange; Settings does not wrap it.

import { getCity, type City } from './catalog.js';
import type { Coordinates } from './chrome/debugger.js';
import type { StorageAdapter } from './chrome/storage.js';

export type Selection = { cityId: string; coordinates: Coordinates };

export type Settings = { selection: Selection | null; enabled: boolean };

const SELECTION_KEY = 'selection';
const ENABLED_KEY = 'enabled';
const PAUSED_KEY = 'paused';

export async function loadSettings(storage: StorageAdapter): Promise<Settings> {
  const [stored, enabled] = await Promise.all([storage.get(SELECTION_KEY), storage.get(ENABLED_KEY)]);
  return { selection: isSelection(stored) ? stored : null, enabled: enabled !== false };
}

export async function selectCity(storage: StorageAdapter, cityId: string): Promise<Selection> {
  const city = getCity(cityId);
  if (!city) throw new Error(`No City with id ${cityId}`);
  // The same City keeps the point it was given: the Jitter tells installs apart, so it must not
  // change under a site that is watching, and only a new City is a new place.
  const stored = await storage.get(SELECTION_KEY);
  const kept = isSelection(stored) && stored.cityId === cityId ? stored.coordinates : undefined;
  const selection: Selection = { cityId, coordinates: kept ?? coordinatesFor(city) };
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

// The Jitter is a point uniform by area over a disc of this radius, so a list of known Spoofer
// coordinates cannot name an install, and every point stays inside the City.
const JITTER_METRES = 2000;

// The Accuracy radius a covered page reports, between a good Wi-Fi fix and a poor one.
const ACCURACY_LEAST = 20;
const ACCURACY_MOST = 100;

// The sphere the Jitter is measured on, the mean Earth radius in metres.
const EARTH_RADIUS = 6371000;

function coordinatesFor(city: City): Coordinates {
  // Uniform by area needs the root of a uniform draw, and 1 - random() is never 0, so the point is
  // never the City itself.
  const distance = JITTER_METRES * Math.sqrt(1 - Math.random());
  const bearing = 2 * Math.PI * Math.random();
  const angle = distance / EARTH_RADIUS;
  const fromLatitude = radians(city.latitude);
  const fromLongitude = radians(city.longitude);
  // The point at that distance and bearing on the sphere, so the great-circle distance is exact.
  const latitude = Math.asin(
    Math.sin(fromLatitude) * Math.cos(angle) + Math.cos(fromLatitude) * Math.sin(angle) * Math.cos(bearing),
  );
  const longitude =
    fromLongitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angle) * Math.cos(fromLatitude),
      Math.cos(angle) - Math.sin(fromLatitude) * Math.sin(latitude),
    );
  return {
    latitude: degrees(latitude),
    longitude: degrees(longitude),
    accuracy: ACCURACY_LEAST + Math.floor(Math.random() * (ACCURACY_MOST - ACCURACY_LEAST + 1)),
  };
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const degrees = (radians: number): number => (radians * 180) / Math.PI;

// A Selection without coordinates is not a Selection: a tab covered from one would report the real
// position while the badge said it was covered, which is the silent fallback the rules forbid.
function isSelection(value: unknown): value is Selection {
  if (typeof value !== 'object' || value === null) return false;
  const selection = value as Selection;
  return typeof selection.cityId === 'string' && typeof selection.coordinates?.latitude === 'number';
}
