/**
 * dsh-delegate — the prompt-side surface.
 *
 * Two tools, whatever the backend count: `delegate` dispatches one brief to one
 * installed adapter, `delegate_task` inspects and controls the tasks it started
 * (ADR 0002). Both are built from the descriptors in `lib/backends/`, so a third
 * CLI needs no edit here: the `backend` enum grows, and the `options` bag is
 * validated against that adapter's own `optionsSchema`.
 *
 * Every refusal in this module returns `{ ok: false, message }` and spawns
 * nothing: an empty brief, an unknown backend, a foreign option key, a backend
 * whose model is required but missing, and readOnly combined with an explicit
 * full-access request. The concurrency ceiling is the runner's to refuse.
 */

/** The option keys one adapter accepts, straight from its schema. */
export function optionKeys(descriptor) {
  const properties = descriptor?.optionsSchema?.properties;
  return properties !== null && typeof properties === 'object' ? Object.keys(properties) : [];
}

/** A comma list, for messages a model has to read. */
function commaList(items) {
  return items.join(', ');
}

/** One option's declared shape, as the short phrase a refusal message uses. */
function shapeOf(property) {
  if (Array.isArray(property?.enum) && property.enum.length > 0) {
    return `one of ${commaList(property.enum.map((value) => JSON.stringify(value)))}`;
  }
  const type = property?.type;
  if (type === 'array') {
    const items = property?.items?.type;
    return typeof items === 'string' && items !== '' ? `an array of ${items}s` : 'an array';
  }
  return typeof type === 'string' && type !== '' ? `a ${type}` : 'a JSON value';
}

/** What kind of value arrived, for the same message. */
function kindOf(value) {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return typeof value;
}

/** Does this value contradict its schema fragment (enum first, then type)? */
function mismatches(property, value) {
  if (property === null || typeof property !== 'object') return false;
  if (Array.isArray(property.enum) && property.enum.length > 0) return !property.enum.includes(value);
  const type = property.type;
  if (type === 'array') {
    if (!Array.isArray(value)) return true;
    const items = property.items?.type;
    return typeof items === 'string' && items !== '' ? !value.every((item) => typeof item === items) : false;
  }
  if (type === 'boolean') return typeof value !== 'boolean';
  if (type === 'number') return typeof value !== 'number' || Number.isNaN(value);
  if (type === 'integer') return !Number.isInteger(value);
  if (type === 'string') return typeof value !== 'string';
  if (type === 'object') return typeof value !== 'object' || value === null || Array.isArray(value);
  return false;
}

/**
 * Validate a per-backend options bag against that adapter's schema: a foreign
 * key, or a value that contradicts the declared type or enum, is refused.
 *
 * A foreign key is the one mistake a flat mega-schema would have made
 * impossible to see, so it is refused by name with the accepted keys attached.
 * @param descriptor - the chosen backend's descriptor.
 * @param options - the raw tool argument (may be undefined).
 * @returns `{ ok: true, options }` or `{ ok: false, message }`.
 */
export function validateOptions(descriptor, options) {
  const properties = descriptor?.optionsSchema?.properties ?? {};
  const accepted = optionKeys(descriptor);
  if (options === undefined || options === null) return { ok: true, options: {} };
  if (typeof options !== 'object' || Array.isArray(options)) {
    return {
      ok: false,
      message: `options must be an object; backend "${descriptor.id}" accepts ${accepted.length === 0 ? 'no options' : commaList(accepted)}.`,
    };
  }
  const unknown = Object.keys(options).filter((key) => !accepted.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `unknown option${unknown.length === 1 ? '' : 's'} ${commaList(unknown.map((key) => `"${key}"`))} for backend "${descriptor.id}"; `
        + `it accepts ${accepted.length === 0 ? 'no options' : commaList(accepted)}.`,
    };
  }
  for (const [key, value] of Object.entries(options)) {
    if (mismatches(properties[key], value)) {
      return {
        ok: false,
        message: `invalid option "${key}" for backend "${descriptor.id}": expected ${shapeOf(properties[key])}, got ${kindOf(value)}.`,
      };
    }
  }
  return { ok: true, options: { ...options } };
}

/** The `backend` enum: every installed adapter, in dispatch order. */
export function backendChoices(backends) {
  return backends.list().map(({ descriptor }) => ({ id: descriptor.id, label: descriptor.label }));
}

