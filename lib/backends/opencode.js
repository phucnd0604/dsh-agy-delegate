/**
 * dsh-delegate — the OpenCode CLI backend adapter.
 *
 * Same contract as `lib/backends/agy.js`: one plain descriptor, no class, and
 * every opencode-specific fact (flags, event shapes, model naming, the Windows
 * shim) kept here. The core reads only the descriptor, so this file and
 * `opencode-events.js` are the whole cost of a second CLI.
 *
 * Measured against opencode 2.0.32: `opencode run --format json` reads the brief
 * on stdin and prints JSON lines on stdout; `opencode models` lists
 * `provider/model` ids; a missing model is the CLI's own error, so we refuse
 * before spawning and list the free ids first.
 */

import { execFileSync } from 'node:child_process';

import { resolveExecutable } from '../exec.js';
import { createOpencodeStream } from './opencode-events.js';

/** Watchdog for a run that never settles; opencode has no print timeout of its own. */
export const DEFAULT_TIMEOUT = '30m';
/** Grace past the timeout before the tree is felled. */
const WATCHDOG_GRACE_MS = 60_000;

/** `h`/`m`/`s` duration to ms, or the fallback. */
function parseDuration(value, fallbackMs) {
  if (typeof value !== 'string' || value.trim() === '') return fallbackMs;
  const match = /^(\d+)(h|m|s)$/.exec(value.trim());
  if (match === null) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2];
  return unit === 'h' ? amount * 3_600_000 : unit === 'm' ? amount * 60_000 : amount * 1_000;
}

/** The denial wording worth stopping a run over (only reachable without `--auto`). */
const DENIAL = /permission (?:request|denied|required)|requires approval|user (?:denied|rejected)/i;

/**
 * The model ids in the order a refusal should list them: free first, then the
 * subscription (`opencode-go/`) lane, then the rest, each group sorted.
 * @param models - ids from `opencode models`.
 * @returns a new array; non-strings dropped.
 */
