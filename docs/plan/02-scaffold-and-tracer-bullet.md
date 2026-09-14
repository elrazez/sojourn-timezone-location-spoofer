# Phase 02: scaffold and the first tracer bullet

By the end of this phase `npm test` runs a Playwright test that launches Chromium with the extension loaded, selects Tokyo, opens a page, and observes `Asia/Tokyo`. That one green test is a tracer bullet through every layer: Settings, Coverage, the debugger adapter, the service worker. Everything else in this phase exists to make that test possible.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, every file under `docs/adr/`, and the Consequences sections of every file under `docs/research/`. Record `git rev-parse HEAD` as the fixed point.

## Step 1: interfaces

Call the Skill tool with `codebase-design`. For each module the brief names (Catalog, Settings, Coverage, the Chrome adapters, Background, Popup), write its interface in the session in the skill's sense: signature, invariants, ordering constraints, error modes. Apply the deletion test to each. Coverage must come out deep: one reducer entry point and one effects runner; the popup and the service worker learn nothing about CDP.

Confirm with the user only if you propose to move a module boundary the brief fixed. Otherwise proceed, and place each interface as the leading comment of the module file when you create it in step 3. No design document; the code is the record.

## Step 2: tooling

- `package.json` with `type: module`, no `dependencies`, and scripts: `build` (`tsc`), `test:unit` (Vitest), `test:e2e` (Playwright, after `build`), `test` (both), `typecheck`.
- `tsconfig.json`: strict, ES2022 modules, `src/` to `extension/dist/`, `@types/chrome`.
- `extension/manifest.json`: MV3, the permissions the ADR names and no others, `background.service_worker` as a module, `action` with a placeholder `popup.html` (a title and nothing else; phase 05 builds it). Minimum Chrome version from the brief.
- Playwright config and fixtures under `test/e2e/`: a fixture that launches a persistent context with `extension/` loaded, `TZ=UTC` in the Chromium environment so the Baseline offset is `0`, exposes the extension id and its service worker, and a `select(cityId)` helper that writes the Selection through the extension's own Settings module by evaluating inside the service worker. A second fixture serves `test/pages/` on two origins, `http://localhost:<port>` and `http://127.0.0.1:<port>`, from `node:http`.
- A smoke test that reads `chrome.runtime.id` inside the service worker, so a broken harness fails here and not inside a real test.

Step 2 is complete when `npm test` runs to a green smoke test and `npm run build` emits into `extension/dist/` with zero type errors.

## Step 3: tracer bullets

Call the Skill tool with `tdd`. The seams are the brief's Testing Decisions and are pre-agreed; confirm with the user only if you propose a different one. One slice at a time, red before green, the least code that turns each red green, in this order:

1. **e2e** `a page opened after selecting Tokyo observes Asia/Tokyo`: `Intl.DateTimeFormat().resolvedOptions().timeZone` is `Asia/Tokyo` and `new Date().getTimezoneOffset()` is `-540`. Green means: the service worker reads the Selection, attaches on tab creation, and sends the time zone override through the debugger adapter. The Coverage reducer may be a stub that always emits attach-and-override; phase 03 deepens it.
2. **e2e** `a tab already open when Tokyo is selected observes Asia/Tokyo without reload`: green means the service worker reacts to a storage change by covering every existing tab.
3. **e2e** `with no Selection a page observes the Baseline zone`: `UTC` and offset `0`.
4. **unit** Catalog: `getCity` returns Tokyo with zone `Asia/Tokyo`; `searchCities('tok')` finds it and `searchCities('zzz')` finds nothing; every City's zone is accepted by `new Intl.DateTimeFormat(undefined, { timeZone })`; every id is unique; every coordinate is in range; a table of ten well-known cities is within half a degree of literal coordinates you write from memory as an independent oracle.

Rules for the green code: adapters are the only modules that touch `chrome`; the debugger adapter sends nothing from the `Runtime` domain except `runIfWaitingForDebugger`; a failed attach on a restricted target is swallowed and recorded, never retried in a loop.

## Step 4: review

Call the Skill tool with `code-review`. Fixed point: the SHA recorded at the start. Spec: this file, with `docs/plan/00-brief.md` behind it. Standards: the Coding standards section of `CLAUDE.md` plus the skill's smell baseline. Fix every hard violation and every spec gap; for each judgement call, fix it or write one line saying why not.

Call the Skill tool with `domain-modeling` if any term crystallised during the phase and add it to `CONTEXT.md`.

## Done when

- [ ] `npm test` is green and lists at least three e2e tests and the Catalog unit tests.
- [ ] `node -e "const p=require('./package.json');process.exit(p.dependencies&&Object.keys(p.dependencies).length?1:0)"` exits `0`.
- [ ] `extension/manifest.json` permissions equal the ADR's set exactly.
- [ ] `grep -rn "Runtime.enable" src/` prints nothing.
- [ ] Test names use `CONTEXT.md` vocabulary (Selection, Covered, Baseline), not the avoided synonyms.
- [ ] Committed on `main` with the message `phase 02: scaffold and tracer bullet`.
