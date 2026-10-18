/**
 * The prompt-side surface: delegate and delegate_task (spec 5.3, ADR 0002).
 *
 * Two promises are held here: every refusal returns { ok: false, message }
 * without dispatching, and the description plus schema are rebuilt from the
 * installed descriptors instead of naming one CLI.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackends } from '../lib/backends/registry.js';
import { buildDelegateTool, buildTaskTool, modelGateRefusal, planDispatch, validateOptions } from '../lib/tools.js';

/** A fake adapter: enough descriptor for the tool layer, no CLI involved. */
function fake(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake CLI',
    bin: 'fake',
    capabilities: {},
    defaults: {},
    optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...overrides,
  };
}

const backends = (descriptors, config = {}) => createBackends({ descriptors, config });

test('the schema and description are built from the descriptors', () => {
  const tool = buildDelegateTool(backends([
    fake({ id: 'one', label: 'One CLI', optionsSchema: { properties: { alpha: {}, beta: {} } } }),
    fake({ id: 'two', label: 'Two CLI', capabilities: { modelRequired: true, readOnly: 'plan' }, optionsSchema: { properties: { gamma: {} } } }),
  ]));
  assert.equal(tool.name, 'delegate');
  assert.deepEqual(tool.parameters.properties.backend.enum, ['one', 'two']);
  assert.match(tool.parameters.properties.backend.description, /defaults to one/);
  assert.match(tool.description, /One CLI/);
  assert.match(tool.description, /Two CLI/);
  assert.match(tool.parameters.properties.options.description, /one: alpha, beta/);
  assert.match(tool.parameters.properties.options.description, /unknown key is refused/);
  assert.match(tool.parameters.properties.readOnly.description, /two: plan/);
  assert.match(tool.parameters.properties.model.description, /two needs an explicit model/);
  assert.doesNotMatch(tool.description, /agy/i);
});

test('delegate_task is one control surface for every backend', () => {
  const tool = buildTaskTool();
  assert.equal(tool.name, 'delegate_task');
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'status', 'detail', 'wait', 'kill', 'dismiss']);
  assert.match(tool.description, /started by delegate/);
  assert.deepEqual(tool.parameters.required, ['action']);
});

test('an empty brief is refused', () => {
  const refused = planDispatch({ backends: backends([fake()]), args: { brief: '   ' } });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /brief is required/);
});

test('an unknown backend is refused with the installed ids', () => {
  const registry = backends([fake({ id: 'alpha' }), fake({ id: 'beta' })]);
  const refused = planDispatch({ backends: registry, args: { brief: 'go', backend: 'claude' } });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /unknown backend "claude"/);
  assert.match(refused.message, /installed: alpha, beta/);
});

test('a model-less dispatch asks the adapter and passes its refusal through', () => {
  let seenBin = null;
  const descriptor = fake({
    id: 'metered',
    label: 'Metered CLI',
    capabilities: { modelRequired: true, modelList: true },
    listModels: ({ bin }) => { seenBin = bin; return ['z/go-sub', 'a-free', 'b-free']; },
    modelRefusal: (models) => 'pick one: ' + models.join(', '),
  });
  const registry = backends([descriptor], { backends: { metered: { path: 'C:/tools/metered.exe' } } });
  const refused = planDispatch({ backends: registry, args: { brief: 'go' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.message, 'pick one: z/go-sub, a-free, b-free');
  assert.equal(seenBin, 'C:/tools/metered.exe', 'the configured path is what gets probed');
  const named = planDispatch({ backends: registry, args: { brief: 'go', model: 'vendor/model' } });
  assert.equal(named.ok, true);
  assert.equal(named.dispatch.model, 'vendor/model');
  assert.equal(named.dispatch.backend, 'metered', 'an unnamed dispatch takes the default backend');
});

test('a configured defaultModel is an explicit opt-in, never inferred', () => {
  const descriptor = fake({ id: 'metered', capabilities: { modelRequired: true } });
  const refused = planDispatch({ backends: backends([descriptor]), args: { brief: 'go' } });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /names no default/);
  const registry = backends([descriptor], { backends: { metered: { defaultModel: 'vendor/model' } } });
  const planned = planDispatch({ backends: registry, args: { brief: 'go' } });
  assert.equal(planned.ok, true);
  assert.equal(planned.dispatch.model, 'vendor/model');
});

test('a foreign option key is refused by name', () => {
  const registry = backends([fake({ id: 'alpha', optionsSchema: { properties: { effort: {}, sandbox: {} } } })]);
  const refused = planDispatch({ backends: registry, args: { brief: 'go', options: { gamma: 1 } } });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /unknown option "gamma" for backend "alpha"/);
  assert.match(refused.message, /accepts effort, sandbox/);
});

