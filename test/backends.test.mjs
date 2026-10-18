/**
 * The seam's contract, held by two kinds of test: a golden argv for the agy
 * adapter (behaviour must be byte-identical to the pre-seam runner, and agy is
 * not installed here so nothing else can pin it), and an end-to-end run of a
 * fake backend that the core had to learn nothing about. If adding a backend
 * ever needs a branch in `lib/runner.js`, the fake-descriptor test below is what
 * catches it.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { descriptor as agy } from '../lib/backends/agy.js';
import { BUNDLED_BACKENDS, createBackends } from '../lib/backends/registry.js';
import { createRegistry } from '../lib/runner.js';

// ---------------------------------------------------------------- the registry

test('the bundle ships agy as the default backend', () => {
  const backends = createBackends({ config: {} });
  assert.deepEqual(backends.ids(), ['agy']);
  assert.deepEqual(backends.ids(), BUNDLED_BACKENDS.map((entry) => entry.id));
  assert.equal(backends.defaultId(), 'agy');
  assert.equal(backends.get('agy').descriptor.label, 'Antigravity CLI');
  assert.equal(backends.get('nope'), null);
});

test('per-backend config beats the legacy flat keys, which beat the defaults', () => {
  const legacy = createBackends({
    config: { agyPath: 'C:\\tools\\agy.exe', printTimeout: '10m', skipPermissions: false, projectsDir: 'C:\\projects' },
  });
  const resolved = legacy.get('agy').config;
  assert.equal(resolved.path, 'C:\\tools\\agy.exe');
  assert.equal(resolved.printTimeout, '10m');
  assert.equal(resolved.skipPermissions, false);
  assert.equal(resolved.projectsDir, 'C:\\projects');

  const nested = createBackends({
    config: { agyPath: 'C:\\tools\\agy.exe', backends: { agy: { printTimeout: '5m' } } },
  });
  assert.equal(nested.get('agy').config.printTimeout, '5m');
  assert.equal(nested.get('agy').config.path, 'C:\\tools\\agy.exe', 'unrelated legacy keys still apply');

  const untouched = createBackends({ config: {} }).get('agy').config;
  assert.equal(untouched.printTimeout, '30m');
  assert.equal(untouched.skipPermissions, true);
});

test('probe reports observed health and never throws', () => {
  const [probed] = createBackends({ config: {} }).probe();
  assert.equal(probed.id, 'agy');
  assert.equal(typeof probed.found, 'boolean');
  assert.equal(probed.models, null);
});

// ------------------------------------------------------------------- agy argv

test('agy argv is byte-identical to the pre-seam runner', () => {
  const cd = resolve(tmpdir(), 'golden-repo');
  const absDir = resolve(cd, '..', 'elsewhere');
  const logPath = resolve(tmpdir(), 'runs', 'agy-abc', 'agy.log');
  const task = {
    cd,
    brief: 'do the thing',
    model: 'gemini-4-argon-high',
    effort: 'high',
    readOnly: false,
    sandbox: true,
    skipPermissions: true,
    printTimeout: '30m',
    logPath,
    options: { newProject: true, addDirs: ['sub', absDir] },
    config: {},
  };

  const { argv, facts } = agy.buildArgv(task);
  assert.deepEqual(argv, [
    '--new-project',
    '--add-dir', cd,
    '--add-dir', resolve(cd, 'sub'),
    '--add-dir', absDir,
    '--model', 'gemini-4-argon-high',
    '--effort', 'high',
    '--sandbox', '--dangerously-skip-permissions',
    '--print-timeout', '30m',
    '--log-file', logPath,
    '--output-format', 'stream-json',
    '--print=do the thing',
  ]);
  assert.deepEqual(facts, { projectId: null, projectName: null, reusedProject: false });
});

test('agy argv: read-only keeps the sandbox and never asks for full access twice', () => {
  const cd = resolve(tmpdir(), 'ro-repo');
  const { argv } = agy.buildArgv({
    cd,
    brief: 'look only',
    readOnly: true,
    sandbox: false,
    skipPermissions: false,
    printTimeout: '2m',
    logPath: resolve(cd, 'agy.log'),
    options: { newProject: true },
    config: {},
  });
  assert.deepEqual(argv.slice(0, 6), ['--new-project', '--add-dir', cd, '--sandbox', '--dangerously-skip-permissions', '--print-timeout']);
  assert.equal(argv.filter((part) => part === '--dangerously-skip-permissions').length, 1);
});

test('agy argv: an explicit project joins it instead of opening a new one', () => {
  const cd = resolve(tmpdir(), 'project-repo');
  const { argv, facts } = agy.buildArgv({
    cd,
    brief: 'continue',
    skipPermissions: true,
    printTimeout: '30m',
    logPath: resolve(cd, 'agy.log'),
    options: { project: 'proj-1' },
    config: {},
  });
  assert.deepEqual(argv.slice(0, 4), ['--project', 'proj-1', '--add-dir', cd]);
  assert.ok(!argv.includes('--new-project'));
  assert.equal(facts.projectId, 'proj-1');
});

test('agy argv: resume-last and conversation carry their own flags', () => {
  const cd = resolve(tmpdir(), 'resume-repo');
  const base = { cd, brief: 'again', skipPermissions: true, printTimeout: '30m', logPath: resolve(cd, 'agy.log'), config: {} };
  const resumed = agy.buildArgv({ ...base, options: { resumeLast: true } }).argv;
  assert.deepEqual(resumed.slice(0, 3), ['--continue', '--add-dir', cd]);
  assert.ok(resumed.includes('--print-timeout'));
  assert.ok(!resumed.includes('--new-project'), 'a continued run must not open a project');

  const conversation = agy.buildArgv({ ...base, options: { conversation: 'conv-9' } }).argv;
  assert.deepEqual(conversation.slice(0, 4), ['--conversation', 'conv-9', '--add-dir', cd]);
});

// ------------------------------------------------- a second backend, no core change

/** A backend that speaks a language the core has never seen: plain lines. */
function fakeBackend() {
  const logs = [];
  let steps = [];
  return {
    id: 'fake',
    label: 'Fake CLI',
    bin: process.execPath,
    capabilities: { modelRequired: false },
    defaults: { printTimeout: '30s' },
    optionsSchema: { type: 'object', properties: {}, additionalProperties: false },

    buildArgv(task) {
      return {
        argv: ['-e', 'process.stdout.write(process.env.FAKE_LINES ?? "")'],
        env: { FAKE_LINES: task.options.lines ?? '' },
      };
    },

    createStream() {
      steps = [];
      return {
        push(line) {
          const text = line.trim();
          if (text === '') return [];
          if (text.startsWith('!')) {
            logs.push(text.slice(1));
            return [{ kind: 'log', text: text.slice(1) }];
          }
          steps.push({ stepIndex: steps.length, stepType: 'agent_response', state: 'DONE', text, thinking: '', deltas: 1 });
          return [{ kind: 'step', step: steps.at(-1) }];
        },
        steps() {
          return steps;
        },
        logs() {
          return logs;
        },
        result() {
          return { status: 'SUCCESS' };
        },
        info() {
          return { conversationId: 'conv-fake' };
        },
      };
    },

    settled({ code }) {
      return code === 0 ? { status: 'done' } : { status: 'failed', error: `fake exited ${code}` };
    },

    factsAfterRun(task) {
      task.conversationId = 'conv-fake';
      task.projectId = 'fake-project';
    },

    answerOf(folded) {
      return folded.map((step) => step.text).join('\n');
    },
  };
}

