// Interface: the deep module that decides what every tab and every context inside it needs, and
// records what it got. Nothing outside this file knows the coverage rules.
//   settle(state, events, ads) -> folds the events in, then reconciles, runs and folds what came
//                                 back until nothing is due; the next state and every command it
//                                 issued. The only impure step, and the only caller of an adapter
//   reduce(state, event)       -> the next state; pure, total, order-dependent (events fold in order)
//   reconcile(state)           -> the commands that state needs now; pure, empty when nothing is due
//   status(state)              -> what the badge and the popup show; pure
//   nextTick(state)            -> how long until reconcile is worth running again; pure
// Ordering: reduce every event, then reconcile, then run, then reduce the events that came back.
// Each round leaves less to do, so settle ends; it gives up after a bound rather than spin.
// Invariants: nothing attaches unless Enabled, not Paused, and a Selection exists. A failure is
// recorded once and retried on the next tick, never in a tight loop. Every tick re-sends the zone
// to every session, which is what retakes a renderer process whose override was released when
// another tab left it. Errors never throw out of runCommands: a failure becomes an event carrying
// Chrome's message, because a tab that is not Covered has to say so rather than fall back silently.

import { getCity } from './catalog.js';
import { loadPaused, loadSettings, savePaused, type Selection } from './settings.js';
import type { ActionAdapter } from './chrome/action.js';
import type { Coordinates, DebuggerAdapter, SessionTarget } from './chrome/debugger.js';
import type { StorageAdapter } from './chrome/storage.js';
import type { TabsAdapter, TabState } from './chrome/tabs.js';

// What one call answered, and when, so a failure can be shown and retried on the next tick.
type Send = { at: number; error?: string };

export type SendKind = 'zone' | 'autoAttach' | 'resumed' | 'geolocation';

// attach is absent until the first try; present without an error means the session is ours.
type Tab = { loading: boolean; loadingSince: number; attach?: Send };

type Session = { tabId: number; sessionId?: string; sends: Partial<Record<SendKind, Send>> };

export type CoverageState = {
  selection: Selection | null;
  enabled: boolean;
  paused: boolean;
  pausedSaved: boolean | null;
  tabs: ReadonlyMap<number, Tab>;
  sessions: ReadonlyMap<string, Session>;
  badge: Badge | null;
  // When state was last read from the browser, and why that read is not to be trusted if it failed.
  derived: { at: number; error?: string } | null;
  // How many times the zone has been sent to a session since the worker started. Nothing acts on
  // it: it is what lets a test tell a page that never flickered from a page nothing re-sent to.
  zoneSends: number;
  now: number;
};

export type Badge = { text: string; color: string };

export type CoverageEvent =
  | { type: 'settings-changed' }
  | { type: 'derived'; selection: Selection | null; enabled: boolean; paused: boolean; tabs: readonly TabState[] }
  | { type: 'failed'; error: string }
  | { type: 'tab-created'; tabId: number }
  | { type: 'tab-status'; tabId: number; loading: boolean }
  | { type: 'tab-removed'; tabId: number }
  | { type: 'attached'; tabId: number }
  | { type: 'attach-failed'; tabId: number; error: string }
  | { type: 'detached'; tabId: number; reason: string }
  | { type: 'child-attached'; tabId: number; sessionId: string }
  | { type: 'child-detached'; tabId: number; sessionId: string }
  | { type: 'sent'; target: SessionTarget; what: SendKind; error?: string }
  | { type: 'resumed' }
  | { type: 'badge-set'; text: string; color: string }
  | { type: 'paused-remembered'; paused: boolean }
  | { type: 'tick'; now: number };

export type Command =
  | { type: 'rederive' }
  | { type: 'attach'; tabId: number }
  | { type: 'detach'; tabId: number }
  | { type: 'zone'; target: SessionTarget; zone: string }
  | { type: 'geolocation'; tabId: number; coordinates: Coordinates }
  | { type: 'auto-attach'; target: SessionTarget }
  | { type: 'resume'; target: SessionTarget }
  | { type: 'badge'; text: string; color: string }
  | { type: 'remember-paused'; paused: boolean };

export type Adapters = {
  debuggerAdapter: DebuggerAdapter;
  storage: StorageAdapter;
  session: StorageAdapter;
  tabs: TabsAdapter;
  action: ActionAdapter;
};

export type CoverageStatus = {
  enabled: boolean;
  paused: boolean;
  selected: boolean;
  covered: number;
  pending: number;
  restricted: number;
  notCovered: readonly { tabId: number; reason: string }[];
  badge: Badge;
  zoneSends: number;
  error?: string;
};

