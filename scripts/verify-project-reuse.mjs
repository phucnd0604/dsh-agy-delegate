/**
 * One real end-to-end check of the two dispatch guarantees, against live agy:
 *
 *   1. a brief that needs a tool runs to completion without pre-granted
 *      allow-rules (full access is the default), and
 *   2. the second brief at the same root joins the project the first one
 *      created instead of opening another.
 *
 * Costs two agy round trips, so it is a script, not part of `node --test`.
 * Usage: node scripts/verify-project-reuse.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistry } from '../lib/runner.js';
import { createBackends } from '../lib/backends/registry.js';
import { findProjectForCwd } from '../lib/projects.js';

const home = mkdtempSync(join(tmpdir(), 'agy-reuse-home-'));
const work = mkdtempSync(join(tmpdir(), 'agy-reuse-work-'));
const registry = createRegistry({
  home,
  backends: createBackends({ config: {} }),
  maxConcurrent: 1,
  log: (line) => console.log('[host]', line),
});

/** Dispatch one brief and wait for it, printing what the widget would show. */
async function dispatch(name, brief) {
  const row = registry.start({ backend: 'agy', brief, cd: work, printTimeout: '150s' });
  const detail = await registry.wait(row.id, 200_000);
  const tools = detail.steps.filter((step) => step.toolName !== undefined).map((step) => step.toolName);
  console.log(`\n${name}: status=${detail.status} reusedProject=${detail.reusedProject} project=${detail.projectId ?? '-'} (${detail.projectName ?? '-'})`);
  console.log(`  tools used: ${tools.length === 0 ? '(none)' : tools.join(', ')}`);
  console.log(`  answer: ${JSON.stringify(detail.answer.trim().slice(0, 120))}`);
  if (detail.error !== null) console.log(`  error: ${detail.error}`);
  return detail;
}

// 1. A tool-using brief with no skipPermissions option: the default must carry it.
const first = await dispatch(
  'tool run (default permissions)',
  'Use the run_command tool to run the command `Get-ChildItem` in the current directory, then reply with exactly: done',
);
assert.equal(first.status, 'done', 'a tool-using brief must complete under the default full access');
assert.ok(first.steps.some((step) => step.toolName === 'run_command'), 'the tool actually ran');

// 2. A plain brief at the same root: it must reuse that project, not open another.
const second = await dispatch('second brief (same root)', 'Reply with exactly: two. Do not use any tools.');

const existing = findProjectForCwd(work);
console.log(`\nregistry lookup for ${work}: ${existing === null ? 'none' : `${existing.id} (${existing.name})`}`);

assert.equal(first.reusedProject, false, 'the first brief opens the project');
assert.equal(second.reusedProject, true, 'the second brief reuses it');
assert.equal(second.projectId, first.projectId, 'and lands in the same project id');
assert.equal(existing.id, first.projectId, 'the registry lookup agrees with what the dispatcher used');

console.log('\nPROJECT REUSE + FULL ACCESS OK');
