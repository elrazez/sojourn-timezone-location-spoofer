// In-memory stand-ins for the Chrome adapters, the only things these tests fake.

import type { DebuggerAdapter, SessionTarget } from '../../src/chrome/debugger.js';
import type { StorageAdapter } from '../../src/chrome/storage.js';
import type { TabsAdapter } from '../../src/chrome/tabs.js';

export type FakeDebugger = DebuggerAdapter & {
  failAttach(tabId: number, error: string): void;
  zoneOf(tabId: number, sessionId?: string): string | undefined;
};

export type FakeStorage = StorageAdapter & { fail(error: string): void };

export function fakeDebugger(): FakeDebugger {
  const attachErrors = new Map<number, string>();
  const zones = new Map<string, string>();
  const attached = new Set<number>();
  return {
    async attach(tabId) {
      const error = attachErrors.get(tabId);
      if (error) throw new Error(error);
      attached.add(tabId);
    },
    async setTimezone(target, zone) {
      zones.set(key(target), zone);
    },
    async setGeolocation() {},
    async autoAttach() {},
    async resume() {},
    onDetach() {},
    failAttach(tabId, error) {
      attachErrors.set(tabId, error);
    },
    zoneOf(tabId, sessionId) {
      return zones.get(key({ tabId, sessionId }));
    },
  };
}

export function fakeStorage(): FakeStorage {
  const values = new Map<string, unknown>();
  let error: string | undefined;
  return {
    async get(storageKey) {
      if (error) throw new Error(error);
      return values.get(storageKey);
    },
    async set(storageKey, value) {
      if (error) throw new Error(error);
      values.set(storageKey, value);
    },
    onChange() {},
    fail(message) {
      error = message;
    },
  };
}

export function fakeTabs(tabIds: number[] = []): TabsAdapter {
  return {
    async listIds() {
      return [...tabIds];
    },
    onCreated() {},
    onRemoved() {},
  };
}

export function fakeAdapters(tabIds: number[] = []) {
  return { debuggerAdapter: fakeDebugger(), storage: fakeStorage(), tabs: fakeTabs(tabIds) };
}

function key(target: SessionTarget): string {
  return target.sessionId ? `${target.tabId}:${target.sessionId}` : String(target.tabId);
}
