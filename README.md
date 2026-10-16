# dsh-agy-delegate

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

Check the install before trusting it:

```bash
node scripts/smoke.mjs          # one real agy round trip: dispatch, stream, result.json
node --test test/*.test.mjs     # pure NDJSON projection logic
```

## Install

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-agy-delegate
```

then mount it by adding a row to that profile's `cordis.patch.yml`:

```yaml
- id: agy-delegate
  name: dsh-agy-delegate
```

Restart the app (or reload the profile). No build step: the package ships plain ESM in `lib/`, and
the browser half is a hand-written module-loader closure factory, so `npm run build` does not exist
by design.

## Use

The agent-facing tools:

| Tool | What it does |
| --- | --- |
| `agy_delegate` | Dispatch a brief. Returns immediately with a task id (`background: false` blocks instead). |
| `agy_task` | `list` / `status` / `detail` / `wait` / `kill` / `dismiss` — inspect and control tasks. |

`agy_delegate` arguments mirror the skill's dispatch flags: `brief` (required), `cd`, `model`,
`effort`, `readOnly` (agy sandbox + auto-approved tools inside it), `sandbox`,
`dangerouslySkipPermissions`, `printTimeout`, `addDirs`, `resumeLast`, `conversation`, `project`.
`readOnly` and `dangerouslySkipPermissions` are mutually exclusive, exactly as in the skill.

The widget appears in the frame-wide `shell.overlay` layer as soon as a task exists: a pill with the
running count, expanding into the task list and a live transcript per task. Drag its header to move
it; the corner is remembered per browser.

`agy` processes can only edit what its own permissions allow. Headless agy cannot answer a
permission prompt, so a run that needs a denied tool fails with an explicit message instead of
silently doing nothing — grant the tool in agy's settings, or dispatch with `readOnly` /
`dangerouslySkipPermissions`.

## Layout

```
lib/index.js    host half: tools + loopback /api/agy-delegate/* routes
lib/runner.js   agy spawn, task registry, run artifacts, watchdog, tree kill
lib/parse.js    pure NDJSON -> events/steps projection (the only unit-tested logic)
lib/client.js   browser half: the floating widget
scripts/smoke.mjs  one real end-to-end agy run
```

Every run writes `brief.txt`, `events.jsonl`, `agy.log`, `stderr.txt`, `final.txt` and a
relay-shaped `result.json` under `$DSH_HOME/agy-delegate/runs/<task id>/`.

The HTTP routes are loopback-only and origin-checked; they answer only this machine's GUI.

## Deliberate limits

- The task registry is **in memory**: restarting the host forgets tasks (the run directories on disk
  stay). Running agy children are killed on host shutdown.
- No `touchedFiles` report. The skill's `relay.mjs` fingerprints the working tree for that; run the
  relay when a review needs it. This plugin reports the stream, not the diff.
- No lane resolution (`--lane`): pass `model` / `effort` explicitly.

## License

MIT
