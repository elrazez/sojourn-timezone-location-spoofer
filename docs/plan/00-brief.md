# Spoofer: product brief

The spec for the whole extension. Every phase's `code-review` runs its Spec axis against this file and the phase's own prompt. The mechanism is recorded in `docs/adr/0001-override-mechanism.md` and the boundary in `docs/adr/0002-no-other-surface.md`. This file changes only through an ADR, except for the edits a phase prompt names (the Manual verification line and the Residual Traces list).

## Problem Statement

Websites read my time zone and geolocation from the browser and use them to profile, price, and gate. I want to present a city of my choosing, consistently, across every page, without any site being able to tell that an extension is doing it.

## Solution

A Chrome extension called Spoofer. I pick a City from a bundled Catalog. From then on, every tab reports that City's IANA time zone and coordinates near it. The popup shows what is covered. Everything else about the browser is untouched: no other API is changed, no request is made, nothing is collected.

## User Stories

1. As a user, I want to pick a City by typing part of its name, so that I can switch cities in seconds.
2. As a user, I want every open and future tab to report the City's time zone through `Date`, `Intl.DateTimeFormat`, and `Temporal`, so that no script sees my real zone.
3. As a user, I want same-origin and cross-origin iframes, dedicated workers, and service workers of a covered page to report the same time zone as the top page from their first script, and popups opened by pages, prerendered pages, and shared workers to report it from the moment Spoofer attaches, and from their first script when they share a covered process, so that a cross-context comparison shows nothing beyond the Residual Traces the README names.
4. As a user, I want `navigator.geolocation` to report coordinates near the City with a plausible accuracy, so that location-aware sites place me there.
5. As a user, I want the geolocation permission prompt to behave exactly as it does without the extension, so that the permission flow itself is not a Trace.
6. As a user, I want the coordinates to be stable across calls, tabs, and restarts until I change City, so that a site sees one consistent device.
7. As a user, I want each install to report a slightly different point (Jitter), so that a list of known Spoofer coordinates cannot identify me.
8. As a user, I want the time zone and the coordinates to always come from the same City, so that they never contradict each other.
9. As a user, I want a single switch to disable the Override, so that I can compare with reality or use a site that needs my real location.
10. As a user, I want the badge to tell me when the Override is off or when tabs are Not Covered, so that I am never unknowingly exposed.
11. As a user, I want the popup to show how many tabs are covered, so that I can trust what I see.
12. As a user, I want my Selection to survive browser restarts, so that I set it once.
13. As a user, I want changing the City to take effect immediately in open tabs, so that I do not have to hunt for tabs to reload.
14. As a user, I want the extension to work in incognito windows once I allow it there, so that private windows are covered too.
15. As a user, I want the extension to need only the permissions its mechanism strictly requires, so that the install prompt is honest and small.
16. As a user, I want zero network activity from the extension, so that it cannot phone home even by accident.
17. As a user, I want a page to find no injected element, global, resource, console line, or stack frame that points at the extension, so that a fingerprinting script sees an unmodified browser.
18. As a user, I want the Audit to prove all of the above against a Baseline, so that "no Trace" is a test result, not a claim.
19. As a user, I want the README to say plainly what the extension does not cover (IP address, language, user agent) and which Residual Traces remain, so that I pair it with a VPN knowingly.
20. As a developer, I want the coverage logic to be a pure module tested with a fake Chrome adapter, so that lifecycle bugs are reproducible without a browser.

## Implementation Decisions

### Mechanism

DevTools Protocol override through `chrome.debugger` (ADR-0001). The service worker attaches to every tab and sends the Override through `Emulation`, with `Target.setAutoAttach` (flattened, wait-for-debugger) so cross-process iframes and workers are covered before their first script runs. The engine itself produces the values. MAIN-world page-script patching was rejected; ADR-0001 records why.

### Protocol rule

- Allowed methods, exactly four: `Emulation.setTimezoneOverride`, `Emulation.setGeolocationOverride`, `Target.setAutoAttach`, `Runtime.runIfWaitingForDebugger`.
- Forbidden by name, along with every method not in the allowed list: `Runtime.enable`, every `Debugger.*` method, `Page.enable`, `Log.enable`, `Network.enable`, `Emulation.setAutomationOverride`.
- The zone goes to every session (tab, `iframe`, `worker`, `service_worker`) before that session's resume call.
- Every child session gets its own `Target.setAutoAttach` with `autoAttach: true`, `waitForDebuggerOnStart: true`, `flatten: true`, because auto-attach is not recursive.
- Geolocation goes to tab sessions only, never to child sessions, and carries `latitude`, `longitude`, and `accuracy` only, so `altitude`, `altitudeAccuracy`, `heading`, and `speed` read `null`.

### Platform facts the design rests on

From `docs/research/`:

