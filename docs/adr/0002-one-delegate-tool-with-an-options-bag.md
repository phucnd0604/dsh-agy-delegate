# One `delegate` tool with a per-backend options bag

The prompt-side surface is two tools — `delegate` and `delegate_task` — not two per backend. `delegate` carries
the shared fields (`brief`, `cd`, `model`, `readOnly`, `background`, `waitSeconds`) plus `backend` (an enum built
from the installed adapters) and `options`, a per-backend bag validated against that adapter's
`optionsSchema`.

Rejected: `agy_delegate` + `opencode_delegate` (tight per-CLI schemas) — it reads better with two backends but is
2N hand-written tools, so a fifth CLI means ten tools and a growing `index.js`; and one flat mega-schema — it
advertises `effort` and `conversation` to an opencode dispatch, where they are meaningless.

The cost we accept: `options` is a loosely typed object at the tool boundary. It is paid back inside the adapter,
which rejects unknown keys with a message naming the ones it accepts — so the schema is still enforced, just one
layer in.
