// Interface: the service worker. It has no callers, so its interface is what it wires together:
// storage changes, tab events, detaches, child sessions, and a periodic tick all become Coverage
// events, and every event is folded, reconciled, and run in one serialised queue so two events
// cannot command the same tab twice. A tab that has just been created is the one thing that does not
// queue: Coverage covers it on the spot and the queue folds in what came back, because Chrome seals
// Sojourn's New Tab Page against every call 10 to 22 ms after the tab is created and this listener
// hears about the tab 6 to 12 ms into that window. That cycle reads the settings itself when a
// change has just emptied them, so a tab opened right after a City change is covered rather than
// left out. It re-derives state on start, which is what makes a worker restart invisible.
// Errors: a refused attach or send is recorded inside Coverage and shows up in the status it
// exposes. A step that throws anyway is recorded as a failed run and the queue carries on, because
// one bad event must not stop the next.

import { chromeAction } from './chrome/action.js';
import { chromeDebugger } from './chrome/debugger.js';
import { chromeMessaging, type Request } from './chrome/messaging.js';
import { chromeSession, chromeStorage } from './chrome/storage.js';
import { chromeTabs } from './chrome/tabs.js';
import { NO_COVERAGE, cover, nextTick, reduce, settle, status, type Adapters, type CoverageEvent } from './coverage.js';
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
// Paused lives in session storage, so a write there is a change to re-derive from like any other.
chromeSession.onChange(() => void dispatch({ type: 'settings-changed' }));
chromeTabs.onCreated((tabId) => {
  // Ahead of the queue, or Chrome seals the tab before the Override reaches it. A cover that throws
  // still has to report the tab, or nothing would know it exists until the next re-derive.
  void cover(state, tabId, adapters).then(
    (events) => dispatch(...events),
    () => dispatch({ type: 'tab-created', tabId }),
  );
});
chromeTabs.onUpdated((tabId, loading) => void dispatch({ type: 'tab-status', tabId, loading }));
chromeTabs.onRemoved((tabId) => void dispatch({ type: 'tab-removed', tabId }));
chromeDebugger.onDetach((tabId, reason) => void dispatch({ type: 'detached', tabId, reason }));
chromeDebugger.onChildAttached((tabId, sessionId) => void dispatch({ type: 'child-attached', tabId, sessionId }));
chromeDebugger.onChildDetached((tabId, sessionId) => void dispatch({ type: 'child-detached', tabId, sessionId }));

// The popup's one channel in. Every request is answered with the status the request produced, never
// the one before it, so the popup never paints a stale count over a change the user just made.
chromeMessaging.onAsk(async (request) => {
  await act(request);
  return status(state);
});

async function act(request: Request): Promise<void> {
  switch (request.type) {
    case 'status':
      return;
    case 'resume':
      // One message in, and the Coverage reducer does the rest: attach, both Overrides, the badge.
      return dispatch({ type: 'resumed' });
    case 'select':
      await selectCity(chromeStorage, request.cityId);
      break;
    case 'enable':
      await setEnabled(chromeStorage, request.enabled);
      break;
  }
  // The storage listener hears this write too; dispatching here is what makes the answer the new
  // status rather than a race with it.
  await dispatch({ type: 'settings-changed' });
}

// ponytail: a 1 s poll is the whole retry policy, so a failed send or a renderer that lost its
// override to a closing tab is real for up to 1 s; upgrade path is signal-driven bursts.
function tick(): void {
  void dispatch({ type: 'tick', now: Date.now() }).then(() => setTimeout(tick, nextTick(state)));
}
setTimeout(tick, 1000);

void dispatch({ type: 'settings-changed' });

// A service worker global is reachable only by an extension context, never by a page.
// ponytail: the harness's way to drive Settings without opening the popup, which is what keeps the
// time zone and geolocation suites off the user interface; drop it if those ever drive the popup.
Object.assign(globalThis, {
  sojourn: {
    selectCity: (cityId: string) => selectCity(chromeStorage, cityId),
    clearSelection: () => clearSelection(chromeStorage),
    setEnabled: (enabled: boolean) => setEnabled(chromeStorage, enabled),
    status: () => status(state),
  },
});
