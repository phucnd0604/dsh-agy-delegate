/**
 * The bundled `agy-delegate` skill.
 *
 * The skill ships inside this plugin so a user never has to install it
 * separately: the host half registers it with the `skills` service, which
 * exposes it to every agent exactly like an installed skill, with
 * `resourceBase` pointing at this directory so the `references/*.md` and
 * `scripts/relay.mjs` the skill tells the agent to read actually resolve.
 *
 * `skills/agy-delegate/SKILL.md` stays byte-identical to upstream (see
 * UPSTREAM.md); the one adaptation — telling the agent that the same loop is
 * also available as widget-visible tools in this install — is appended here at
 * registration time, so a future upstream re-copy is a plain file copy.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The skill name agents route by (and the directory name on disk). */
export const BUNDLED_SKILL_NAME = 'agy-delegate';

/** Where the verbatim skill lives inside this package. */
export function bundledSkillDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', BUNDLED_SKILL_NAME);
}

/** One-line routing description for the skill catalog. */
const DESCRIPTION = 'Delegate a bounded coding task to the Google Antigravity CLI (agy) as a background task, '
  + 'then review and land its work — the agy-delegate loop, bundled so no separate skill install is needed.';

/** When an agent should reach for it. */
const WHEN_TO_USE = 'When the user names /agy-delegate, or asks to hand a coding task to agy / the Antigravity CLI, '
  + 'or to run a self-contained brief in another agent\'s own conversation.';

/**
 * The adaptation note appended to the upstream body. It exists because this
 * install offers two paths to the same loop, and an agent that only reads the
 * upstream text would miss the one the user can watch.
 */
const IN_THIS_INSTALL = `
## In this install (dsh-delegate)

This copy ships with the \`dsh-delegate\` plugin, so the skill needs no separate install. The same loop is
also exposed as tools, and those runs appear live in the user's floating agy widget:

- \`agy_delegate { brief, cd, model, effort, readOnly, sandbox, dangerouslySkipPermissions, printTimeout, addDirs, resumeLast, conversation }\`
  dispatches a brief and returns a task id immediately; the widget shows its thinking, answer and tool calls while
  it runs. Several tasks may run at once (4 by default).
- \`agy_task { action: "list" | "status" | "detail" | "wait" | "kill" | "dismiss", id }\` inspects and controls them.

The relay path described above still works and is bundled here at \`scripts/relay.mjs\`. Prefer it when you need its
\`result.json\` artifact — in particular \`touchedFiles\`, which the tool path does not report — and prefer the tools
when the run should be visible in the widget.

Two differences from the relay lane are worth knowing before you dispatch:

- **The project is reused, not recreated.** If the working root already has an agy project, the tool joins it instead
  of opening a new one, so repeated briefs against one repository keep their history (and \`--resume-last\` stays
  meaningful). Pass \`newProject: true\` to force a fresh project.
- **Runs are dispatched with full access** (\`--dangerously-skip-permissions\`), because headless agy cannot answer a
  permission prompt and would otherwise fail on the first tool that needs one. Scope the brief accordingly; pass
  \`dangerouslySkipPermissions: false\` to require pre-granted allow-rules, or \`readOnly: true\` for a sandboxed review
  whose writes are discarded.
`;

/**
 * Build the registration object for the `skills` service.
 * @param dir - the bundled skill directory (defaults to the packaged one).
 * @returns the skill registration, ready for `ctx.skills.register(...)`.
 */
export function bundledSkillRegistration(dir = bundledSkillDir()) {
  const skillPath = join(dir, 'SKILL.md');
  const content = readFileSync(skillPath, 'utf8');
  return {
    name: BUNDLED_SKILL_NAME,
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    path: skillPath,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: dir },
    invocation: { modelInvocable: true, userInvocable: true },
    metadata: {
      plugin: 'dsh-delegate',
      upstream: 'https://github.com/amElnagdy/delegate-skills (MIT)',
    },
    content: `${content.trimEnd()}\n${IN_THIS_INSTALL}`,
  };
}

/**
 * Whether the packaged skill is complete enough to register. A missing file
 * means a broken package, not a broken run, so the caller can warn and carry on.
 * @param dir - the bundled skill directory.
 * @returns the missing paths, empty when the bundle is intact.
 */
export function missingSkillFiles(dir = bundledSkillDir()) {
  const required = [
    'SKILL.md',
    'UPSTREAM.md',
    'scripts/relay.mjs',
    'references/writing-the-brief.md',
    'references/dispatch-and-poll.md',
    'references/review-and-land.md',
    'references/multi-task-queues.md',
  ].map((relative) => join(dir, relative));
  return required.filter((path) => !existsSync(path));
}
