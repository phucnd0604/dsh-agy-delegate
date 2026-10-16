/**
 * The bundled skill: a user must be able to use /agy-delegate without ever
 * installing it. These checks guard the two ways that promise breaks — a package
 * that ships without the skill files, and a registration the skills service
 * would reject or that the agent would read without the tools note.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { BUNDLED_SKILL_NAME, bundledSkillDir, bundledSkillRegistration, missingSkillFiles } from '../lib/skill.js';

test('the package ships the whole skill', () => {
  assert.equal(BUNDLED_SKILL_NAME, 'agy-delegate');
  assert.deepEqual(missingSkillFiles(), []);

  const dir = bundledSkillDir();
  // The relay is part of the promise: an agent that reads the upstream body is
  // told to run it, so it has to be here.
  assert.match(readFileSync(join(dir, 'scripts', 'relay.mjs'), 'utf8'), /dispatch a brief to agy/);
  assert.match(readFileSync(join(dir, 'UPSTREAM.md'), 'utf8'), /MIT/);
});

test('the registration is one the skills service can take', () => {
  const skill = bundledSkillRegistration();
  assert.equal(skill.name, 'agy-delegate');
  assert.ok(skill.description.length > 40, 'the catalog needs a real routing description');
  assert.ok(skill.whenToUse.length > 20);
  assert.equal(skill.source, 'bundled');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.equal(skill.resourceBase.path, bundledSkillDir());
  assert.match(skill.metadata.upstream, /amElnagdy\/delegate-skills/);
  // A summary is what the catalog carries; only `get` loads the body.
  assert.equal(typeof skill.content, 'string');
});

test('the body keeps upstream intact and adds the install note', () => {
  const skill = bundledSkillRegistration();
  const upstream = readFileSync(join(bundledSkillDir(), 'SKILL.md'), 'utf8').trimEnd();

  assert.ok(skill.content.startsWith(upstream), 'the upstream body is passed through unchanged');
  assert.ok(skill.content.includes('# Antigravity Delegate'));
  assert.ok(skill.content.includes('## The loop'), 'upstream sections survive');

  assert.ok(skill.content.includes('## In this install (dsh-agy-delegate)'));
  assert.ok(skill.content.includes('agy_delegate'), 'the note names the tool the widget watches');
  assert.ok(skill.content.includes('agy_task'));
  assert.ok(skill.content.includes('scripts/relay.mjs'), 'the relay path stays documented');
  assert.ok(skill.content.includes('touchedFiles'), 'and the reviewer knows what the tool path omits');
});
