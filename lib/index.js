/**
 * dsh-delegate — host half.
 *
 * Hands a bounded brief to one installed CLI backend (see `lib/backends/`) as a
 * task and exposes the run for the browser half: the `delegate` / `delegate_task`
 * tools for the agent, and loopback `/api/delegate/*` routes for the floating
 * widget that watches the task live.
 *
 * Dispatch semantics follow the delegate skills (brief → a CLI → reviewable
 * report, a workspace the run may touch, read-only expressed per backend —
 * see `docs/agents/domain.md` and the descriptor contract in
 * `docs/specs/0001-multi-backend-delegate.md`). The skill's relay.mjs stays
 * the source of truth for its own checks; this plugin re-implements only what
 * the live widget needs.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createRegistry } from './runner.js';
import { createBackends } from './backends/registry.js';
import { buildDelegateTool, buildTaskTool, planDispatch } from './tools.js';
import { excerpt } from './step.js';
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
    const planned = planDispatch({ backends, args, cwd: process.cwd() });
    if (planned.ok !== true) return planned;
    let row;
    try {
      row = registry.start(planned.dispatch);
    } catch (refusal) {
      // The concurrency ceiling: refuse rather than stack a fifth local agent.
      return { ok: false, message: String(refusal.message ?? refusal) };
    }
    return {
      ok: true,
      background,
      message: `Dispatched ${row.id} to ${row.backendLabel ?? row.backend} (${row.model ?? 'default model'}, ${row.cd}).`
        + (background
          ? ' It runs in the background; the floating widget shows its thinking, answer and tool calls,'
            + ' and delegate_task { action: "detail" | "wait" } returns the live transcript.'
          : ''),
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
      // The schema is built from the descriptors: the `backend` enum and the
      // `options` bag grow with the adapters; no CLI name is written here.
      ...buildDelegateTool(backends),
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? 'delegate finished.') }],
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
      ...buildTaskTool(),
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? 'delegate_task finished.') }],
      },
      async execute(args) {
        const action = String(args?.action ?? '');
        const id = typeof args?.id === 'string' ? args.id : '';
        if (action === 'list') {
          const rows = registry.list();
          return {
            ok: true,
            running: registry.running(),
            message: rows.length === 0 ? 'No tasks yet.' : rows.map(renderTask).join('\n'),
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
          const tools = detail.steps.filter((step) => step.kind === 'tool');
          const message = [
            renderTask(detail),
            `${detail.steps.length} steps, ${tools.length} tool calls`,
            ...tools.slice(-10).map((step) => `  ⚙ ${step.name} ${step.error === undefined ? '' : `(error: ${excerpt(JSON.stringify(step.error), 120)})`}`),
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
