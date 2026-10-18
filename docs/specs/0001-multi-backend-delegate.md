# 0001 — Many backends behind one delegate registry

**Status:** proposed (for review)
**Supersedes:** the one-CLI shape described in `README.md` today
**Decided by:** grilling session on 2 backends → N backends; every decision below was put to the user and accepted.

## 1. Problem

The plugin delegates a brief to exactly one CLI (`agy`). Its host half, its routes, its widget and its
bundled skill all assume Antigravity: `agy_delegate`/`agy_task` tools, `/api/agy-delegate/*` routes,
`agy`-specific spawn and NDJSON parsing, one bundled skill. The user wants a second CLI (`opencode`) now
and more CLIs later, without touching the core each time.

## 2. Goals

- Add `opencode` as a second backend with the same loop: brief → implementer → review → land.
- Make "add a CLI" a one-file change: a new adapter module plus a bundled skill directory.
- Keep one task registry, one widget, one set of routes, one prompt-side tool vocabulary.
- Ship both bundled skills so no separate skill install is needed.
- Keep the current behaviour for `agy` byte-for-byte where the user can see it (transcript, status, widget).

## 3. Non-goals

- No auto-selection of a backend or of a model on the user's behalf (cost is the user's decision).
- No per-backend widgets, routes, or npm packages.
- No worktree management, no auto-commit: the orchestrator commits (unchanged).
- No support for CLIs that cannot run headless.

## 4. Domain vocabulary

Terms live in [../../lib/GLOSSARY.md](../../lib/GLOSSARY.md): **backend**, **backend adapter**, **brief**, **dispatch**,
**implementer**, **orchestrator**, **step**, **task**, **transcript**, **widget**, **capability**.

## 5. Architecture

### 5.1 Adapter seam

Each backend is one module `lib/backends/<id>.js` exporting a plain descriptor (data + pure functions,
no class, no `this`):

```js
export const descriptor = {
  id: 'opencode',                 // tool enum value, route field, config key
  label: 'OpenCode CLI',          // widget badge and probe display name
  bin: 'opencode',                // executable when the config names no path
  skill: {                        // the bundled skill that documents this backend's loop
    name: 'open-code-subagent',
    dir: 'skills/open-code-subagent',
    upstream: 'https://github.com/amElnagdy/delegate-skills', // source repo; "(MIT)" is appended to the metadata
  },
  capabilities: {
    modelRequired: true,          // refuse a dispatch that names no model
    modelList: true,              // adapter can enumerate models for suggestions
    readOnly: 'plan',             // how "look but do not edit" is expressed
    resume: ['resumeLast', 'session'],
    auto: true,                   // has an auto-approve dial
    fullAccessOption: 'auto',     // the options key that means "full access"; refused with readOnly
  },
  defaults: { /* config keys this backend always needs */ },
  optionsSchema: { /* JSON Schema for the per-backend "options" bag */ },

  // Health and identity: observed facts, never configuration.
  probe({ bin }) { /* -> { found, version, models, error? }, never throws */ },
  listModels({ bin }) { /* -> string[] | null, never throws */ },
  modelRefusal(models) { /* -> the missing-model refusal text, free ids first */ },
  describeModel(model) { /* -> short label for the widget row, optional */ },

  // One dispatch: build the command, then judge and describe the run.
  buildArgv(task) { /* -> { argv, stdin?, env?, facts? } */ },
  createStream() { /* -> { push(line) -> event[], steps(), logs(), result(), info() } */ },
  timeoutMs(task) { /* -> ms for the watchdog, or null */ },
  timeoutMessage(task) { /* -> what the watchdog records */ },
  denialIn(event) { /* -> { tool, message } | null: a live refusal worth killing for */ },
  denialMessage(denial) { /* -> the actionable error text */ },
  settled({ task, stream, code, signal }) { /* -> { status, error?, deniedTool? } */ },
  factsAfterRun(task, stream) { /* fills ids/usage/answer only this CLI carries */ },
  answerOf(steps) { /* -> the answer text the row shows */ },

  // Optional: read flat config keys from before the seam (agy does; still honoured — see 5.5).
  legacyConfig(config) { /* -> partial config */ },
};
// parseEvent(line, task) from the first sketch is createStream() in the shipped
// contract: a CLI's stream is stateful (init, deltas, tool results, final), so the
// adapter owns one projector per process instead of a stateless per-line fold.
```

The core (`lib/runner.js`, `lib/index.js`, `lib/client.js`) knows only this contract. It never imports a
backend module directly: `lib/backends/registry.js` collects the installed descriptors and hands them to
the core. Adding CLI number three is `lib/backends/<id>.js` + `skills/<skill-name>/`, nothing else.

### 5.2 Normalized transcript

Every adapter parses its own event stream and emits the same `Step` shape, so the widget and
`renderTask` stay backend-agnostic:

```js
{ kind: 'thinking', text, at }
{ kind: 'answer',   text, at }
{ kind: 'tool',     name, input?, error?, at }
{ kind: 'session',  id, at }        // conversation id, enables resume
{ kind: 'cost',     usd, tokens?, at }
{ kind: 'log',      level, text, at }
```

