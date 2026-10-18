# Adding a backend

How to put a third coding-agent CLI behind the same `delegate` tool. The core
(`lib/runner.js`, `lib/index.js`, `lib/client.js`) never imports a backend: it reads the
descriptor contract below through `lib/backends/registry.js`. So the whole cost is one adapter
module, one skill directory, and one recorded fixture pair.

Shipped examples: `lib/backends/agy.js` (streamed NDJSON on stdout, project reuse) and
`lib/backends/opencode.js` (JSON lines on stdout, brief on stdin, explicit model, Windows shim),
with `lib/backends/opencode-events.js` as a parser helper. The normative source is
`docs/specs/0001-multi-backend-delegate.md` §5.1, §5.2 and §9.

## There is nothing to register

`lib/backends/registry.js` discovers every `*.js` file in its own directory at load
(`discoverBackends()` → `BUNDLED_BACKENDS`). A file that exports `descriptor` is an adapter; a
file that exports nothing else is skipped; a file that cannot be imported is treated as absent so a
stray file can never stop plugin load. `agy` is the default backend for an unnamed dispatch, the
rest sort by `id`.

Drop `lib/backends/<id>.js` in and the plugin lists it. Do **not** add it to a list somewhere — the
contract test fails if a descriptor file is not discovered, and passes a new adapter with no edit to
the test.

## The descriptor

`lib/backends/<id>.js` exports one plain `descriptor`: data plus pure functions, no class, no
`this`. The full shape, with the methods the contract test requires:

```js
export const descriptor = {
  id: 'mycli',                 // kebab-case; the tool enum value, route field and config key
  label: 'My CLI',             // widget badge and probe display name
  bin: 'mycli',                // executable when the config names no path
  skill: {
    name: 'mycli-sub-agent',   // the bundled skill's registered name
    dir: 'skills/mycli-sub-agent',   // relative to the package root
    upstream: 'https://github.com/…', // source repo; "(MIT)" is appended to the metadata
  },
  capabilities: { /* see "Capabilities" */ },
  defaults: { /* config keys this backend always needs */ },
  optionsSchema: {
    type: 'object',
    properties: { /* the per-dispatch `options` bag */ },
    additionalProperties: false,       // the bag is closed; a foreign key is refused
  },

  probe({ bin, config }) { /* -> { found, version, models, error? }; never throws */ },
  listModels({ bin, config }) { /* -> string[] | null; never throws */ },
  modelRefusal(models) { /* required only when capabilities.modelRequired */ },
  describeModel(model) { /* optional: a label for a model id; the shipped core does not call it yet */ },
  buildArgv(task) { /* -> { argv, stdin?, env?, facts? } */ },
  createStream() { /* -> { push(line), steps(), logs(), result(), info() } */ },
  timeoutMs(task) { /* -> ms for the watchdog, or null */ },
  timeoutMessage(task) { /* -> what the watchdog records */ },
  denialIn(step) { /* -> { tool, message } | null: a live refusal worth killing for */ },
  denialMessage(denial) { /* -> the actionable error text */ },
  settled({ task, stream, code, signal }) { /* -> { status, error?, deniedTool? } */ },
  factsAfterRun(task, stream) { /* fills ids/usage/answer only this CLI carries */ },
  answerOf(steps) { /* -> the answer text the row shows */ },
  legacyConfig(config) { /* optional: read flat config keys from before the seam */ },
};
```

Required methods: `probe`, `listModels`, `buildArgv`, `createStream`, `timeoutMs`,
`timeoutMessage`, `denialIn`, `denialMessage`, `settled`, `factsAfterRun`, `answerOf`.
Optional: `describeModel` (it exists for a row label the core does not call today),
`legacyConfig`. `modelRefusal` is required when
`capabilities.modelRequired` is true. The adapter's config is whatever the user writes under
`config.backends.<id>`, merged over `defaults`.

### Capabilities

| key | meaning |
| --- | --- |
| `modelRequired` | refuse a dispatch that names no model (`modelRefusal` must exist) |
| `modelList` | `probe`/`listModels` can enumerate models for a refusal or the UI |
| `readOnly` | how "look, do not edit" is expressed: `'sandbox'` (agy) or `'plan'` (opencode) |
| `resume` | the `options` keys that continue a session (`resumeLast`, `session`, `conversation`, `project`) |
| `auto` | the backend has an auto-approve dial |
| `fullAccessOption` | the `options` key that means full access; refused together with `readOnly` |
| `projectReuse` | optional: the `options` key that forces a fresh project instead of joining an existing one |

Declare a capability only when it is true of the CLI; the core branches on these rather than on the
backend's name.

### `buildArgv(task)`

`task` carries `{ cd, brief, model, effort, readOnly, sandbox, skipPermissions, printTimeout,
logPath, options, config }`. Return an argv of non-empty strings and hand the brief over **exactly
once** — in one argv slot or on `stdin`. The contract test fails a plan that carries it twice or not
at all.

Keep a multi-line brief out of a shell: opencode puts it on `stdin`, agy uses a single
`--print=<brief>` element. `facts` is an optional object merged onto the task row (agy fills the
project it joined).

### `createStream()`

