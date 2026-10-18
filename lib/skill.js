/**
 * The bundled delegate skills — one per backend adapter.
 *
 * Every adapter that declares a `skill` ships its upstream copy inside this
 * package, so a user never has to install the skill separately: the host half
 * registers each bundle with the `skills` service, which exposes it to agents
 * exactly like an installed skill, with `resourceBase` pointing at the shipped
 * directory so the `references/*.md` and `scripts/relay.mjs` the skill tells
 * the agent to read actually resolve.
 *
 * Each `SKILL.md` stays byte-identical to upstream (see `UPSTREAM.md`); the one
 * adaptation — telling the agent that the same loop is also available as
 * widget-visible tools in this install — is generated from the descriptor and
 * appended here at registration time, so a future upstream re-copy is a plain
 * file copy. The upstream frontmatter keeps its own `name:` (the file is copied
 * verbatim), but the name that resolves is the registered one: the skills
 * registry keys runtime registrations by the registration's `name`, not by
 * frontmatter.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { optionKeys } from './tools.js';

/** The package root, so a descriptor's `skill.dir` can stay relative. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The license every bundled copy carries; appended to the registration's `upstream`. */
const UPSTREAM_LICENSE = 'MIT';

/**
 * The files a bundle must carry to be worth registering. Exported because
 * `UPSTREAM.md` pins one git blob hash per vendored file, and a test walks the
 * same list.
 */
export const REQUIRED_FILES = [
  'SKILL.md',
  'UPSTREAM.md',
  'scripts/relay.mjs',
  'references/writing-the-brief.md',
  'references/dispatch-and-poll.md',
  'references/review-and-land.md',
  'references/multi-task-queues.md',
];

/**
 * The skills this plugin ships: one per adapter that declares one.
 * @param backends - the registry from `createBackends`.
 * @returns `[{ backend, name, dir, descriptor }]`, in dispatch order.
 */
export function bundledSkills(backends) {
  return backends.list()
    .filter(({ descriptor }) => {
      const skill = descriptor?.skill;
      return typeof skill?.name === 'string' && typeof skill?.dir === 'string' && typeof skill?.upstream === 'string';
    })
    .map(({ descriptor }) => ({
      backend: descriptor.id,
      name: descriptor.skill.name,
      dir: join(PACKAGE_ROOT, descriptor.skill.dir),
      descriptor,
    }));
}

/** One-line routing description for the skill catalog. */
function descriptionFor(descriptor) {
  return `Delegate a bounded coding task to the ${descriptor.label} as a background task, then review and land `
    + `its work — the ${descriptor.skill.name} loop, bundled so no separate skill install is needed.`;
}

/** When an agent should reach for it. */
function whenToUseFor(descriptor) {
  return `When the user names /${descriptor.skill.name}, or asks to hand a coding task to ${descriptor.id} / the `
    + `${descriptor.label}, or to run a self-contained brief in another agent's own conversation.`;
}

/**
 * The adaptation note appended to the upstream body, built from the adapter's
 * descriptor. It exists because this install offers two paths to the same loop,
 * and an agent that only reads the upstream text would miss the one the user can
 * watch — plus the per-backend option key that grants full access.
 * @param bundle - as returned by `bundledSkills`.
 */
function installNote({ descriptor }) {
  const capabilities = descriptor.capabilities ?? {};
  const lane = String(capabilities.readOnly ?? 'no writes');
  const options = optionKeys(descriptor).map((key) => `\`${key}\``).join(', ');

  const lines = [
    '## In this install (dsh-delegate)',
    '',
    'This copy ships with the `dsh-delegate` plugin, so the skill needs no separate install. The same loop is',
    "also exposed as two tools, and those runs appear live in the user's floating widget:",
    '',
    `- \`delegate { brief, backend: "${descriptor.id}", cd, model, readOnly, options }\` dispatches a brief to the`,
    `  ${descriptor.label} and returns a task id immediately; the widget shows its thinking, answer and tool calls`,
    "  while it runs. Several tasks may run at once (up to the plugin's `maxConcurrent` ceiling). `options` is this",
    `  backend's bag — ${options}.`,
  ];
  if (capabilities.modelRequired === true) {
    lines.push('  This backend has no default model: a dispatch without `model` is refused with its models listed, free ones first.');
  }
  lines.push(
    '- `delegate_task { action: "list" | "status" | "detail" | "wait" | "kill" | "dismiss", id }` inspects and controls them.',
    '',
    'The relay path described above still works and is bundled here at `scripts/relay.mjs`. Prefer it when you need its',
    '`result.json` artifact — in particular `touchedFiles`, which the tool path does not report — and prefer the tools',
    'when the run should be visible in the widget.',
    '',
    'Differences from the relay lane are worth knowing before you dispatch:',
    '',
  );
  if (typeof capabilities.projectReuse === 'string') {
    const key = capabilities.projectReuse;
    lines.push(
      '- **The project is reused, not recreated.** If the working root already has a project, the tool joins it instead',
      '  of opening a new one, so repeated briefs against one repository keep their history (and resuming the last',
      `  conversation stays meaningful). Pass \`options.${key}: true\` to force a fresh project.`,
    );
  }
  if (typeof capabilities.fullAccessOption === 'string') {
    const key = capabilities.fullAccessOption;
    lines.push(
      `- **Runs are dispatched with full access** (\`options.${key}\`), because a headless CLI cannot answer a permission`,
      '  prompt and would otherwise fail on the first tool that needs one. Scope the brief accordingly; pass',
      `  \`options.${key}: false\` to require pre-granted rules, or \`readOnly: true\` for the no-edits lane (${lane}).`,
    );
  }
  return `\n${lines.join('\n')}\n`;
}

/**
 * Build the registration object for the `skills` service.
 * @param bundle - one entry from `bundledSkills`.
 * @returns the skill registration, ready for `ctx.skills.register(...)`.
 */
export function bundledSkillRegistration(bundle) {
  const skillPath = join(bundle.dir, 'SKILL.md');
  const content = readFileSync(skillPath, 'utf8');
  return {
    name: bundle.name,
    description: descriptionFor(bundle.descriptor),
    whenToUse: whenToUseFor(bundle.descriptor),
    path: skillPath,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: bundle.dir },
    invocation: { modelInvocable: true, userInvocable: true },
    metadata: {
      plugin: 'dsh-delegate',
      backend: bundle.backend,
      upstream: `${bundle.descriptor.skill.upstream} (${UPSTREAM_LICENSE})`,
    },
    content: `${content.trimEnd()}\n${installNote(bundle)}`,
  };
}

/**
 * Whether every packaged bundle is complete enough to register. A missing file
 * means a broken package, not a broken run, so the caller can warn and carry on.
 * @param bundles - the entries from `bundledSkills`.
 * @returns the missing paths, empty when every bundle is intact.
 */
export function missingSkillFiles(bundles) {
  const missing = [];
  for (const bundle of bundles) {
    for (const relative of REQUIRED_FILES) {
      const path = join(bundle.dir, relative);
      if (!existsSync(path)) missing.push(path);
    }
  }
  return missing;
}