export function modelChoices(models) {
  const ids = Array.isArray(models) ? models.filter((model) => typeof model === 'string' && model !== '') : [];
  const free = ids.filter((model) => /-free(#|$)/i.test(model)).sort();
  const subscription = ids.filter((model) => !free.includes(model) && model.startsWith('opencode-go/')).sort();
  const other = ids.filter((model) => !free.includes(model) && !subscription.includes(model)).sort();
  return [...free, ...subscription, ...other];
}

/**
 * The refusal for a dispatch with no model. opencode has no safe default, so it
 * is refused rather than guessed — a guess can bill a metered provider.
 * @param models - ids from `opencode models` (null when the list failed).
 */
export function modelRefusal(models) {
  const choices = modelChoices(models);
  if (choices.length === 0) {
    return 'opencode needs an explicit model ("provider/model", optional "#variant"), and `opencode models` listed none — run `opencode auth login` and try again.';
  }
  const free = choices.filter((model) => /-free(#|$)/i.test(model));
  const subscription = choices.filter((model) => model.startsWith('opencode-go/'));
  const freeLine = free.length === 0 ? 'none listed' : free.slice(0, 8).join(', ');
  const subscriptionLine = subscription.length === 0 ? 'none listed' : subscription.slice(0, 6).join(', ');
  return 'opencode needs an explicit model ("provider/model", optional "#variant"); it has no default and a guessed one may be metered. '
    + `Free models first: ${freeLine}.`
    + ` Subscription models: ${subscriptionLine}.`
    + ' Run `opencode models` for the whole list.';
}

/** The opencode descriptor the core dispatches through. */
export const descriptor = {
  id: 'opencode',
  label: 'OpenCode CLI',
  bin: 'opencode',
  skill: {
    name: 'open-code-subagent',
    dir: 'skills/open-code-subagent',
    upstream: 'https://github.com/amElnagdy/delegate-skills',
  },
  capabilities: {
    /** No safe default model: a dispatch without one is refused. */
    modelRequired: true,
    modelList: true,
    /** `--agent plan` is the read-only lane; it never gets `--auto`. */
    readOnly: 'plan',
    resume: ['resumeLast', 'session'],
    auto: true,
    /** The options key that grants full access; refused together with readOnly. */
    fullAccessOption: 'auto',
  },
  defaults: { printTimeout: DEFAULT_TIMEOUT },
  optionsSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', enum: ['build', 'plan'] },
      resumeLast: { type: 'boolean' },
      session: { type: 'string' },
      auto: { type: 'boolean' },
      standalone: { type: 'boolean' },
      timeout: { type: 'string' },
    },
    additionalProperties: false,
  },

  /**
   * Observed health, never configuration.
   * @returns `{ found, version, models }`; never throws.
   */
  probe({ bin, config }) {
    const command = resolveExecutable(typeof config?.path === 'string' && config.path !== '' ? config.path : bin);
    try {
      const output = execFileSync(command, ['--version'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return { found: true, version: output.split(/\r?\n/u)[0] ?? null, models: null };
    } catch (error) {
      return { found: false, version: null, models: null, error: String(error?.message ?? error) };
    }
  },

  /**
   * The ids `opencode models` prints, or null when the CLI is missing or the
   * listing fails. Never throws, so a refusal can always be produced.
   */
  listModels({ bin, config } = {}) {
    const command = resolveExecutable(typeof config?.path === 'string' && config.path !== '' ? config.path : bin);
    try {
      const output = execFileSync(command, ['models'], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const models = output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => /^[^\s/]+\/.+$/u.test(line));
      return models.length === 0 ? null : models;
    } catch {
      return null;
    }
  },

  /** The widget row label for a model id. */
  describeModel(model) {
    return model;
  },

  /** The refusal a dispatch with no model gets, free ids first. */
  modelRefusal,


  /**
   * Build the argv for one dispatch. The brief goes on `stdio[0]` (plan.stdin),
   * never argv: a multi-line XML-tagged brief survives without a shell.
   */
  buildArgv(task) {
    const options = task.options ?? {};
    const readOnly = task.readOnly === true;
    const args = ['run', '--format', 'json'];
    const agent = readOnly ? 'plan' : (typeof options.agent === 'string' && options.agent !== '' ? options.agent : 'build');
    args.push('--agent', agent);
    if (typeof task.model === 'string' && task.model !== '') args.push('--model', task.model);
    if (options.resumeLast === true) args.push('--continue');
    else if (typeof options.session === 'string' && options.session !== '') args.push('--session', options.session);
    if (readOnly) {
      // The plan agent reads; without --auto a permission ask is surfaced, so
      // "read-only" cannot be defeated by auto-approving an edit.
    } else if (options.auto !== false) {
      // Headless opencode cannot answer a prompt; auto is the build default.
      args.push('--auto');
    }
    if (options.standalone === true) args.push('--standalone');
    return { argv: args, stdin: task.brief };
  },

  /** One JSON-line projector per opencode process. */
  createStream() {
    return createOpencodeStream();
  },

  /** Watchdog: the configured timeout plus a grace period. */
  timeoutMs(task) {
    const configured = task.options?.timeout ?? task.printTimeout ?? DEFAULT_TIMEOUT;
    return parseDuration(configured, parseDuration(DEFAULT_TIMEOUT, 0)) + WATCHDOG_GRACE_MS;
  },

  /** What the watchdog records on the task it fells. */
  timeoutMessage(task) {
    const configured = task.options?.timeout ?? task.printTimeout ?? DEFAULT_TIMEOUT;
    return `timed out after ${configured} plus ${WATCHDOG_GRACE_MS / 1_000}s grace; the process tree was killed.`;
  },

  /**
   * A permission refusal visible in a live tool step. With `--auto` this never
   * fires; without it, an ask-gated edit surfaces here and the run is stopped.
   */
  denialIn(step) {
    if (step.kind !== 'tool' || step.error === null || typeof step.error !== 'object') return null;
    const message = String(step.error.message ?? '');
    if (!DENIAL.test(message)) return null;
    return { tool: step.name, message };
  },

  /** What a refusal means for the caller. */
  denialMessage(denial) {
    return `opencode was refused permission for ${denial.tool}: ${denial.message}. `
      + 'Headless runs cannot answer a prompt; pass auto: true (the build default) or pre-approve the tool.';
  },

  /**
   * Did the run actually succeed? Exit 0 with an `error` event is a failure, and
   * so is a non-zero exit with no error event.
   */
  settled({ stream, code, signal }) {
    const result = stream.result();
    if (typeof result?.error === 'string' && result.error !== '') return { status: 'failed', error: result.error };
    if (code === 0) return { status: 'done' };
    return {
      status: 'failed',
      error: signal === null || signal === undefined
        ? `opencode exited with code ${code} before reporting an error`
        : `opencode exited on signal ${signal}`,
    };
  },

  /** Facts only opencode's own stream carries. */
  factsAfterRun(task, stream) {
    task.conversationId = stream.info()?.conversationId ?? null;
    task.usage = stream.result()?.tokens ?? null;
    task.numTurns = null;
  },
};
