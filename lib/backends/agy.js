/**
 * dsh-delegate — the Antigravity CLI (`agy`) backend adapter.
 *
 * One plain descriptor: data plus pure functions, no class, no `this`. The core
 * (`lib/runner.js`, `lib/index.js`) reads only this contract and never learns
 * agy's flags, NDJSON shapes or project registry — that is what lets a second
 * CLI cost one more module in `lib/backends/` instead of edits to the core.
 *
 * The measured event shapes and the permission-denial rules live next door in
 * `lib/parse.js`, and the project registry in `lib/projects.js`; both are agy
 * facts, which is why only this adapter imports them.
 *
 * Behaviour contract (ticket #7): the argv this builds, the statuses it settles
 * and the transcript it folds are byte-identical to the pre-seam runner. The
 * golden argv test in `test/backends.test.mjs` is what holds that promise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { createParser, findPermissionDenial, isPermissionDenial, permissionDenialMessage } from '../parse.js';
import { answerOf as answerText } from '../step.js';
import { defaultProjectsDir, findProjectForCwd } from '../projects.js';

/** agy's own default print timeout, matching the relay. */
export const DEFAULT_PRINT_TIMEOUT = '30m';
/** Grace the watchdog allows past agy's print timeout before it fells the tree. */
const WATCHDOG_GRACE_MS = 60_000;

/** Bail out of the whole run when a duration cannot be parsed. */
function parseDuration(value, fallbackMs) {
  if (typeof value !== 'string' || value.trim() === '') return fallbackMs;
  const match = /^(\d+)(h|m|s)$/.exec(value.trim());
  if (match === null) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2];
  return unit === 'h' ? amount * 3_600_000 : unit === 'm' ? amount * 60_000 : amount * 1_000;
}

/** A failure line that says what actually went wrong, not just the exit code. */
function describeFailure(result, code, signal) {
  if (result !== null && typeof result.status === 'string' && result.status !== 'SUCCESS') {
    return `agy reported ${result.status}${result.error === undefined ? '' : `: ${String(result.error)}`}`;
  }
  if (signal !== null) return `agy exited on signal ${signal}`;
  return `agy exited with code ${code} before a result`;
}

/**
 * The outcome a finished run deserves.
 *
 * agy exits 0 and reports SUCCESS even when every tool it needed was auto-denied
 * — one of the user's own runs spent 89s, made 27 tool calls, changed nothing and
 * called itself done. A "done" is therefore only believed after the transcript
 * agrees: a refusal anywhere in it makes the run a failure with the actionable
 * reason attached.
 *
 * Pure, so the decision is unit tested against real captured transcripts.
 * @param outcome - the proposed status plus the folded steps and log lines.
 * @returns the final `{ status, error?, deniedTool? }`.
 */
export function settleOutcome({ status, steps, logs }) {
  if (status !== 'done') return { status };
  const denial = findPermissionDenial(steps, logs);
  if (denial === null) return { status: 'done' };
  return { status: 'failed', error: permissionDenialMessage(denial), deniedTool: denial.tool };
}

