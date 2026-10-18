/**
 * dsh-delegate — host half.
 *
 * Hands a bounded brief to the Antigravity CLI (`agy`) as a background task and
 * exposes the run for the browser half: the `agy_delegate` / `agy_task` tools
 * for the agent, and loopback `/api/delegate/*` routes for the floating
 * widget that watches the task live.
 *
 * Dispatch semantics follow the agy-delegate skill (brief → agy → reviewable
 * report, `--add-dir` workspace, `--read-only` = sandbox + auto-approve inside
 * it). The skill's relay.mjs is the CLI path and stays the source of truth for
 * its own checks; this plugin re-implements only what the live widget needs.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createRegistry } from './runner.js';
import { createBackends } from './backends/registry.js';
import { excerpt } from './parse.js';
import { bundledSkillRegistration, missingSkillFiles, BUNDLED_SKILL_NAME } from './skill.js';

/** Stable cordis plugin name. */
export const name = 'delegate';

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'webServer'];

/** Route family. */
export const DELEGATE_API = {
  probe: '/api/delegate/probe',
  tasks: '/api/delegate/tasks',
  task: '/api/delegate/task',
  kill: '/api/delegate/kill',
  dismiss: '/api/delegate/dismiss',
};

/** Cap on a JSON request body. */
const MAX_BODY_BYTES = 64 * 1024;

/** The DSH home that holds this plugin's run directories. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/** Whether a request comes from this machine and this origin. */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** One JSON response. */
function sendJson(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/** Read a JSON request body within the cap, or undefined when unusable. */
function readJsonBody(request) {
  return new Promise((settle) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        settle({});
        return;
      }
      try {
        settle(JSON.parse(text));
      } catch {
        settle(undefined);
      }
    });
    request.on('error', () => settle(undefined));
  });
}

/** How a task row reads to the model. */
function renderTask(row) {
  const seconds = Math.round(((row.endedAt ?? Date.now()) - row.startedAt) / 1_000);
  const marks = { running: '◌', done: '●', failed: '✖', timeout: '⏱', killed: '⊘' };
  return `${marks[row.status] ?? '○'} ${row.id}  ${row.status}  ${seconds}s  ${row.toolCalls} tool calls  ${row.model ?? 'default model'}  ${row.cd}`
    + (row.error === null || row.error === undefined ? '' : `\n    ⚠️ ${excerpt(row.error, 300)}`);
}