// Chrome refuses an attach with one of these when no extension may touch the tab at all.
const RESTRICTED = [
  'Cannot access a chrome:// URL',
  'The extensions gallery cannot be scripted',
  'Cannot access contents of the page',
];

// Chrome says this when the session is one this extension already holds, which is what a service
// worker restart looks like from here: the tab is still Covered and only needs its overrides again.
const ALREADY_OURS = 'Another debugger is already attached';

// And this when the session is not ours after all, so the attach has to be made again: another
// client held the tab when Spoofer attached, and every send since has gone nowhere.
const NOT_ATTACHED = 'Debugger is not attached';

const BADGE_OFF = '#5f6368';
const BADGE_ALERT = '#d93025';

// The fast cadence is the brief's contingency for a tab that starts where no extension may attach.
const SLOW_TICK = 1000;
const FAST_TICK = 20;
const FAST_TICK_LIMIT = 30_000;

// More rounds than any sequence needs: attach, then the sends it unlocks, then the badge.
const MAX_ROUNDS = 8;

export const NO_COVERAGE: CoverageState = {
  selection: null,
  enabled: true,
  paused: false,
  pausedSaved: null,
  tabs: new Map(),
  sessions: new Map(),
  badge: null,
  derived: null,
  zoneSends: 0,
  now: 0,
};

export function reduce(state: CoverageState, event: CoverageEvent): CoverageState {
  switch (event.type) {
    case 'settings-changed':
      return { ...state, derived: null };
    case 'derived': {
      // A new Selection is a new zone and a new position, so every session owes a fresh send.
      const fresh = JSON.stringify(state.selection) !== JSON.stringify(event.selection);
      // Switching Enabled back on is the other way out of Paused, beside the popup's Resume.
      const paused = event.paused && !(event.enabled && !state.enabled);
      const tabs = new Map<number, Tab>(
        event.tabs.map((tab) => [
          tab.id,
          { loadingSince: state.now, ...state.tabs.get(tab.id), loading: tab.loading },
        ]),
      );
      const sessions = new Map(
        [...state.sessions]
          .filter(([, session]) => tabs.has(session.tabId))
          .map(([id, session]) => [id, fresh ? forget(session) : session]),
      );
      return {
        ...state,
        selection: event.selection,
        enabled: event.enabled,
        paused,
        pausedSaved: event.paused,
        tabs,
        sessions,
        derived: { at: state.now },
      };
    }
    case 'failed':
      return { ...state, derived: { at: state.now, error: event.error } };
    case 'tab-created':
      return withTab(state, event.tabId, { loading: true, loadingSince: state.now });
    case 'tab-status': {
      const tab = state.tabs.get(event.tabId);
      if (!tab) return state;
      const next = withTab(state, event.tabId, {
        ...tab,
        loading: event.loading,
        loadingSince: event.loading ? state.now : tab.loadingSince,
      });
      // A tab that starts loading needs its position again: the last one was for the old document.
      return event.loading ? withSession(next, { tabId: event.tabId }, (s) => drop(s, 'geolocation')) : next;
    }
    case 'tab-removed': {
      const tabs = new Map(state.tabs);
      tabs.delete(event.tabId);
      return dropSessions({ ...state, tabs }, event.tabId);
    }
    case 'attached':
      // A tab that has already gone stays gone: a late answer must not bring it back.
      return state.tabs.has(event.tabId) ? attach(state, event.tabId) : state;
    case 'attach-failed': {
      const tab = state.tabs.get(event.tabId);
      if (!tab) return state;
      if (event.error.includes(ALREADY_OURS)) return attach(state, event.tabId);
      return withTab(state, event.tabId, { ...tab, attach: { at: state.now, error: event.error } });
    }
    case 'detached': {
      // The tab is often still open: Chrome says target_closed for a navigation to a page no
      // extension may touch. Keep the tab and let reconcile attach it again.
      const paused = event.reason === 'canceled_by_user' ? true : state.paused;
      const tab = state.tabs.get(event.tabId);
      const next = tab
        ? withTab(state, event.tabId, { loading: tab.loading, loadingSince: tab.loadingSince })
        : state;
      return { ...dropSessions(next, event.tabId), paused };
    }
    case 'child-attached': {
      if (!isAttached(state.tabs.get(event.tabId))) return state;
      const sessions = new Map(state.sessions);
      sessions.set(keyOf(event), { tabId: event.tabId, sessionId: event.sessionId, sends: {} });
      return { ...state, sessions };
    }
    case 'child-detached': {
      const sessions = new Map(state.sessions);
      sessions.delete(keyOf(event));
      return reclaim({ ...state, sessions });
    }
    case 'sent': {
      // A send that lands nowhere says the tab is not attached to Spoofer, whatever the attach
      // answered, so record the refusal on the tab and let a later tick attach it again.
      if (event.error?.includes(NOT_ATTACHED)) return unattach(state, event.target.tabId, event.error);
      const sent = withSession(state, event.target, (session) => ({
        ...session,
        sends: {
          ...session.sends,
          [event.what]: { at: state.now, ...(event.error === undefined ? {} : { error: event.error }) },
        },
      }));
      return event.what === 'zone' ? { ...sent, zoneSends: sent.zoneSends + 1 } : sent;
    }
    case 'resumed':
      return { ...state, paused: false };
    case 'badge-set':
      return { ...state, badge: { text: event.text, color: event.color } };
    case 'paused-remembered':
      return { ...state, pausedSaved: event.paused };
    case 'tick':
      return { ...state, now: event.now };
  }
}

