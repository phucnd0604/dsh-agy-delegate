/**
 * agy's project registry.
 *
 * Every agy project is one JSON file in `~/.gemini/config/projects/`, recording
 * the folders the project owns:
 *
 *   { "id": "<uuid>", "name": "repo-name",
 *     "projectResources": { "resources": [ { "folderUri": "file://C:/repo" } ] } }
 *
 * DSH dispatches many briefs against the same repository, so a fresh
 * `--new-project` per dispatch would scatter one repo across projects and lose
 * the conversation history that makes `--resume-last` useful. The dispatch path
 * therefore looks the working root up here first and reuses the project it
 * finds; only a root with no project gets a new one.
 *
 * Everything here is pure or filesystem-read-only, so it is unit tested against
 * fixtures rather than a live agy.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where agy keeps its project registry on this platform. */
export function defaultProjectsDir() {
  return join(homedir(), '.gemini', 'config', 'projects');
}

/**
 * Canonical form used for comparing a registry entry with a working root:
 * `file://C:/Repo/` and `C:\repo` must compare equal on Windows, where the
 * filesystem is case-insensitive and both separators appear in practice.
 * @param value - a folder URI, or a plain path.
 * @returns the canonical comparison key, or null when unusable.
 */
export function canonicalPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let text = value.trim();
  if (/^file:\/\//iu.test(text)) {
    text = text.slice('file://'.length);
    try {
      text = decodeURIComponent(text);
    } catch {
      // Keep the raw text; a malformed escape is not worth failing the lookup.
    }
    // file:///C:/repo carries a leading slash that is not part of the path.
    if (/^\/[A-Za-z]:/u.test(text)) text = text.slice(1);
  }
  text = text.replaceAll('\\', '/').replace(/\/+$/u, '');
  if (text === '') return null;
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * The primary folder a project record claims.
 * @param record - a parsed registry entry.
 * @returns the canonical path, or null when the record names none.
 */
export function projectCwd(record) {
  if (record === null || typeof record !== 'object') return null;
  const resources = record.projectResources?.resources;
  if (!Array.isArray(resources)) return null;
  for (const resource of resources) {
    const path = canonicalPath(resource?.folderUri);
    if (path !== null) return path;
  }
  return null;
}

/**
 * The project that already owns `cwd`, if any.
 *
 * Several projects can claim one folder (each `--new-project` adds another), so
 * the most recently touched registry file wins — that is the one the user was
 * last working in.
 * @param cwd - the working root agy will be given.
 * @param projectsDir - the registry directory.
 * @returns `{ id, name, path }`, or null when the root has no project.
 */
export function findProjectForCwd(cwd, projectsDir = defaultProjectsDir()) {
  const wanted = canonicalPath(cwd);
  if (wanted === null) return null;

  let names;
  try {
    names = readdirSync(projectsDir);
  } catch {
    // No registry yet (agy never ran here): nothing to reuse.
    return null;
  }

  let best = null;
  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue;
    const file = join(projectsDir, fileName);
    let record;
    try {
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // A half-written or foreign file is skipped, never fatal.
      continue;
    }
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') continue;
    if (projectCwd(record) !== wanted) continue;
    let touchedAt = 0;
    try {
      touchedAt = statSync(file).mtimeMs;
    } catch {
      // Unstatable: treat as oldest.
    }
    if (best === null || touchedAt > best.touchedAt) {
      best = {
        touchedAt,
        project: {
          id: record.id,
          name: typeof record.name === 'string' && record.name !== '' ? record.name : record.id,
          path: cwd,
        },
      };
    }
  }
  return best === null ? null : best.project;
}
