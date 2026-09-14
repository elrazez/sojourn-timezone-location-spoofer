# Build plan

Seven phases. Each file from `01` on is a complete prompt: open a fresh Claude Code session in this repo, and say

```
Run docs/plan/01-research-and-decide.md
```

then `02`, and so on. `00-brief.md` is not a phase; it is the spec every phase is reviewed against.

## Conventions the phases share

- **One phase, one session.** Start each phase in a fresh context. Nothing from the previous phase needs to be in memory; it is in the repo.
- **Phase 01 is a conversation.** It ends in a grilling round where you make the decisions. Every other phase runs unattended except where a prompt says "confirm with the user".
- **The fixed point.** Every phase records `git rev-parse HEAD` at its start and reviews its own diff against that SHA with `code-review` before committing.
- **Completion criteria are gates.** A phase is done when every criterion in its "Done when" list is true, verified by running the command named beside it, not by reading the code.
- **Skills, by name.** Prompts call skills through the Skill tool: `research`, `grilling`, `domain-modeling`, `codebase-design`, `prototype`, `tdd`, `code-review`, `diagnosing-bugs`, `wizard`, `writing-for-agents`. These are the `mattpocock-skills` plugin skills; install it with `claude plugins install mattpocock-skills` if a call fails.
- **Commits land on `main`.** Solo project, no branches, except `prototype/<name>` branches that the `prototype` skill leaves behind as primary sources.

## Phases

| # | File | Produces |
|---|------|----------|
| 01 | `01-research-and-decide.md` | Cited research files, the mechanism ADR, a reconciled brief |
| 02 | `02-scaffold-and-tracer-bullet.md` | Tooling, the e2e harness, the first covered page |
| 03 | `03-time-zone-coverage.md` | The coverage state machine and full time zone coverage |
| 04 | `04-geolocation.md` | Geolocation override with Jitter and Accuracy |
| 05 | `05-popup.md` | The popup: city search, switch, status |
| 06 | `06-audit.md` | The differential Audit and every Trace it finds, fixed |
| 07 | `07-release.md` | Manual-check wizard, packaged zip, final review, tag |

## If phase 01 picks the other mechanism

The phases from 02 on are written for the recommended mechanism, a DevTools Protocol override through `chrome.debugger` (mechanism B in the brief). If the ADR from phase 01 picks the MAIN-world script mechanism (A) instead, phase 01's last step rewrites `02` to `06` before it stops. The rewrite keeps the same phase boundaries, seams, and Audit, and swaps the coverage design for this skeleton:

- **Injection**: a MAIN-world content script at `document_start`, `all_frames`, `match_about_blank`, `match_origin_as_fallback`, registered dynamically per City so the Selection is baked into the script (one generated file per City, or `chrome.userScripts` with inline code if the user accepts the "Allow user scripts" toggle). No async config hand-off: the first page script must already see the Override.
- **Time zone**: replace `Date` local-time accessors and setters, the `Date` constructor's local-time forms, `Date.parse` of offset-less strings, `toString`/`toTimeString`/`toDateString`/`toLocale*`, `Intl.DateTimeFormat` (constructor default, `resolvedOptions`, `format*`), and `Temporal.Now` if present. Offsets and long zone names come from the captured original `Intl.DateTimeFormat` with an explicit `timeZone`.
- **Geolocation**: call the real `getCurrentPosition`/`watchPosition` so the permission prompt and timing stay genuine, then replace the prototype getters on `GeolocationCoordinates` and `GeolocationPosition.toJSON` so the real position object reports the Override.
- **Stealth layer**: every replaced function is prototype-less, keeps `name` and `length`, and `Function.prototype.toString` reports native source for it (and for itself); errors rethrown from replaced functions carry no `chrome-extension://` frame; `contentWindow`/`contentDocument` getters apply the patch to a child window on first access to close the same-origin iframe race; the `Worker` and `SharedWorker` constructors prefix same-origin classic worker sources with the patch. Cross-origin and module workers remain a documented residual Trace.
- **Phases**: 02 builds the injection and the first covered page; 03 the time zone surface; 04 geolocation; 05 the popup unchanged; 06 the Audit with the stealth probes turned up to full.
