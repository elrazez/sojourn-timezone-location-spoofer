// Interface: the service worker. It has no callers, so its interface is what it wires together:
// storage changes, tab creation and removal, and worker start all become Coverage events, and every
// event is folded, reconciled, and run in one serialised queue so two events cannot command the same
// tab twice. It re-derives state on start, which is what makes a worker restart invisible.
// Errors: a failed send is recorded as not-covered inside Coverage and never thrown here.

import { chromeDebugger } from './chrome/debugger.js';
import { chromeStorage } from './chrome/storage.js';
import { chromeTabs } from './chrome/tabs.js';
import { NO_COVERAGE, reconcile, reduce, runCommands, type CoverageEvent } from './coverage.js';
import { loadSelection, selectCity } from './settings.js';

let state = NO_COVERAGE;
let queue: Promise<void> = Promise.resolve();

function dispatch(...events: CoverageEvent[]): Promise<void> {
  queue = queue.then(() => step(events));
  return queue;
}

async function step(events: readonly CoverageEvent[]): Promise<void> {
  for (const event of events) state = reduce(state, event);
  const commands = reconcile(state);
  if (commands.length > 0) await step(await runCommands(commands, chromeDebugger));
}

async function rederive(): Promise<void> {
  const [selection, tabIds] = await Promise.all([loadSelection(chromeStorage), chromeTabs.listIds()]);
  await dispatch({ type: 'selection', selection }, { type: 'tabs-open', tabIds });
}

chromeStorage.onChange(() => void rederive());
chromeTabs.onCreated((tabId) => void dispatch({ type: 'tab-opened', tabId }));
chromeTabs.onRemoved((tabId) => void dispatch({ type: 'tab-closed', tabId }));
chromeDebugger.onDetach((tabId, reason) => void dispatch({ type: 'not-covered', tabId, error: reason }));

void rederive();

// The e2e fixture makes a real Selection through Settings from here; a service worker global is
// reachable only by an extension context, never by a page.
// ponytail: the fixture's only way in, so it ships; drop it once the popup can drive a Selection.
Object.assign(globalThis, {
  spoofer: { selectCity: (cityId: string) => selectCity(chromeStorage, cityId) },
});