/** The agy descriptor the core dispatches through. */
export const descriptor = {
  id: 'agy',
  label: 'Antigravity CLI',
  /** Executable name when the config names no path. */
  bin: 'agy',
  skill: {
    name: 'agy-delegate',
    dir: 'skills/agy-delegate',
    upstream: 'https://github.com/phucnd0604/dsh-delegate',
  },
  capabilities: {
    /** agy picks a sensible model on its own; no model is required. */
    modelRequired: false,
    modelList: false,
    readOnly: 'sandbox',
    resume: ['resumeLast', 'conversation', 'project'],
    auto: false,
    /** The options key that grants full access; refused together with readOnly. */
    fullAccessOption: 'skipPermissions',
  },
  defaults: { printTimeout: DEFAULT_PRINT_TIMEOUT, skipPermissions: true },
  /** Per-dispatch options this backend understands (the `options` bag). */
  optionsSchema: {
    type: 'object',
    properties: {
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
      project: { type: 'string' },
      conversation: { type: 'string' },
      resumeLast: { type: 'boolean' },
      newProject: { type: 'boolean' },
      sandbox: { type: 'boolean' },
      addDirs: { type: 'array', items: { type: 'string' } },
      printTimeout: { type: 'string' },
      skipPermissions: { type: 'boolean' },
      projectsDir: { type: 'string' },
      reuseProjects: { type: 'boolean' },
    },
    additionalProperties: false,
  },

  /**
   * Flat config keys this repo shipped before the seam. Read so an existing
   * `cordis.patch.yml` keeps working; ticket #9 replaces them with
   * `backends.agy` and this function goes away.
   * @param config - the plugin config block.
   */
  legacyConfig(config) {
    const value = config ?? {};
    return {
      ...(typeof value.agyPath === 'string' && value.agyPath !== '' ? { path: value.agyPath } : {}),
      ...(typeof value.printTimeout === 'string' && value.printTimeout !== '' ? { printTimeout: value.printTimeout } : {}),
      ...(typeof value.skipPermissions === 'boolean' ? { skipPermissions: value.skipPermissions } : {}),
      ...(typeof value.projectsDir === 'string' && value.projectsDir !== '' ? { projectsDir: value.projectsDir } : {}),
      ...(typeof value.reuseProjects === 'boolean' ? { reuseProjects: value.reuseProjects } : {}),
    };
  },

  /**
   * Observed health, never configuration.
   * @param options - the configured `bin`.
   * @returns `{ found, version, models }`; never throws.
   */
  probe({ bin }) {
    try {
      const output = execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return { found: true, version: output.split(/\r?\n/u)[0] ?? null, models: null };
    } catch (error) {
      return { found: false, version: null, models: null, error: String(error?.message ?? error) };
    }
  },

  /** agy prints no machine-readable model list through its CLI. */
  listModels() {
    return null;
  },

  /** The widget row label for a model id. */
  describeModel(model) {
    return model;
  },

  /**
   * Build the argv for one dispatch, resolving the project this run joins.
   * @param task - `{ cd, brief, model, effort, readOnly, sandbox, skipPermissions,
   *   printTimeout, logPath, options, config }`.
   * @returns `{ argv, facts }` — facts fill project reuse on the task row.
   */
  buildArgv(task) {
    const options = task.options ?? {};
    const config = task.config ?? {};
    const cd = task.cd;
    const facts = { projectId: null, projectName: null, reusedProject: false };

    // Which agy project this run belongs to. A root that already has a project
    // is reused rather than spawning another one: repeated briefs against one
    // repository then share its history (and `--resume-last` keeps working),
    // instead of scattering the repo across a project per dispatch.
    const explicitProject = typeof options.project === 'string' && options.project !== '';
    const continuing = options.resumeLast === true || (typeof options.conversation === 'string' && options.conversation !== '');
    let projectId = explicitProject ? options.project : null;
    if (explicitProject) {
      facts.projectId = projectId;
    } else if (options.newProject !== true && !continuing && options.reuseProjects !== false && config.reuseProjects !== false) {
      const registryDir = options.projectsDir ?? config.projectsDir ?? defaultProjectsDir();
      const existing = findProjectForCwd(cd, registryDir);
      if (existing !== null) {
        projectId = existing.id;
        facts.projectId = existing.id;
        facts.projectName = existing.name;
        facts.reusedProject = true;
      }
    }

    const args = [];
    if (projectId !== null) args.push('--project', projectId);
    if (typeof options.conversation === 'string' && options.conversation !== '') args.push('--conversation', options.conversation);
    if (options.resumeLast === true) args.push('--continue');
    if (projectId === null && !continuing) args.push('--new-project');
    args.push('--add-dir', cd);
    for (const dir of options.addDirs ?? []) args.push('--add-dir', isAbsolute(dir) ? dir : resolve(cd, dir));
    if (typeof task.model === 'string' && task.model !== '') args.push('--model', task.model);
    if (typeof task.effort === 'string' && task.effort !== '') args.push('--effort', task.effort);
    if (task.readOnly === true) args.push('--sandbox', '--dangerously-skip-permissions');
    else {
      if (task.sandbox === true) args.push('--sandbox');
      if (task.skipPermissions !== false) args.push('--dangerously-skip-permissions');
    }
    if (typeof task.printTimeout === 'string' && task.printTimeout !== '') args.push('--print-timeout', task.printTimeout);
    args.push('--log-file', task.logPath);
    // The whole point of this plugin: NDJSON on stdout while the task runs
    // (init / step_update with text_delta, tool_info / result). Without it agy
    // prints its answer as plain text only when the run is already over.
    args.push('--output-format', 'stream-json');
    // `--print=<brief>` in one argv element: a multi-line brief and paths with
    // spaces survive without a shell.
    args.push(`--print=${task.brief}`);

    return { argv: args, facts };
  },

  /** One NDJSON projector per agy process. */
  createStream() {
    return createParser();
  },

  /** Watchdog: agy's own print timeout plus a grace period. */
  timeoutMs(task) {
    return parseDuration(task.printTimeout ?? DEFAULT_PRINT_TIMEOUT, parseDuration(DEFAULT_PRINT_TIMEOUT, 0)) + WATCHDOG_GRACE_MS;
  },

  /** What the watchdog records on the task it fells. */
  timeoutMessage(task) {
    return `timed out after ${task.printTimeout} plus ${WATCHDOG_GRACE_MS / 1_000}s grace; the process tree was killed.`;
  },

  /**
   * A permission refusal visible in a live streamed step, so the run can be stopped
   * before agy spends minutes on tools that will all be denied too.
   * @param step - one normalized step from the stream.
   * @returns `{ tool, message }` or null.
   */
  denialIn(step) {
    if (!isPermissionDenial(step)) return null;
    return { tool: step.name, message: String(step.error?.message ?? '') };
  },

  /** What a refusal means for the caller. */
  denialMessage(denial) {
    return permissionDenialMessage(denial);
  },

  /**
   * Did the run actually succeed? agy exits 0 and says SUCCESS even when every
   * tool it needed was auto-denied, so the transcript gets the final word.
   * @returns `{ status: 'done' | 'failed', error?, deniedTool? }`.
   */
  settled({ task, stream, code, signal }) {
    const result = stream.result();
    const succeeded = code === 0 && result !== null && typeof result === 'object' && result.status === 'SUCCESS';
    const settled = settleOutcome({ status: succeeded ? 'done' : 'failed', steps: stream.steps(), logs: stream.logs() });
    const error = settled.error ?? (succeeded ? undefined : task.error ?? describeFailure(result, code, signal));
    return { status: settled.status, error, deniedTool: settled.deniedTool };
  },

  /** Facts only agy's own artifacts carry. */
  factsAfterRun(task, stream) {
    task.conversationId = stream.info()?.conversationId ?? null;
    const result = stream.result();
    task.usage = result?.usage ?? null;
    task.numTurns = result?.num_turns ?? null;
    if (typeof result?.response === 'string' && result.response !== '') task.answer = result.response;
    // A fresh project's id is only in agy's own log (the `init` event carries
    // the conversation, not the project). Same pattern the skill's relay uses.
    if (task.projectId === null && existsSync(task.logPath)) {
      try {
        const created = /project: created project "[^"]*" \(id=([0-9a-f-]+)\)/iu.exec(readFileSync(task.logPath, 'utf8'));
        if (created !== null) task.projectId = created[1];
      } catch {
        // Observability only.
      }
    }
  },

  /** The answer text the widget and `result.json` show. */
  answerOf(steps) {
    return answerText(steps);
  },
};