/** How one backend expresses "look but do not edit", or null when it cannot. */
function readOnlyLane(descriptor) {
  const lane = descriptor.capabilities?.readOnly;
  return typeof lane === 'string' && lane !== '' ? lane : null;
}

/** One backend's model policy, one clause, shared by the description and the hint. */
function modelPolicy(descriptor) {
  return descriptor.capabilities?.modelRequired === true
    ? `${descriptor.id} needs an explicit model (its refusal lists the available ids)`
    : `${descriptor.id} picks its own`;
}

/** The option keys one backend accepts, as list text. */
function optionKeysText(descriptor) {
  const keys = optionKeys(descriptor);
  return keys.length === 0 ? 'none' : commaList(keys);
}

/**
 * One backend as the single line the tool description carries: capabilities
 * first (what a model needs to decide), then the option keys it accepts.
 */
export function describeBackend(entry) {
  const { descriptor } = entry;
  const capabilities = descriptor.capabilities ?? {};
  const bits = [];
  bits.push(capabilities.modelRequired === true ? 'needs an explicit model' : 'picks its own model');
  if (capabilities.modelList === true) bits.push('can list models');
  const lane = readOnlyLane(descriptor);
  if (lane !== null) bits.push(`readOnly = ${lane}`);
  if (Array.isArray(capabilities.resume) && capabilities.resume.length > 0) bits.push(`resume via ${commaList(capabilities.resume)}`);
  if (capabilities.auto === true) bits.push('has an auto-approve dial');
  if (typeof capabilities.fullAccessOption === 'string' && capabilities.fullAccessOption !== '') {
    bits.push(`full access via options.${capabilities.fullAccessOption}`);
  }
  return `${descriptor.id} (${descriptor.label}; ${commaList(bits)}; options: ${optionKeysText(descriptor)})`;
}

/**
 * The refusal for a model-less dispatch on a backend that needs one. The
 * adapter is asked live and its own wording is used; the runner calls this too,
 * so both layers refuse with one sentence (the runner is the last line of
 * defence for a dispatch that did not come through the tool).
 * @param descriptor - the chosen backend's descriptor.
 * @param config - that backend's resolved config (for `path`).
 * @returns the refusal message.
 */
export function modelGateRefusal(descriptor, config = {}) {
  const bin = typeof config.path === 'string' && config.path !== '' ? config.path : descriptor.bin;
  let models = null;
  try {
    models = typeof descriptor.listModels === 'function' ? descriptor.listModels({ bin, config }) : null;
  } catch {
    models = null;
  }
  return typeof descriptor.modelRefusal === 'function'
    ? descriptor.modelRefusal(models)
    : `${descriptor.label} needs an explicit model; this adapter names no default.`;
}
/**
 * Turn raw tool arguments into the dispatch `registry.start` takes, or a refusal.
 * The returned dispatch is flat — shared fields plus the validated option keys —
 * which is exactly what the adapters already read (`task.options` is that object).
 */
export function planDispatch({ backends, args, cwd }) {
  const raw = args ?? {};
  const brief = typeof raw.brief === 'string' ? raw.brief.trim() : '';
  if (brief === '') return { ok: false, message: 'brief is required and must not be empty.' };

  const installed = backends.ids();
  const backendId = raw.backend === undefined || raw.backend === '' ? backends.defaultId() : String(raw.backend);
  const entry = backends.get(backendId);
  if (entry === null) {
    return {
      ok: false,
      message: `unknown backend "${backendId}"; installed: ${installed.length === 0 ? '(none)' : commaList(installed)}.`,
    };
  }
  const { descriptor, config } = entry;

  const checked = validateOptions(descriptor, raw.options);
  if (checked.ok !== true) return checked;
  const options = checked.options;

  const readOnly = raw.readOnly === true;
  const fullAccessOption = descriptor.capabilities?.fullAccessOption;
  if (readOnly && typeof fullAccessOption === 'string' && options[fullAccessOption] === true) {
    return {
      ok: false,
      message: `readOnly and options.${fullAccessOption}: true are mutually exclusive on backend "${descriptor.id}"; `
        + 'readOnly is already the no-edits lane.',
    };
  }

  // A model may be written down in config (an explicit opt-in, never inferred).
  const configured = typeof config.defaultModel === 'string' && config.defaultModel !== '' ? config.defaultModel : '';
  const model = typeof raw.model === 'string' && raw.model !== '' ? raw.model : configured;
  if (descriptor.capabilities?.modelRequired === true && model === '') {
    // Never guess a model: a guessed one may be metered. The adapter's own list
    // is asked live, and its refusal puts the free ids first. The runner calls
    // the same helper, so both layers refuse with one sentence.
    return { ok: false, message: modelGateRefusal(descriptor, config) };
  }

  const cd = typeof raw.cd === 'string' && raw.cd !== '' ? raw.cd : (cwd ?? process.cwd());
  return {
    ok: true,
    // Options first: a future adapter whose schema reuses a shared field name
    // must not be able to shadow what was validated above.
    dispatch: { ...options, backend: descriptor.id, brief, cd, model, readOnly },
  };
}

