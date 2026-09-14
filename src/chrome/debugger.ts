// Interface: the only seam onto chrome.debugger, and the only place in this repo a protocol method
// is named. Callers ask for an override, never for a method.
//   attach(tabId)               -> resolves once this extension owns the tab's session
//   detach(tabId)               -> gives the session up, which hands both overrides back
//   setTimezone(target, zone)   -> that session's renderer process observes the zone
//   setGeolocation(tabId, pos)  -> the whole tab observes the position; tab sessions only, because
//                                  the position lives on the tab, not on the renderer
//   autoAttach(target)          -> that session reports its child targets and pauses them at start
//   resume(target)              -> releases a child paused at start
//   onDetach(fn)                -> fn runs with the tab id and Chrome's reason
//   onChildAttached(fn)         -> fn runs when a session's child target starts and waits for us
//   onChildDetached(fn)         -> fn runs when a child session goes away
// Invariants: the four sending methods are exactly the four the brief always allows, so a forbidden
// one (any domain's `enable`, any `Debugger.*` method, `Emulation.setAutomationOverride`) has
// nowhere to be written. The fifth the brief permits conditionally stays absent: phase 04's detach
// slice measured that detaching alone hands the tab back the same answer a browser with no
// extension gives, so Emulation.clearGeolocationOverride is never needed.
// Ordering: attach before anything else. For a child session: setTimezone and autoAttach, then
// resume, because a resumed child cannot be configured any more.
// Errors: every call rejects with Chrome's message ("Cannot access a chrome:// URL", "Another
// debugger is already attached to the tab with id: N", "Timezone override is already in effect").
// The caller records the message; it never retries in a tight loop.

// A tab session when sessionId is absent, one of its flattened children when it is present.
export type SessionTarget = { tabId: number; sessionId?: string };

export type Coordinates = { latitude: number; longitude: number; accuracy: number };

export type DebuggerAdapter = {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  setTimezone(target: SessionTarget, zone: string): Promise<void>;
  setGeolocation(tabId: number, coordinates: Coordinates): Promise<void>;
  autoAttach(target: SessionTarget): Promise<void>;
  resume(target: SessionTarget): Promise<void>;
  onDetach(listener: (tabId: number, reason: string) => void): void;
  onChildAttached(listener: (tabId: number, sessionId: string) => void): void;
  onChildDetached(listener: (tabId: number, sessionId: string) => void): void;
};

// The protocol version chrome.debugger requires at attach, not a CDP method.
const PROTOCOL_VERSION = '1.3';

// Flattened child sessions landed in Chrome 125; @types/chrome still types Debuggee without them.
type FlatSession = chrome.debugger.Debuggee & { sessionId?: string };

export const chromeDebugger: DebuggerAdapter = {
  async attach(tabId) {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  },
  async detach(tabId) {
    await chrome.debugger.detach({ tabId });
  },
  async setTimezone(target, zone) {
    await send(target, 'Emulation.setTimezoneOverride', { timezoneId: zone });
  },
  async setGeolocation(tabId, coordinates) {
    // Only these three, so altitude, altitudeAccuracy, heading and speed read null as they do
    // without the extension.
    await send({ tabId }, 'Emulation.setGeolocationOverride', coordinates);
  },
  async autoAttach(target) {
    // Not recursive: every child needs this call of its own before it is resumed.
    await send(target, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  },
  async resume(target) {
    await send(target, 'Runtime.runIfWaitingForDebugger');
  },
  onDetach(listener) {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined) listener(source.tabId, reason);
    });
  },
  onChildAttached(listener) {
    // A child's arrival is reported on the root session, with the child's own id in the body.
    onEvent('Target.attachedToTarget', (tabId, params) => {
      const body = params as { sessionId?: string };
      if (body.sessionId) listener(tabId, body.sessionId);
    });
  },
  onChildDetached(listener) {
    onEvent('Target.detachedFromTarget', (tabId, params) => {
      const body = params as { sessionId?: string };
      if (body.sessionId) listener(tabId, body.sessionId);
    });
  },
};

function onEvent(wanted: string, listener: (tabId: number, params: object) => void): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === wanted && source.tabId !== undefined && params) listener(source.tabId, params);
  });
}

async function send(target: SessionTarget, method: string, params?: object): Promise<void> {
  const session: FlatSession = { tabId: target.tabId, sessionId: target.sessionId };
  try {
    await chrome.debugger.sendCommand(session, method, params);
  } catch (error) {
    throw new Error(protocolMessage(error));
  }
}

// A refused command rejects with the whole protocol error as JSON. The caller shows this to the
// user, so unwrap it to the sentence Chrome wrote.
function protocolMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed: unknown = JSON.parse(raw);
    const message = (parsed as { message?: unknown } | null)?.message;
    return typeof message === 'string' ? message : raw;
  } catch {
    return raw;
  }
}
