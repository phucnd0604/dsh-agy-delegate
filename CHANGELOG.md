# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-18

### Added

- Renamed the package and plugin identity to the multi-backend `dsh-delegate` / `delegate`, with the loopback-only, origin-checked `/api/delegate/*` routes (#3).
- Extracted the backend adapter seam so the core never imports a CLI directly (#7).
- Added the OpenCode CLI backend alongside the Antigravity CLI, behind one adapter registry (#6).
- Normalized the transcript into one six-kind `Step` union shared by every adapter (#10).
- Replaced the old per-CLI tools with one `delegate` tool and one `delegate_task` tool (#4).
- Rebuilt the floating widget with a per-backend badge and a header tally (#8).
- Shipped both bundled upstream skills, `agy-sub-agent` and `open-code-subagent` (#11).
- Settled the nested config shape (`enabled`, shared `maxConcurrent`, `backends.<id>`), with the old flat agy keys still honoured (#9).
- Discovered adapters from `lib/backends/`, with a conformance harness and recorded fixtures (#12, #2).
- Documented the multi-backend surface in the README and the `docs/adding-a-backend.md` guide (#5).
