# Spoofer: product brief

The spec for the whole extension. Every phase's `code-review` runs its Spec axis against this file and the phase's own prompt. Phase 01 reconciles the Implementation Decisions section with the ADR it produces; after that, this file changes only through an ADR.

## Problem Statement

Websites read my time zone and geolocation from the browser and use them to profile, price, and gate. I want to present a city of my choosing, consistently, across every page, without any site being able to tell that an extension is doing it.

## Solution

A Chrome extension called Spoofer. I pick a City from a bundled Catalog. From then on, every tab reports that City's IANA time zone and coordinates near it. The popup shows what is covered. Everything else about the browser is untouched: no other API is changed, no request is made, nothing is collected.

## User Stories

1. As a user, I want to pick a City by typing part of its name, so that I can switch cities in seconds.
2. As a user, I want every open and future tab to report the City's time zone through `Date`, `Intl.DateTimeFormat`, and `Temporal` where present, so that no script sees my real zone.
3. As a user, I want workers, iframes (same-origin and cross-origin), popups opened by pages, and prerendered pages to report the same time zone as the top page, so that a cross-context comparison shows nothing.
4. As a user, I want `navigator.geolocation` to report coordinates near the City with a plausible accuracy, so that location-aware sites place me there.
5. As a user, I want the geolocation permission prompt to behave exactly as it does without the extension, so that the permission flow itself is not a Trace.
6. As a user, I want the coordinates to be stable across calls, tabs, and restarts until I change City, so that a site sees one consistent device.
7. As a user, I want each install to report a slightly different point (Jitter), so that a list of known Spoofer coordinates cannot identify me.
8. As a user, I want the time zone and the coordinates to always come from the same City, so that they never contradict each other.
9. As a user, I want a single switch to disable the Override, so that I can compare with reality or use a site that needs my real location.
10. As a user, I want the badge to tell me when the Override is off or when tabs are not covered, so that I am never unknowingly exposed.
11. As a user, I want the popup to show how many tabs are covered, so that I can trust what I see.
12. As a user, I want my Selection to survive browser restarts, so that I set it once.
13. As a user, I want changing the City to take effect immediately in open tabs, so that I do not have to hunt for tabs to reload.
14. As a user, I want the extension to work in incognito windows once I allow it there, so that private windows are covered too.
15. As a user, I want the extension to need only the permissions its mechanism strictly requires, so that the install prompt is honest and small.
16. As a user, I want zero network activity from the extension, so that it cannot phone home even by accident.
17. As a user, I want a page to find no injected element, global, resource, console line, or stack frame that points at the extension, so that a fingerprinting script sees an unmodified browser.
18. As a user, I want the Audit to prove all of the above against a Baseline, so that "no Trace" is a test result, not a claim.
19. As a user, I want the README to say plainly what the extension does not cover (IP address, language, user agent), so that I pair it with a VPN knowingly.
20. As a developer, I want the coverage logic to be a pure module tested with a fake Chrome adapter, so that lifecycle bugs are reproducible without a browser.

## Implementation Decisions

Mechanism, pending ADR-0001 from phase 01. Two candidates:

- **B, recommended: DevTools Protocol override through `chrome.debugger`.** The service worker attaches to every tab and sends `Emulation.setTimezoneOverride` and `Emulation.setGeolocationOverride`, plus `Target.setAutoAttach` (flattened, wait-for-debugger) so cross-process iframes, workers, and prerenders are covered before their first script runs. The engine itself produces the values, so `Function.prototype.toString`, prototypes, stack traces, workers, and `Temporal` are all consistent by construction. Cost: Chrome shows a "Spoofer started debugging this browser" bar; the `debugger` permission carries a scary install warning; cancelling the bar detaches everything, which the extension must surface as Paused rather than fall open.
- **A: MAIN-world content script that replaces `Date`, `Intl`, and geolocation.** No bar, smaller permission warning, but every replaced function is a Trace to spoof (native `toString`, stack frames, iframe timing, worker mismatch), the Selection cannot reach the script synchronously without a generated-per-City script or the `userScripts` toggle, and cross-origin or module workers stay a residual Trace. The plan README carries the design skeleton for A.

