/**
 * The adapter contract from docs/specs/0001-multi-backend-delegate.md section
 * 5.1, run against every descriptor in lib/backends/.
 *
 * Adapters are discovered from the directory, so a new lib/backends/<id>.js is
 * put under every check below with no edit to this file. Registering it is a
 * separate line in lib/backends/registry.js, and the first test says so
 * explicitly rather than letting an unregistered file pass unnoticed. A
 * deliberately broken parser or a throwing probe fails here instead of in a
 * user's run.
 *
 * Each adapter also ships a recorded run and its expected steps -
 * <id>-run.jsonl and <id>-run.expected.json - and the fold is asserted against
 * those expected steps, not merely for non-emptiness (spec section 9).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

import { BUNDLED_BACKENDS } from '../../lib/backends/registry.js';
import { isStep } from '../../lib/step.js';
import { validateOptions } from '../../lib/tools.js';

const BACKENDS_DIR = fileURLToPath(new URL('../../lib/backends/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const RUN_FIXTURE = '-run.jsonl';
const EXPECTED_FIXTURE = '-run.expected.json';

/**
 * Every module in lib/backends/ that exports a descriptor, in file-name order.
 * opencode-events.js and registry.js are helpers, not adapters, so the
 * exports-a-descriptor rule skips them instead of a hardcoded name list.
 */
const adapters = [];
for (const file of readdirSync(BACKENDS_DIR).filter((name) => name.endsWith('.js')).sort()) {
  const module = await import(pathToFileURL(join(BACKENDS_DIR, file)).href);
  if (module.descriptor !== undefined) adapters.push({ file, descriptor: module.descriptor });
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-contract-'));
const noSuchCli = join(scratch, 'no-such-cli');
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The methods spec section 5.1 lists without an "optional" marker. describeModel
 * and legacyConfig are the two it marks optional; modelRefusal is required only
 * of a backend that needs an explicit model.
 */
const REQUIRED_METHODS = [
  'probe', 'listModels', 'buildArgv', 'createStream', 'timeoutMs', 'timeoutMessage',
  'denialIn', 'denialMessage', 'settled', 'factsAfterRun', 'answerOf',
];

/** Spec section 5.1 marks these optional, and the core tolerates their absence. */
const OPTIONAL_METHODS = ['describeModel', 'legacyConfig'];

/** The brief every buildArgv check hands over; distinctive so it cannot be a flag value. */
const BRIEF = 'contract brief\nsecond line - ünïcode "quoted"';

/** The recorded input and expected steps for one adapter, side by side. */
function fixturePath(id, suffix) {
  return join(FIXTURES_DIR, id + suffix);
}

/** Fold every line of a recorded run through an adapter's stream projector. */
function foldLines(descriptor, lines, where) {
  const stream = descriptor.createStream();
  for (const line of lines) {
    const produced = stream.push(line);
    if (produced !== undefined) {
      assert.ok(Array.isArray(produced), where + ': push(' + JSON.stringify(line) + ') returned a non-array');
    }
  }
  return stream;
}

/** A value the schema must refuse, chosen to contradict the first declared rule. */
function contradictory(schema) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return '__no_such_enum_value__';
  if (schema.type === 'boolean') return 'not-a-boolean';
  if (schema.type === 'string') return 7;
  if (schema.type === 'array') return 'not-an-array';
  return { not: 'a value' };
}

test('every registered adapter has a file, and every file is registered', () => {
  assert.ok(BUNDLED_BACKENDS.length > 0, 'no bundled backends registered');
  const discovered = adapters.map((entry) => entry.descriptor.id).sort();
  const registered = BUNDLED_BACKENDS.map((descriptor) => descriptor.id).sort();
  assert.deepEqual(
    discovered,
    registered,
    'lib/backends and BUNDLED_BACKENDS disagree; a new adapter is registered in lib/backends/registry.js',
  );
  assert.equal(new Set(registered).size, registered.length, 'duplicate adapter ids');
});

test('every bundled adapter ships a recorded run and its expected steps', () => {
  for (const descriptor of BUNDLED_BACKENDS) {
    for (const suffix of [RUN_FIXTURE, EXPECTED_FIXTURE]) {
      const fixture = fixturePath(descriptor.id, suffix);
      assert.ok(existsSync(fixture), 'missing ' + fixture);
    }
  }
});

