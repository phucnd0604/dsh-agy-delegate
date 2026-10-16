/**
 * Unit checks for the one piece of real logic in the plugin: turning agy's
 * stream-json lines into the events and steps the widget renders. Fixtures are
 * verbatim lines captured from `agy --output-format stream-json` on this
 * machine, including the non-JSON denial line headless agy prints.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createParser, excerpt, isAnswerStep, summarizeSteps } from '../lib/parse.js';

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
