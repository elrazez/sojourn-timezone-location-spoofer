# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in the repo.

## Conventions

- The product brief at `docs/plan/00-brief.md` is the spec for the whole extension. Each phase prompt at `docs/plan/NN-<slug>.md` is the spec for that phase; `code-review` takes the phase file as its spec source, with the brief behind it.
- Ad-hoc feature work outside the plan uses `.scratch/<feature-slug>/spec.md`, with one ticket per file at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Public bug reports arrive as GitHub Issues on `elrazez/sojourn-timezone-location-spoofer`; the plan files remain the specs, so a report gets triaged into one of them or into `.scratch/`, never treated as a spec itself.
- Triage state is a `Status:` line near the top of an issue file.
- Comments append to the bottom of the file under a `## Comments` heading.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user normally passes the path directly.