/**
 * The `delegate` tool definition. Description and schema are rebuilt from the
 * installed descriptors; no CLI name is written here, so this file does not
 * change when CLI number three arrives.
 */
export function buildDelegateTool(backends) {
  const choices = backendChoices(backends);
  const described = backends.list().map(describeBackend);
  const defaultId = backends.defaultId();
  const readOnlyLanes = backends.list()
    .map(({ descriptor }) => `${descriptor.id}: ${readOnlyLane(descriptor) ?? 'unsupported'}`)
    .join('; ');
  const modelHint = backends.list().map(({ descriptor }) => modelPolicy(descriptor)).join('; ');
  const bag = backends.list()
    .map(({ descriptor }) => `${descriptor.id}: ${optionKeysText(descriptor)}`)
    .join('; ');
  return {
    name: 'delegate',
    description: [
      "Delegate a self-contained brief to one of this install's CLI backends as a task — the delegate loop:",
      'you write the brief, the CLI types in its own conversation, you review and land the result.',
      `Backends: ${described.join('; ')}.`,
      'Returns immediately with a task id; watch it with delegate_task, and the user sees the same task live in the floating widget (thinking, answer, tool calls).',
      "Several tasks can run at once (the plugin's maxConcurrent ceiling); a dispatch past that ceiling is refused, not queued.",
      'The brief must carry everything needed: goal, current state with file:line, constraints, the project\'s real gate commands,',
      'and a report contract. The CLI does NOT commit — the caller commits.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The full brief. Self-contained: the CLI sees only this text plus the workspace.' },
        backend: {
          type: 'string',
          enum: choices.map((choice) => choice.id),
          description: `Which CLI backend${defaultId === null ? '' : ` (defaults to ${defaultId})`}: ${choices.map((choice) => `${choice.id} — ${choice.label}`).join('; ')}.`,
        },
        cd: { type: 'string', description: 'Working root for the run (the repo). Defaults to the session working directory.' },
        model: { type: 'string', description: `Model the backend should use. ${modelHint}.` },
        readOnly: { type: 'boolean', description: `Review/diagnosis with no edits, expressed per backend — ${readOnlyLanes}.` },
        options: { type: 'object', description: `Per-backend bag — ${bag}; an unknown key is refused.` },
        background: { type: 'boolean', description: 'Default true. Set false to block until the task settles.' },
        waitSeconds: { type: 'number', description: 'With background:false, how long to wait before returning the running task anyway (default 120, max 600).' },
      },
      required: ['brief'],
      additionalProperties: false,
    },
  };
}

/** The `delegate_task` tool definition: one control surface for every backend. */
export function buildTaskTool() {
  return {
    name: 'delegate_task',
    description:
      'Inspect and control the tasks started by delegate. Actions: list (all tasks, newest first), status (one task\'s row), '
      + 'detail (full live transcript: steps, thinking, answer, tool calls, logs, usage), wait (block until settled or the timeout expires), '
      + "kill (fell the run's process tree), dismiss (forget a finished task).",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'detail', 'wait', 'kill', 'dismiss'], description: 'What to do.' },
        id: { type: 'string', description: 'Task id for status/detail/wait/kill/dismiss.' },
        waitSeconds: { type: 'number', description: 'For action "wait": how long to block (default 120, max 600).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };
}
