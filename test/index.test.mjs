/**
 * The host half's mount contract: `enabled: false` mounts nothing, and the
 * default mounts both agent tools, the five widget routes and both bundled
 * skills. No CLI is spawned, so this is cheap enough for the suite; the live
 * dispatch path stays in scripts/verify-host-half.mjs.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../lib/index.js';

/** Mount on a fake host context and report what it registered. */
function mount(config) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'delegate-host-'));
  const tools = new Map();
  const routes = new Map();
  const skills = [];
  const disposers = [];
  const ctx = {
    logger: { warn: () => {} },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    get(name) {
      if (name !== 'skills') return undefined;
      return {
        register: (skill) => {
          skills.push(skill);
          return () => { skills.splice(skills.indexOf(skill), 1); };
        },
      };
    },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } },
  };
  apply(ctx, config);
  if (previous === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previous;
  return { tools, routes, skills, disposers };
}

test('enabled: false mounts nothing', () => {
  const mounted = mount({ enabled: false });
  assert.equal(mounted.tools.size, 0, 'no agent tools');
  assert.equal(mounted.routes.size, 0, 'no widget routes');
  assert.equal(mounted.skills.length, 0, 'no skills registered');
  assert.equal(mounted.disposers.length, 1, 'the effect still hands back a (no-op) disposer');
});

test('the default mounts both tools, the five routes and both skills', () => {
  const mounted = mount({});
  assert.deepEqual([...mounted.tools.keys()].sort(), ['delegate', 'delegate_task']);
  assert.equal(mounted.routes.size, 5);
  assert.deepEqual(mounted.skills.map((skill) => skill.name).sort(), ['agy-sub-agent', 'open-code-subagent']);
});
