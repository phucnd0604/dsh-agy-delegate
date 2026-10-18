/**
 * One real end-to-end run: spawn agy through the registry, watch it settle, and
 * check the task carries a streamed answer. Costs one cheap agy round trip, so
 * it is a script rather than part of `node --test`.
 *
 * Usage: node scripts/smoke.mjs [model]
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistry } from '../lib/runner.js';
import { createBackends } from '../lib/backends/registry.js';

const home = mkdtempSync(join(tmpdir(), 'delegate-smoke-'));
const work = mkdtempSync(join(tmpdir(), 'delegate-work-'));
const registry = createRegistry({
  home,
  backends: createBackends({ config: {} }),
  log: (line) => console.log('[host]', line),
});

const started = registry.start({
  backend: 'agy',
  brief: 'Reply with exactly the word pong. Do not use any tools.',
  cd: work,
  model: process.argv[2],
  printTimeout: '120s',
});
console.log('task', started.id, 'in', work, '(artifacts under', home, ')');

const deadline = Date.now() + 180_000;
let detail = registry.detail(started.id);
while (detail.status === 'running' && Date.now() < deadline) {
  await new Promise((done) => setTimeout(done, 1_000));
  detail = registry.detail(started.id);
  process.stdout.write(`\r${detail.status} · ${detail.steps.length} steps · ${detail.toolCalls} tool calls   `);
}
console.log('\nfinal:', detail.status, detail.error ?? '');

console.log('steps:');
for (const step of detail.steps) {
  console.log(`  ${step.stepIndex} ${step.stepType} ${step.state} ${JSON.stringify(step.text.slice(0, 60))}`);
}
console.log('answer:', JSON.stringify(detail.answer));
console.log('result.json:');
const resultPath = join(home, 'delegate', 'runs', started.id, 'result.json');
console.log(existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : '(missing!)');

assert.equal(detail.status, 'done', 'task should settle as done');
assert.match(detail.answer, /pong/i, 'the streamed answer should be captured');
assert.ok(existsSync(resultPath), 'result.json should be written');
assert.ok(detail.steps.length >= 2, 'streamed steps should be folded');
console.log('\nSMOKE OK');
