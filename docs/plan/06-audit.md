# Phase 06: the Audit

"No Trace" becomes a test result. The Audit is a locally served page that gathers probes from every context into one JSON report, and a runner that collects a Baseline report from a browser without the extension and a covered report from a browser with Tokyo selected, then diffs them. The diff must be exactly the Override keys, the covered report must agree with itself across contexts, and every Residual Trace the brief lists is measured and printed by name.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, every file under `docs/adr/`, and `docs/research/main-world-patching.md` in full (its list of CreepJS vectors is the probe list's floor). Record `git rev-parse HEAD` as the fixed point.

## Step 1: the probes

Build `test/audit/` as plain HTML and JavaScript served by the two-origin fixture. The page runs every probe in every context it can reach and resolves one flat report, keyed `<context>.<probe>`, delivered to the test through a global promise the runner awaits. Contexts: the main page, a same-origin iframe, a cross-origin iframe, a `srcdoc` iframe, an `about:blank` iframe read synchronously in the same task that appended it, a blob dedicated worker, a module worker, a shared worker, a service worker, and a `window.open` popup. The main report reads each context after it has loaded; first-script readings belong to the residual measurements in step 2.

Probes, in every context that has the API:

- **Time**: `Intl.DateTimeFormat().resolvedOptions().timeZone`; `getTimezoneOffset()` at epoch `0` and at a fixed summer instant; `toString()`, `toTimeString()`, `toLocaleString('en-US', { timeZoneName: 'long' })` of the fixed instant; `new Intl.DateTimeFormat().formatToParts(fixed)`; `Date.parse('2024-06-01T12:00')` (offset-less, so it reveals the local zone); `Temporal.Now.timeZoneId()`.
- **Geolocation** (main and the cross-origin iframe with `allow`): the coordinate fields, `instanceof` checks, `JSON.stringify` keys, milliseconds to the first position rounded to the nearest 50, `permissions.query` state, and `Date.now() - position.timestamp <= 31000` as a boolean (unless phase 04 dropped the 30 s refresh, in which case record the age as a residual measurement instead).
- **Integrity**: the sorted own property names of `globalThis`; for `Date`, `Date.prototype`, `Intl`, `Intl.DateTimeFormat.prototype`, `Geolocation.prototype`, `GeolocationCoordinates.prototype`, and `GeolocationPosition.prototype`, every own property with its descriptor shape (getter, setter, writable, enumerable, configurable) and, for functions, `Function.prototype.toString` output, `name`, `length`, and whether `'prototype' in fn`; the message and stack of `Date.prototype.getTimezoneOffset.call(null)` with line and column numbers stripped; `performance.getEntriesByType('resource')` names containing `extension`; `document.scripts.length`; `navigator.webdriver`.
- **Every vector** named in `docs/research/main-world-patching.md`, one probe each, named after the CreepJS file that implements it.

Step 1 is complete when the page, opened in a plain browser, resolves a report where every expected key is present and no probe threw.

## Step 2: the runner

A Playwright test under `test/e2e/audit.spec.ts` that launches two persistent contexts with `TZ=UTC`, both with geolocation granted for the audit origin: one without the extension (Baseline) and one with the extension and Tokyo selected (covered). It collects both reports and asserts:

1. The set of keys whose values differ equals a literal `OVERRIDE_KEYS` list written in the test (time and geolocation values in every context, and nothing else). A key in the diff that is not in the list fails the test and prints the key with both values.
2. Every context in the covered report agrees on the zone and the coordinates.
3. A third run, extension loaded but Disabled, diffs against the Baseline as empty.

Playwright itself sets `navigator.webdriver` and adds its own frames to some stacks; those appear in both reports and cancel out. Anything that appears only in the covered report is a Trace.

It then takes the residual measurements, writes them to `test/audit/residuals.json`, and prints each by name. These never fail the run:

4. **First-script gaps**: the zone and position recorded by the first inline script in a same-site and a cross-site `window.open` popup, in a page prerendered through speculation rules, and on the first line of a shared worker, each against the Override.
5. **New Tab Page misses**: over 20 loads that go from `chrome://new-tab-page` to the audit origin, the count whose first-script zone is not the Override.
6. **The bar**: one headed run with `viewport: null` that records `innerHeight` and `resize` events before attach, right after, and 6 s later, and lists the difference by name.

## Step 3: close every Trace

For each unexpected key, call the Skill tool with `diagnosing-bugs`. The Audit is already the tight loop, so Phase 1 is done: name the one command (`npx playwright test test/e2e/audit.spec.ts`) and its red output. Minimise (which single probe, which single context), write three to five falsifiable hypotheses, instrument one at a time, fix at the seam that owns the cause, and keep the probe as the regression test. The Consequences sections under `docs/research/` are the first place to look for a cause.

If a Trace cannot be closed without contradicting the ADR, stop and put it to the user with the options and your recommendation; do not weaken the `OVERRIDE_KEYS` list to make the test pass. A non-zero residual measurement is not a Trace to close here; confirm it is within the bound the brief's Residual Traces list gives, and put it to the user if it is not.

## Step 4: review

Call the Skill tool with `code-review`. Fixed point: the SHA from the start. Spec: this file, with the brief behind it. Standards: `CLAUDE.md`. Fix hard violations and spec gaps; note judgement calls you leave.

Call the Skill tool with `domain-modeling` if a term crystallised (Baseline, Trace, and Residual Trace already exist; use them).

## Done when

- [ ] `npx playwright test test/e2e/audit.spec.ts` is green for all three assertions.
- [ ] `test/audit/residuals.json` exists after that run and has one entry per measurement in step 2, items 4 to 6.
- [ ] `grep -c "\." test/audit/probes.js` (or the equivalent file) shows at least one probe per vector listed in `docs/research/main-world-patching.md`; list them side by side in the session.
- [ ] `npm test` runs the Audit as part of `test:e2e`.
- [ ] `git log --oneline <fixed point>..HEAD` shows any Trace fix as its own commit naming the confirmed hypothesis.
- [ ] Committed on `main` with the message `phase 06: audit`.