for (const { file, descriptor } of adapters) {
  const where = file + ' (' + descriptor.id + ')';

  test(where + ': declares the identity, schema and methods the core reads', () => {
    assert.ok(/^[a-z][a-z0-9-]*$/.test(descriptor.id), where + ': id must be kebab-case');
    assert.ok(typeof descriptor.label === 'string' && descriptor.label !== '', where + ': label');
    assert.ok(typeof descriptor.bin === 'string' && descriptor.bin !== '', where + ': bin');
    assert.ok(descriptor.defaults !== null && typeof descriptor.defaults === 'object', where + ': defaults');
    assert.ok(descriptor.capabilities !== null && typeof descriptor.capabilities === 'object', where + ': capabilities');
    const { skill } = descriptor;
    assert.ok(skill !== null && typeof skill === 'object', where + ': skill');
    for (const key of ['name', 'dir', 'upstream']) {
      assert.ok(typeof skill[key] === 'string' && skill[key] !== '', where + ': skill.' + key);
    }
    const schema = descriptor.optionsSchema;
    assert.equal(schema?.type, 'object', where + ': optionsSchema.type');
    assert.ok(schema?.properties !== null && typeof schema.properties === 'object', where + ': optionsSchema.properties');
    assert.equal(schema.additionalProperties, false, where + ': optionsSchema must close the bag');
    for (const name of REQUIRED_METHODS) {
      assert.equal(typeof descriptor[name], 'function', where + ': missing method ' + name);
    }
    for (const name of OPTIONAL_METHODS) {
      if (descriptor[name] !== undefined) {
        assert.equal(typeof descriptor[name], 'function', where + ': optional ' + name + ' is not a function');
      }
    }
    if (descriptor.capabilities.modelRequired === true) {
      assert.equal(typeof descriptor.modelRefusal, 'function', where + ': modelRequired but no modelRefusal');
    }
  });

  test(where + ': buildArgv hands the brief over exactly once', () => {
    const plan = descriptor.buildArgv({
      cd: scratch,
      brief: BRIEF,
      logPath: join(scratch, descriptor.id + '.log'),
      options: {},
      config: { projectsDir: join(scratch, 'projects') },
    });
    assert.ok(plan !== null && typeof plan === 'object', where + ': buildArgv returned ' + String(plan));
    assert.ok(Array.isArray(plan.argv) && plan.argv.length > 0, where + ': argv must be a non-empty array');
    for (const arg of plan.argv) {
      assert.ok(typeof arg === 'string' && arg.length > 0, where + ': argv entry ' + JSON.stringify(arg));
    }
    const inArgv = plan.argv.filter((arg) => arg.includes(BRIEF)).length;
    const onStdin = typeof plan.stdin === 'string' && plan.stdin.includes(BRIEF) ? 1 : 0;
    assert.equal(inArgv + onStdin, 1, where + ': brief crossed ' + (inArgv + onStdin) + ' times (argv ' + inArgv + ', stdin ' + onStdin + ')');
  });

  test(where + ': the stream parser tolerates garbage and only emits steps', () => {
    const garbage = [
      '', '   ', '\t', 'not json at all', '{"event":', '{"type":', '[]', 'null', '0', '"a string"',
      '{"event":"some_new_thing","payload":{"x":1}}', '{"type":"some_new_thing"}', '{"event":null}',
    ];
    const stream = foldLines(descriptor, garbage, where);
    assert.ok(stream.steps().length > 0, where + ': garbage produced no diagnostic step at all');
    for (const step of stream.steps()) {
      assert.ok(isStep(step), where + ': non-Step emitted: ' + JSON.stringify(step));
    }
  });

  test(where + ': probe and listModels report absence instead of throwing', () => {
    const probed = descriptor.probe({ bin: noSuchCli, config: {} });
    assert.equal(probed.found, false, where + ': probe claimed a missing binary was found');
    assert.equal(probed.version, null, where + ': version for a missing binary');
    assert.ok(Array.isArray(probed.models) || probed.models === null, where + ': probe.models');
    const models = descriptor.listModels({ bin: noSuchCli, config: {} });
    assert.ok(models === null || Array.isArray(models), where + ': listModels must be string[] or null');
  });

  test(where + ': optionsSchema refuses a foreign key and a contradictory value', () => {
    const foreign = validateOptions(descriptor, { definitely_not_an_option: true });
    assert.equal(foreign.ok, false, where + ': a foreign option key was accepted');
    assert.ok(foreign.message.includes('definitely_not_an_option'), where + ': refusal must name the key');
    const [key] = Object.keys(descriptor.optionsSchema.properties);
    if (key === undefined) return;
    const wrong = contradictory(descriptor.optionsSchema.properties[key]);
    const refused = validateOptions(descriptor, { [key]: wrong });
    assert.equal(refused.ok, false, where + ': ' + key + ' accepted ' + JSON.stringify(wrong));
    assert.ok(refused.message.includes(key), where + ': refusal must name ' + key);
  });

  test(where + ': the recorded fixture folds into the expected steps', () => {
    const input = fixturePath(descriptor.id, RUN_FIXTURE);
    const expected = fixturePath(descriptor.id, EXPECTED_FIXTURE);
    assert.ok(existsSync(input), where + ': missing ' + input);
    assert.ok(existsSync(expected), where + ': missing ' + expected);
    const lines = readFileSync(input, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '');
    const wanted = JSON.parse(readFileSync(expected, 'utf8'));
    assert.ok(Array.isArray(wanted) && wanted.length > 0, where + ': expected steps must be a non-empty array');
    const stream = foldLines(descriptor, lines, where);
    const steps = stream.steps();
    assert.equal(steps.length, wanted.length, where + ': folded ' + steps.length + ' steps, expected ' + wanted.length);
    wanted.forEach((want, index) => {
      const got = steps[index];
      assert.ok(isStep(got), where + ': step ' + index + ' is not a Step');
      for (const key of Object.keys(want)) {
        assert.deepEqual(got[key], want[key], where + ': step ' + index + ' (' + got.kind + ').' + key);
      }
    });
    assert.ok(typeof stream.result() === 'object', where + ': result() must be an object');
    assert.ok(Array.isArray(stream.logs()), where + ': logs() must be an array');
    assert.ok(typeof stream.info() === 'object', where + ': info() must be an object');
  });
}
