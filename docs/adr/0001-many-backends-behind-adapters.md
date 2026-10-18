# Many backends behind adapters, one registry

The plugin shipped with one hard-wired CLI (agy). Adding a second CLI (opencode) and expecting more later, we
keep one task registry, one route family, one widget and one prompt-side tool vocabulary, and move every
CLI-specific fact into a per-backend descriptor module (`lib/backends/<id>.js`: argv construction, stdin/brief
handling, event parsing, availability probe, model listing, capabilities). The core imports the descriptor
registry, never a backend directly.

Rejected: per-backend copies of the host half (two runners, two widgets, two route families) — every CLI would
duplicate ~500 lines and each new CLI would fork the widget; and a single generic spawner driven by config flags
only — the event streams genuinely differ (agy NDJSON, opencode event JSON), so the parser has to be code, not
config.

Consequence worth knowing: adapters also normalize their own event stream into one `Step` shape, which is what
keeps the widget and `renderTask` from growing a branch per CLI.
