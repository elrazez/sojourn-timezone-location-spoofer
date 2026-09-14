# Phase 03: coverage lifecycle and full time zone coverage

Coverage becomes the deep module the brief describes: a pure reducer over browser events that emits commands, and a thin runner that executes them. By the end, every context of a covered page observes the Override (cross-origin iframes, workers, popups, prerenders, and the page after a cross-site navigation), and the lifecycle (cancel, disable, city change, worker restart) is handled and badged.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, every file under `docs/adr/`, and `docs/research/cdp-emulation-scope.md` and `docs/research/chrome-debugger-api.md` in full. Record `git rev-parse HEAD` as the fixed point.

## Step 1: prototype the state model

Call the Skill tool with `prototype` and take the logic branch. The question: does this reducer handle every lifecycle sequence without an illegal state?

- **State**: per tab, one of `uncovered`, `attaching`, `covered`, `restricted`; globally, `enabled` and `paused`.
- **Events**: tab created, tab removed, attach succeeded, attach failed with the reason string, detached with reason (`canceled_by_user`, `target_closed`, and whatever R1 found for DevTools), child target attached (session id and type), Selection changed, Enabled changed, service worker started with the current tab list.
- **Commands**: attach tab, detach tab, send overrides to a tab or child session, resume a waiting child session, set badge text.
- **Scenarios** as walkthrough tabs: the happy path; cancel from the bar then Resume; disable then enable with three tabs open; City change with three tabs; service worker restart with two tabs already attached (attach fails with "already attached"); DevTools opened on a covered tab; a tab closed while still attaching.

Keep the reducer pure and portable. When the walkthroughs read right, commit the prototype to a `prototype/coverage-state` branch, note its verdict in the commit, and lift the reducer into the Coverage module on `main`. The HTML stays on the prototype branch only.

## Step 2: slices

Call the Skill tool with `tdd`. Seams are pre-agreed. One slice at a time, red before green.

**Reducer seam** (Vitest, the fake debugger adapter): one test per scenario from step 1, written as an event list in and a literal state-plus-commands out. Expected commands are literals you write, never derived by running the reducer.

**Browser seam** (Playwright), each as its own slice:

1. A covered tab keeps `Asia/Tokyo` across a navigation from the `localhost` origin to the `127.0.0.1` origin.
2. A cross-origin iframe (`127.0.0.1` inside `localhost`) observes `Asia/Tokyo` in its first script. The iframe page records the zone in an inline script at the top of `<head>` and posts it to the parent; the test asserts on that first reading, not on a later one.
3. A dedicated worker created from a blob, a module worker, and a shared worker (if the research says it arrives as a child target) each observe `Asia/Tokyo`.
4. A popup opened with `window.open` from a covered page observes `Asia/Tokyo` in its first script.
5. A page prerendered through speculation rules observes `Asia/Tokyo` when activated. If Playwright cannot drive activation, write the test, mark it skipped with the reason, and add the case to the brief's Manual verification line.
6. `new Date().toString()` in a covered page ends with `GMT+0900 (Japan Standard Time)`.
7. Disabling makes an open page observe `UTC` and offset `0`; enabling again makes it observe `Asia/Tokyo`. Neither needs a reload.
8. Changing the City from Tokyo to Los Angeles makes an open tab observe `America/Los_Angeles` without reload, and the offset matches the literal for the test's date (write the date and the offset as literals; pick a date outside a DST transition week).
9. The badge reads `OFF` while disabled and is empty while enabled and covering, read through `chrome.action.getBadgeText` inside the service worker.
10. A `chrome://` tab counts as Restricted, not uncovered: the status the service worker exposes reports it in the restricted count and the badge stays empty.

Paused after the bar's Cancel and the service worker restart are covered at the reducer seam and by the phase 07 wizard; do not simulate them with test-only hooks in production code.

Rules for the green code: the runner sends `Emulation.setTimezoneOverride` and, on every child target attach, the same override followed by `Runtime.runIfWaitingForDebugger`; a child target of a type the Emulation domain rejects gets the resume call anyway and the rejection is swallowed. Nothing from the `Runtime` domain beyond that one call. The service worker re-derives its tab list on start and treats "already attached" as covered.

## Step 3: glossary

Call the Skill tool with `domain-modeling`. Paused, Restricted, and any other state the popup will show are now real; add each to `CONTEXT.md` in the product's words, without mentioning the protocol.

## Step 4: review

Call the Skill tool with `code-review`. Fixed point: the SHA from the start. Spec: this file, with the brief behind it. Standards: `CLAUDE.md`. Fix every hard violation and every spec gap; note judgement calls you leave.

## Done when

- [ ] `npm test` is green; the reducer tests cover all seven scenarios and the browser tests above exist, with at most the prerender test skipped.
- [ ] `grep -rn "Runtime\." src/ | grep -v runIfWaitingForDebugger` prints nothing.
- [ ] `git branch --list 'prototype/*'` shows `prototype/coverage-state`, and `git ls-files | grep -i prototype` prints nothing on `main`.
- [ ] `CONTEXT.md` defines Paused and Restricted.
- [ ] Committed on `main` with the message `phase 03: coverage lifecycle and time zone`.
