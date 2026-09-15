// Interface: everything the popup shows, as one pure function of what the service worker reported
// and what the user has typed.
//   view(status, query) -> the strings, the flags and the Catalog rows the DOM paints
// Invariants: every visible word is a CONTEXT.md term, so Paused, Off, Covered, Not Covered and
// Restricted mean here exactly what they mean in the glossary. Nothing is decided in the DOM layer:
// a string that is empty is a line that is not shown.
// Pure: no chrome, no DOM, no state.
// Errors: it never throws. A refusal Chrome words in a sentence this module does not know
// becomes one general line rather than nothing, so a tab that is Not Covered always says so.

import type { CoverageStatus } from './coverage.js';
import { getCity, searchCities, type City } from './catalog.js';

// One City the query matched: what to show, and what to send back when it is chosen.
export type Match = { cityId: string; name: string };

export type View = {
  // The City the Selection names, and nothing at all on a fresh install, which has no City to name.
  selection: string;
  enabled: boolean;
  // Off, Paused, No Selection, or the covered count. One line, because one thing is read first.
  state: string;
  // The Paused notice and its Resume action, which only an Enabled Sojourn can be brought back from.
  paused: boolean;
  restricted: string;
  // The count and why, because a tab that is not Covered has to say so rather than go quiet.
  notCovered: string;
  results: Match[];
  // More Cities matched than the list shows, so the line that says to keep typing is shown.
  more: boolean;
  // The query matched no City, which is a thing to say and not an error.
  empty: boolean;
};

// More rows than this is a list nobody can tab past on the way to the switch.
const MOST_RESULTS = 8;

// Chrome's own words for the refusals a person can act on, against what to tell them instead.
const REASONS: readonly (readonly [string, string])[] = [
  ['Timezone override is already in effect', 'another debugging client holds the time zone'],
  ['Debugger is not attached', 'another debugging client holds the tab'],
  ['Cannot navigate to a file URL', 'Sojourn has no access to local files'],
];

// Every other sentence Chrome can answer with, which are sentences for a protocol and not a person.
const REFUSED = 'Chrome refused the Override';

export function view(status: CoverageStatus, query: string): View {
  const city = status.cityId === null ? undefined : getCity(status.cityId);
  // The Catalog answers an empty query with every City, and a popup that opens on all of them has
  // buried its own search box, so an empty query lists nothing at all.
  const matched = query.trim() === '' ? [] : searchCities(query);
  const found = matched.slice(0, MOST_RESULTS);
  return {
    selection: city ? label(city) : '',
    enabled: status.enabled,
    state: state(status),
    paused: status.enabled && status.paused,
    restricted: status.restricted > 0 ? `${tabs(status.restricted)} Restricted` : '',
    notCovered: status.notCovered.length === 0 ? '' : `${tabs(status.notCovered.length)} Not Covered: ${why(status)}`,
    results: found.map((match) => ({ cityId: match.id, name: label(match) })),
    more: matched.length > MOST_RESULTS,
    empty: query.trim() !== '' && found.length === 0,
  };
}

const label = (city: City): string => `${city.name}, ${city.country}`;

// Every distinct reason, so two tabs refused two ways say both and two refused the same way say it
// once.
function why(status: CoverageStatus): string {
  const reasons = status.notCovered.map(
    (tab) => REASONS.find(([sentence]) => tab.reason.includes(sentence))?.[1] ?? REFUSED,
  );
  return [...new Set(reasons)].join(', ');
}

function state(status: CoverageStatus): string {
  if (!status.enabled) return 'Off';
  if (status.paused) return 'Paused';
  // No Selection means no tab is due the Override, so this says why rather than count nothing.
  if (status.cityId === null) return 'No Selection';
  return `${tabs(status.covered)} Covered`;
}

const tabs = (count: number): string => `${count} ${count === 1 ? 'tab' : 'tabs'}`;
