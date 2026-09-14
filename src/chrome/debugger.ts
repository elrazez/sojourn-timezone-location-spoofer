// Interface: the only seam onto chrome.debugger, and the only place a protocol method is named.
//   attach(tabId)                -> resolves once this extension owns the tab's session
//   send(tabId, method, params)  -> resolves once the tab session has run the method
//   onDetach(fn)                 -> fn runs with the tab id and Chrome's reason
// Invariants: `method` is typed to the four methods the brief always allows, so a forbidden one
// (any domain's `enable`, any `Debugger.*` method, `Emulation.setAutomationOverride`) cannot
// compile. The fifth method the brief permits conditionally is absent until phase 04's detach slice
// earns it. Ordering: attach before any send.
// Errors: attach and send reject with Chrome's message ("Cannot access a chrome:// URL",
// "Another debugger is already attached to the tab with id: N", "Timezone override is already
// in effect"). The caller records the message; it never retries in a loop.

export type AllowedMethod =
  | 'Emulation.setTimezoneOverride'
  | 'Emulation.setGeolocationOverride'
  | 'Target.setAutoAttach'
  | 'Runtime.runIfWaitingForDebugger';

export type DebuggerAdapter = {
  attach(tabId: number): Promise<void>;
  send(tabId: number, method: AllowedMethod, params?: object): Promise<void>;
  onDetach(listener: (tabId: number, reason: string) => void): void;
};

// The protocol version chrome.debugger requires at attach, not a CDP method.
const PROTOCOL_VERSION = '1.3';

export const chromeDebugger: DebuggerAdapter = {
  async attach(tabId) {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  },
  async send(tabId, method, params) {
    await chrome.debugger.sendCommand({ tabId }, method, params);
  },
  onDetach(listener) {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined) listener(source.tabId, reason);
    });
  },
};
