// Interface: the popup page. It has no callers, so its interface is what it wires: it asks the
// service worker for the status, paints what popup-view decided about it, and sends back the four
// things a person can do here, which are type, choose a City, move the switch, and press Resume.
// Invariants: the only state it keeps is the query and the last status, so the Selection on screen
// is always the one the service worker reported and never one the popup remembers. It decides
// nothing: every string and every count comes out of view().
// Errors: an unanswered request leaves the last painting up, and the next refresh asks again.

import { chromeMessaging, type Request } from './chrome/messaging.js';
import type { CoverageStatus } from './coverage.js';
import { view, type Match, type View } from './popup-view.js';

// ponytail: the popup asks once a second rather than being told, so a count can be a second stale
// while it is open; upgrade path is the service worker pushing its status after every settle.
const REFRESH = 1000;

const search = element<HTMLInputElement>('search');
const results = element('results');
const empty = element('empty');
const selection = element('selection');
const state = element('state');
const notCovered = element('not-covered');
const restricted = element('restricted');
const paused = element('paused');
const enabled = element<HTMLInputElement>('enabled');

let query = '';
let reported: CoverageStatus | null = null;
let rows = '';

search.addEventListener('input', () => {
  query = search.value;
  repaint();
});

search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !reported) return;
  event.preventDefault();
  const first = view(reported, query).results[0];
  if (first) choose(first.cityId);
});

enabled.addEventListener('change', () => void ask({ type: 'enable', enabled: enabled.checked }));

// One message, and the Coverage reducer in the service worker does the rest.
element('resume').addEventListener('click', () => void ask({ type: 'resume' }));

// A City chosen is a search finished: the rows fold away so the status under them can be read.
function choose(cityId: string): void {
  query = search.value = '';
  void ask({ type: 'select', cityId });
}

async function ask(request: Request): Promise<void> {
  const answer = await chromeMessaging.ask(request);
  if (!answer) return;
  reported = answer;
  repaint();
}

function repaint(): void {
  if (reported) paint(view(reported, query));
}

function paint(next: View): void {
  show(selection, next.selection);
  state.textContent = next.state;
  show(notCovered, next.notCovered);
  show(restricted, next.restricted);
  paused.hidden = !next.paused;
  enabled.checked = next.enabled;
  empty.hidden = !next.empty;
  // The rows are rebuilt only when they changed, because rebuilding them under the refresh would
  // take the focus out of the row the user had just tabbed to.
  const listed = next.results.map((match) => match.cityId).join();
  if (listed === rows) return;
  rows = listed;
  results.replaceChildren(...next.results.map(row));
}

function row(match: Match): HTMLElement {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = match.name;
  button.addEventListener('click', () => choose(match.cityId));
  item.append(button);
  return item;
}

// A line with nothing to say is a line that is not there, rather than an empty gap on the screen.
function show(where: HTMLElement, text: string): void {
  where.textContent = text;
  where.hidden = text === '';
}

function element<E extends HTMLElement = HTMLElement>(id: string): E {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup.html has no #${id}`);
  return found as E;
}

void ask({ type: 'status' });
setInterval(() => void ask({ type: 'status' }), REFRESH);
