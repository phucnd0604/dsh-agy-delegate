/**
 * Unit checks for the one piece of real logic in the plugin: folding agy's
 * stream-json lines into the normalized transcript from `lib/step.js`. Fixtures
 * are verbatim lines captured from `agy --output-format stream-json` on this
 * machine, including the non-JSON denial line headless agy prints.
 *
 * These assert the Step union, not agy's raw rows: the whole point of #10 is
 * that a second backend can emit the same shape and the rest of the plugin will
 * not know the difference.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createParser, findPermissionDenial, isAnswerStep, isPermissionDenial, permissionDenialMessage } from '../lib/parse.js';
import { costOf, excerpt, summarizeSteps, toolsOf } from '../lib/step.js';

/**
 * Two real error payloads from this machine, one of each kind. The invalid-args
 * one mentions "permissions" in its preamble, which is exactly why the denial
 * check must not match that word.
 */
const DENIED_COMMAND = {
  type: 'TOOL_ERROR',
  message: 'permission check failed for command "Get-FileHash mobile/assets/images/ic-add-light.png": '
    + 'user denied permission to run command:\nGet-FileHash mobile/assets/images/ic-add-light.png\n'
    + 'Do not attempt to circumvent this denial by rephrasing the command.',
};
const INVALID_ARGS = {
  type: 'TOOL_ERROR',
  message: 'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: '
    + 'invalid tool call error (invalid_args) failed to read file: GetFileAttributesEx D:/repo/docs/plan.md: '
    + 'The system cannot find the file specified.',
};

/**
 * The recorded agy run behind test/fixtures/agy-run.jsonl; the conformance
 * harness folds the same pair in test/backends/contract.test.mjs.
 */
const AGY_RUN = readFileSync(new URL('./fixtures/agy-run.jsonl', import.meta.url), 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.trim() !== '');

test('folds the recorded agy run into one normalized transcript', () => {
  const parser = createParser();
  const lines = AGY_RUN;
  const steps = lines.flatMap((line) => parser.push(line));

  // The session step comes first: it is how a run becomes resumable.
  assert.deepEqual(steps[0], { kind: 'session', id: 'd93dec18-fa0f-4f79-af12-11fa24d9be7c', at: steps[0].at });
  assert.equal(steps[0].kind, 'session');
  assert.equal(parser.info().conversationId, 'd93dec18-fa0f-4f79-af12-11fa24d9be7c');
  assert.deepEqual(parser.info().tools, ['run_command', 'view_file']);

  const answer = parser.steps().find(isAnswerStep);
  assert.equal(answer.kind, 'answer');
  assert.equal(answer.text, 'pong\n');

  // Usage lives on a cost step; every kind carries `at`.
  assert.deepEqual(costOf(parser.steps()).tokens, { input_tokens: 16923, output_tokens: 5, total_tokens: 16928 });
  assert.equal(typeof answer.at, 'number');

  assert.equal(parser.result().status, 'SUCCESS');
  assert.equal(parser.result().response, 'pong\n');
  assert.equal(steps.at(-1).kind, 'cost');
});

test('streams one tool call as a single updated step', () => {
  const parser = createParser();
  parser.push('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem -Force"}}}}');
  const [active] = parser.steps();
  assert.equal(active.kind, 'tool');
  assert.equal(active.name, 'run_command');
  assert.equal(active.input.CommandLine, 'Get-ChildItem -Force');
  assert.equal(active.error, undefined);

  parser.push('{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":1.49,"tool_info":{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem -Force"},"error":{"type":"TOOL_ERROR","message":"permission check failed"}}}}');
  const [errored] = parser.steps();
  assert.equal(errored, active, 'the update folds into the same step object');
  assert.equal(errored.kind, 'tool');
  assert.equal(errored.name, 'run_command');
  assert.equal(errored.error.type, 'TOOL_ERROR');
  assert.equal(toolsOf(parser.steps()).length, 1, 'one step per tool call, not one per update');
});

test('an update that clears a tool error neither crashes nor duplicates the step', () => {
  const parser = createParser();
  parser.push('{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"path":"a"}}}}');
  parser.push('{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"path":"a"},"error":null}}}');
  const [step] = parser.steps();
  assert.equal(parser.steps().length, 1);
  assert.equal(step.name, 'view_file');
  assert.equal(step.error, undefined, 'a null error does not become a stored error');
  assert.equal(isPermissionDenial(step), false);
});

test('keeps a non-JSON denial line as a log step instead of dropping it', () => {
  const parser = createParser();
  const steps = parser.push("jetski: no output produced — a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied.");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'log');
  assert.equal(steps[0].level, 'info');
  assert.match(parser.logs()[0], /auto-denied/);
  // Blank lines produce nothing at all.
  assert.deepEqual(parser.push('   '), []);
});

test('reports an unknown event as a debug log step (drift alarm)', () => {
  const parser = createParser();
  const steps = parser.push('{"event":"some_new_thing","payload":{"huge":"blob"}}');
  assert.equal(steps[0].kind, 'log');
  assert.equal(steps[0].level, 'debug');
  assert.match(steps[0].text, /unhandled event "some_new_thing"/);
  assert.equal(steps[0].payload, undefined, 'payloads are not carried into the transcript');
});

test('a refused tool is told apart from an ordinary tool failure', () => {
  assert.equal(isPermissionDenial({ kind: 'tool', name: 'run_command', error: DENIED_COMMAND }), true);
  // The regression this guards: a missing-file error mentions "permissions" in
  // its preamble, and treating that as a denial would abort good runs.
  assert.equal(isPermissionDenial({ kind: 'tool', name: 'view_file', error: INVALID_ARGS }), false);
  assert.equal(isPermissionDenial({ kind: 'tool', name: 'view_file' }), false);
  assert.equal(isPermissionDenial({ kind: 'answer', text: 'hi' }), false);
  assert.equal(isPermissionDenial(null), false);

  const denied = findPermissionDenial([
    { kind: 'tool', name: 'view_file', error: INVALID_ARGS },
    { kind: 'tool', name: 'run_command', error: DENIED_COMMAND },
  ]);
  assert.equal(denied.tool, 'run_command');
  assert.equal(denied.source, 'step');
  assert.equal(findPermissionDenial([{ kind: 'tool', name: 'view_file', error: INVALID_ARGS }]), null);

  // The other way agy reports it: a bare line when the denial leaves no output.
  const fromLog = findPermissionDenial([], ['jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.']);
  assert.equal(fromLog.source, 'log');
  assert.match(permissionDenialMessage(denied), /permission denied for run_command/);
  assert.match(permissionDenialMessage(denied), /full access/);
  assert.match(permissionDenialMessage(denied), /addDirs/);
});

test('summarizes a run and trims excerpts', () => {
  const parser = createParser();
  parser.push('{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Done: edited lib/index.js"}}');
  parser.push('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"path":"lib/index.js"}}}}');
  const summary = summarizeSteps(parser.steps());
  assert.match(summary, /2 steps/);
  assert.match(summary, /1 tool calls \(view_file\)/);
  assert.match(summary, /answer: Done: edited lib\/index\.js/);

  assert.equal(excerpt('  a\n\n b ', 20), 'a b');
  assert.equal(excerpt('x'.repeat(30), 10), 'xxxxxxxxx…');
});

test('a reasoning step streams apart from the answer', () => {
  const parser = createParser();
  parser.push('{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_thinking","text_delta":"let me think"}}');
  parser.push('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"done"}}');
  const kinds = parser.steps().map((step) => step.kind);
  assert.deepEqual(kinds, ['thinking', 'answer']);
  assert.equal(parser.steps()[0].text, 'let me think');
});
