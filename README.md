# dsh-delegate

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that hands a brief to a
**coding-agent CLI** as a **background task**, and shows that task live in a floating
widget: thinking, answer, tool calls, logs and usage arrive while the CLI is still working.

Two backends ship today — the **Antigravity CLI** (`agy`) and the **OpenCode CLI**
(`opencode`) — behind one tool vocabulary, one task registry and one widget. A third CLI is one
adapter module plus its skill directory and a recorded fixture pair; see
[docs/adding-a-backend.md](docs/adding-a-backend.md).

It implements the same loop as the **delegate skills it bundles** — you write the brief, the CLI types
in its own conversation, you review and land the result — but replaces the skills' "run a command and poll
`result.json`" dispatch with a streamed one, because `--print` alone only tells you the answer once
the run is over.

## Backends

| Backend | CLI | Bundled skill | Model policy |
| --- | --- | --- | --- |
| `agy` | Antigravity CLI (`agy`) | `agy-sub-agent` | agy picks a model; `--model` is optional |
| `opencode` | OpenCode CLI (`opencode`) | `open-code-subagent` | must name `provider/model`; the refusal lists free ids first |

`probe` reports each one's observed health (`found`, `version`, `models`) — configuration never
pretends a CLI is installed. Which backends exist, and what each accepts, comes from the installed
adapters; [docs/adding-a-backend.md](docs/adding-a-backend.md) is how another one joins.

## Requirements

