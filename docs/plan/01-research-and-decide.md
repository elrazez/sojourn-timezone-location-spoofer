# Phase 01: research and decide

You are building Spoofer, the extension described in `docs/plan/00-brief.md`. This phase settles the decision everything else hangs on, the override mechanism, from primary sources and a grilling round with the user. Nothing is implemented in this phase.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, and `docs/plan/README.md`. Record `git rev-parse HEAD`.

## Step 1: research, in parallel

Call the Skill tool with `research`. Dispatch one background agent per question below, all at once. Each agent writes one file under `docs/research/`, cites a primary source for every claim (Chrome extension docs, the DevTools Protocol reference, Chromium source, Playwright docs and source, the CreepJS source, the W3C spec), quotes the line that settles the claim, and marks any claim it cannot settle as `OPEN:` with what would settle it. A secondary source may point at a primary source; it never carries a claim on its own. Each file ends with a section `## Consequences for Spoofer` of at most ten lines.

**R1 `chrome-debugger-api.md`: the `chrome.debugger` API as it exists in current stable Chrome.**
- Attach and detach semantics; the error strings for "already attached" and restricted targets; which targets are restricted (`chrome://`, the Web Store, other extensions, `file://`).
- `Debuggee.sessionId` and flattened child sessions: the Chrome version that introduced it, and how `onEvent` reports the `sessionId` of a child.
- The "started debugging this browser" bar: when it appears, whether it is per tab or global, what its Cancel button does and which `onDetach` reason it fires, and the `--silent-debugger-extension-api` switch.
- What happens when the user opens DevTools on a tab the extension is attached to: coexistence, or a detach with which reason.
- Service worker lifetime: whether an open debugger session keeps the extension service worker alive, whether idle termination detaches sessions, and the documented keep-alive story.
- Incognito: whether the default `spanning` mode sees incognito tabs once the user allows the extension there.
- Sources: developer.chrome.com `chrome.debugger` reference and the extension service worker lifecycle page; Chromium `extensions/browser/api/debugger/debugger_api.cc` and `chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.cc`.

**R2 `cdp-emulation-scope.md`: how far the two Emulation overrides reach.**
- `Emulation.setTimezoneOverride`: where it is implemented (Blink `InspectorEmulationAgent`, `TimeZoneController`); whether the override is per frame or per renderer process; its effect on `Intl`, `Temporal`, and dedicated, shared, and service workers in the same process; whether it survives a cross-process navigation of the same tab; what happens when two sessions set different overrides in one process.
- `Emulation.setGeolocationOverride`: browser side or renderer side; whether it covers cross-process iframes; whether the permission prompt still appears; the `accuracy` requirement; what `clearGeolocationOverride` restores.
- `Target.setAutoAttach` with `flatten: true` and `waitForDebuggerOnStart: true` sent on a tab session: which child target types arrive (iframe, worker, shared_worker, service_worker, prerender); whether `window.open` popups are children of the opener session or separate top-level targets; the need for `Runtime.runIfWaitingForDebugger`.
- Which CDP calls are known detection vectors (the `Runtime.enable` console serialisation trick) so the design avoids them.
- Sources: chromedevtools.github.io/devtools-protocol; Chromium `third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc`, `third_party/blink/renderer/core/timezone/time_zone_controller.cc`, `content/browser/devtools/protocol/emulation_handler.cc`, `content/browser/devtools/protocol/target_handler.cc`; Puppeteer's `Page.emulateTimezone` and target manager source.

**R3 `main-world-patching.md`: the alternative mechanism and what it would cost.**
- Content scripts with `world: "MAIN"` at `run_at: document_start`: the ordering guarantee relative to page scripts; `all_frames`, `match_about_blank`, `match_origin_as_fallback`; whether `document.documentElement` exists at `document_start`.
- `chrome.scripting.registerContentScripts` and `updateContentScripts`: support for `world` and `matchOriginAsFallback`, with versions.
- `chrome.userScripts`: inline `code`, `world: 'MAIN'`, and the "Allow user scripts" toggle (Chrome 138 and later) versus Developer mode before it.
- The synchronous configuration problem: confirm there is no synchronous channel from `chrome.storage` to a `document_start` script, so a Selection must be baked into the script itself.
- Detection vectors in the CreepJS source (`abrahamjuliot/creepjs`): the lie checks on `Function.prototype.toString`, prototype descriptors, stack traces, worker versus main mismatch, `contentWindow` iframe mismatch, `Intl` versus `Date` mismatch. List each with the file that implements it; phase 06 turns every one into an Audit probe.
- Whether `Temporal` ships in stable Chrome today (chromestatus.com).
- Sources: developer.chrome.com content scripts, `chrome.scripting`, and `chrome.userScripts` references; the CreepJS repository; chromestatus.

**R4 `playwright-extension-harness.md`: driving Chromium with the extension loaded.**
- Loading an MV3 extension in `launchPersistentContext` (`--disable-extensions-except`, `--load-extension`), headless support through `channel: 'chromium'`, obtaining the service worker and the extension id.
- Multi-client CDP: whether an extension's `chrome.debugger` session coexists with Playwright's own connection on the same tab, and any documented limit.
- Whether Playwright's `timezoneId`, `geolocation`, and `grantPermissions` options touch the same Emulation state as the extension, and which wins. The harness must not use `timezoneId` or `setGeolocation`; it makes the Baseline deterministic with the `TZ` environment variable on the Chromium process instead, and grants permissions only through `grantPermissions`.
- Serving pages on two local origins (`localhost` and `127.0.0.1`) to force a cross-process iframe, and whether site isolation treats them as distinct sites by default.
- Sources: playwright.dev (Chrome extensions, browser contexts, emulation); Playwright source under `packages/playwright-core/src/server/chromium/`; the Chromium DevTools multi-client design note.