export function reconcile(state: CoverageState): Command[] {
  // Never read the browser, or the last read failed and a tick has passed since: read it again.
  if (!state.derived || (state.derived.error !== undefined && state.derived.at < state.now)) {
    return [{ type: 'rederive' }];
  }

  const commands: Command[] = [];
  const zone = state.selection ? getCity(state.selection.cityId)?.zone : undefined;

  if (zone === undefined || !state.enabled || state.paused) {
    // Nothing is due, so give every session up: that is what hands the real values back.
    for (const [tabId, tab] of state.tabs) if (isAttached(tab)) commands.push({ type: 'detach', tabId });
  } else {
    for (const [tabId, tab] of state.tabs) {
      if (!isAttached(tab) && unsettled(tab.attach, state.now)) commands.push({ type: 'attach', tabId });
    }
    for (const session of state.sessions.values()) {
      const target = targetOf(session);
      const sends = session.sends;
      if (due(sends.zone, state.now)) commands.push({ type: 'zone', target, zone });
      if (unsettled(sends.autoAttach, state.now)) commands.push({ type: 'auto-attach', target });
      if (session.sessionId && unsettled(sends.resumed, state.now)) commands.push({ type: 'resume', target });
      const coordinates = state.selection?.coordinates;
      // The position belongs to the tab, not to the renderer, so child sessions never get one, and
      // it goes out once per document and once per Selection: a re-send hands every active watch a
      // POSITION_UNAVAILABLE first, which is why the brief's 30 s refresh is gone.
      if (!session.sessionId && coordinates && unsettled(sends.geolocation, state.now)) {
        commands.push({ type: 'geolocation', tabId: session.tabId, coordinates });
      }
    }
  }

  // Both of these write down what Spoofer believes, so neither runs off a read that just failed:
  // an empty badge would hide a real count, and a false Paused would forget the dismissed bar.
  // They also wait for a round with nothing else in it, so a new tab's Override is never queued
  // behind a chrome.action or a storage call. settle loops until nothing is due, so they land.
  if (commands.length === 0 && state.derived.error === undefined) {
    const badge = desiredBadge(state);
    if (state.badge?.text !== badge.text || state.badge.color !== badge.color) {
      commands.push({ type: 'badge', ...badge });
    }
    if (state.pausedSaved !== null && state.pausedSaved !== state.paused) {
      commands.push({ type: 'remember-paused', paused: state.paused });
    }
  }
  return commands;
}

// How long until the next tick. A tab that is loading and not attached yet is the one case worth
// polling hard for, and only for as long as a page load can plausibly take.
export function nextTick(state: CoverageState): number {
  const waiting = [...state.tabs.values()].some(
    (tab) => tab.loading && !isAttached(tab) && state.now - tab.loadingSince < FAST_TICK_LIMIT,
  );
  return waiting ? FAST_TICK : SLOW_TICK;
}