- The zone Override is per renderer process. Frames and workers in that process follow it. Same-site tabs share a process by default. The first session to set the zone owns it; when that session goes away the process falls back to the real zone with no event, and a non-owning session that sends a different zone gets "Timezone override is already in effect". A non-owning session that sends the same zone gets success and changes nothing. Blink replays the zone after a cross-process navigation of the same tab.
- The geolocation Override is per tab, applied in the browser process, covers cross-process iframes, never bypasses the permission check or prompt, and is cleared when the session that set it detaches. Its `timestamp` is fixed at the time of the send.
- A tab session cannot pause popups, prerendered pages, or shared workers.
- The debugger bar is one per extension, shown on every tab of every window while any session is attached, and closes 5 s after the last detach. Its Cancel and its close both detach every tab with reason `canceled_by_user`.
- There are only two detach reasons, `canceled_by_user` and `target_closed`. `target_closed` also fires when a tab navigates to a page Chrome forbids, with the tab still open.
- Opening DevTools does not detach Spoofer. A zone set in the DevTools Sensors panel blocks Spoofer's zone send (or is blocked by it), and a Sensors position overwrites Spoofer's.
- An attached session keeps the extension service worker alive with no timeout (Chrome 118 and later), and worker termination does not detach sessions. No keep-alive mechanism exists or is needed.
- `chrome.debugger.attach` is refused while `chrome://new-tab-page` is committed, so a tab going from the New Tab Page to a website may run its first script before the attach lands.
- The default `spanning` incognito mode reaches incognito tabs once the user allows the extension there.

### Modules

In `codebase-design` vocabulary:

- **Catalog**: the City list and `searchCities`/`getCity`. Pure. About 150 hand-curated major cities, each with name, country, IANA zone, and coordinates, bundled as a TypeScript module with no runtime additions. A test asserts every zone id equals `new Intl.DateTimeFormat(undefined, { timeZone: id }).resolvedOptions().timeZone`, so the id Spoofer sends is the id a page reads back.
- **Settings**: loads and saves the Selection and the Enabled switch through a storage adapter, and notifies on change. When the City changes it generates the Jitter, a point uniform by area over a disc of radius 2 km around the City (radius sampled as 2000 m times the square root of a uniform number), and the Accuracy, an integer uniform in [20, 100] metres. Both persist and stay stable across restarts until the City changes.
- **Coverage**: the deep module. It holds desired state (the Selection, Enabled, Paused) and, per session, the result and time of the last zone and geolocation sends. A pure reducer folds browser events into that state; a pure reconcile step turns state into commands; a thin effects runner executes commands through the debugger adapter and feeds results back as events. It exposes the status the popup and badge show.
- **Chrome adapters**: one module each for `chrome.debugger`, `chrome.tabs`, `chrome.storage`, `chrome.action`, with in-memory fakes for tests.
- **Background**: the service worker that wires events to Coverage, re-derives state on start, runs the reconcile interval, and sets the badge.
- **Popup**: search box over the Catalog, the current Selection, the Enabled switch, the covered count, the Not Covered count with reasons, and a Paused notice with a Resume action.
- **Audit** (test-only): a locally served page that gathers probes from every context into one JSON report, and a runner that diffs it against the Baseline.

### Behaviour decisions

- **Attach precondition.** Spoofer attaches only when Enabled, not Paused, and a Selection exists. A fresh install shows no bar until the user picks a City.
- **When to attach.** On the first Selection, on Enabled turned on, on Resume, on service worker start (every existing tab), and on `tabs.onCreated` (which is how popups get covered).
- **Worker start.** State is re-derived from `chrome.debugger.getTargets()` plus the tab list. An attach that fails with "Another debugger is already attached" means this extension already holds that session, so the tab counts as Covered.
- **Reconcile loop.** Reconcile sends the zone to every session and geolocation to tab sessions under the refresh rule below. It runs immediately on every tab event, detach, child attach, and Selection or Enabled change, and on a 1000 ms interval while any tab is Covered. The interval bounds the shared-process fallback to 1 s, because a re-send takes ownership of a process whose override was released. The code carries a `ponytail:` comment naming the 1 s ceiling and the upgrade path (signal-driven bursts).
- **Geolocation refresh.** Reconcile re-sends geolocation to a tab session when the tab starts loading (`tabs.onUpdated` with status `loading`), when that tab's last geolocation send is older than 30 s, and when the Selection changes.
- **City change.** A City change updates desired state and runs reconcile immediately, with no reload and no separate retry logic. A session whose last send failed shows Not Covered until a later run succeeds.
- **Covered, Not Covered, Restricted.** Restricted is a tab whose top-level page no extension may touch: `chrome://`, another extension's page, `devtools:`, `view-source:`, the Chrome Web Store. It is counted separately and the badge ignores it. Not Covered is every web page (`http`, `https`, `file`) that cannot be attached or whose last send failed, whatever the reason. Examples: it frames another extension's iframe, `file://` has no file access, it shows an interstitial, an enterprise policy blocks attach, or the DevTools Sensors panel holds the zone. The popup names the reason when the error string is known.
- **Badge.** `OFF` while Disabled or Paused. Otherwise the count of Not Covered web tabs, in red, when above zero. Empty otherwise. Restricted never counts.
- **Paused.** Detach reason `canceled_by_user` sets Paused: no attach until the user presses Resume or switches Enabled back on, and Spoofer never re-attaches on its own. The popup's Paused notice says in one sentence that Resume shows the bar again. Paused is kept in `chrome.storage.session`, so a worker restart keeps it and a browser restart clears it.
- **Disable.** Disabling detaches every tab, which clears both overrides. Enabling attaches every tab.
- **Permission.** Geolocation permission is untouched: the prompt, grant, and deny paths are the browser's own. The Override only replaces the position.
- **Contingencies**, decided now and triggered by named tests:
  - If phase 03's flicker probe shows the owner's re-send is page-visible, drop the 1000 ms interval, keep signal-driven reconcile, and add the fallback window to the Residual Traces.
  - If phase 04's watch test shows a geolocation re-send delivers `POSITION_UNAVAILABLE`, drop the 30 s refresh, keep the loading re-send, and add the timestamp staleness to the Residual Traces.
  - If phase 03's New Tab Page test is red, reconcile retries attach every 20 ms while the tab reports status `loading`, bounded at 30 s, and phase 06 measures the miss rate over 20 such loads.