test('a validated bag is spread flat into the dispatch', () => {
  const registry = backends([fake({ id: 'alpha', optionsSchema: { properties: { effort: {}, sandbox: {} } } })]);
  const planned = planDispatch({ backends: registry, args: { brief: 'do it', backend: 'alpha', model: 'm', readOnly: true, options: { effort: 'high', sandbox: true } } });
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.dispatch, { backend: 'alpha', brief: 'do it', cd: process.cwd(), model: 'm', readOnly: true, effort: 'high', sandbox: true });
  assert.equal(Object.hasOwn(planned.dispatch, 'options'), false, 'the bag is not forwarded as a nested key');
});

test('readOnly plus an explicit full-access dial is refused', () => {
  const registry = backends([fake({
    id: 'alpha',
    capabilities: { readOnly: 'plan', fullAccessOption: 'auto' },
    optionsSchema: { properties: { auto: {} } },
  })]);
  const refused = planDispatch({ backends: registry, args: { brief: 'go', readOnly: true, options: { auto: true } } });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /readOnly and options.auto: true are mutually exclusive/);
  const allowed = planDispatch({ backends: registry, args: { brief: 'go', readOnly: true, options: { auto: false } } });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.dispatch.readOnly, true);
  assert.equal(allowed.dispatch.auto, false);
});

test('the real bundle fills the enum and both option lists', () => {
  const tool = buildDelegateTool(createBackends({ config: {} }));
  assert.deepEqual(tool.parameters.properties.backend.enum, ['agy', 'opencode']);
  const options = tool.parameters.properties.options.description;
  assert.match(options, /agy: .*addDirs/);
  assert.match(options, /opencode: .*standalone/);
});

test('an option value that contradicts the schema is refused, not forwarded', () => {
  const registry = backends([fake({
    id: 'alpha',
    optionsSchema: {
      properties: {
        effort: { type: 'string', enum: ['low', 'high'] },
        addDirs: { type: 'array', items: { type: 'string' } },
        sandbox: { type: 'boolean' },
      },
    },
  })]);
  const wrongEnum = planDispatch({ backends: registry, args: { brief: 'go', options: { effort: 7 } } });
  assert.equal(wrongEnum.ok, false);
  assert.match(wrongEnum.message, /invalid option "effort".*expected one of "low", "high", got a number/);
  const wrongType = planDispatch({ backends: registry, args: { brief: 'go', options: { addDirs: 'C:/extra' } } });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.message, /invalid option "addDirs".*expected an array of strings, got a string/);
  const wrongItem = planDispatch({ backends: registry, args: { brief: 'go', options: { addDirs: ['ok', 7] } } });
  assert.equal(wrongItem.ok, false);
  const ok = planDispatch({ backends: registry, args: { brief: 'go', options: { effort: 'high', addDirs: ['sub'], sandbox: false } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.dispatch.addDirs, ['sub']);
});

test('a backend option can never shadow a shared field', () => {
  const registry = backends([fake({
    id: 'alpha',
    optionsSchema: { properties: { model: { type: 'string' }, readOnly: { type: 'boolean' } } },
  })]);
  const planned = planDispatch({ backends: registry, args: { brief: 'go', model: 'real-model', readOnly: true, options: { model: 'sneaky', readOnly: false } } });
  assert.equal(planned.ok, true);
  assert.equal(planned.dispatch.model, 'real-model');
  assert.equal(planned.dispatch.readOnly, true);
});

test('the tool and the runner share one missing-model refusal', () => {
  const descriptor = fake({
    id: 'metered',
    label: 'Metered CLI',
    capabilities: { modelRequired: true },
    modelRefusal: () => 'pick a free model from the list',
  });
  const registry = backends([descriptor], { backends: { metered: { path: 'C:/tools/metered.exe' } } });
  const refused = planDispatch({ backends: registry, args: { brief: 'go' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.message, modelGateRefusal(descriptor, registry.get('metered').config));
});

test('validateOptions takes an absent bag and refuses a non-object', () => {
  const descriptor = fake({ optionsSchema: { properties: { alpha: {} } } });
  assert.deepEqual(validateOptions(descriptor, undefined), { ok: true, options: {} });
  const refused = validateOptions(descriptor, [1]);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /options must be an object/);
  assert.match(refused.message, /accepts alpha/);
});