export function status(state: CoverageState): CoverageStatus {
  // While Disabled, Paused, or with no Selection, no tab is due the Override, so no tab is Covered,
  // Not Covered or Pending. The popup says why instead of showing counts of nothing.
  const covering = state.selection !== null && state.enabled && !state.paused;
  const tabs = covering ? [...state.tabs.keys()].map((tabId) => ({ tabId, status: tabStatus(state, tabId) })) : [];
  return {
    enabled: state.enabled,
    paused: state.paused,
    selected: state.selection !== null,
    covered: tabs.filter((tab) => tab.status === 'covered').length,
    pending: tabs.filter((tab) => tab.status === 'pending').length,
    restricted: tabs.filter((tab) => tab.status === 'restricted').length,
    notCovered: tabs
      .filter((tab) => tab.status === 'not covered')
      .map((tab) => ({ tabId: tab.tabId, reason: reasonFor(state, tab.tabId) })),
    badge: desiredBadge(state),
    zoneSends: state.zoneSends,
    ...(state.derived?.error === undefined ? {} : { error: state.derived.error }),
  };
}

// The whole cycle, which is what the service worker runs and what the reducer tests drive.
export async function settle(
  state: CoverageState,
  events: readonly CoverageEvent[],
  adapters: Adapters,
): Promise<{ state: CoverageState; commands: Command[] }> {
  let next = events.reduce(reduce, state);
  const issued: Command[] = [];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const commands = reconcile(next);
    if (commands.length === 0) return { state: next, commands: issued };
    issued.push(...commands);
    next = (await runCommands(commands, adapters)).reduce(reduce, next);
  }
  // A round that keeps asking for the same thing is a bug, and looping for ever would hide it.
  throw new Error('coverage never settled');
}

async function runCommands(commands: readonly Command[], adapters: Adapters): Promise<CoverageEvent[]> {
  // Issued in order, awaited together, because a worker paused at start holds every message until
  // it is resumed: awaiting the zone before sending the resume deadlocks.
  const rounds = await Promise.all(commands.map((command) => run(command, adapters)));
  return rounds.flat();
}

async function run(command: Command, adapters: Adapters): Promise<CoverageEvent[]> {
  const { debuggerAdapter } = adapters;
  switch (command.type) {
    case 'rederive':
      return [await rederive(adapters)];
    case 'attach':
      return [
        await answer(
          () => debuggerAdapter.attach(command.tabId),
          () => ({ type: 'attached', tabId: command.tabId }),
          (error) => ({ type: 'attach-failed', tabId: command.tabId, error }),
        ),
      ];
    case 'detach':
      // An explicit detach fires no onDetach event, so the runner reports it.
      await debuggerAdapter.detach(command.tabId).catch(() => {});
      return [{ type: 'detached', tabId: command.tabId, reason: 'requested' }];
    case 'zone':
      return [await sent(command.target, 'zone', () => debuggerAdapter.setTimezone(command.target, command.zone))];
    case 'auto-attach':
      return [await sent(command.target, 'autoAttach', () => debuggerAdapter.autoAttach(command.target))];
    case 'resume':
      return [await sent(command.target, 'resumed', () => debuggerAdapter.resume(command.target))];
    case 'geolocation':
      return [
        await sent({ tabId: command.tabId }, 'geolocation', () =>
          debuggerAdapter.setGeolocation(command.tabId, command.coordinates),
        ),
      ];
    case 'badge':
      await adapters.action.setBadge(command.text, command.color).catch(() => {});
      return [{ type: 'badge-set', text: command.text, color: command.color }];
    case 'remember-paused':
      await savePaused(adapters.session, command.paused).catch(() => {});
      return [{ type: 'paused-remembered', paused: command.paused }];
  }
}

async function rederive(adapters: Adapters): Promise<CoverageEvent> {
  try {
    const [settings, paused, tabs] = await Promise.all([
      loadSettings(adapters.storage),
      loadPaused(adapters.session),
      adapters.tabs.list(),
    ]);
    return { type: 'derived', selection: settings.selection, enabled: settings.enabled, paused, tabs };
  } catch (error) {
    return { type: 'failed', error: describe(error) };
  }
}

async function answer(
  act: () => Promise<void>,
  ok: () => CoverageEvent,
  failed: (error: string) => CoverageEvent,
): Promise<CoverageEvent> {
  try {
    await act();
    return ok();
  } catch (error) {
    return failed(describe(error));
  }
}

function sent(
  target: SessionTarget,
  what: 'zone' | 'autoAttach' | 'resumed' | 'geolocation',
  act: () => Promise<void>,
): Promise<CoverageEvent> {
  return answer(
    act,
    () => ({ type: 'sent', target, what }),
    (error) => ({ type: 'sent', target, what, error }),
  );
}