- No icons beyond what Chrome requires; no options page; no i18n; no telemetry.

### Permissions and manifest

`debugger` and `storage`, nothing else, no host permissions (ADR-0002). No content scripts, no `web_accessible_resources`, no `externally_connectable`. The install prompt shows "Access the page debugger backend".

### Minimum Chrome

125, the first version whose `chrome.debugger` exposes flattened child `sessionId`s. The harness runs Playwright's bundled Chromium 153, so the floor is asserted by the manifest, not by a test.

### Tooling

TypeScript strict compiled by `tsc` to ESM, no bundler, zero runtime dependencies, npm. Vitest for pure modules. Playwright for the browser seam, launching Chromium with the extension loaded and serving test pages from two local origins (`localhost` and `127.0.0.1`, distinct sites) to force cross-process iframes.

## Testing Decisions

A good test observes behaviour through a public interface with an expected value from an independent source. It survives any refactor that keeps behaviour.

Seams, pre-agreed for every `tdd` cycle:

1. **Browser seam** (primary): what a page observes, driven by Playwright with the extension loaded; and what the popup shows. Expected time zone offsets are known literals (Tokyo is always UTC+9, so `getTimezoneOffset()` is `-540`), expected coordinates are the City's plus a Jitter read back from Settings.
2. **Coverage reducer and reconcile** with a fake debugger adapter: lifecycle sequences (cancel, restart, disable, City change, shared-process owner loss) as event lists in, state and commands out.
3. **Catalog** and **Settings** as pure modules with the storage fake.

Fakes stand in only for Chrome adapters. No own module is mocked, no private function is tested, no call count is asserted.

Harness rules:

- Both runs pin the zone with `TZ=UTC` on the Chromium process, and phase 02's smoke test asserts a page reads `UTC`. If macOS Chromium ignores `TZ`, use Chromium's `--time-zone-for-testing` switch instead and cite it in `docs/research/playwright-extension-harness.md`.
- The harness never passes `--silent-debugger-extension-api`, never uses Playwright's `timezoneId`, `geolocation`, or `setGeolocation`, and grants permissions only through `grantPermissions`.
- Every open research item that changes behaviour becomes a named test in the phase that owns it, marked skipped with the reason if it cannot run yet: the shared-process owner loss and the New Tab Page gap in phase 03; the geolocation re-send, the timestamp age, and the iframe `allow` attribute in phase 04; the bar's viewport change and the first-script gaps in phase 06. Open items that change nothing stay in the research files.

The Audit is the acceptance test: with a City selected, the diff between the covered report and the Baseline is exactly the set of Override keys, and every context in the covered report agrees with every other. Residual Traces are measured and printed by name, never folded into the Override keys.

### Manual verification

The bar's Cancel (badge reads `OFF`, popup shows Paused, Resume restores coverage and shows the bar again), and a service worker restart (stop the worker from `chrome://serviceworker-internals` while tabs are Covered, then confirm they stay Covered and a new tab is Covered).

## Out of Scope

- IP address, DNS, WebRTC. Use a VPN.
- `navigator.language`, `Accept-Language`, user agent, screen, canvas, fonts, and every other fingerprint surface.
- Per-site rules, multiple Selections, schedules, automatic City picking from the VPN.
- Firefox and Safari.
- Publishing to the Chrome Web Store (the release phase produces a zip; listing is a human task).

## Further Notes

Time is the hard part of time zones: a `Date` created before a City change keeps its instant and re-renders in the new zone, exactly as a laptop crossing a border does. That is correct, not a bug.

"No Trace" is proven differentially, never by inspection. Any check that cannot be expressed as an Audit probe is not a requirement.

### Residual Traces

Each is bounded here, measured by the Audit, and named in the README with the measured number:

- **Shared-process zone window:** up to 1 s of the real zone in a tab whose renderer process lost its override when another tab left it.
- **Position timestamp age:** `Date.now() - position.timestamp` up to 31 s.
- **First-script gaps:** popups, prerendered pages, and shared workers that do not share a covered process, plus tabs leaving the New Tab Page if phase 03's test is red.
- **The bar:** one `resize` and a smaller `innerHeight` on open tabs in a headed browser when Spoofer attaches.