A CLI's stream is stateful, so the adapter owns one projector per process:

- `push(line)` folds one raw line and returns the steps it produced (an array, or nothing for a line
  that changed nothing). It must never throw: an empty line, partial JSON, a JSON-error line and an
  unknown event type are all normal input, and unknown *fields* on a known event are ignored — the
  Step union is additive.
- `steps()` returns the whole transcript; `logs()` the raw log lines; `result()` the final result
  object; `info()` the session facts.

Surface an unparseable line as a `log` step rather than swallowing it, so a real run's garbage is
visible instead of silent. `lib/parse.js` is agy's fold onto this contract; opencode's lives in
`lib/backends/opencode-events.js`.

Every step is one of six kinds (`lib/step.js`): `thinking`, `answer`, `tool`, `session`,
`cost`, `log`; `at` is epoch milliseconds. The selectors (`answerOf`, `toolsOf`,
`sessionOf`, `costOf`, `countsOf`, `summarizeSteps`, `trimSteps`) are shared, so a backend's
`answerOf` is usually just `answerOf` from `lib/step.js`.

### `settled`, `denialIn`, `factsAfterRun`

- `settled({ task, stream, code, signal })` returns `{ status, error?, deniedTool? }`; an adapter
  returns `done` or `failed`. The other statuses (`running | timeout | killed`) are the runner's own
  verdicts and are decided before `settled` is called. A zero exit is not proof of success — agy
  exits 0 with `SUCCESS` even when every tool was auto-denied, so read the transcript.
- `denialIn(step)` lets the runner kill a run early when a live step shows a permission refusal;
  `denialMessage(denial)` turns one into the actionable error text.
- `factsAfterRun(task, stream)` fills the facts only this CLI carries (`conversationId`,
  `usage`, `answer`, `numTurns`, a project id discovered in the log) onto the task row.

### Windows shims

The CLI on `PATH` is usually a `.cmd` or `.ps1` shim next to the real executable. `probe` and
`listModels` must resolve it (and can then exec it) and must never mistake the shim for a missing
CLI; `lib/runner.js` resolves it too and spawns the real path **without a shell**. Both shipped
adapters use `resolveExecutable` from `lib/exec.js`, and `test/backends.test.mjs` pins the agy case.

## Checklist

1. **Adapter** — `lib/backends/<id>.js` exporting `descriptor`. No registry edit: the directory is
   discovered at load, and `config.backends.<id>` is picked up automatically.
2. **Skill** — `skills/<skill-name>/` with the same layout as the shipped bundles (`SKILL.md`, its
   reference documents, `scripts/relay.mjs`), plus `UPSTREAM.md` recording the source, the pinned
   commit and one blob hash per vendored file. Declare it in `descriptor.skill`; the host registers
   it on mount and appends an "In this install" appendix generated from the descriptor, so the files
   on disk stay byte-identical to upstream.
3. **Fixtures** — record one real run to `test/fixtures/<id>-run.jsonl`, and save the steps the
   adapter should fold it into as `test/fixtures/<id>-run.expected.json` (a non-empty array; each
   object is compared only on the keys it lists, so write down the fields that matter). Both files are
   required for every bundled adapter.
4. **Test** — `npm test` runs `test/backends/contract.test.mjs` against your file with no edit to
   the test: identity, schema and required methods; the brief crossing exactly once; garbage
   tolerance and Step-only output; missing-binary probes; `optionsSchema` refusals; and the fixture
   fold against the expected steps.

## What the core guarantees

- **One registry, one widget, one route family.** Tasks from every backend share ids, the
  `/api/delegate/*` routes and the widget's rows; the widget adds a backend badge and a per-backend
  count, nothing per-CLI.
- **Config resolution.** `{ ...descriptor.defaults, ...descriptor.legacyConfig(config), ...config.backends[<id>] }`
  — the per-backend block wins, then a legacy flat mapping, then your defaults. Two keys are read by
  the core for every backend: `path` (the executable; the descriptor's `bin` when absent) and
  `defaultModel` (an optional default model for a dispatch that names none, never inferred).
- **Refusals before a process starts.** Empty brief; unknown backend; an unknown `options` key or a
  value that contradicts `optionsSchema` (named in the message); a missing model when
  `modelRequired` (`modelRefusal`, free ids first); `readOnly` together with
  `<fullAccessOption>: true`; a dispatch past the shared `maxConcurrent` ceiling.
- **Health is observed, never configured.** The descriptor's `probe` returns
  `{ found, version, models, error? }` for this CLI; the registry adds `id` and `label`, so the route
  reports `{ id, label, found, version, models }`. A missing binary gives `found: false`,
  `version: null`. `probe` and `listModels` must not throw, because the health route stays up
  regardless.
- **Run artifacts.** Every dispatch writes `brief.txt`, `events.jsonl`, `stderr.txt` and a
  relay-shaped `result.json` under `$DSH_HOME/delegate/runs/<task id>/`, plus a backend log named
  after the adapter (`<id>.log`) and `final.txt` once the run has produced an answer.
- **A watchdog around your timeout.** `timeoutMs` plus a grace period, then the process tree is
  killed and `timeoutMessage` is recorded.