The rest of this section assumes B. If ADR-0001 picks A, phase 01 rewrites it.

Modules, in `codebase-design` vocabulary:

- **Catalog**: the City list and `searchCities`/`getCity`. Pure. Around 150 hand-curated major cities, each with IANA zone and coordinates. Every zone id is validated by `Intl.DateTimeFormat` in a test.
- **Settings**: loads and saves the Selection and the Enabled switch through a storage adapter, generates Jitter (uniform within about 2 km) and Accuracy (uniform in 20 to 100 m) when the City changes, and notifies on change.
- **Coverage**: the deep module. A pure reducer over browser events (tab created, tab closed, attach succeeded, attach failed, detached with reason, target attached, settings changed, worker restarted) producing a state (per-tab status, global Paused) and a list of commands. A thin effects runner executes commands through a debugger adapter. Exposes the status the popup shows. Never calls `Runtime.enable` or any domain beyond `Emulation` and `Target`.
- **Chrome adapters**: one module each for `chrome.debugger`, `chrome.tabs`, `chrome.storage`, `chrome.action`, with in-memory fakes for tests.
- **Background**: the service worker that wires events to Coverage, re-derives state after a restart, and sets the badge.
- **Popup**: search box over the Catalog, the current Selection, the Enabled switch, covered count, and a Paused notice with a Resume action.
- **Audit** (test-only): a locally served page that gathers probes from every context into one JSON report, and a runner that diffs it against the Baseline.

Behaviour decisions:

- Attach on install, on service worker start (all existing tabs), and on tab creation. Restricted targets (`chrome://`, the Web Store, other extensions) are skipped silently and do not count as uncovered.
- Detach reason `canceled_by_user` sets Paused: no re-attach until the user presses Resume or toggles Enabled. Badge reads `OFF`.
- Disabling detaches every tab. Enabling re-attaches every tab.
- Changing City re-sends both overrides to every covered tab immediately.
- Geolocation permission is untouched: the prompt, grant, and deny paths are the browser's own. The Override only replaces the position.
- No icons beyond what Chrome requires; no options page; no i18n; no telemetry.

Permissions (B): `debugger`, `storage`. Nothing else, no host permissions.

Minimum Chrome: 125 (the first version whose `chrome.debugger` exposes flattened child `sessionId`s).

Tooling: TypeScript strict compiled by `tsc` to ESM, no bundler, zero runtime dependencies. Vitest for pure modules. Playwright for the browser seam, launching Chromium with the extension loaded and serving test pages from two local origins to force cross-process iframes.

## Testing Decisions

A good test observes behaviour through a public interface with an expected value from an independent source. It survives any refactor that keeps behaviour.

Seams, pre-agreed for every `tdd` cycle:

1. **Browser seam** (primary): what a page observes, driven by Playwright with the extension loaded; and what the popup shows. Expected time zone offsets are known literals (Tokyo is always UTC+9, so `getTimezoneOffset()` is `-540`), expected coordinates are the City's plus a Jitter read back from Settings.
2. **Coverage reducer** with a fake debugger adapter: lifecycle sequences (cancel, restart, disable, city change) as event lists in, state and commands out.
3. **Catalog** and **Settings** as pure modules with the storage fake.

Fakes stand in only for Chrome adapters. No own module is mocked, no private function is tested, no call count is asserted.

The Audit is the acceptance test: with a City selected, the diff between the covered report and the Baseline is exactly the set of Override keys, and every context in the covered report agrees with every other.

## Out of Scope

- IP address, DNS, WebRTC. Use a VPN.
- `navigator.language`, `Accept-Language`, user agent, screen, canvas, fonts, and every other fingerprint surface.
- Per-site rules, multiple Selections, schedules, automatic City picking from the VPN.
- Firefox and Safari.
- Publishing to the Chrome Web Store (the release phase produces a zip; listing is a human task).

## Further Notes

Time is the hard part of time zones: a `Date` created before a City change keeps its instant and re-renders in the new zone, exactly as a laptop crossing a border does. That is correct, not a bug.

"No Trace" is proven differentially, never by inspection. Any check that cannot be expressed as an Audit probe is not a requirement.
