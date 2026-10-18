# dsh-delegate

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that hands a brief to the
**Antigravity CLI** (`agy`) as a **background task**, and shows that task live in a floating
widget: thinking, answer, tool calls, logs and usage arrive while agy is still working.

It implements the same loop as the **agy-delegate skill** — you write the brief, agy types in its
own conversation, you review and land the result — but replaces the skill's "run a command and poll
`result.json`" dispatch with a streamed one, because `--print` alone only tells you the answer once
the run is over.

## Requirements

- `agy` installed and logged in (`agy models` succeeds).
- DSH with the web profile (the widget lives in the browser half).

Check the install before trusting it — the unit tests are free, the scripts each
spend real agy runs:

```bash
node --test test/*.test.mjs              # pure logic: NDJSON projection, widget renders, project lookup, skill payload
node scripts/smoke.mjs                   # one real agy round trip through the runner
node scripts/verify-project-reuse.mjs    # two real briefs: full access by default, then the same project reused
node scripts/verify-host-half.mjs        # mounts the host half on a fake context and drives the tool plus the
                                         # widget's own HTTP routes against live agy (21 checks: skill registration,
                                         # loopback guard, dispatch, reuse, route payloads)
```

## Install

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-delegate
```

then mount it by adding a row to that profile's `cordis.patch.yml`:

```yaml
- id: delegate
  name: dsh-delegate
```

Restart the app (or reload the profile). No build step: the package ships plain ESM in `lib/`, and
the browser half is a hand-written module-loader closure factory, so `npm run build` does not exist
by design.

## Configuration

Optional keys on the plugin's row in `cordis.patch.yml`:

```yaml
- id: delegate
  name: dsh-delegate
  config:
    agyPath: agy          # the agy executable
    printTimeout: 30m     # default print timeout when a dispatch omits one
    maxConcurrent: 4      # concurrent agy runs; a dispatch past it is refused, not queued
    skipPermissions: true # full access by default (see below); false requires agy allow-rules
    reuseProjects: true   # join the root's existing agy project instead of opening one
    projectsDir: null     # agy's project registry (default ~/.gemini/config/projects)
    enabled: true
```

## Bundled skill

The plugin ships the `agy-delegate` skill, so `/agy-delegate` works without the skill being
installed: `skills/agy-delegate/` holds a verbatim copy of upstream (SKILL.md, the four reference
documents and `scripts/relay.mjs`) and the host half registers it with the `skills` service, pointing
`resourceBase` at that directory so the references and the relay resolve. Upstream is delegate-skills
by Ahmed Mohammed (amElnagdy), MIT — see `skills/agy-delegate/UPSTREAM.md`. The only difference from
upstream is a short "In this install" note appended to the text an agent reads; `SKILL.md` on disk
stays byte-identical, so re-copying it from upstream is a plain file copy.

If the profile has no `skills` service the registration is skipped with a warning and everything else
still works; if the user has their own copy installed, that copy wins the name, which is the point of
letting a user override a plugin.

## Dispatch semantics

Two deliberate differences from the skill's relay lane:

- **The project is reused.** Before dispatching, the plugin looks the working root up in agy's project
  registry (`~/.gemini/config/projects/*.json`) and joins the project that already owns it. Repeated
  briefs against one repository therefore share its history and `--resume-last` stays meaningful,
  instead of scattering the repo across a project per dispatch. Only a root with no project gets a new
  one; `newProject: true` forces that. `result.json` and the widget's detail line report which project
  the run joined.
- **Runs use full access.** `--dangerously-skip-permissions` is passed by default, because headless
  agy cannot answer a permission prompt and a run without it dies on the first tool that needs one.
  Scope the brief accordingly; `dangerouslySkipPermissions: false` requires pre-granted allow-rules,
  and `readOnly: true` still means sandboxed plus auto-approved inside the sandbox, with writes
  discarded.

## Use

The agent-facing tools:

| Tool | What it does |
| --- | --- |
| `agy_delegate` | Dispatch a brief. Returns immediately with a task id (`background: false` blocks instead). |
| `agy_task` | `list` / `status` / `detail` / `wait` / `kill` / `dismiss` — inspect and control tasks. |

`agy_delegate` arguments mirror the skill's dispatch flags: `brief` (required), `cd`, `model`,
`effort`, `readOnly` (agy sandbox + auto-approved tools inside it), `sandbox`,
`dangerouslySkipPermissions` (default true — see "Dispatch semantics"), `newProject`, `printTimeout`,
`addDirs`, `resumeLast`, `conversation`, `project`. `readOnly` plus an explicit
`dangerouslySkipPermissions` is refused, exactly as in the skill.

The widget always sits in the frame-wide `shell.overlay` layer: a pill showing the running count
(`0 tasks` when idle), expanding into the task list — several delegations can be in flight, and the
empty list is itself the answer to "is anything running?" — and, for one task, its live transcript.
Drag its header to move it (or use the header's reset button, or arrow keys while it is focused);
the corner is remembered per browser, and the panel is clamped to the viewport so it can never grow
off-screen.

## Layout

```
lib/index.js    host half: tools + loopback /api/delegate/* routes
lib/runner.js   agy spawn, task registry, run artifacts, watchdog, tree kill
lib/parse.js    pure NDJSON -> events/steps projection (the only unit-tested logic)
lib/client.js   browser half: the floating widget
scripts/smoke.mjs  one real end-to-end agy run
```

Every run writes `brief.txt`, `events.jsonl`, `agy.log`, `stderr.txt`, `final.txt` and a
relay-shaped `result.json` under `$DSH_HOME/delegate/runs/<task id>/`.

The HTTP routes are loopback-only and origin-checked; they answer only this machine's GUI.

## Deliberate limits

- The task registry is **in memory**: restarting the host forgets tasks (the run directories on disk
  stay). Running agy children are killed on host shutdown.
- No `touchedFiles` report. The skill's `relay.mjs` fingerprints the working tree for that; run the
  relay when a review needs it. This plugin reports the stream, not the diff.
- No lane resolution (`--lane`): pass `model` / `effort` explicitly.

## License

MIT
