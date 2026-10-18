/**
 * Checks for the opencode adapter: its event fold, the argv it builds, and the
 * refusal/probe behaviour the contract in spec §9 requires.
 *
 * Fixtures are lines recorded from opencode 2.0.32 on this machine; the argv
 * assertions are golden on purpose, so a flag this adapter gains or loses shows
 * up as a diff rather than a run that silently changes shape.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { descriptor, modelChoices, modelRefusal } from '../lib/backends/opencode.js';
import { createBackends } from '../lib/backends/registry.js';
import { createRegistry } from '../lib/runner.js';
import { createOpencodeStream } from '../lib/backends/opencode-events.js';
import { resolveExecutable } from '../lib/exec.js';
import { costOf } from '../lib/step.js';

/** The lines a tool-using run prints, in the order it prints them. */
const RUN = readFileSync(new URL('./fixtures/opencode-run.jsonl', import.meta.url), 'utf8')
  .split(/\r?\n/u).filter(Boolean);
/** A dispatch with an unusable model id: one error event, exit 1. */
const ERROR_RUN = readFileSync(new URL('./fixtures/opencode-error.jsonl', import.meta.url), 'utf8')
  .split(/\r?\n/u).filter(Boolean);

test('folds a recorded opencode run into the step union', () => {
  const stream = createOpencodeStream();
  const touched = RUN.flatMap((line) => stream.push(line));

  assert.deepEqual(stream.steps().map((step) => step.kind), ['session', 'tool', 'cost', 'answer']);
  // Every step a line creates is handed back for events.jsonl — including the
  // session, which is what makes the run resumable.
  assert.deepEqual(touched.map((step) => step.kind), ['session', 'tool', 'cost', 'answer']);
  assert.equal(stream.steps()[0].id, 'ses_eb27e78daffeF7WiKsXdkalz8H');
  assert.equal(stream.info().conversationId, 'ses_eb27e78daffeF7WiKsXdkalz8H');

  const tool = stream.steps().find((step) => step.kind === 'tool');
  assert.equal(tool.name, 'shell');
  assert.deepEqual(tool.input, { command: 'echo hi' });
  assert.equal(tool.error, undefined);

  const cost = costOf(stream.steps());
  assert.equal(cost.usd, 0);
  assert.deepEqual(cost.tokens, { input: 3447, output: 38, reasoning: 0, cache: { read: 2944, write: 0 } });

  assert.equal(stream.result().status, 'SUCCESS');
  assert.equal(stream.result().tokens.input, 3447);
});

test('streamed text rewrites one answer step instead of appending', () => {
  const stream = createOpencodeStream();
  stream.push(JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { id: 'prt_1', type: 'text', text: 'he' } }));
  stream.push(JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { id: 'prt_1', type: 'text', text: 'hello' } }));

  const answers = stream.steps().filter((step) => step.kind === 'answer');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].text, 'hello');
});

test('a retried tool clears its error without duplicating the step', () => {
  const stream = createOpencodeStream();
  const part = { partID: 'prt_retry', type: 'tool', id: 'call_1', tool: 'shell' };
  stream.push(JSON.stringify({ type: 'tool_use', sessionID: 'ses_1', part: { ...part, state: { status: 'error', input: { command: 'x' }, error: 'boom' } } }));
  stream.push(JSON.stringify({ type: 'tool_use', sessionID: 'ses_1', part: { ...part, state: { status: 'completed', input: { command: 'x' }, output: 'ok' } } }));

  const tools = stream.steps().filter((step) => step.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].error, undefined);
});

test('a provider error is a failed run, not an empty success', () => {
  const stream = createOpencodeStream();
  for (const line of ERROR_RUN) stream.push(line);

  assert.equal(stream.result().status, 'ERROR');
  assert.match(stream.result().error, /provider\.no-route: Model unavailable/u);
  assert.deepEqual(stream.logs(), ['provider.no-route: Model unavailable: nope/nope']);

  const settled = descriptor.settled({ stream, code: 1, signal: null });
  assert.equal(settled.status, 'failed');
  assert.match(settled.error, /provider\.no-route/u);
});

test('unknown events and non-JSON lines become visible log steps', () => {
  const stream = createOpencodeStream();
  const junk = stream.push('this is not json');
  assert.equal(junk[0].kind, 'log');
  assert.equal(junk[0].level, 'info');
  assert.equal(junk[0].text, 'this is not json');

  const drift = stream.push(JSON.stringify({ type: 'metrics' }));
  assert.equal(drift[0].level, 'debug');
  assert.equal(drift[0].text, 'unhandled event "metrics"');

  // Structural noise is not transcript: step_start must add nothing.
  assert.deepEqual(stream.push(JSON.stringify({ type: 'step_start' })), []);
  // But a step_start that reveals the session still yields that one step.
  assert.deepEqual(stream.push(JSON.stringify({ type: 'step_start', sessionID: 'ses_2' })).map((step) => step.kind), ['session']);
});