- At least one backend CLI installed and logged in (`agy --version` answers, or `opencode --version`
  plus `opencode models` lists the models — the plugin's `probe` runs exactly those).
- DSH with the web profile (the widget lives in the browser half).

Check the install before trusting it — the unit tests are free, the scripts each
spend real agy runs:

```bash
node --test test/*.test.mjs test/backends/*.test.mjs   # pure logic: transcript projection, adapter contract, widget renders, project lookup, skill payload
node scripts/smoke.mjs                   # one real agy round trip through the runner
node scripts/verify-project-reuse.mjs    # two real briefs: full access by default, then the same project reused
node scripts/verify-host-half.mjs        # mounts the host half on a fake context and drives the tool plus the
                                         # widget's own HTTP routes against live agy (21 checks: skill registration,
                                         # loopback guard, dispatch, reuse, route payloads)
```

`test/backends/contract.test.mjs` runs the adapter contract from
`docs/specs/0001-multi-backend-delegate.md` §5.1 against every descriptor discovered in
`lib/backends/`, and folds each adapter's recorded run fixture against its expected steps.

## Install

```bash
dsh plugin --profile <profile> add github:phucnd0604/dsh-delegate
```

pnpm adds the package and records it in the profile's bundles; the package's own
`cordis.patch.yml` inserts the plugin, so no hand edit is needed. From a local checkout, use
`link:/absolute/path/to/dsh-delegate` instead of the `github:` spec.

To mount it by hand instead, the package resolves as a plugin row in the profile's
`cordis.patch.yml`:

```yaml
- id: delegate
  name: dsh-delegate
```

Restart the app (or reload the profile). No build step: the package ships plain ESM in `lib/`, and
the browser half is a hand-written module-loader closure factory, so `npm run build` does not exist
by design.

## Configuration

Optional keys on the plugin's row in the profile config:

```yaml
- id: delegate
  name: dsh-delegate
  config:
    enabled: true
    maxConcurrent: 4          # shared across backends: machine load, not a per-CLI limit
    backends:
      agy:
        path: agy             # the agy executable
        printTimeout: 30m     # default print timeout when a dispatch omits one
        skipPermissions: true # full access by default (see below); false requires agy allow-rules
        reuseProjects: true   # join the root's existing agy project instead of opening one
        projectsDir: null     # agy's project registry (default ~/.gemini/config/projects)
      opencode:
        path: opencode        # the opencode executable
        printTimeout: 30m     # watchdog window when a dispatch omits `timeout`
        auto: true            # build runs auto-approve; false honours the agent's permission config
        defaultModel: null    # never inferred; set it to opt into a default model
```

The flat `agyPath` / `printTimeout` / `skipPermissions` / `projectsDir` / `reuseProjects` keys
from 0.1.0 are still read and map into `backends.agy`; a `backends.agy` key wins when both name
the same thing (see the upgrade note). `enabled: false` mounts nothing. Under every backend the core
reads `path` (the executable) and `defaultModel` (an optional default model, never inferred); the
rest of the block is the adapter's own, and its `defaults` fill whatever the user omits.

## Bundled skills

The plugin ships one skill per backend — `agy-sub-agent` for the Antigravity CLI and
`open-code-subagent` for OpenCode — so `/agy-sub-agent` and `/open-code-subagent` work without a
separate skill install. `skills/agy-sub-agent/` and `skills/open-code-subagent/` each hold a verbatim
copy of upstream (SKILL.md, the four reference documents and `scripts/relay.mjs`), and the host half
registers both with the `skills` service, pointing `resourceBase` at that directory so the references
and the relay resolve. Upstream is delegate-skills by Ahmed Mohammed (amElnagdy), MIT, pinned at commit
`3aa72d6` — see each bundle's `UPSTREAM.md`. The only difference from upstream is a short "In this
install" note generated from the adapter's descriptor and appended to the text an agent reads; each
`SKILL.md` on disk stays byte-identical, so re-copying it from upstream is a plain file copy.

If the profile has no `skills` service the registrations are skipped with a warning and everything else
still works; if the user has their own copy installed, that copy wins the name, which is the point of
letting a user override a plugin.

## Dispatch semantics

Two deliberate differences from the skill's relay lane:

- **The project is reused.** Before dispatching, the plugin looks the working root up in agy's project
  registry (`~/.gemini/config/projects/*.json`) and joins the project that already owns it. Repeated
  briefs against one repository therefore share its history and `--resume-last` stays meaningful,
  instead of scattering the repo across a project per dispatch. Only a root with no project gets a new
  one; `options.newProject: true` (agy) forces that. `result.json` reports which project the run joined. (opencode has no project registry; it continues a session with `--continue` or
  `--session <id>`.)
- **Runs use full access.** agy gets `--dangerously-skip-permissions` by default, because headless
  agy cannot answer a permission prompt and a run without it dies on the first tool that needs one;
  opencode build runs get `--auto` for the same reason. Scope the brief accordingly;
  `options.skipPermissions: false` on agy requires pre-granted allow-rules, and `options.auto: false`
  on opencode honours the agent's own permission config. `readOnly: true` still means agy sandboxed
  plus auto-approved inside the sandbox (writes discarded) and opencode's `--agent plan` with no
  `--auto`.

## Use

The agent-facing tools:

| Tool | What it does |
| --- | --- |
| `delegate` | Dispatch a brief to one installed backend. Returns immediately with a task id (`background: false` blocks instead). |
| `delegate_task` | `list` / `status` / `detail` / `wait` / `kill` / `dismiss` — inspect and control tasks. |

`delegate` takes `brief` (required), `backend`, `cd`, `model`, `readOnly`, `background`,
`waitSeconds`, and a per-backend `options` bag (`agy`: `effort`, `project`, `conversation`,
`resumeLast`, `newProject`, `sandbox`, `addDirs`, `printTimeout`, `skipPermissions`, `projectsDir`,
`reuseProjects`; `opencode`: `agent`, `resumeLast`, `session`, `auto`, `standalone`, `timeout`).
Task ids are unique across backends, so one control surface (and one `delegate_task`) covers every
run. An unknown option key is refused by name, and so is a value that contradicts the option's declared
type or enum. `readOnly` plus an explicit full-access option (`agy`: `skipPermissions`; `opencode`:
`auto`) is refused. Which backends exist, and what each accepts, comes from the installed adapters —
see `docs/specs/0001-multi-backend-delegate.md` §5.3.

The widget always sits in the frame-wide `shell.overlay` layer: a pill showing the running count
(`0 tasks` when idle), expanding into the task list — several delegations can be in flight, and the
empty list is itself the answer to "is anything running?" — one row per task with its input and its
latest output, and a backend badge. Drag its header to move it (or use the header's reset button, or
arrow keys while it is focused); the corner is remembered per browser, and the panel is clamped to the
viewport so it can never grow off-screen.

The routes the widget reads and drives are the loopback-only, origin-checked family
`/api/delegate/probe`, `/api/delegate/tasks`, `/api/delegate/task`, `/api/delegate/kill` and
`/api/delegate/dismiss`.

## Upgrade note: from the dsh-agy-delegate plugin

The second backend renamed the package and moved the agy config under `backends`. Nothing keeps the
old tool names, so update anything that used them:

| before (dsh-agy-delegate) | now (dsh-delegate) |
| --- | --- |
| package `dsh-agy-delegate`, plugin id `agy-delegate` | `dsh-delegate`, plugin id `delegate` |
| routes `/api/agy-delegate/*` | `/api/delegate/*` |
| tools `agy_delegate`, `agy_task` | `delegate`, `delegate_task` |
| skill `agy-delegate` | skill `agy-sub-agent` (plus the new `open-code-subagent`) |
| config `agyPath`, `printTimeout`, `skipPermissions`, `projectsDir`, `reuseProjects` | `backends.agy.*` (the flat keys are still honoured) |
| repo `phucnd0604/dsh-agy-delegate` | `phucnd0604/dsh-delegate` |

The old flat config keys are the one compatibility exception, kept because a live install may still be
running with them; everything else expects the new names.

## Layout

```
lib/index.js        host half: tools + loopback /api/delegate/* routes
lib/runner.js       spawn, task registry, run artifacts, watchdog, tree kill
lib/step.js         the normalized Step union and its selectors
lib/backends/       one descriptor per CLI; registry.js discovers them from the directory
lib/backends/agy.js opencode.js  the two shipped adapters
lib/backends/opencode-events.js  opencode's JSON-line projector
lib/parse.js        agy's NDJSON fold (agy-only)
lib/client.js       browser half: the floating widget
scripts/smoke.mjs   one real end-to-end agy run
```

Every run writes `brief.txt`, `events.jsonl`, `stderr.txt` and a relay-shaped `result.json` under
`$DSH_HOME/delegate/runs/<task id>/`, plus a backend log named after the adapter (`agy.log`,
`opencode.log`) and `final.txt` once the run has produced an answer.

The HTTP routes are loopback-only and origin-checked; they answer only this machine's GUI.

## Deliberate limits

- The task registry is **in memory**: restarting the host forgets tasks (the run directories on disk
  stay). Running CLI children are killed on host shutdown.
- No `touchedFiles` report. The skill's `relay.mjs` fingerprints the working tree for that; run the
  relay when a review needs it. This plugin reports the stream, not the diff.
- No lane resolution (`--lane`): pass `model` / `effort` explicitly.

## License

MIT
