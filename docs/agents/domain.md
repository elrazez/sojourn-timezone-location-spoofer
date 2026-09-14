# Domain Docs

How the engineering skills consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary.
- **`docs/adr/`**: read the ADRs that touch the area you are about to work in.

If `docs/adr/` does not exist yet, proceed silently. The `domain-modeling` skill creates it when the first decision is recorded.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   └── 0001-<slug>.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in a test name, a module name, a commit message, a hypothesis), use the term as defined in `CONTEXT.md`. Do not drift to the synonyms the glossary avoids.

If the concept you need is not in the glossary yet, that is a signal: either you are inventing language the project does not use (reconsider) or there is a real gap (add it through `domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (override mechanism), but worth reopening because…_
