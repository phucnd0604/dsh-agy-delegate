/**
 * Directory discovery in lib/backends/registry.js: dropping in an adapter file
 * is the whole registration step (spec 5.1). Scans run against a temp directory,
 * so the shipped bundle is never touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBackends, discoverBackends } from '../lib/backends/registry.js';

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-delegate-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeModule(dir, file, source) {
  writeFileSync(join(dir, file), source, 'utf8');
}

test('a dropped-in descriptor file joins the bundle with no registry edit', async (t) => {
  const dir = scratchDir(t);
  writeModule(dir, 'berry.js', "export const descriptor = { id: 'berry' };\n");
  const found = await discoverBackends(dir);
  assert.deepEqual(found.map((entry) => entry.id), ['berry']);
});

test('the registry default leads, the rest sort by id, not file name', async (t) => {
  const dir = scratchDir(t);
  writeModule(dir, 'zzz.js', "export const descriptor = { id: 'alpha' };\n");
  writeModule(dir, 'mmm.js', "export const descriptor = { id: 'agy' };\n");
  writeModule(dir, 'aaa.js', "export const descriptor = { id: 'zeta' };\n");
  const found = await discoverBackends(dir);
  assert.deepEqual(found.map((entry) => entry.id), ['agy', 'alpha', 'zeta']);
});

test('without the registry default the first id becomes the default', async (t) => {
  const dir = scratchDir(t);
  writeModule(dir, 'zzz.js', "export const descriptor = { id: 'zeta' };\n");
  writeModule(dir, 'aaa.js', "export const descriptor = { id: 'alpha' };\n");
  const backends = createBackends({ config: {}, descriptors: await discoverBackends(dir) });
  assert.deepEqual(backends.ids(), ['alpha', 'zeta']);
  assert.equal(backends.defaultId(), 'alpha');
});

test('a helper module and a file that cannot be imported are ignored', async (t) => {
  const dir = scratchDir(t);
  writeModule(dir, 'events.js', 'export const parse = () => null;\n');
  writeModule(dir, 'broken.js', "throw new Error('cannot load me');\n");
  writeModule(dir, 'good.js', "export const descriptor = { id: 'good' };\n");
  const found = await discoverBackends(dir);
  assert.deepEqual(found.map((entry) => entry.id), ['good']);
});

test('a null descriptor export is not an adapter', async (t) => {
  const dir = scratchDir(t);
  writeModule(dir, 'empty.js', 'export const descriptor = null;\n');
  assert.deepEqual(await discoverBackends(dir), []);
});

test('a discovered adapter reaches the registry and the probe', async (t) => {
  const dir = scratchDir(t);
  writeModule(dir, 'berry.js', [
    'export const descriptor = {',
    "  id: 'berry',",
    "  label: 'Berry CLI',",
    "  bin: 'berry',",
    '  defaults: {},',
    '  probe: () => ({ found: false, version: null }),',
    '};',
    '',
  ].join('\n'));
  const backends = createBackends({ config: {}, descriptors: await discoverBackends(dir) });
  assert.deepEqual(backends.ids(), ['berry']);
  assert.equal(backends.defaultId(), 'berry');
  assert.deepEqual(backends.probe(), [
    { id: 'berry', label: 'Berry CLI', found: false, version: null, models: null },
  ]);
});
