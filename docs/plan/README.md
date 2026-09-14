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
| 06.1 | `06.1-new-tab-page.md` | Spoofer's own New Tab Page, closing the measured first-script gap |
| 07 | `07-release.md` | Manual-check wizard, packaged zip, final review, tag |

## Mechanism

Phase 01 chose the DevTools Protocol override through `chrome.debugger`; `docs/adr/0001-override-mechanism.md` records the decision and why MAIN-world page-script patching was rejected.
