/**
 * Project reuse: a brief dispatched at the same root must land in the project
 * that root already has, instead of scattering one repository across a new
 * project per run. Fixtures are the real registry format agy writes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalPath, findProjectForCwd, projectCwd } from '../lib/projects.js';

/** A registry directory with the given entries. */
function registry(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-projects-'));
  for (const [fileName, record] of Object.entries(entries)) {
    writeFileSync(join(dir, fileName), typeof record === 'string' ? record : JSON.stringify(record, null, 2), 'utf8');
  }
  return dir;
}

/** The real shape agy writes, from this machine. */
function record(id, name, folderUri) {
  return { id, name, projectResources: { resources: [{ folderUri }] } };
}

test('folder URIs and plain paths canonicalize to one comparison key', () => {
  const canonical = canonicalPath('C:/Users/me/repo');
  assert.equal(canonicalPath('file://C:/Users/me/repo'), canonical);
  assert.equal(canonicalPath('file:///C:/Users/me/repo/'), canonical);
  assert.equal(canonicalPath('C:\\Users\\me\\repo\\'), canonical);
  assert.equal(canonicalPath('file://C:/Users/me/re%20po'), canonicalPath('C:/Users/me/re po'));
  assert.equal(canonicalPath(''), null);
  assert.equal(canonicalPath(undefined), null);
  assert.equal(canonicalPath('file://'), null);
});

test('a record yields the folder it owns', () => {
  assert.equal(projectCwd(record('a', 'repo', 'file://C:/repo')), canonicalPath('C:/repo'));
  assert.equal(projectCwd({ id: 'a', name: 'repo' }), null);
  assert.equal(projectCwd({ id: 'a', projectResources: { resources: [] } }), null);
  assert.equal(projectCwd(null), null);
});

test('an existing project for the same root is reused', () => {
  const dir = registry({
    '00e51dd3-f42e-4614-9049-867c540c2d18.json': record('00e51dd3-f42e-4614-9049-867c540c2d18', 'agy-delegate-work-jVqV7b', 'file://C:/Users/me/AppData/Local/Temp/agy-delegate-work-jVqV7b'),
    'default-cli-project.json': record('default-cli-project', 'default-cli-project', 'file://C:/Users/me/scratch'),
  });

  const found = findProjectForCwd('C:\\Users\\me\\AppData\\Local\\Temp\\agy-delegate-work-jVqV7b', dir);
  assert.equal(found?.id, '00e51dd3-f42e-4614-9049-867c540c2d18');
  assert.equal(found?.name, 'agy-delegate-work-jVqV7b');

  // A root with no project gets none, so the caller opens a new one.
  assert.equal(findProjectForCwd('C:/somewhere/else', dir), null);
  // No registry at all is not an error.
  assert.equal(findProjectForCwd('C:/repo', join(dir, 'missing')), null);
});

test('the most recently touched project wins when several claim the root', () => {
  const dir = registry({
    'older.json': record('older', 'repo-old', 'file://C:/repo'),
    'newer.json': record('newer', 'repo-new', 'file://C:/repo'),
  });
  // Seconds apart, not milliseconds: some filesystems stamp coarser mtimes, and
  // a tie would make the winner depend on readdir order.
  const now = Math.floor(Date.now() / 1_000) * 1_000;
  utimesSync(join(dir, 'older.json'), new Date(now - 600_000), new Date(now - 600_000));
  utimesSync(join(dir, 'newer.json'), new Date(now), new Date(now));

  assert.equal(findProjectForCwd('C:/repo', dir)?.id, 'newer');

  // Flip the ages: the lookup follows the file that was touched last.
  utimesSync(join(dir, 'older.json'), new Date(now + 600_000), new Date(now + 600_000));
  assert.equal(findProjectForCwd('C:/repo', dir)?.id, 'older');
});

test('malformed and foreign entries are skipped, not fatal', () => {
  const dir = registry({
    'broken.json': '{ not json',
    'no-id.json': { name: 'no id', projectResources: { resources: [{ folderUri: 'file://C:/repo' }] } },
    'no-folders.json': { id: 'x', name: 'x' },
    'not-json.txt': 'ignored',
    'good.json': record('good', 'repo', 'file://C:/repo'),
  });
  assert.equal(findProjectForCwd('C:/repo', dir)?.id, 'good');
});
