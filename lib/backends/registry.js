/**
 * dsh-delegate — the backend registry.
 *
 * The one place that knows which CLI adapters this install ships. Everything
 * downstream (`lib/runner.js`, `lib/index.js`, the widget) talks to a backend
 * only through this object, never through a module import, so adding CLI number
 * three is: write `lib/backends/<id>.js`, add its skill directory. Nothing
 * else — the installed descriptors are discovered from this directory at load
 * (spec 5.1).
 *
 * Config is resolved per backend: `config.backends.<id>` wins, and a descriptor
 * may still read the flat keys this repo shipped before the seam (agy does, via
 * `legacyConfig`; the spec keeps them honoured — 5.5, 10).
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BACKENDS_DIR = fileURLToPath(new URL('.', import.meta.url));
const THIS_MODULE = fileURLToPath(import.meta.url);

/**
 * The backend an unnamed dispatch falls back to. Which adapter is the default
 * is a plugin policy rather than a fact about a CLI (ADR-0001 keeps per-CLI
 * facts in the descriptor), so it lives here: agy leads the bundle until a
 * dispatch names one (see `defaultId`). The rest sort by id.
 */
const DEFAULT_BACKEND_ID = 'agy';

/**
 * Read every installed adapter out of a directory: the `*.js` files that export
 * a `descriptor`. The registry module itself is skipped — importing it here
 * would await the top-level await that is running this function. A file that
 * cannot be imported, or that exports no descriptor, is not an installed
 * adapter, and plugin load never fails for one; the contract test imports every
 * file in the directory and names the broken one.
 *
 * Async by nature: the adapters are ESM, so only `import()` can load them. The
 * module calls this below, which is what makes dropping in a file enough.
 * @param directory - the directory to scan; injectable for tests.
 * @returns the descriptors, the declared default first, the rest by id.
 */
export async function discoverBackends(directory = BACKENDS_DIR) {
  const found = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.js')).sort()) {
    const path = join(directory, file);
    if (path === THIS_MODULE) continue;
    try {
      const module = await import(pathToFileURL(path).href);
      if (module.descriptor == null) continue;
      found.push(module.descriptor);
    } catch {
      // Unimportable is treated as absent so a stray file cannot stop plugin
      // load; the contract test is where the file gets named.
    }
  }
  const isDefault = (descriptor) => descriptor.id === DEFAULT_BACKEND_ID;
  const rest = found
    .filter((descriptor) => !isDefault(descriptor))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return found.filter(isDefault).concat(rest);
}

/**
 * Every adapter this package ships, in dispatch order. Discovered from
 * `lib/backends/` at load, so adding an adapter is dropping in its file.
 */
export const BUNDLED_BACKENDS = await discoverBackends();

/**
 * The model list for a found adapter that can enumerate one (spec 5.1), when its
 * own probe did not carry one. Observed health, so a missing CLI is not asked;
 * never throws, so the health route stays up.
 */
function observedModels(descriptor, observed, { bin, config }) {
  if (observed.found !== true || observed.models != null) return null;
  if (descriptor.capabilities?.modelList !== true || typeof descriptor.listModels !== 'function') return null;
  try {
    return descriptor.listModels({ bin, config }) ?? null;
  } catch {
    return null;
  }
}

/**
 * Collect the installed backends with their resolved config.
 * @param options - `{ config, descriptors }`; descriptors defaults to the bundle
 *   and is injectable so a test can exercise a fake CLI without a core change.
 * @returns `{ list, ids, get, defaultId, probe }`.
 */
export function createBackends({ config = {}, descriptors = BUNDLED_BACKENDS } = {}) {
  const configured = config?.backends ?? {};
  const entries = new Map();
  for (const descriptor of descriptors) {
    const legacy = typeof descriptor.legacyConfig === 'function' ? descriptor.legacyConfig(config ?? {}) : {};
    const overrides = configured?.[descriptor.id] ?? {};
    entries.set(descriptor.id, {
      descriptor,
      config: { ...descriptor.defaults, ...legacy, ...overrides },
    });
  }

  const first = entries.keys().next();

  return {
    /** Installed backends with resolved config, in dispatch order. */
    list() {
      return [...entries.values()];
    },

    /** The dispatch ids, handy for a tool enum. */
    ids() {
      return [...entries.keys()];
    },

    /** One backend entry, or null when nothing installed matches. */
    get(id) {
      return entries.get(String(id ?? '')) ?? null;
    },

    /** The backend a dispatch uses when the caller names none. */
    defaultId() {
      return first.done === true ? null : first.value;
    },

    /**
     * Observed health for every backend, never configuration.
     * @returns an array of `{ id, label, found, version, models }`.
     */
    probe() {
      return [...entries.values()].map(({ descriptor, config: backendConfig }) => {
        const bin = typeof backendConfig.path === 'string' && backendConfig.path !== '' ? backendConfig.path : descriptor.bin;
        let observed = {};
        try {
          observed = typeof descriptor.probe === 'function' ? descriptor.probe({ bin, config: backendConfig }) ?? {} : {};
        } catch (error) {
          observed = { found: false, version: null, error: String(error?.message ?? error) };
        }
        return {
          id: descriptor.id,
          label: descriptor.label,
          found: observed.found === true,
          version: observed.version ?? null,
          models: observed.models ?? observedModels(descriptor, observed, { bin, config: backendConfig }),
          ...(observed.error === undefined ? {} : { error: observed.error }),
        };
      });
    },
  };
}
