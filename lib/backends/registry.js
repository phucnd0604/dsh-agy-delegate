/**
 * dsh-delegate — the backend registry.
 *
 * The one place that knows which CLI adapters this install ships. Everything
 * downstream (`lib/runner.js`, `lib/index.js`, the widget) talks to a backend
 * only through this object, never through a module import, so adding CLI number
 * three is: write `lib/backends/<id>.js`, add its descriptor to
 * `BUNDLED_BACKENDS` below, add its skill directory. Nothing in the core moves.
 *
 * Config is resolved per backend: `config.backends.<id>` wins, and a descriptor
 * may still read the flat keys this repo shipped before the seam (agy does, via
 * `legacyConfig`; ticket #9 removes them).
 */

import { descriptor as agy } from './agy.js';

/** Every adapter this package ships, in dispatch order. */
export const BUNDLED_BACKENDS = [agy];

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
          models: observed.models ?? null,
          ...(observed.error === undefined ? {} : { error: observed.error }),
        };
      });
    },
  };
}