test('a fake backend runs end to end through the unmodified core', async () => {
  const home = mkdtempSync(join(tmpdir(), 'delegate-backends-'));
  const work = mkdtempSync(join(tmpdir(), 'delegate-work-'));
  const backends = createBackends({ config: {}, descriptors: [fakeBackend()] });
  const registry = createRegistry({ home, backends, log: () => {} });

  const row = registry.start({
    brief: 'say hello',
    cd: work,
    lines: 'hello\n!a note from the cli\nworld\n',
  });
  assert.equal(row.backend, 'fake');
  assert.equal(row.backendLabel, 'Fake CLI');
  assert.equal(row.status, 'running');

  const detail = await registry.wait(row.id, 20_000);
  assert.equal(detail.status, 'done');
  assert.equal(detail.answer, 'hello\nworld');
  assert.equal(detail.stepCount, 2);
  assert.equal(detail.toolCalls, 0);
  assert.equal(detail.conversationId, 'conv-fake');
  assert.equal(detail.projectId, 'fake-project', 'adapter facts land on the row');
  assert.deepEqual(detail.logs, ['a note from the cli']);

  const resultPath = join(home, 'delegate', 'runs', row.id, 'result.json');
  assert.ok(existsSync(resultPath));
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.backend, 'fake');
  assert.equal(result.plugin, 'dsh-delegate');
  assert.equal(result.finalMessage, 'hello\nworld');
  assert.ok(result.artifacts.brief.endsWith('brief.txt'));
});

test('dispatching to a backend nobody installed is refused, not guessed', () => {
  const registry = createRegistry({
    home: mkdtempSync(join(tmpdir(), 'delegate-backends-')),
    backends: createBackends({ config: {} }),
    log: () => {},
  });
  assert.throws(() => registry.start({ backend: 'opencode', brief: 'x', cd: process.cwd() }), /unknown backend "opencode"; installed: agy/);
});

test('the core refuses a registry with no backends', () => {
  assert.throws(() => createRegistry({ home: tmpdir() }), /needs a backend registry/);
});
