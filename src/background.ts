// Interface: the service worker. It has no callers, so its interface is what it wires together:
// storage changes, tab creation and removal, detaches, and a periodic tick all become Coverage
// events, and every event is folded, reconciled, and run in one serialised queue so two events
// cannot command the same tab twice. It re-derives state on start, which is what makes a worker
// restart invisible.
// Errors: a failed send is recorded as not-covered inside Coverage. A step that throws anyway is
// recorded as a failed run and the queue carries on, because one bad event must not stop the next.

import { chromeDebugger } from './chrome/debugger.js';
import { chromeStorage } from './chrome/storage.js';
import { chromeTabs } from './chrome/tabs.js';
import {
  NO_COVERAGE,
  reconcile,
  reduce,
  runCommands,
  status,
  type Adapters,
  type CoverageEvent,
} from './coverage.js';
import { selectCity } from './settings.js';

const adapters: Adapters = { debuggerAdapter: chromeDebugger, storage: chromeStorage, tabs: chromeTabs };

let state = NO_COVERAGE;
let queue: Promise<void> = Promise.resolve();

function dispatch(...events: CoverageEvent[]): Promise<void> {
  queue = queue
    .then(() => step(events))
    .catch((error: unknown) => {
      // Recorded rather than rethrown: a rejection here would break the chain for every later
      // event, and the tick re-derives from a failed run on its own.
      state = reduce(state, { type: 'failed', error: error instanceof Error ? error.message : String(error) });
    });
  return queue;
}

async function step(events: readonly CoverageEvent[]): Promise<void> {
  for (const event of events) state = reduce(state, event);
  const commands = reconcile(state);
  if (commands.length > 0) await step(await runCommands(commands, adapters));
}

chromeStorage.onChange(() => void dispatch({ type: 'settings-changed' }));
chromeTabs.onCreated((tabId) => void dispatch({ type: 'tab-opened', tabId }));
chromeTabs.onRemoved((tabId) => void dispatch({ type: 'tab-closed', tabId }));
chromeDebugger.onDetach((tabId, reason) => void dispatch({ type: 'not-covered', tabId, error: reason }));

// ponytail: a 1 s poll is the whole retry policy, so a failed send or a lost shared-process
// override is real for up to 1 s; upgrade path is signal-driven bursts instead of a fixed interval.
setInterval(() => void dispatch({ type: 'tick', now: Date.now() }), 1000);

void dispatch({ type: 'settings-changed' });

// The e2e fixture makes a real Selection through Settings from here and reads the status Coverage
// exposes; a service worker global is reachable only by an extension context, never by a page.
// ponytail: the fixture's only way in, so it ships; drop it once the popup can drive a Selection.
Object.assign(globalThis, {
  spoofer: {
    selectCity: (cityId: string) => selectCity(chromeStorage, cityId),
    status: () => status(state),
  },
});