/**
 * A dispatch shaped the way the runner hands one to an adapter.
 * @param overrides - fields to override on the default build task.
 */
function task(overrides = {}) {
  return {
    brief: 'Reply with exactly: pong',
    cd: process.cwd(),
    model: 'opencode/beam-free',
    readOnly: false,
    options: {},
    printTimeout: '30m',
    ...overrides,
  };
}

test('builds the recorded opencode argv, with the brief on stdin', () => {
  const plan = descriptor.buildArgv(task());
  assert.deepEqual(plan.argv, [
    'run', '--format', 'json',
    '--agent', 'build',
    '--model', 'opencode/beam-free',
    '--auto',
  ]);
  assert.equal(plan.stdin, 'Reply with exactly: pong');
  // The brief never rides in argv: a multi-line brief would need a shell to quote it.
  assert.equal(plan.argv.includes('Reply with exactly: pong'), false);
});

test('read-only never passes --auto, even when auto is asked for', () => {
  const plan = descriptor.buildArgv(task({ readOnly: true, options: { auto: true } }));
  assert.equal(plan.argv[plan.argv.indexOf('--agent') + 1], 'plan');
  assert.equal(plan.argv.includes('--auto'), false);
});

test('auto: false is honoured on a build run', () => {
  const plan = descriptor.buildArgv(task({ options: { auto: false } }));
  assert.equal(plan.argv.includes('--auto'), false);
  assert.equal(plan.argv[plan.argv.indexOf('--agent') + 1], 'build');
});

test('resume is one of continue or an explicit session, never both', () => {
  const session = descriptor.buildArgv(task({ options: { session: 'ses_abc' } }));
  const at = session.argv.indexOf('--session');
  assert.deepEqual(session.argv.slice(at, at + 2), ['--session', 'ses_abc']);

  const last = descriptor.buildArgv(task({ options: { resumeLast: true, session: 'ses_abc' } }));
  assert.equal(last.argv.includes('--continue'), true);
  assert.equal(last.argv.includes('--session'), false);
});

test('the free model ids are listed before the subscription lane', () => {
  const models = ['opencode-go/zeta', 'opencode/beam-free', 'zai/glm-5', 'opencode-go/alpha', 'opencode/big-pickle'];
  // Only ids ending in "-free" are the free lane; big-pickle is free but the
  // naming rule the refusal relies on cannot see that, so it sorts with the rest.
  assert.deepEqual(modelChoices(models), [
    'opencode/beam-free',
    'opencode-go/alpha',
    'opencode-go/zeta',
    'opencode/big-pickle',
    'zai/glm-5',
  ]);

  const refusal = modelRefusal(models);
  assert.match(refusal, /needs an explicit model/u);
  assert.ok(refusal.indexOf('opencode/beam-free') < refusal.indexOf('opencode-go/alpha'));
  assert.match(refusal, /opencode models/u);
});

test('a missing model is refused without a model list to draw on', () => {
  assert.match(modelRefusal(null), /opencode auth login/u);
});

test('a dispatch with no model is refused before it spawns', () => {
  const registry = createRegistry({
    home: mkdtempSync(join(tmpdir(), 'delegate-model-')),
    backends: createBackends({ config: { backends: { opencode: { path: 'definitely-not-an-opencode-cli-xyz' } } } }),
    log: () => {},
  });
  const row = registry.start({ backend: 'opencode', brief: 'x', cd: process.cwd() });
  assert.equal(row.status, 'failed');
  assert.match(row.error, /needs an explicit model/u);
  assert.equal(row.stepCount, 0);
});

test('probe and listModels never throw when the CLI is missing', () => {
  const missing = { bin: 'definitely-not-an-opencode-cli-xyz', config: {} };
  const probe = descriptor.probe(missing);
  assert.equal(probe.found, false);
  assert.equal(descriptor.listModels(missing), null);
});

test('resolves the Windows npm shim to the exe it forwards to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delegate-shim-'));
  const exe = join(dir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  const shim = join(dir, 'opencode.cmd');
  // Built without backslash escapes: the shim body must be able to carry a
  // literal path, and "\n" in a JS literal would become a newline instead.
  const bs = String.fromCharCode(92);
  const eol = String.fromCharCode(13, 10);
  const body = ['@echo off', '"%dp0%' + bs + 'node_modules' + bs + '@opencode' + bs + 'cli' + bs + 'bin' + bs + 'opencode.exe" %*', ''].join(eol);
  writeFileSync(shim, body);

  const env = { PATH: dir };
  assert.equal(resolveExecutable('opencode', { platform: 'win32', env }), exe);
  // An explicit shim path is not spawnable either: it resolves the same way.
  assert.equal(resolveExecutable(shim, { platform: 'win32', env }), exe);
  // A real .exe on PATH wins outright.
  assert.equal(resolveExecutable('opencode.exe', { platform: 'win32', env: { PATH: '' }, exists: () => true }), 'opencode.exe');
});
