# Phase 03: coverage lifecycle and full time zone coverage

Coverage becomes the deep module the brief describes: a pure reducer over browser events, a pure reconcile step that turns state into commands, and a thin runner that executes them. By the end, every context of a covered page observes the Override (cross-origin iframes, workers, popups, prerenders, and the page after a cross-site navigation), the reconcile loop closes the shared-process fallback, and the lifecycle (cancel, disable, City change, worker restart) is handled and badged.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, every file under `docs/adr/`, and `docs/research/cdp-emulation-scope.md` and `docs/research/chrome-debugger-api.md` in full. Record `git rev-parse HEAD` as the fixed point.

## Step 1: prototype the state model

Call the Skill tool with `prototype` and take the logic branch. The question: do the reducer and the reconcile step handle every lifecycle sequence without an illegal state?

- **State**: desired state (Selection, Enabled, Paused); per tab, one of `attaching`, `covered`, `not covered` (with the reason string when known), `restricted`; per session (tab, `iframe`, `worker`, `service_worker`), its type, its tab, and the result and time of its last zone and geolocation sends.
- **Events**: tab created; tab updated with status `loading`; tab removed; attach succeeded; attach failed with the error string; detached with reason (`canceled_by_user` or `target_closed`); child session attached (session id and type); child session detached; send result (ok or the error string); Selection changed; Enabled changed; Resume; service worker started with the tab list and `chrome.debugger.getTargets()`; tick (the 1000 ms interval).
- **Commands**: attach tab; detach tab; send the zone to a session; send geolocation to a tab session; send `Target.setAutoAttach` to a session; resume a waiting child session; set badge text and colour.
- **Scenarios** as walkthrough tabs:
  1. The happy path.
  2. Cancel from the bar, then Resume.
  3. Disable then enable with three tabs open.
  4. City change with three tabs, where a non-owning session answers "Timezone override is already in effect" before the owner changes, and a later run succeeds.
  5. Service worker restart with two tabs already attached (attach fails with "Another debugger is already attached", which counts as Covered).
  6. The DevTools Sensors panel already holds the zone in a tab's process (every send fails; the tab stays Not Covered and the badge counts it).
  7. A tab closed while still attaching.
  8. Two tabs share a process and the owning tab closes (the next run re-sends and the other tab stays Covered).
  9. A Covered tab navigates to a page Chrome forbids (`target_closed` with the tab still open; the tab becomes Restricted or Not Covered by the brief's definitions and is attached again when it leaves).
  10. No Selection yet: nothing attaches and no bar appears.

Keep the reducer and reconcile step pure and portable. When the walkthroughs read right, commit the prototype to a `prototype/coverage-state` branch, note its verdict in the commit, and lift the logic into the Coverage module on `main`. The HTML stays on the prototype branch only.

## Step 2: slices

Call the Skill tool with `tdd`. Seams are pre-agreed. One slice at a time, red before green.

**Reducer seam** (Vitest, the fake debugger adapter): one test per scenario from step 1, written as an event list in and a literal state-plus-commands out. Expected commands are literals you write, never derived by running the reducer.

**Browser seam** (Playwright), each as its own slice:

1. A covered tab keeps `Asia/Tokyo` across a navigation from the `localhost` origin to the `127.0.0.1` origin.
2. A cross-origin iframe (`127.0.0.1` inside `localhost`) observes `Asia/Tokyo` in its first script. The iframe page records the zone in an inline script at the top of `<head>` and posts it to the parent; the test asserts on that first reading, not on a later one.
3. A dedicated worker created from a blob, a module worker, and a service worker registered by the page each observe `Asia/Tokyo` on their first line. Shared workers are not child targets of a tab session; phase 06 measures them.
4. A same-site popup opened with `window.open` from a covered page, which shares the opener's process, observes `Asia/Tokyo` in its first script.
5. A cross-site popup opened with `window.open` (the `127.0.0.1` origin from a `localhost` page) observes `Asia/Tokyo` after Sojourn attaches: assert a second reading taken after the attach. Its first-script value is recorded as a measurement, not asserted, and phase 06 lists the gap under its first-script measurements.
6. A page prerendered through speculation rules observes `Asia/Tokyo` when activated. If Playwright cannot drive activation, write the test, mark it skipped with the reason, and add the case to the brief's Manual verification line.
7. `new Date().toString()` in a covered page ends with `GMT+0900 (Japan Standard Time)`.
8. Disabling makes an open page observe `Pacific/Kiritimati` and offset `-840`; enabling again makes it observe `Asia/Tokyo`. Neither needs a reload.
9. Changing the City from Tokyo to Los Angeles makes an open tab observe `America/Los_Angeles` without reload, and the offset matches the literal for the test's date (write the date and the offset as literals; pick a date outside a DST transition week).
10. The badge reads `OFF` while Disabled, reads `1` in red while a `file://` page is open (unpacked extensions have no file access, so that tab is Not Covered), and is empty while Enabled and every web tab is Covered, read through `chrome.action.getBadgeText` and `chrome.action.getBadgeBackgroundColor` inside the service worker. Wait for every web tab to report status `complete` before asserting the badge is empty, because a loading tab is pending and is never counted.
11. A `chrome://` tab counts as Restricted, not Not Covered: the status the service worker exposes reports it in the Restricted count and the badge stays empty.
12. **Shared-process owner loss.** Launch this test's context with `--renderer-process-limit=1`, open two covered tabs on the `localhost` origin, close the tab attached first, and assert the remaining tab observes `Asia/Tokyo` within 1100 ms of the close.
13. **Flicker probe.** A covered page and a blob worker each sample `Intl.DateTimeFormat().resolvedOptions().timeZone` and `new Date().getTimezoneOffset()` every 10 ms for 5 s, across at least four reconcile ticks, and must see exactly one value. Each also records `'ontimezonechange' in window` in the page and `'ontimezonechange' in self` in the worker, registers a `timezonechange` listener, and must count zero events over the same span. If red, the owner's re-send is page-visible: drop the 1000 ms interval, keep signal-driven reconcile, add the fallback window to the brief's Residual Traces, and keep this test as the guard that the interval stays gone. A non-zero `timezonechange` count is the same red.
14. **New Tab Page gap.** `page.goto('chrome://new-tab-page')`, then `page.goto` the test origin, and assert the zone recorded by an inline script at the top of `<head>` is `Asia/Tokyo`. If red: reconcile retries attach every 20 ms while the tab reports status `loading`, bounded at 30 s. If still red after that, mark the test skipped with the measured result as the reason; phase 06 measures the miss rate over 20 loads.
15. **Renderer crash.** `page.goto('chrome://crash')` on a covered tab, then reload it; the page observes `Asia/Tokyo` in the zone its first script records.
16. **Tab discard.** `chrome.tabs.discard(tabId)` from the service worker, then `bringToFront` and wait for the reload; the page observes `Asia/Tokyo`. If discard cannot be driven from the harness, mark the test skipped with the reason and add it to the brief's Manual verification line.

Paused after the bar's Cancel and the service worker restart are covered at the reducer seam and by the phase 07 wizard; do not simulate them with test-only hooks in production code.

Rules for the green code:

- The runner sends only the methods the brief allows.
- On attach: `Target.setAutoAttach` and the zone on the tab session.
- On every child attach: the zone, then the child's own `Target.setAutoAttach`, then `Runtime.runIfWaitingForDebugger`. A child whose zone send is rejected still gets its resume call, and the rejection is recorded as that session's last send result.
- Reconcile runs on every event and on a 1000 ms interval while Enabled with a Selection, whether or not a tab is Covered yet, so a failed send keeps retrying. The interval carries a `ponytail:` comment naming the 1 s ceiling and the upgrade path (signal-driven bursts).
- The service worker re-derives state on start from `chrome.debugger.getTargets()` plus the tab list, and treats "Another debugger is already attached" as Covered.
- Nothing attaches unless Enabled, not Paused, and a Selection exists.

## Step 3: glossary

Not Covered, Paused, Restricted, and Residual Trace were settled in phase 01. Call the Skill tool with `domain-modeling` only if another state the popup will show appears; add it to `CONTEXT.md` in the product's words, without mentioning the protocol.

## Step 4: review

Call the Skill tool with `code-review`. Fixed point: the SHA from the start. Spec: this file, with the brief behind it. Standards: `CLAUDE.md`. Fix every hard violation and every spec gap; note judgement calls you leave.

## Done when

- [ ] `npm test` is green; the reducer tests cover all ten scenarios and browser tests 1 to 16 exist, with at most the prerender test, the New Tab Page test, the tab discard test, and the tab created straight onto a url on the same machine skipped, each with its reason.
- [ ] `grep -rn "Runtime\." src/ | grep -v runIfWaitingForDebugger` prints nothing.
- [ ] `grep -rn "ponytail:" src/` shows the reconcile interval's comment.
- [ ] `git branch --list 'prototype/*'` shows `prototype/coverage-state`, and `git ls-files | grep -i prototype` prints nothing on `main`.
- [ ] `CONTEXT.md` defines Paused, Restricted, and Not Covered.
- [ ] Committed on `main` with the message `phase 03: coverage lifecycle and time zone`.
