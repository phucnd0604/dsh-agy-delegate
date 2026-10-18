/**
 * dsh-delegate — find the real executable behind a CLI name.
 *
 * A backend names its CLI (`opencode`, `agy`) and the config may name a path.
 * On Windows a package like opencode installs `opencode.cmd` / `opencode.ps1`
 * shims that Node cannot spawn without a shell — and a shell would have to
 * quote the argv, which is exactly what the adapter avoids by putting the brief
 * on stdin. So resolve the shim to the `.exe` it forwards to and spawn that.
 *
 * POSIX needs none of this: the PATH entry is already executable, so the first
 * match wins. Everything is injectable so the Windows path is testable on any
 * machine.
 */

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/** A path ending in .exe inside a shim script: absolute, or relative to node_modules. */
const EXE_IN_SHIM = /([A-Za-z]:\\[^"'\r\n]*?\.exe|node_modules[\\/][^"'\r\n]*?\.exe)/i;

/** Follow a .cmd/.ps1 shim to the executable it forwards to, or null. */
function shimTarget(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const match = EXE_IN_SHIM.exec(text);
  if (match === null) return null;
  const relative = match[1].replace(/^%~dp0%?[\\/]?/i, '').replace(/^["']|["']$/g, '');
  const target = isAbsolute(relative) ? relative : join(dirname(shimPath), relative);
  return existsSync(target) ? target : null;
}

/**
 * Resolve a CLI name to a path that `spawn` can run without a shell.
 * @param bin - the configured path or bare name (`opencode`).
 * @param options - injectable platform facts (tests).
 * @returns an executable path: absolute, or the original name when nothing better exists.
 */
export function resolveExecutable(bin, {
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readShim = shimTarget,
} = {}) {
  const name = String(bin ?? '');
  if (name === '') return name;
  const windows = platform === 'win32';
  const shimName = /\.(bat|cmd|ps1)$/i.test(name);
  // An absolute path, or a path with a separator, is the caller's business —
  // unless it names a shim, which still cannot be spawned without a shell.
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    if (!windows || !shimName) return name;
    return readShim(name) ?? name;
  }
  if (windows && !shimName && /\.(exe|com)$/i.test(name)) return name;

  const dirs = String(env.PATH ?? env.Path ?? '').split(windows ? delimiter : ':').filter(Boolean);
  const extensions = windows ? ['.exe', '.cmd', '.bat', '.ps1'] : [''];
  let shim = null;
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (!exists(candidate)) continue;
      // A real .exe wins even when a shim appeared earlier on PATH.
      if (!windows || extension === '.exe') return candidate;
      if (shim === null) shim = candidate;
    }
  }
  if (shim !== null) {
    const target = readShim(shim);
    if (target !== null) return target;
  }
  return name;
}