function tabStatus(state: CoverageState, tabId: number): 'covered' | 'not covered' | 'pending' | 'restricted' {
  const tab = state.tabs.get(tabId);
  if (!tab) return 'pending';
  const refused = tab.attach?.error;
  if (refused !== undefined && RESTRICTED.some((restricted) => refused.includes(restricted))) return 'restricted';
  // A tab that is still loading is due the Override and has not observed it yet, whatever failed
  // so far, so it is Pending and never counts against Spoofer.
  if (tab.loading) return 'pending';
  if (refused !== undefined) return 'not covered';
  if (!isAttached(tab)) return 'pending';
  const own = [...state.sessions.values()].filter((session) => session.tabId === tabId);
  // Fail loud: one failed send anywhere in the tab means some context is not covered.
  if (own.some((session) => refusalIn(session) !== undefined)) return 'not covered';
  const top = own.find((session) => !session.sessionId);
  return top?.sends.zone && top.sends.zone.error === undefined ? 'covered' : 'pending';
}

function reasonFor(state: CoverageState, tabId: number): string {
  const refused = state.tabs.get(tabId)?.attach?.error;
  if (refused !== undefined) return refused;
  const inSession = [...state.sessions.values()]
    .filter((session) => session.tabId === tabId)
    .map(refusalIn)
    .find((error) => error !== undefined);
  return inSession ?? 'unknown';
}

function desiredBadge(state: CoverageState): Badge {
  if (!state.enabled || state.paused) return { text: 'OFF', color: BADGE_OFF };
  const count = [...state.tabs.keys()].filter((tabId) => tabStatus(state, tabId) === 'not covered').length;
  return { text: count > 0 ? String(count) : '', color: BADGE_ALERT };
}

const refusalIn = (session: Session): string | undefined =>
  Object.values(session.sends).find((send) => send.error !== undefined)?.error;

const isAttached = (tab: Tab | undefined): boolean => tab?.attach !== undefined && tab.attach.error === undefined;

// Once a second whatever the tick rate: a re-send is what retakes a renderer whose override was
// released, and what retries a send that failed.
const due = (send: Send | undefined, now: number): boolean => !send || now - send.at >= SLOW_TICK;

// Once, then again on a later tick only if it failed.
const unsettled = (send: Send | undefined, now: number): boolean =>
  !send || (send.error !== undefined && send.at < now);

// A new Selection is a new zone and a new position; what a session was watching for is unchanged.
const forget = (session: Session): Session => drop(drop(session, 'zone'), 'geolocation');

function drop(session: Session, what: SendKind): Session {
  const { [what]: _gone, ...kept } = session.sends;
  return { ...session, sends: kept };
}

function attach(state: CoverageState, tabId: number): CoverageState {
  const tab = state.tabs.get(tabId) ?? { loading: false, loadingSince: state.now };
  const next = withTab(state, tabId, { ...tab, attach: { at: state.now } });
  if (next.sessions.has(String(tabId))) return next;
  return { ...next, sessions: new Map(next.sessions).set(String(tabId), { tabId, sends: {} }) };
}

// The tab keeps the refusal as its attach result, so it reads Not Covered with a reason and the
// next tick attaches it again, rather than attaching in a tight loop inside one settle.
function unattach(state: CoverageState, tabId: number, error: string): CoverageState {
  const tab = state.tabs.get(tabId);
  if (!tab) return state;
  return dropSessions(withTab(state, tabId, { ...tab, attach: { at: state.now, error } }), tabId);
}

// A session leaving can release the zone for a whole renderer process with no event to say so, so
// every session left over owes a fresh send.
function dropSessions(state: CoverageState, tabId: number): CoverageState {
  const sessions = new Map([...state.sessions].filter(([, session]) => session.tabId !== tabId));
  return reclaim({ ...state, sessions });
}

function reclaim(state: CoverageState): CoverageState {
  return { ...state, sessions: new Map([...state.sessions].map(([id, s]) => [id, drop(s, 'zone')])) };
}

function withTab(state: CoverageState, tabId: number, tab: Tab): CoverageState {
  return { ...state, tabs: new Map(state.tabs).set(tabId, tab) };
}

function withSession(
  state: CoverageState,
  target: SessionTarget,
  update: (session: Session) => Session,
): CoverageState {
  const id = keyOf(target);
  const session = state.sessions.get(id);
  if (!session) return state;
  return { ...state, sessions: new Map(state.sessions).set(id, update(session)) };
}

function targetOf(session: Session): SessionTarget {
  return session.sessionId ? { tabId: session.tabId, sessionId: session.sessionId } : { tabId: session.tabId };
}

function keyOf(target: SessionTarget): string {
  return target.sessionId ? `${target.tabId}:${target.sessionId}` : String(target.tabId);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