`at` is epoch milliseconds. `usd` is null when the CLI reports tokens but no price (agy); `tokens`
is that CLI's usage object. `level` is `debug | info | warn | error`. The union and its selectors
(`answerOf`, `toolsOf`, `sessionOf`, `costOf`, `countsOf`, `summarizeSteps`, `trimSteps`) live in
`lib/step.js`; `lib/parse.js` is only agy's fold onto it.

A task row is `{ id, backend, status, startedAt, endedAt, model, cd, toolCalls, steps, answer, error, cost }`.
`status` is one of `running | done | failed | timeout | killed` (unchanged); `cost` is the row-level
`costOf(...).usd` (null when unknown). `steps` counts every kind, so a CLI's own log line is transcript
too.

### 5.3 Prompt-side tools

Two tools, regardless of how many backends exist:

- `delegate { backend, brief, cd?, model?, readOnly?, background?, waitSeconds?, options? }` — `backend` is an
  enum generated from the installed adapters; `options` is the per-backend bag validated against that
  adapter's `optionsSchema`, which is the source of truth for its keys (agy: `effort`, `project`,
  `conversation`, `resumeLast`, `newProject`, `sandbox`, `addDirs`, `printTimeout`, `skipPermissions`,
  `projectsDir`, `reuseProjects`; opencode: `agent`, `resumeLast`, `session`, `auto`, `standalone`, `timeout`).
- `delegate_task { action: list | status | detail | wait | kill | dismiss, id?, waitSeconds? }` — task ids are
  unique across backends, so one control surface suffices.

Refusal rules (all return `{ ok: false, message }` without dispatching): empty brief; unknown backend;
an unknown key in `options`, or a value that contradicts its declared type or enum (validated in `lib/tools.js`
against the chosen adapter's `optionsSchema`, and named in
the message); `model` missing on a backend whose `capabilities.modelRequired` is true (the message lists free
models first, then the rest, from a live `listModels()` call); `readOnly` combined with an explicit full-access
request (`options[capabilities.fullAccessOption] === true`); dispatch past the concurrency ceiling (the
runner's, because it is machine load).

### 5.4 Routes and probe

Route family `/api/delegate/*`: `probe`, `tasks`, `task`, `kill`, `dismiss` (loopback-only, unchanged guard).

`probe` reports observed health, not configuration:

```json
{ "ok": true, "enabled": true, "running": 1,
  "backends": [{ "id": "agy", "label": "...", "found": true, "version": "1.0.x", "models": null },
               { "id": "opencode", "label": "...", "found": true, "version": "2.0.32", "models": ["opencode/beam-free", "..."] }],
  "skills": [{ "name": "agy-sub-agent", "registered": true, "reason": null },
             { "name": "open-code-subagent", "registered": true, "reason": null }] }
```

### 5.5 Configuration

```js
{
  enabled: true,
  maxConcurrent: 4,                       // shared across backends: it is machine load, not a CLI limit
  backends: {
    agy:      { path: 'agy', printTimeout: '30m', skipPermissions: true, projectsDir: undefined, reuseProjects: undefined },
    opencode: { path: 'opencode', printTimeout: '30m', auto: true, defaultModel: undefined },
  },
}
```

Backward compatibility: the old flat keys (`agyPath`, `printTimeout`, `skipPermissions`, `projectsDir`,
`reuseProjects`) are still read and mapped into `backends.agy`. `defaultModel` is never inferred — a model is
only used as a default if the user wrote it down.

### 5.6 Bundled skills

One skill per adapter, one directory per skill, both registered on mount even when the CLI is absent
(the skill is documentation; `probe` is where "not installed" is reported):

| backend | skill directory | skill name |
| --- | --- | --- |
| agy | `skills/agy-sub-agent/` (renamed from `skills/agy-delegate/`) | `agy-sub-agent` |
| opencode | `skills/open-code-subagent/` (copied verbatim from the upstream `opencode-delegate` skill) | `open-code-subagent` |

Each `SKILL.md` stays byte-identical to its upstream copy; an `UPSTREAM.md` records the source, the pinned
commit, and one git blob hash per vendored file, so drift is detectable offline. The "In this install"
appendix is generated from the adapter's descriptor and appended at registration time (the pattern in
`lib/skill.js`), so an upstream refresh is a plain file copy. Both bundles are pinned at
`amElnagdy/delegate-skills` commit `3aa72d681a79e2a9d09bd9a316353003ae1cb4a7` (2026-10-14), recorded in
each `UPSTREAM.md`.

`bundledSkills(backends)` derives the bundles from the descriptors, so a new adapter ships its skill by
declaring `skill: { name, dir, upstream }` — nothing in `lib/skill.js` names a CLI. The registered name is
the descriptor's; the upstream frontmatter keeps its own `name:` because the file is copied verbatim. A
descriptor may also declare `capabilities.projectReuse` (agy names `'newProject'`) when a dispatch joins
the root's existing project instead of opening a new one; the value is the `options` key that forces a
fresh project.

### 5.7 Widget