**R5 `geolocation-plausibility.md`: what a real desktop position looks like.**
- The `GeolocationCoordinates` fields and which are `null` on desktop; typical `accuracy` values from Chrome's network location provider on desktop; whether `GeolocationPosition.prototype.toJSON` and `GeolocationCoordinates.prototype.toJSON` exist in stable Chrome.
- `navigator.permissions.query({ name: 'geolocation' })` states and how an override interacts with them.
- Sources: the W3C Geolocation specification; Chromium `services/device/geolocation/network_location_provider.cc`; MDN compatibility tables only for availability.

Step 1 is complete when all five files exist, every claim in each carries a citation or an `OPEN:` marker, and each ends with its Consequences section.

## Step 2: reconcile

Read all five files in full. Write, in the session, the list of places where a finding contradicts the brief's Implementation Decisions or Behaviour decisions, quoting both sides. Every contradiction becomes a grill question in step 3. Any `OPEN:` marker that bears on the mechanism decision also becomes a question, with the cheapest experiment that would settle it named as an option.

## Step 3: grill

Call the Skill tool twice, with `grilling` and with `domain-modeling`. Open with one round that covers the whole frontier below, plus the questions from step 2, each with your recommended answer so the user can accept in a word. Then keep asking rounds until the frontier is empty. Facts are yours to find (dispatch a sub-agent for anything missing); decisions are the user's.

- **Q1 Mechanism.** B (DevTools Protocol through `chrome.debugger`) or A (MAIN-world script). Recommend B: the engine produces every value, so there is no Trace to spoof and no arms race. State the cost in one line: a persistent "Spoofer started debugging this browser" bar and a `debugger` permission warning at install. State A's cost in one line: residual Traces in cross-origin and module workers, and a generated-per-City script or a user toggle for configuration.
- **Q2 The bar.** With B, cancelling the bar detaches every tab. Recommend: the extension enters Paused, badge reads `OFF`, the popup explains and offers Resume; no automatic re-attach, because re-attaching re-shows the bar and fights the user.
- **Q3 DevTools.** Whatever R1 found: if opening DevTools detaches the extension from that tab, recommend treating it like any uncovered tab (badge shows the count) and noting it in the README.
- **Q4 Service worker lifetime.** Whatever R1 found: if idle termination drops sessions, recommend the documented keep-alive, and add it to the brief's behaviour decisions.
- **Q5 Chrome floor.** Recommend the version R1 names for flattened `sessionId`, expected to be 125.
- **Q6 Jitter and Accuracy.** Recommend Jitter uniform within about 2 km and Accuracy uniform in 20 to 100 m, both generated when the City changes, both stable across restarts.
- **Q7 Catalog.** Recommend about 150 hand-curated major cities with name, country, IANA zone, and coordinates, bundled as a TypeScript module, validated by `Intl` in a test, no runtime additions.
- **Q8 Scope.** Confirm the brief's Out of Scope list, popup-only UI, no options page, no icons beyond what Chrome requires.
- **Q9 Incognito.** Recommend `spanning`, user enables it in `chrome://extensions`, README documents it.
- **Q10 City change with open tabs.** Recommend immediate re-override, no reload.
- **Q11 Tooling.** Recommend TypeScript strict compiled by `tsc`, no bundler, zero runtime dependencies, Vitest, Playwright, npm.
- **Q12 Distribution.** Recommend load-unpacked plus a zip from phase 07; the Web Store listing stays a human task.

Throughout, apply `domain-modeling`: challenge any term the user uses that conflicts with `CONTEXT.md`, and add a term the moment it is settled (Paused and Restricted are likely candidates; both are user-visible states, so they belong in the glossary even though the mechanism is not).

Step 3 is complete when the user confirms a shared understanding and no question remains on the frontier.

## Step 4: record

1. Write `docs/adr/0001-override-mechanism.md` in the `domain-modeling` ADR format: the decision, the rejected alternative, and the reason, in a paragraph. Include `Considered Options` because the rejection is non-obvious.
2. Offer, and write only if the user accepts, `docs/adr/0002-no-other-surface.md`: the explicit no-s (no network, no locale or user-agent spoofing, no permissions beyond the mechanism's). It qualifies as a boundary decision whose reversal would be tempting "for consistency".
3. Edit `docs/plan/00-brief.md`: replace every "pending", "recommended", and "assumes B" phrase in Implementation Decisions with the decision as a fact, fold in every answer from step 3 (Chrome floor, keep-alive, DevTools behaviour, Jitter numbers), and delete the description of the mechanism that was not chosen except for one line pointing at the ADR.
4. If the ADR chose A, rewrite `docs/plan/02-scaffold-and-tracer-bullet.md` through `06-audit.md` following the skeleton in `docs/plan/README.md`, keeping each file's structure (Start, numbered steps with skill calls, Done when, commit). Call the Skill tool with `writing-for-agents` before rewriting.
5. Add a `## Manual verification` line to the brief's Testing Decisions naming the two paths phase 03 cannot drive from Playwright (the bar's Cancel, and a service worker restart), so phase 07's wizard picks them up.

## Done when

- [ ] `ls docs/research/` shows the five files and `grep -L "Consequences for Spoofer" docs/research/*.md` prints nothing.
- [ ] `docs/adr/0001-override-mechanism.md` exists and names the rejected option.
- [ ] `grep -n -i "pending\|recommended\|assumes B" docs/plan/00-brief.md` prints nothing.
- [ ] `CONTEXT.md` carries every term settled in the grill.
- [ ] The user has said the understanding is shared.
- [ ] Committed on `main` with the message `phase 01: research and mechanism decision`.
