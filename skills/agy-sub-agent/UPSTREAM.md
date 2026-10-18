# Bundled from delegate-skills

The files in this directory are a verbatim copy of the `agy-delegate` skill from
**delegate-skills** by Ahmed Mohammed (amElnagdy): https://github.com/amElnagdy/delegate-skills

Pinned at commit `3aa72d681a79e2a9d09bd9a316353003ae1cb4a7` (2026-10-14). They ship inside the `dsh-delegate` plugin so the skill
works without a separate install. The only difference from upstream is that the plugin appends a short
"In this install" note (see `lib/skill.js`) to the text the agent reads; `SKILL.md` on disk stays
byte-identical to upstream. An upstream refresh is a plain file copy plus a new commit hash here.

## Pinned files

Git blob hashes at that commit; `git hash-object <file>` (or `test/skill.test.mjs`) must reproduce them:

| file | git blob |
| --- | --- |
| `SKILL.md` | `4e275813408677dad20363ea996a97c5d6afaaff` |
| `references/writing-the-brief.md` | `5d3a6164114a98e08609bca3b647ca142114ab10` |
| `references/dispatch-and-poll.md` | `53ad2d3d04ef67dea558ac21760c2373f9fe2ec4` |
| `references/review-and-land.md` | `3372a09a395d6e81f9a8b372649558c639d9d777` |
| `references/multi-task-queues.md` | `af3a4d68de44d13a8bd5076eec5d48fcd229efa4` |
| `scripts/relay.mjs` | `100d8d9bc2ddda7dbfcf43f7f89a042e90459f0a` |

Upstream license:

MIT License

Copyright (c) 2026 Ahmed Mohammed (amElnagdy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
