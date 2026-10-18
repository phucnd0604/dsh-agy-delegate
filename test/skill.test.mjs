/**
 * The bundled skills: a user must be able to use /agy-sub-agent and
 * /open-code-subagent without ever installing them. These checks guard the two
 * ways that promise breaks — a package that ships without the skill files, and a
 * registration the skills service would reject or that the agent would read
 * without the tools note.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createBackends } from '../lib/backends/registry.js';
import { bundledSkills, bundledSkillRegistration, missingSkillFiles, REQUIRED_FILES } from '../lib/skill.js';

const bundles = bundledSkills(createBackends({ config: {} }));
const bundleOf = (backend) => bundles.find((bundle) => bundle.backend === backend);

test('every adapter with a skill ships the whole bundle', () => {
  assert.deepEqual(bundles.map((bundle) => bundle.name), ['agy-sub-agent', 'open-code-subagent']);
  assert.deepEqual(missingSkillFiles(bundles), []);

  // The relay is part of the promise: an agent that reads the upstream body is
  // told to run it, so it has to be here, and each UPSTREAM.md pins the copy.
  for (const bundle of bundles) {
    assert.match(readFileSync(join(bundle.dir, 'scripts', 'relay.mjs'), 'utf8'), /dispatch a brief to/);
    const upstream = readFileSync(join(bundle.dir, 'UPSTREAM.md'), 'utf8');
    assert.match(upstream, /3aa72d681a79e2a9d09bd9a316353003ae1cb4a7/, 'the copy records the pinned commit');
    assert.match(upstream, /MIT/);
  }
});

test('a missing file is reported against its own bundle', () => {
  const agy = bundleOf('agy');
  assert.equal(
    missingSkillFiles([{ ...agy, dir: join(agy.dir, 'not-here') }]).length,
    REQUIRED_FILES.length,
  );
  assert.deepEqual(missingSkillFiles(bundles), []);
});

test('each registration is one the skills service can take', () => {
  for (const bundle of bundles) {
    const skill = bundledSkillRegistration(bundle);
    assert.equal(skill.name, bundle.name);
    assert.ok(skill.description.length > 40, 'the catalog needs a real routing description');
    assert.ok(skill.whenToUse.length > 20);
    assert.equal(skill.source, 'bundled');
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(skill.resourceBase.kind, 'directory');
    assert.equal(skill.resourceBase.path, bundle.dir);
    assert.equal(skill.metadata.backend, bundle.backend);
    assert.match(skill.metadata.upstream, /amElnagdy\/delegate-skills/);
    assert.equal(skill.metadata.plugin, 'dsh-delegate', 'the catalog attributes the skill to the renamed plugin');
    assert.equal(typeof skill.content, 'string');
  }
});

test('each body keeps upstream intact and adds the backend-specific note', () => {
  for (const bundle of bundles) {
    const skill = bundledSkillRegistration(bundle);
    const upstream = readFileSync(join(bundle.dir, 'SKILL.md'), 'utf8').trimEnd();

    assert.ok(skill.content.startsWith(upstream), 'the upstream body is passed through unchanged');
    assert.ok(!upstream.includes('## In this install'), 'the note is appended at registration, never written to disk');
    assert.ok(skill.content.includes('## In this install (dsh-delegate)'));
    assert.match(skill.content, /\`delegate \{ brief/);
    assert.ok(skill.content.includes('delegate_task'));
    assert.ok(skill.content.includes('scripts/relay.mjs'), 'the relay path stays documented');
    assert.ok(skill.content.includes('touchedFiles'), 'and the reviewer knows what the tool path omits');
    assert.ok(skill.content.includes(`backend: "${bundle.backend}"`), 'the note names this backend');
  }

  const agy = bundledSkillRegistration(bundleOf('agy')).content;
  assert.ok(agy.includes('# Antigravity Delegate'));
  assert.ok(agy.includes('## The loop'), 'upstream sections survive');
  assert.ok(agy.includes('options.newProject: true'), 'agy reuses the root project');
  assert.ok(agy.includes('options.skipPermissions'));

  const opencode = bundledSkillRegistration(bundleOf('opencode')).content;
  assert.ok(opencode.includes('# OpenCode Delegate'));
  assert.ok(!opencode.includes('options.newProject'), 'the project-reuse difference is agy-only');
  assert.ok(opencode.includes('options.auto'));
  assert.ok(opencode.includes('This backend has no default model'));
});

test('every vendored file still matches the hash its UPSTREAM.md pins', () => {
  const vendored = REQUIRED_FILES.filter((file) => file !== 'UPSTREAM.md');
  for (const bundle of bundles) {
    const upstream = readFileSync(join(bundle.dir, 'UPSTREAM.md'), 'utf8');
    const pinned = new Map();
    for (const line of upstream.split(/\r?\n/)) {
      const match = /^\| `([^`]+)` \| `([0-9a-f]{40})` \|$/.exec(line);
      if (match !== null) pinned.set(match[1], match[2]);
    }
    assert.deepEqual(
      [...pinned.keys()].sort(),
      [...vendored].sort(),
      'the pin table covers every file copied from upstream',
    );
    for (const file of vendored) {
      // Normalized the way git does with core.autocrlf: the blob, not the checkout.
      const bytes = Buffer.from(readFileSync(join(bundle.dir, file)).toString('utf8').replace(/\r\n/g, '\n'));
      const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(hash, pinned.get(file), `${file} must still be the pinned upstream blob`);
    }
  }
});
