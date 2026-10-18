# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## This repo's layout: multi-context

This repo is **multi-context**: it holds more than one distinctly-named subject area that each deserve their own vocabulary, so there is no single root `GLOSSARY.md`. Instead:

- **`GLOSSARY-MAP.md`** at the repo root is the pointer. It names each context and links to that context's `GLOSSARY.md`. It does not define terms itself.
- **One `GLOSSARY.md` per subproject**, at that subproject's root (for example a context living under `lib/` gets `lib/GLOSSARY.md`).
- **`docs/adr/`** holds system-wide decisions; a context that owns its own decisions may add `<context>/docs/adr/`.

Both `GLOSSARY-MAP.md` and the per-context `GLOSSARY.md` files are created lazily by `/domain-modeling` the first time a real term gets resolved — this setup deliberately created neither, so the map appears when there is something to point at.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root (multi-context, this repo): it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- If `GLOSSARY-MAP.md` is absent, fall back to a root **`GLOSSARY.md`** if one exists.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check the relevant context's `docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context repo (this repo — the layout the root `GLOSSARY-MAP.md` establishes once it exists):

```
/
├── GLOSSARY-MAP.md                   ← pointer: context → its GLOSSARY.md
├── docs/adr/                         ← system-wide decisions
└── <context>/
    ├── GLOSSARY.md
    └── docs/adr/                     ← context-specific decisions
```

For reference, the single-context shape this repo does **not** use:

```
/
├── GLOSSARY.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
