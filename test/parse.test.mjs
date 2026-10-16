/**
 * Unit checks for the one piece of real logic in the plugin: turning agy's
 * stream-json lines into the events and steps the widget renders. Fixtures are
 * verbatim lines captured from `agy --output-format stream-json` on this
 * machine, including the non-JSON denial line headless agy prints.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createParser, excerpt, findPermissionDenial, isAnswerStep, isPermissionDenial, permissionDenialMessage, summarizeSteps } from '../lib/parse.js';

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

test('folds a plain answer run end to end', () => {
  const parser = createParser();
  const lines = [
    '{"event":"init","conversation_id":"d93dec18-fa0f-4f79-af12-11fa24d9be7c","init":{"cwd":"C:\\\\tmp","tools":["run_command","view_file"],"permission_mode":"request-review"}}',
    '{"event":"step_update","step_update":{"conversation_id":"d93dec18","step_index":0,"state":"DONE","step_type":"user_input"}}',
    '{"event":"step_update","step_update":{"conversation_id":"d93dec18","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"po"}}',
    '{"event":"step_update","step_update":{"conversation_id":"d93dec18","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"ng"}}',
    '{"event":"step_update","step_update":{"conversation_id":"d93dec18","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":4.49,"usage":{"input_tokens":16923,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":16928}}}',
    '{"event":"result","result":{"conversation_id":"d93dec18","status":"SUCCESS","response":"pong\\n","duration_seconds":4.55,"num_turns":1,"usage":{"input_tokens":16923,"output_tokens":5,"total_tokens":16928}}}',
  ];
  const events = lines.flatMap((line) => parser.push(line));

  assert.equal(events[0].kind, 'init');
  assert.equal(parser.info().conversationId, 'd93dec18-fa0f-4f79-af12-11fa24d9be7c');
  assert.deepEqual(parser.info().tools, ['run_command', 'view_file']);

  const answer = parser.steps().find(isAnswerStep);
  assert.equal(answer.text, 'pong\n');
  assert.equal(answer.state, 'DONE');
  assert.equal(answer.deltas, 3);
  assert.equal(answer.usage.total_tokens, 16928);

  assert.equal(parser.result().status, 'SUCCESS');
  assert.equal(parser.result().response, 'pong\n');
  assert.equal(events.at(-1).kind, 'result');
});

test('captures a tool call and its permission error', () => {
  const parser = createParser();
  parser.push('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem -Force"}}}}');
  const active = parser.steps().at(-1);
  assert.equal(active.toolName, 'run_command');
  assert.equal(active.tool.parameters.CommandLine, 'Get-ChildItem -Force');
  assert.equal(active.state, 'ACTIVE');

  parser.push('{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":1.49,"tool_info":{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem -Force"},"error":{"type":"TOOL_ERROR","message":"permission check failed"}}}}');
  const errored = parser.steps().at(-1);
  assert.equal(errored.state, 'ERROR');
  assert.equal(errored.error.type, 'TOOL_ERROR');
  // One row per (step_index, step_type): the update folds into the same row.
  assert.equal(parser.steps().filter((step) => step.toolName !== undefined).length, 1);
});

test('keeps a non-JSON denial line as a log instead of dropping it', () => {
  const parser = createParser();
  const events = parser.push("jetski: no output produced — a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied.");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'log');
  assert.equal(parser.logs().length, 1);
  assert.match(parser.logs()[0], /auto-denied/);
  // Blank lines produce nothing at all.
  assert.deepEqual(parser.push('   '), []);
});

test('records an unknown event by name only', () => {
  const parser = createParser();
  const events = parser.push('{"event":"some_new_thing","payload":{"huge":"blob"}}');
  assert.equal(events[0].kind, 'raw');
  assert.equal(events[0].event, 'some_new_thing');
  assert.equal(events[0].payload, undefined);
});

test('a refused tool is told apart from an ordinary tool failure', () => {
  assert.equal(isPermissionDenial({ toolName: 'run_command', error: DENIED_COMMAND }), true);
  // The regression this guards: a missing-file error mentions "permissions" in
  // its preamble, and treating that as a denial would abort good runs.
  assert.equal(isPermissionDenial({ toolName: 'view_file', error: INVALID_ARGS }), false);
  assert.equal(isPermissionDenial({ toolName: 'view_file' }), false);
  assert.equal(isPermissionDenial(null), false);

  const denied = findPermissionDenial([{ toolName: 'view_file', error: INVALID_ARGS }, { toolName: 'run_command', error: DENIED_COMMAND }]);
  assert.equal(denied.tool, 'run_command');
  assert.equal(denied.source, 'step');
  assert.equal(findPermissionDenial([{ toolName: 'view_file', error: INVALID_ARGS }]), null);

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