/**
 * Mount the tools and the widget routes.
 * @param ctx - host plugin context carrying tools/webServer.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx, config) {
  const enabled = config?.enabled !== false;
  // Backends come from the registry, never from a module import: the core sees
  // descriptors, and a CLI's argv, event shapes and config keys stay in its own
  // file under lib/backends/.
  const backends = createBackends({ config: config ?? {} });
  const registry = createRegistry({
    home: dshHome(),
    backends,
    log: (message) => ctx.logger?.warn?.(message),
    maxConcurrent: config?.maxConcurrent,
  });

  const startTask = (args, background) => {
    const raw = args ?? {};
    const brief = typeof raw.brief === 'string' ? raw.brief.trim() : '';
    if (brief === '') return { ok: false, message: 'brief is required and must not be empty.' };
    const cd = typeof raw.cd === 'string' && raw.cd !== '' ? raw.cd : process.cwd();
    const readOnly = raw.readOnly === true;
    // Defaults are the backend's, not the core's: each CLI decides how a fresh
    // run should behave, and the config may override them per backend.
    const entry = backends.get(backends.defaultId());
    if (entry === null) return { ok: false, message: 'no backend is installed for this plugin.' };
    const settings = entry.config ?? {};
    const defaults = entry.descriptor.defaults ?? {};
    const defaultSkipPermissions = settings.skipPermissions !== false && defaults.skipPermissions !== false;
    const defaultPrintTimeout = settings.printTimeout ?? defaults.printTimeout ?? null;
    // Full access unless the caller turns it off explicitly; readOnly already
    // auto-approves inside its sandbox, so only an explicit double-request is a
    // mistake worth refusing.
    const skipRequested = raw.dangerouslySkipPermissions === true;
    const skipPermissions = raw.dangerouslySkipPermissions === undefined ? defaultSkipPermissions : skipRequested;
    if (readOnly && skipRequested) {
      return { ok: false, message: 'readOnly and dangerouslySkipPermissions are mutually exclusive (readOnly already auto-approves inside its sandbox).' };
    }
    let row;
    try {
      row = registry.start({
        backend: entry.descriptor.id,
        brief,
        cd,
        model: raw.model,
        effort: raw.effort,
        readOnly,
        sandbox: raw.sandbox === true,
        skipPermissions,
        printTimeout: typeof raw.printTimeout === 'string' && raw.printTimeout !== '' ? raw.printTimeout : defaultPrintTimeout,
        addDirs: Array.isArray(raw.addDirs) ? raw.addDirs.filter((dir) => typeof dir === 'string') : [],
        newProject: raw.newProject,
        resumeLast: raw.resumeLast === true,
        conversation: raw.conversation,
        project: raw.project,
      });
    } catch (refusal) {
      // The concurrency ceiling: refuse rather than stack a fifth local agent.
      return { ok: false, message: String(refusal.message ?? refusal) };
    }
    return {
      ok: true,
      background,
      message: `Dispatched ${row.id} to ${row.backendLabel ?? row.backend} (${row.model ?? 'default model'}, ${row.cd}).`
        + (background
          ? ' It runs in the background; the floating agy widget shows its thinking, answer and tool calls,'
            + ' and agy_task { action: "detail" | "wait" } returns the live transcript.'
          : `${row.status}.`),
      task: row,
    };
  };

  // Health facts the loopback probe reports, so a support question ("is the
  // bundled skill actually live?") has an answer that is observed, not assumed.
  const skillState = { registered: false, reason: 'not attempted' };

  ctx.effect(() => {
    const disposers = [];
    if (!enabled) return () => {};

    // The agy-delegate skill ships inside this package, so the user never has to
    // install it separately. `skills` is an optional dependency on purpose: a
    // profile without that plugin still gets the tools, the routes and the widget.
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
    if (skills === undefined || typeof skills.register !== 'function') {
      skillState.reason = 'no skills service';
      ctx.logger?.warn?.('dsh-delegate: no skills service; the bundled agy-delegate skill was not registered');
    } else {
      const missing = missingSkillFiles();
      if (missing.length > 0) {
        skillState.reason = `bundled skill incomplete: ${missing.join(', ')}`;
        ctx.logger?.warn?.(`dsh-delegate: ${skillState.reason}`);
      } else {
        disposers.push(ctx.effect(
          () => {
            const dispose = skills.register(bundledSkillRegistration());
            skillState.registered = true;
            skillState.reason = null;
            return () => {
              skillState.registered = false;
              skillState.reason = 'disposed';
              dispose();
            };
          },
          'dsh-delegate: bundled skill',
        ));
      }
    }

    disposers.push(ctx.tools.register({
      name: 'agy_delegate',
      description:
        'Delegate a self-contained brief to the Antigravity CLI (agy) as a background task — the agy-delegate loop: '
        + 'you write the brief, agy types in its own conversation, you review and land the result. Returns immediately with a '
        + 'task id; watch it with agy_task, and the user sees the same task live in the floating agy widget (thinking, answer, tool calls). '
        + 'Several tasks can run at once (4 by default, the plugin\'s maxConcurrent); a dispatch past that ceiling is refused, not queued. '
        + 'The root\'s existing agy project is reused, so repeated briefs against one repository keep its history; pass newProject to force a fresh one. '
        + 'Runs are dispatched with full access (--dangerously-skip-permissions) because headless agy cannot answer a permission prompt; pass '
        + 'dangerouslySkipPermissions: false to require pre-granted allow-rules, or readOnly for a sandboxed review that discards writes. '
        + 'The brief must carry everything needed: goal, current state with file:line, constraints, the project\'s real gate commands, '
        + 'and a report contract. agy does NOT commit — the caller commits.',
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: 'The full brief. Self-contained: agy sees only this text plus the workspace.' },
          cd: { type: 'string', description: 'Working root for agy (the repo). Defaults to the session working directory.' },
          model: { type: 'string', description: "agy model label from `agy models` (e.g. gemini-4-argon-high). Omit for agy's default." },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning effort.' },
          readOnly: {
            type: 'boolean',
            description: 'Review/diagnosis with no edits: agy sandbox + auto-approved tools inside it. Reads and writes are both confined to the workspace.',
          },
          sandbox: { type: 'boolean', description: "Enable agy's terminal sandbox for a normal write run." },
          dangerouslySkipPermissions: {
            type: 'boolean',
            description: 'Default true (full access). Set false to require agy allow-rules; headless agy cannot answer a prompt, so a denied tool fails the run.',
          },
          newProject: {
            type: 'boolean',
            description: "Force a fresh agy project instead of reusing the one that already owns cd. Without it, an existing project for cd is reused.",
          },
          printTimeout: { type: 'string', description: "agy's own print timeout, h/m/s form (default 30m). A watchdog kills the tree 60s past it." },
          addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra workspace directories (absolute, or relative to cd).' },
          resumeLast: { type: 'boolean', description: 'Continue the most recent agy conversation; send only the delta brief.' },
          conversation: { type: 'string', description: 'Continue a specific agy conversation id.' },
          project: { type: 'string', description: 'Use an existing agy project id or name.' },
          background: { type: 'boolean', description: 'Default true. Set false to block until the task settles.' },
          waitSeconds: { type: 'number', description: 'With background:false, how long to wait before returning the running task anyway (default 120, max 600).' },
        },
        required: ['brief'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? 'agy_delegate finished.') }],
      },
      async execute(args) {
        const background = args?.background !== false;
        const started = startTask(args, background);
        if (!started.ok || background) return started;
        const waitMs = Math.min(Math.max(Number(args?.waitSeconds ?? 120) || 120, 5), 600) * 1_000;
        const detail = await registry.wait(started.task.id, waitMs);
        if (detail === null || detail === undefined) return started;
        return {
          ok: detail.status === 'done',
          background: false,
          message: `${started.message}\n${renderTask(detail)}${detail.status === 'running' ? '\n(still running — the widget keeps tracking it)' : ''}`,
          task: detail,
        };
      },
    }));

    disposers.push(ctx.tools.register({
      name: 'agy_task',
      description:
        'Inspect and control agy tasks started by agy_delegate. Actions: list (all tasks, newest first), status (one task\'s row), '
        + 'detail (full live transcript: steps, thinking, answer, tool calls, logs, usage), wait (block until settled or the timeout expires), '
        + 'kill (fell the agy process tree), dismiss (forget a finished task).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'status', 'detail', 'wait', 'kill', 'dismiss'], description: 'What to do.' },
          id: { type: 'string', description: 'Task id for status/detail/wait/kill/dismiss.' },
          waitSeconds: { type: 'number', description: 'For action "wait": how long to block (default 120, max 600).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? 'agy_task finished.') }],
      },
      async execute(args) {
        const action = String(args?.action ?? '');
        const id = typeof args?.id === 'string' ? args.id : '';
        if (action === 'list') {
          const rows = registry.list();
          return {
            ok: true,
            running: registry.running(),
            message: rows.length === 0 ? 'No agy tasks yet.' : rows.map(renderTask).join('\n'),
            tasks: rows,
          };
        }
        if (id === '') return { ok: false, message: `action "${action}" needs an id.` };
        if (action === 'kill') return registry.kill(id);
        if (action === 'dismiss') return registry.dismiss(id);
        if (action === 'status') {
          const row = registry.list().find((task) => task.id === id);
          return row === undefined ? { ok: false, message: `no task ${id}` } : { ok: true, message: renderTask(row), task: row };
        }
        if (action === 'detail' || action === 'wait') {
          const waitMs = Math.min(Math.max(Number(args?.waitSeconds ?? 120) || 120, 5), 600) * 1_000;
          const detail = action === 'wait' ? await registry.wait(id, waitMs) : registry.detail(id);
          if (detail === null) return { ok: false, message: `no task ${id}` };
          const tools = detail.steps.filter((step) => step.toolName !== undefined);
          const message = [
            renderTask(detail),
            `${detail.steps.length} steps, ${tools.length} tool calls`,
            ...tools.slice(-10).map((step) => `  ⚙ ${step.toolName} ${step.error === undefined ? '' : `(error: ${excerpt(JSON.stringify(step.error), 120)})`}`),
            detail.answer === '' ? '' : `answer: ${excerpt(detail.answer, 1_500)}`,
          ].filter((line) => line !== '').join('\n');
          return { ok: detail.status === 'done', message, task: detail };
        }
        return { ok: false, message: `unknown action "${action}".` };
      },
    }));

    disposers.push(ctx.effect(() => {
      const routes = [
        {
          kind: 'exact',
          path: DELEGATE_API.probe,
          handler: (request, response) => {
            if (!isLoopbackRequest(request)) {
              sendJson(response, 403, { ok: false, error: 'loopback-only' });
              return;
            }
            sendJson(response, 200, {
              ok: true,
              plugin: 'dsh-delegate',
              pid: process.pid,
              running: registry.running(),
              skill: {
                name: BUNDLED_SKILL_NAME,
                registered: skillState.registered,
                reason: skillState.reason,
              },
            });
          },
        },
        {
          kind: 'exact',
          path: DELEGATE_API.tasks,
          handler: (request, response) => {
            if (!isLoopbackRequest(request)) {
              sendJson(response, 403, { ok: false, error: 'loopback-only' });
              return;
            }
            if (request.method !== 'GET') {
              sendJson(response, 405, { ok: false, error: 'method not allowed' });
              return;
            }
            sendJson(response, 200, { ok: true, enabled, running: registry.running(), tasks: registry.list() });
          },
        },
        {
          kind: 'exact',
          path: DELEGATE_API.task,
          handler: (request, response) => {
            if (!isLoopbackRequest(request)) {
              sendJson(response, 403, { ok: false, error: 'loopback-only' });
              return;
            }
            const id = new URL(request.url ?? '/', 'http://dsh.local').searchParams.get('id') ?? '';
            const detail = registry.detail(id);
            if (detail === null) {
              sendJson(response, 404, { ok: false, error: `no task ${id}` });
              return;
            }
            sendJson(response, 200, { ok: true, task: detail });
          },
        },
        {
          kind: 'exact',
          path: DELEGATE_API.kill,
          handler: async (request, response) => {
            if (!isLoopbackRequest(request)) {
              sendJson(response, 403, { ok: false, error: 'loopback-only' });
              return;
            }
            const body = await readJsonBody(request);
            if (body === undefined) {
              sendJson(response, 400, { ok: false, error: 'invalid JSON body' });
              return;
            }
            sendJson(response, 200, registry.kill(String(body.id ?? '')));
          },
        },
        {
          kind: 'exact',
          path: DELEGATE_API.dismiss,
          handler: async (request, response) => {
            if (!isLoopbackRequest(request)) {
              sendJson(response, 403, { ok: false, error: 'loopback-only' });
              return;
            }
            const body = await readJsonBody(request);
            if (body === undefined) {
              sendJson(response, 400, { ok: false, error: 'invalid JSON body' });
              return;
            }
            sendJson(response, 200, registry.dismiss(String(body.id ?? '')));
          },
        },
      ];
      const routeDisposers = routes.map((route) => ctx.webServer.register(route));
      return () => { for (const dispose of routeDisposers) dispose(); };
    }, 'dsh-delegate: routes'));

    disposers.push(ctx.effect(() => () => registry.dispose(), 'dsh-delegate: shutdown'));

    return () => { for (const dispose of disposers) dispose(); };
  }, 'dsh-delegate: tools and routes');
}

export { createRegistry } from './runner.js';
export { createBackends } from './backends/registry.js';
export { createParser } from './parse.js';
export { bundledSkillRegistration, bundledSkillDir, missingSkillFiles } from './skill.js';
