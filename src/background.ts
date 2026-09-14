// Interface: the service worker. It has no callers, so its interface is what it wires together:
// storage changes, tab events, detaches, child sessions, and a periodic tick all become Coverage
// events, and every event is folded, reconciled, and run in one serialised queue so two events
// cannot command the same tab twice. It re-derives state on start, which is what makes a worker
// restart invisible.
// Errors: a refused attach or send is recorded inside Coverage and shows up in the status it
// exposes. A step that throws anyway is recorded as a failed run and the queue carries on, because
// one bad event must not stop the next.

import { chromeAction } from './chrome/action.js';
import { chromeDebugger } from './chrome/debugger.js';
import { chromeSession, chromeStorage } from './chrome/storage.js';
import { chromeTabs } from './chrome/tabs.js';
import { NO_COVERAGE, nextTick, reduce, settle, status, type Adapters, type CoverageEvent } from './coverage.js';
import { clearSelection, selectCity, setEnabled } from './settings.js';

const adapters: Adapters = {
  debuggerAdapter: chromeDebugger,
  storage: chromeStorage,
  session: chromeSession,
  tabs: chromeTabs,
  action: chromeAction,
};

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
  state = (await settle(state, events, adapters)).state;
}

chromeStorage.onChange(() => void dispatch({ type: 'settings-changed' }));
chromeTabs.onCreated((tabId) => void dispatch({ type: 'tab-created', tabId }));
chromeTabs.onUpdated((tabId, loading) => void dispatch({ type: 'tab-status', tabId, loading }));
chromeTabs.onRemoved((tabId) => void dispatch({ type: 'tab-removed', tabId }));
chromeDebugger.onDetach((tabId, reason) => void dispatch({ type: 'detached', tabId, reason }));
chromeDebugger.onChildAttached((tabId, sessionId) => void dispatch({ type: 'child-attached', tabId, sessionId }));
chromeDebugger.onChildDetached((tabId, sessionId) => void dispatch({ type: 'child-detached', tabId, sessionId }));

// ponytail: a 1 s poll is the whole retry policy, so a failed send or a renderer that lost its
// override to a closing tab is real for up to 1 s; upgrade path is signal-driven bursts.
function tick(): void {
  void dispatch({ type: 'tick', now: Date.now() }).then(() => setTimeout(tick, nextTick(state)));
}
setTimeout(tick, 1000);

void dispatch({ type: 'settings-changed' });

// A service worker global is reachable only by an extension context, never by a page.
// ponytail: the e2e fixture's only way in, so it ships; drop it once the popup can drive Settings.
Object.assign(globalThis, {
  spoofer: {
    selectCity: (cityId: string) => selectCity(chromeStorage, cityId),
    clearSelection: () => clearSelection(chromeStorage),
    setEnabled: (enabled: boolean) => setEnabled(chromeStorage, enabled),
    status: () => status(state),
  },
});
