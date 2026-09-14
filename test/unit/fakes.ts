// In-memory stand-ins for the Chrome adapters, the only things these tests fake, plus the loop the
// service worker runs over them: reduce every event, reconcile, run, reduce what came back.

import type { ActionAdapter } from '../../src/chrome/action.js';
import type { DebuggerAdapter, SessionTarget } from '../../src/chrome/debugger.js';
import type { StorageAdapter } from '../../src/chrome/storage.js';
import type { TabsAdapter, TabState } from '../../src/chrome/tabs.js';
import {
  NO_COVERAGE,
  reduce,
  settle as settleCoverage,
  status,
  type Adapters,
  type Command,
  type CoverageEvent,
  type CoverageState,
} from '../../src/coverage.js';

// What the fake browser answers with instead of doing the thing, keyed by command and target.
export type Refusal = { command: Command['type']; tabId?: number; sessionId?: string; error: string };

export type World = {
  apply(...events: CoverageEvent[]): void;
  settle(): Promise<Command[]>;
  refuse(...refusals: Refusal[]): void;
  allow(command: Command['type']): void;
  status(): ReturnType<typeof status>;
  state(): CoverageState;
  zoneOf(target: SessionTarget): string | undefined;
  // The two storage areas apart, so a test can say which one a value was written to.
  areas(): { local: Record<string, unknown>; session: Record<string, unknown> };
};

export type WorldOptions = {
  stored?: Record<string, unknown>;
  tabs?: TabState[];
  storageFails?: string;
};

export function world(options: WorldOptions = {}): World {
  let state = NO_COVERAGE;
  let refusals: Refusal[] = [];
  const zones = new Map<string, string>();
  const local = new Map<string, unknown>(Object.entries(options.stored ?? {}));
  const session = new Map<string, unknown>();

  const refusalFor = (command: Command['type'], target: SessionTarget): string | undefined =>
    refusals.find(
      (r) =>
        r.command === command &&
        (r.tabId === undefined || r.tabId === target.tabId) &&
        (r.sessionId === undefined || r.sessionId === target.sessionId),
    )?.error;

  const refuseIf = async (command: Command['type'], target: SessionTarget): Promise<void> => {
    const error = refusalFor(command, target);
    if (error !== undefined) throw new Error(error);
  };

  const debuggerAdapter: DebuggerAdapter = {
    async attach(tabId) {
      await refuseIf('attach', { tabId });
    },
    async detach(tabId) {
      await refuseIf('detach', { tabId });
    },
    async setTimezone(target, zone) {
      await refuseIf('zone', target);
      zones.set(key(target), zone);
    },
    async setPosition(tabId) {
      await refuseIf('geolocation', { tabId });
    },
    async autoAttach(target) {
      await refuseIf('auto-attach', target);
    },
    async resume(target) {
      await refuseIf('resume', target);
    },
    onDetach() {},
    onChildAttached() {},
    onChildDetached() {},
  };

  const area = (values: Map<string, unknown>): StorageAdapter => ({
    async get(storageKey) {
      if (options.storageFails) throw new Error(options.storageFails);
      return values.get(storageKey);
    },
    async set(storageKey, value) {
      if (options.storageFails) throw new Error(options.storageFails);
      values.set(storageKey, value);
    },
    onChange() {},
  });

  const tabs: TabsAdapter = {
    async list() {
      return [...(options.tabs ?? [])];
    },
    onCreated() {},
    onUpdated() {},
    onRemoved() {},
  };

  const action: ActionAdapter = { async setBadge() {} };

  const adapters: Adapters = {
    debuggerAdapter,
    storage: area(local),
    session: area(session),
    tabs,
    action,
  };

  return {
    apply(...events) {
      for (const event of events) state = reduce(state, event);
    },
    async settle() {
      const settled = await settleCoverage(state, [], adapters);
      state = settled.state;
      return settled.commands;
    },
    refuse(...next) {
      refusals.push(...next);
    },
    allow(command) {
      refusals = refusals.filter((r) => r.command !== command);
    },
    status: () => status(state),
    state: () => state,
    zoneOf: (target) => zones.get(key(target)),
    areas: () => ({ local: Object.fromEntries(local), session: Object.fromEntries(session) }),
  };
}

function key(target: SessionTarget): string {
  return target.sessionId ? `${target.tabId}:${target.sessionId}` : String(target.tabId);
}
