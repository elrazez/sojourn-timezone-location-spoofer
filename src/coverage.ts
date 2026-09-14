// Interface: the deep module that decides what each tab needs and records what it got. Three entry
// points, and nothing outside this file names a protocol method or a tab's coverage rules.
//   reduce(state, event)        -> the next state; pure, total, order-dependent (events fold in order)
//   reconcile(state)            -> the commands that state needs now; pure, empty when nothing is due
//   runCommands(commands, dbg)  -> runs them through the debugger adapter, returns the events they
//                                  produced; the only impure step, and the only caller of the adapter
// Ordering: reduce every event, then reconcile, then run, then reduce the events that came back.
// Invariants: nothing is commanded without a Selection. A tab is commanded only while pending, so a
// failure is recorded once and never retried in a loop; a Selection change makes every tab pending
// again. Errors never throw out of runCommands: a failure becomes a not-covered event carrying
// Chrome's message, because a tab that is not Covered has to say so rather than fall back silently.

import { getCity } from './catalog.js';
import type { Selection } from './settings.js';
import type { DebuggerAdapter } from './chrome/debugger.js';

export type TabCoverage = { status: 'pending' | 'covered' | 'not-covered'; error?: string };

export type CoverageState = {
  selection: Selection | null;
  tabs: ReadonlyMap<number, TabCoverage>;
};

export type CoverageEvent =
  | { type: 'selection'; selection: Selection | null }
  | { type: 'tabs-open'; tabIds: readonly number[] }
  | { type: 'tab-opened'; tabId: number }
  | { type: 'tab-closed'; tabId: number }
  | { type: 'covered'; tabId: number }
  | { type: 'not-covered'; tabId: number; error: string };

export type Command = { type: 'cover'; tabId: number; zone: string };

export const NO_COVERAGE: CoverageState = { selection: null, tabs: new Map() };

const PENDING: TabCoverage = { status: 'pending' };

export function reduce(state: CoverageState, event: CoverageEvent): CoverageState {
  switch (event.type) {
    case 'selection': {
      // A new Selection is a new zone, so every tab owes a fresh send, including the failed ones.
      const tabs = new Map([...state.tabs.keys()].map((tabId) => [tabId, PENDING]));
      return { selection: event.selection, tabs };
    }
    case 'tabs-open': {
      const tabs = new Map(event.tabIds.map((tabId) => [tabId, state.tabs.get(tabId) ?? PENDING]));
      return { ...state, tabs };
    }
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
  }
}

export function reconcile(state: CoverageState): Command[] {
  const zone = state.selection ? getCity(state.selection.cityId)?.zone : undefined;
  if (!zone) return [];
  return [...state.tabs]
    .filter(([, coverage]) => coverage.status === 'pending')
    .map(([tabId]) => ({ type: 'cover', tabId, zone }));
}

export async function runCommands(
  commands: readonly Command[],
  debuggerAdapter: DebuggerAdapter,
): Promise<CoverageEvent[]> {
  return Promise.all(commands.map((command) => cover(command, debuggerAdapter)));
}

async function cover(command: Command, debuggerAdapter: DebuggerAdapter): Promise<CoverageEvent> {
  try {
    await debuggerAdapter.attach(command.tabId);
    await debuggerAdapter.send(command.tabId, 'Emulation.setTimezoneOverride', {
      timezoneId: command.zone,
    });
    return { type: 'covered', tabId: command.tabId };
  } catch (error) {
    return { type: 'not-covered', tabId: command.tabId, error: describe(error) };
  }
}

function withTab(state: CoverageState, tabId: number, coverage: TabCoverage): CoverageState {
  return { ...state, tabs: new Map(state.tabs).set(tabId, coverage) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
