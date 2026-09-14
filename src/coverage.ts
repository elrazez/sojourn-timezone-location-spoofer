// Interface: the deep module that decides what each tab needs and records what it got. Four entry
// points, and nothing outside this file knows a tab's coverage rules.
//   reduce(state, event)       -> the next state; pure, total, order-dependent (events fold in order)
//   reconcile(state)           -> the commands that state needs now; pure, empty when nothing is due
//   status(state)              -> what the badge and the popup show; pure
//   runCommands(commands, ads) -> runs them through the adapters, returns the events they produced;
//                                 the only impure step, and the only caller of an adapter
// Ordering: reduce every event, then reconcile, then run, then reduce the events that came back.
// Invariants: nothing is commanded without a Selection. A tab is commanded only while pending, so a
// failure is recorded once rather than retried in a tight loop; a Selection change makes every tab
// pending again, and a failed run leaves state stale so the next tick re-derives it. Errors never
// throw out of runCommands: a failure becomes an event carrying Chrome's message, because a tab
// that is not Covered has to say so rather than fall back silently.

import { getCity } from './catalog.js';
import { loadSelection, type Selection } from './settings.js';
import type { DebuggerAdapter } from './chrome/debugger.js';
import type { StorageAdapter } from './chrome/storage.js';
import type { TabsAdapter } from './chrome/tabs.js';

export type TabCoverage = { status: 'pending' | 'covered' | 'not-covered'; error?: string };

export type CoverageState = {
  selection: Selection | null;
  tabs: ReadonlyMap<number, TabCoverage>;
  // When state was last read from the browser, and why that read is not to be trusted if it failed.
  derived: { at: number; error?: string } | null;
  now: number;
};

export type CoverageEvent =
  | { type: 'settings-changed' }
  | { type: 'derived'; selection: Selection | null; tabIds: readonly number[] }
  | { type: 'failed'; error: string }
  | { type: 'tab-opened'; tabId: number }
  | { type: 'tab-closed'; tabId: number }
  | { type: 'covered'; tabId: number }
  | { type: 'not-covered'; tabId: number; error: string }
  | { type: 'tick'; now: number };

export type Command = { type: 'rederive' } | { type: 'cover'; tabId: number; zone: string };

export type Adapters = {
  debuggerAdapter: DebuggerAdapter;
  storage: StorageAdapter;
  tabs: TabsAdapter;
};

export type CoverageStatus = {
  covered: number;
  pending: number;
  notCovered: readonly { tabId: number; reason: string }[];
  error?: string;
};

export const NO_COVERAGE: CoverageState = { selection: null, tabs: new Map(), derived: null, now: 0 };

const PENDING: TabCoverage = { status: 'pending' };

// Chrome says this when the session is one we already hold, which is what a worker restart looks
// like from here: the tab is still Covered and only needs its overrides sent again.
const ALREADY_OURS = 'Another debugger is already attached';

export function reduce(state: CoverageState, event: CoverageEvent): CoverageState {
  switch (event.type) {
    case 'settings-changed':
      return { ...state, derived: null };
    case 'derived': {
      // A new Selection is a new zone, so every tab owes a fresh send, including the failed ones.
      const changed = JSON.stringify(state.selection) !== JSON.stringify(event.selection);
      const tabs = new Map(
        event.tabIds.map((tabId) => [tabId, changed ? PENDING : (state.tabs.get(tabId) ?? PENDING)]),
      );
      return { ...state, selection: event.selection, tabs, derived: { at: state.now } };
    }
    case 'failed':
      return { ...state, derived: { at: state.now, error: event.error } };
    case 'tab-opened':
      return withTab(state, event.tabId, state.tabs.get(event.tabId) ?? PENDING);
    case 'tab-closed': {
      const tabs = new Map(state.tabs);
      tabs.delete(event.tabId);
      return { ...state, tabs };
    }
    case 'covered':
      return withTab(state, event.tabId, { status: 'covered' });
    case 'not-covered':
      return withTab(state, event.tabId, { status: 'not-covered', error: event.error });
    case 'tick':
      return { ...state, now: event.now };
  }
}

export function reconcile(state: CoverageState): Command[] {
  // Never derived, or the last run failed and a tick has passed since: read the browser again.
  if (!state.derived || (state.derived.error !== undefined && state.derived.at < state.now)) {
    return [{ type: 'rederive' }];
  }
  const zone = state.selection ? getCity(state.selection.cityId)?.zone : undefined;
  if (!zone) return [];
  return [...state.tabs]
    .filter(([, coverage]) => coverage.status === 'pending')
    .map(([tabId]) => ({ type: 'cover', tabId, zone }));
}

export function status(state: CoverageState): CoverageStatus {
  const tabs = [...state.tabs];
  return {
    covered: tabs.filter(([, coverage]) => coverage.status === 'covered').length,
    pending: tabs.filter(([, coverage]) => coverage.status === 'pending').length,
    notCovered: tabs
      .filter(([, coverage]) => coverage.status === 'not-covered')
      .map(([tabId, coverage]) => ({ tabId, reason: coverage.error ?? 'unknown' })),
    ...(state.derived?.error === undefined ? {} : { error: state.derived.error }),
  };
}

export async function runCommands(
  commands: readonly Command[],
  adapters: Adapters,
): Promise<CoverageEvent[]> {
  return Promise.all(commands.map((command) => run(command, adapters)));
}

function run(command: Command, adapters: Adapters): Promise<CoverageEvent> {
  return command.type === 'rederive' ? rederive(adapters) : cover(command, adapters.debuggerAdapter);
}

async function rederive(adapters: Adapters): Promise<CoverageEvent> {
  try {
    const [selection, tabIds] = await Promise.all([
      loadSelection(adapters.storage),
      adapters.tabs.listIds(),
    ]);
    return { type: 'derived', selection, tabIds };
  } catch (error) {
    return { type: 'failed', error: describe(error) };
  }
}

async function cover(
  command: { tabId: number; zone: string },
  debuggerAdapter: DebuggerAdapter,
): Promise<CoverageEvent> {
  try {
    await attach(command.tabId, debuggerAdapter);
    await debuggerAdapter.setTimezone({ tabId: command.tabId }, command.zone);
    return { type: 'covered', tabId: command.tabId };
  } catch (error) {
    return { type: 'not-covered', tabId: command.tabId, error: describe(error) };
  }
}

async function attach(tabId: number, debuggerAdapter: DebuggerAdapter): Promise<void> {
  try {
    await debuggerAdapter.attach(tabId);
  } catch (error) {
    if (!describe(error).includes(ALREADY_OURS)) throw error;
  }
}

function withTab(state: CoverageState, tabId: number, coverage: TabCoverage): CoverageState {
  return { ...state, tabs: new Map(state.tabs).set(tabId, coverage) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
