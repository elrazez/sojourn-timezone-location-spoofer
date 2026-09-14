# Phase 05: the popup

The popup is the whole user interface: a search box over the Catalog, the current Selection, the Enabled switch, the covered count, and a Paused notice with a Resume action. One screen, no options page.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, and every file under `docs/adr/`. Record `git rev-parse HEAD` as the fixed point.

## Step 1: shape

The layout has one obvious form (search on top, results beneath, switch and status at the bottom), so skip the `prototype` skill unless the user asks to see alternatives; if they do, call the Skill tool with `prototype` and take the UI branch with three variants on the popup page.

Call the Skill tool with `codebase-design` for the popup's own seam: a pure view-model function from status plus query to the data the DOM renders, so that Paused and every count are testable without a browser, and a thin DOM layer that renders it. The popup talks to the service worker through the messaging adapter only, and learns nothing about the protocol.

## Step 2: slices

Call the Skill tool with `tdd`. Seams are pre-agreed. One slice at a time, red before green.

**View-model seam** (Vitest):

1. A Paused status renders the Paused notice and a Resume action; a Disabled status renders neither and reads Off; an Enabled status with three covered tabs and one Restricted reads as covering three.
2. A query of `tok` lists Tokyo first; an empty query lists nothing; a query that matches nothing renders an empty state, not an error.
3. A status with one Not Covered tab whose error string is known renders the count and the reason text; the same status with an unknown error string renders the count with a generic reason.

**Browser seam** (Playwright opens `chrome-extension://<id>/popup.html` inside the persistent context):

4. Typing `tok` and choosing Tokyo makes the Selection Tokyo (read back through the service worker) and a page opened afterwards observes `Asia/Tokyo`.
5. Turning the switch off makes the status read Off and the badge read `OFF`, and a page observes the Baseline; turning it on restores `Asia/Tokyo`.
6. The status shows the covered count equal to the number of open `http` tabs, and updates when a tab is opened.
7. Enter on the search box selects the first result; every control has a label; focus order is search, results, switch.

Rules for the green code: no inline scripts or styles (extension CSP); `popup.html` loads `dist/popup.js` as a module; the popup renders from the status the service worker reports and never keeps its own copy of the Selection; the Resume action sends one message and the service worker's Coverage reducer does the rest.

## Step 3: review

Call the Skill tool with `code-review`. Fixed point: the SHA from the start. Spec: this file, with the brief behind it. Standards: `CLAUDE.md`. Fix hard violations and spec gaps; note judgement calls you leave.

Call the Skill tool with `domain-modeling` if a term crystallised (the popup's words must be the glossary's words).

## Done when

- [ ] `npm test` is green and includes the seven slices above.
- [ ] `grep -n "<script>\|style=" extension/popup.html` prints nothing.
- [ ] The popup's visible strings use `CONTEXT.md` terms (Covered, Paused, Off) and none of the avoided synonyms.
- [ ] Committed on `main` with the message `phase 05: popup`.