One floating widget, one row per task, newest first, a backend badge (`agy` / `opencode`) on each row, and a
header count (`2 running (1 agy, 1 opencode)`). No per-backend filter chips — the widget stays small.

## 6. Backend: agy (no behaviour change)

Wraps today's code: NDJSON on stdout, `--add-dir` workspace, `--print-timeout`, `--dangerously-skip-permissions`
by default, `readOnly` = sandbox, project reuse keyed by `cd`, `resumeLast` / `conversation` passthrough.

## 7. Backend: opencode (new)

- **Spawn:** `opencode run --format json [--session <id> | --continue] --agent <build|plan> --model <provider/model>[#variant] [--auto]`
  with the brief piped on **stdin** (no argv quoting issues for multi-line, XML-tagged briefs); working
  directory = `cd`; events are JSON lines on stdout. `--pure` is emitted only when the installed CLI
  advertises it — 2.0.32 does not, so it is not sent (an unknown flag would fail every dispatch).
- **Model policy:** `modelRequired: true`; the `delegate` tool refuses a model-less dispatch before the runner
  sees it (the runner keeps the same gate as the last line of defence), so a missing model never starts a process. Missing model → refusal listing `opencode models` filtered to
  `/-free$/` first (11 today: `opencode/beam-free`, `opencode/deepseek-v4.1-flash-free`,
  `opencode/glm-5.3-flash-free`, `opencode/nemotron-3.5-lightning-free`, …), then the `opencode-go/*`
  subscription models; never auto-picked. `config.backends.opencode.defaultModel` is an explicit opt-in.
- **Read-only:** `readOnly` → `--agent plan` and **never** `--auto` (auto-approving a plan agent's ask-gated
  edit permissions would defeat "read-only", the exact reason the upstream relay does the same).
- **Auto:** `--auto` by default on a build run (headless cannot answer a prompt); `options.auto: false`
  honours the agent's own permission config.
- **Resume:** session id is captured from the event stream into a `session` step; `options.resumeLast` →
  `--continue`, `options.session` → `--session <id>`.
- **Cost:** the `cost` step is populated when the stream reports it — one step summed across the run's
  `step_finish` events (a free model reports `0`, which is a real cost, not a missing one).
- **Windows:** the CLI on PATH is a `.ps1`/`.cmd` shim next to `opencode.exe`; spawn the resolved executable
  without a shell, and cover it with a test.

## 8. Documentation deliverables

- `README.md`: a backend table, the two tool names, the `/api/delegate/*` routes, and the config block.
- `docs/adding-a-backend.md`: the descriptor contract, a checklist (adapter + skill + fixture + contract test),
  and the "what the core guarantees" list.
- `docs/adr/0001-many-backends-behind-adapters.md`, `docs/adr/0002-one-delegate-tool-with-an-options-bag.md`.
- `lib/GLOSSARY.md` updated with the terms this spec settles.

## 9. Testing

- `test/backends/contract.test.mjs`: every installed adapter must satisfy the contract — `buildArgv` returns an
  argv array with the brief on stdin or in one argv slot, `parseEvent` never throws on garbage/empty/JSON-error
  lines, `probe` and `listModels` never throw when the binary is missing, `optionsSchema` rejects unknown keys.
- Fixture-driven parser tests: recorded agy NDJSON and recorded opencode event JSON → expected steps.
- Config compatibility test: old flat keys still map to `backends.agy`.
- Widget render test: two backends side by side, badge and count.
- `test/tools.test.mjs`: refusal messages for unknown backend, missing model, unknown option, an option value
  that contradicts its schema, and shared-field shadowing; the concurrency ceiling is pinned in `test/runner.test.mjs`.

## 10. Migration and breaking changes

| today | after |
| --- | --- |
| package `dsh-agy-delegate` / id `agy-delegate` | `dsh-delegate` / `delegate` |
| routes `/api/agy-delegate/*` | `/api/delegate/*` |
| tools `agy_delegate`, `agy_task` | `delegate`, `delegate_task` |
| skill `agy-delegate` | skill `agy-sub-agent` (+ new `open-code-subagent`) |
| config `agyPath`, `printTimeout`, `skipPermissions`, … | `backends.agy.*` (old keys still honoured) |
| GitHub repo `phucnd0604/dsh-agy-delegate` | `phucnd0604/dsh-delegate` (already renamed) |

The renamed package ships its first public release as 0.1.0 (the dsh-agy-delegate line is retired). No compatibility shims for the old tool names (single user, 0.1.0); the old flat config
keys are the one exception, kept because a live install may be running with them.

## 11. Risks

- **opencode event schema drift** (2.x folds `--variant` into the model value, 1.x does not): pin behaviour by
  capability detection from `--version`, and keep the parser tolerant of unknown event types.
- **agy NDJSON format churn**: parser tolerance plus fixtures recorded today.
- **Windows spawn of npm shims**: resolved by spawning the executable path, not the shim, and tested.
- **Install churn from the rename**: an existing profile shows the new package as a new plugin; documented in
  the README upgrade note.

## 12. Tickets

The map issue mirrors this spec; children are one brief each (see the map for the live list and blocking edges).
