/**
 * Drive the host half the way the app drives it, without the app: mount it on a
 * fake Cordis context, then call the agent tool and the widget's own HTTP routes
 * against live agy. This is what proves the parts a page refresh cannot reach —
 * the bundled skill registration, project reuse through the tool path, full
 * access by default, and the exact JSON the widget polls.
 *
 * Costs two agy round trips, so it is a script, not part of `node --test`.
 * Usage: node scripts/verify-host-half.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

const home = mkdtempSync(join(tmpdir(), 'agy-host-home-'));
const work = mkdtempSync(join(tmpdir(), 'agy-host-work-'));
process.env.DSH_HOME = home;

/** A loopback GET request as node:http would hand it to a route handler. */
function request(path, { method = 'GET', remote = '127.0.0.1', host = '127.0.0.1:19387', origin } = {}) {
  return {
    method,
    url: path,
    socket: { remoteAddress: remote },
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    on() {},
    destroy() {},
  };
}

/** Collect one handler's response. */
function response() {
  const state = { status: null, body: '' };
  return {
    state,
    writeHead(status) { state.status = status; },
    end(body) { state.body = body ?? ''; },
  };
}

const checks = [];
const check = (name, condition, extra = '') => {
  const line = `${condition ? 'PASS' : 'FAIL'}  ${name}${extra === '' ? '' : `  (${extra})`}`;
  checks.push(line);
  console.log(line);
  if (!condition) process.exitCode = 1;
};

// --- mount the plugin on a fake host context --------------------------------
const tools = new Map();
const routes = new Map();
const skills = [];
const warnings = [];
const disposers = [];
const ctx = {
  logger: { warn: (message) => warnings.push(String(message)) },
  effect(callback) {
    const dispose = callback();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  },
  get(name) {
    if (name !== 'skills') return undefined;
    return { register: (skill) => { skills.push(skill); return () => { skills.splice(skills.indexOf(skill), 1); }; } };
  },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
  webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } },
};

apply(ctx, { agyPath: 'agy' });

check('both agent tools mounted', tools.has('delegate') && tools.has('delegate_task'), [...tools.keys()].join(', '));
check('the widget routes mounted', routes.size === 5, [...routes.keys()].join(', '));
check('no mount warnings', warnings.length === 0, warnings.join(' | '));

const skillNames = skills.map((skill) => skill.name).sort().join(',');
check('both bundled skills registered with the skills service',
  skillNames === 'agy-sub-agent,open-code-subagent', skillNames);
check('each skill points resourceBase at its shipped directory',
  skills.length > 0 && skills.every((skill) => skill.resourceBase?.kind === 'directory'
    && skill.resourceBase.path.endsWith(join('skills', skill.name))),
  skills.map((skill) => skill.resourceBase?.path).join(' | '));
check('each body carries the install note',
  skills.every((skill) => skill.content.includes('## In this install (dsh-delegate)') === true));
check('they stay model- and user-invocable',
  skills.every((skill) => skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true));

// --- the routes are the widget's contract -----------------------------------
const call = async (path, req) => {
  // The route table is keyed by pathname; the query rides req.url.
  const route = routes.get(path.split('?')[0]);
  const res = response();
  await route.handler(req, res);
  return { status: res.state.status, json: res.state.body === '' ? null : JSON.parse(res.state.body) };
};

const blocked = await call('/api/delegate/tasks', request('/api/delegate/tasks', { remote: '10.1.2.3' }));
check('a non-loopback caller is refused', blocked.status === 403, `status ${blocked.status}`);
const crossSite = await call('/api/delegate/tasks', request('/api/delegate/tasks', { origin: 'http://evil.example' }));
check('a cross-origin caller is refused', crossSite.status === 403, `status ${crossSite.status}`);
const wrongMethod = await call('/api/delegate/tasks', request('/api/delegate/tasks', { method: 'POST' }));
check('a write to a read route is refused', wrongMethod.status === 405, `status ${wrongMethod.status}`);

// --- a real dispatch through the tool, then read it through the routes -------
const started = await tools.get('delegate').execute({
  brief: 'Use the run_command tool to run the command `Get-ChildItem` in the current directory, then reply with exactly: host-ok',
  cd: work,
  options: { printTimeout: '150s' },
  background: false,
  waitSeconds: 200,
});
check('the tool dispatched a real agy task', started.task?.id !== undefined && started.task?.status !== 'failed', `${started.task?.id} ${started.task?.status}`);
check('the run used full access by default', started.task?.steps?.some((step) => step.kind === 'tool' && step.name === 'run_command') === true,
  'run_command executed, which needs auto-approved permissions');
check('the answer came back through the tool', String(started.message).includes('host-ok') || started.task?.answer?.includes('host-ok') === true);
check('a fresh project was opened for the new root', started.task?.reusedProject === false && typeof started.task?.projectId === 'string');

const list = await call('/api/delegate/tasks', request('/api/delegate/tasks'));
const row = list.json.tasks.find((task) => task.id === started.task.id);
check('the widget list route reports the task', list.status === 200 && row !== undefined, row === undefined ? 'missing' : `${row.status} ${row.toolCalls} tools`);
check('the row carries what the pill renders', row?.brief?.startsWith('Use the run_command tool') === true && typeof row?.cd === 'string');

const detail = await call(`/api/delegate/task?id=${started.task.id}`, request(`/api/delegate/task?id=${started.task.id}`));
const steps = detail.json.task.steps ?? [];
check('the detail route returns the folded steps', detail.status === 200 && steps.length >= 2, `${steps.length} steps`);
check('thinking/answer/tool data survive the round trip',
  steps.some((step) => typeof step.text === 'string' && step.text.includes('host-ok'))
  && steps.some((step) => step.kind === 'tool'));

// --- the second dispatch at the same root must join that project -------------
const second = await tools.get('delegate').execute({
  brief: 'Reply with exactly: reuse-ok. Do not use any tools.',
  cd: work,
  options: { printTimeout: '150s' },
  background: false,
  waitSeconds: 200,
});
check('the second dispatch reused the project', second.task?.reusedProject === true && second.task?.projectId === started.task.projectId,
  `first ${started.task?.projectId} vs second ${second.task?.projectId}`);

const status = await tools.get('delegate_task').execute({ action: 'list' });
check('delegate_task lists every task', status.tasks?.length === 2, `${status.tasks?.length} tasks`);

for (const dispose of disposers.reverse()) dispose();
check('teardown unregistered the skill', skills.length === 0, `${skills.length} left`);

console.log(`\n${checks.filter((line) => line.startsWith('PASS')).length}/${checks.length} checks passed`);
console.log(`run artifacts under ${home}`);
