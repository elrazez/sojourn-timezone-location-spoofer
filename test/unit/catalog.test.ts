import { expect, test } from 'vitest';
import { CITIES, getCity, searchCities } from '../../src/catalog.js';

// Written from memory as an independent oracle, deliberately not copied from the Catalog.
const WELL_KNOWN: ReadonlyArray<[string, number, number]> = [
  ['tokyo', 35.69, 139.69],
  ['london', 51.51, -0.13],
  ['new-york', 40.71, -74.01],
  ['paris', 48.86, 2.35],
  ['sydney', -33.87, 151.21],
  ['sao-paulo', -23.55, -46.63],
  ['cairo', 30.04, 31.24],
  ['moscow', 55.75, 37.62],
  ['mexico-city', 19.43, -99.13],
  ['mumbai', 19.08, 72.88],
];

test('getCity returns Tokyo with the zone Asia/Tokyo', () => {
  expect(getCity('tokyo')).toMatchObject({ name: 'Tokyo', country: 'Japan', zone: 'Asia/Tokyo' });
});

test('getCity returns nothing for an id no City has', () => {
  expect(getCity('atlantis')).toBeUndefined();
});

test('searchCities finds Tokyo by a prefix and finds nothing for a miss', () => {
  expect(searchCities('tok').map((city) => city.id)).toContain('tokyo');
  expect(searchCities('zzz')).toEqual([]);
});

test('every City zone is the IANA id Intl reads back', () => {
  for (const city of CITIES) {
    const readBack = new Intl.DateTimeFormat(undefined, { timeZone: city.zone }).resolvedOptions().timeZone;
    expect(readBack, city.id).toBe(city.zone);
  }
});

test('every City id is unique', () => {
  expect(new Set(CITIES.map((city) => city.id)).size).toBe(CITIES.length);
});

test('every City coordinate is on the globe', () => {
  for (const city of CITIES) {
    expect(Math.abs(city.latitude), city.id).toBeLessThanOrEqual(90);
    expect(Math.abs(city.longitude), city.id).toBeLessThanOrEqual(180);
  }
});

test('ten well-known Cities sit within half a degree of their known coordinates', () => {
  for (const [id, latitude, longitude] of WELL_KNOWN) {
    const city = getCity(id);
    expect(city, id).toBeDefined();
    expect(Math.abs(city!.latitude - latitude), id).toBeLessThan(0.5);
    expect(Math.abs(city!.longitude - longitude), id).toBeLessThan(0.5);
  }
});
