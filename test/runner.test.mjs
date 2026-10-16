/**
 * The registry's one piece of branching logic that does not need a live agy:
 * the concurrency ceiling that keeps a fan-out of delegations from stacking
 * local agent runs without limit.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAX_CONCURRENT, concurrencyRefusal, settleOutcome } from '../lib/runner.js';

test('refuses to start past the concurrency ceiling', () => {
  assert.equal(concurrencyRefusal(0, 4), null);
  assert.equal(concurrencyRefusal(3, 4), null);

  const atCeiling = concurrencyRefusal(4, 4);
  assert.match(atCeiling, /maxConcurrent 4/);
  assert.match(atCeiling, /agy_task/);

  assert.match(concurrencyRefusal(6, 4), /^6 agy tasks are already running/);
  assert.equal(DEFAULT_MAX_CONCURRENT, 4);
});

test('a "done" that was silently denied is settled as a failure', () => {
  // Verbatim from a real run on this machine: the model asked for a command,
  // agy auto-denied it, the run still exited 0 and called itself SUCCESS.
  const deniedStep = {
    stepIndex: 16,
    stepType: 'tool',
    state: 'ERROR',
    toolName: 'run_command',
    error: {
      type: 'TOOL_ERROR',
      message: 'permission check failed for command "Get-ChildItem -Recurse mobile/test": '
        + 'user denied permission to run command:\nGet-ChildItem -Recurse mobile/test',
    },
  };
  const settled = settleOutcome({ status: 'done', steps: [deniedStep], logs: [] });
  assert.equal(settled.status, 'failed');
  assert.equal(settled.deniedTool, 'run_command');
  assert.match(settled.error, /permission denied for run_command/);
  assert.match(settled.error, /full access/);

  // The same verdict when agy reported the denial only as a log line.
  const fromLog = settleOutcome({
    status: 'done',
    steps: [],
    logs: ['jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.'],
  });
  assert.equal(fromLog.status, 'failed');

  // An ordinary tool failure is not a denial and must not fail a good run.
  const invalidArgs = {
    stepIndex: 4,
    stepType: 'tool',
    state: 'ERROR',
    toolName: 'view_file',
    error: {
      type: 'TOOL_ERROR',
      message: 'declaring permissions: cortex tool view_file: convert tool call for permissions: model output invalid tool call error (invalid_args) failed to read file: The system cannot find the file specified.',
    },
  };
  assert.deepEqual(settleOutcome({ status: 'done', steps: [invalidArgs], logs: [] }), { status: 'done' });

  // A genuine failure keeps the status it already earned.
  assert.deepEqual(settleOutcome({ status: 'timeout', steps: [deniedStep], logs: [] }), { status: 'timeout' });
  assert.deepEqual(settleOutcome({ status: 'done', steps: [], logs: [] }), { status: 'done' });
});
