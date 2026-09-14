# Spoofer

Chrome extension that makes websites see the geolocation and time zone of a City the user picks. Nothing else. The product brief (the spec every phase is reviewed against) is `docs/plan/00-brief.md`; the build runs as numbered prompts under `docs/plan/`.

Read `CONTEXT.md` before naming anything, and the ADRs under `docs/adr/` before touching the area they cover.

## Privacy rules

These bind every change. A change that needs an exception records it as an ADR first.

- The extension makes zero network requests, from any context, ever.
- Web pages observe only the overridden values. No injected DOM, no globals, no web-accessible resources, no console output in page contexts, no timing artifacts the Audit can see.
- Permissions are exactly the set the ADR names. Adding one is an ADR.
- Nothing about the user is logged, stored beyond the Selection, or sent anywhere.
- Coverage fails loud: when a tab is not covered, the badge and popup say so. Silent fallback to real values is a bug.

## Coding standards

The `code-review` Standards axis reads this section.

- TypeScript, strict, ESM. `tsc` is the build; there is no bundler. Zero runtime `dependencies` in `package.json`; dev tooling only.
- Chrome APIs are reached only through one adapter module per API surface. Logic modules take adapters as parameters and never import `chrome` themselves.
- Logic returns results; adapters perform effects. A function that both decides and does is two functions.
- Tests live at the seams the brief pre-agrees: the browser seam (Playwright, primary) and the pure modules (Vitest). Fakes stand in for Chrome adapters only. Own modules are never mocked.
- Expected values in tests are independent literals (a known offset, a known coordinate), never recomputed the way the code computes them.
- Names follow `CONTEXT.md`. A concept the glossary lacks is a signal to add it there first.
- Comments are one line and say why. Prose in this repo uses no em-dashes.
- A `ponytail:` comment marks a deliberate shortcut and names its ceiling.

## Workflow

- One plan file per session, in order. Record `git rev-parse HEAD` at the start of a phase; that SHA is the fixed point for `code-review` at the end of it.
- Build test-first through the `tdd` skill, one tracer bullet at a time. Refactoring waits for the review step.
- Update `CONTEXT.md` the moment a term crystallises, through the `domain-modeling` skill. Offer an ADR only when a decision is hard to reverse, surprising, and a real trade-off.
- Commit at the end of every phase with a message that names the phase. Commit only when `npm test` is green.
- Commands live in `package.json` scripts; read them there.

## Agent skills

### Issue tracker

Local markdown: specs and tickets live as files in this repo, and the plan files under `docs/plan/` are the specs. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
