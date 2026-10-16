/**
 * Pure projection of `agy --print … --output-format stream-json` NDJSON into the
 * normalized events the widget renders. No I/O, no timers, no child process —
 * this is the only logic in the plugin worth a unit test.
 *
 * Measured shapes (agy 1.2.x on Windows, 2026-10):
 *   {"event":"init","conversation_id":"…","init":{cwd,tools,permission_mode}}
 *   {"event":"step_update","step_update":{step_index,state,step_type,
 *        text_delta?,tool_name?,tool_info?{name,parameters,error?},
 *        duration_seconds?,usage?}}
 *   {"event":"result","result":{status,response,num_turns,duration_seconds,usage}}
 * A denial also prints a plain "jetski: no output produced …" line that is not
 * JSON at all, so non-JSON lines are kept as log events rather than dropped.
 */

/**
 * @typedef {{stepIndex:number, stepType:string, state:string, text:string,
 *   thinking:string, deltas:number, toolName?:string, tool?:object,
 *   durationSeconds?:number, usage?:object, error?:object}} StepRow
 */

/**
 * Create a projector. One instance per agy process.
 * @returns {{push(line: string): object[], steps(): StepRow[],
 *   info(): object, result(): object|null, logs(): string[]}}
 */
export function createParser() {
  /** @type {Map<string, StepRow>} */
  const rows = new Map();
  const logs = [];
  let seq = 0;
  let info = { conversationId: null, cwd: null, permissionMode: null, tools: [] };
  let result = null;

  const stamp = (event) => ({ seq: ++seq, at: Date.now(), ...event });

  /** One `step_update` folded into its row, keyed by index + type. */
  function foldStep(update) {
    const key = `${update.step_index}:${update.step_type}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = { stepIndex: update.step_index, stepType: update.step_type, state: 'ACTIVE', text: '', thinking: '', deltas: 0 };
      rows.set(key, row);
    }
    if (typeof update.state === 'string') row.state = update.state;
    if (typeof update.text_delta === 'string' && update.text_delta !== '') {
      row.text += update.text_delta;
      row.deltas += 1;
    }
    for (const field of ['thinking_delta', 'reasoning_delta']) {
      const delta = update[field];
      if (typeof delta === 'string' && delta !== '') {
        row.thinking += delta;
        row.deltas += 1;
      }
    }
    if (typeof update.tool_name === 'string') row.toolName = update.tool_name;
    if (update.tool_info !== null && typeof update.tool_info === 'object') {
      row.tool = update.tool_info;
      if (typeof update.tool_info.name === 'string') row.toolName = update.tool_info.name;
      if (update.tool_info.error !== undefined && update.tool_info.error !== null) row.error = update.tool_info.error;
    }
    if (typeof update.duration_seconds === 'number') row.durationSeconds = update.duration_seconds;
    if (update.usage !== null && typeof update.usage === 'object') row.usage = update.usage;
    if (update.error !== undefined && update.error !== null) row.error = update.error;
    return stamp({ kind: 'step', step: { ...row } });
  }

  return {
    /**
     * Fold one output line; returns the events it produced (possibly none).
     * @param line - one raw line of agy stdout.
     * @returns the normalized events, oldest first.
     */
    push(line) {
      const text = line.trim();
      if (text === '') return [];
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        logs.push(text);
        return [stamp({ kind: 'log', text })];
      }
      if (payload === null || typeof payload !== 'object') return [];

      switch (payload.event) {
        case 'init': {
          const init = payload.init ?? {};
          info = {
            conversationId: payload.conversation_id ?? null,
            cwd: init.cwd ?? null,
            permissionMode: init.permission_mode ?? null,
            tools: Array.isArray(init.tools) ? init.tools : [],
            model: init.model ?? null,
          };
          return [stamp({ kind: 'init', info })];
        }
        case 'step_update': {
          const update = payload.step_update;
          if (update === null || typeof update !== 'object') return [];
          return [foldStep(update)];
        }
        case 'result': {
          const value = payload.result;
          if (value === null || typeof value !== 'object') return [];
          result = value;
          return [stamp({ kind: 'result', result: value })];
        }
        default:
          // Unknown event kinds are recorded by name only: the payloads can be
          // large and none of them are rendered.
          return [stamp({ kind: 'raw', event: String(payload.event ?? 'unknown') })];
      }
    },

    /** Every step row, answer steps first in stream order. */
    steps() {
      return [...rows.values()].sort((a, b) => a.stepIndex - b.stepIndex);
    },

    /** The `init` facts, or nulls before the first event. */
    info() {
      return info;
    },

    /** The final `result` payload, or null while running. */
    result() {
      return result;
    },

    /** Non-JSON lines agy printed (denials, warnings). */
    logs() {
      return [...logs];
    },
  };
}

/**
 * Whether a step's text is the model's answer rather than its reasoning. Any
 * step carrying "thinking" is reasoning even when it also streams text.
 * @param step - a folded step row.
 */
export function isAnswerStep(step) {
  return step.stepType.includes('response') && !step.stepType.includes('thinking');
}

/**
 * Whether a folded step is a permission refusal rather than an ordinary tool
 * failure.
 *
 * The signature must be exact. Measured on this machine, an ordinary failure
 * carries the word "permissions" in its preamble —
 * `declaring permissions: cortex tool view_file: convert tool call for
 * permissions: model output error: invalid tool call error (invalid_args) …` —
 * while a real refusal says `permission check failed for command "…"`. Matching
 * the bare word would flag missing-file errors as denials and abort good runs.
 * @param step - a folded step row.
 */
export function isPermissionDenial(step) {
  if (step === null || step === undefined || step.error === undefined) return false;
  const text = `${step.error.type ?? ''} ${step.error.message ?? ''}`;
  return /permission check failed|user denied permission|headless mode cannot prompt|auto-denied/i.test(text);
}

/**
 * The first permission refusal in a run, whichever way agy reported it.
 *
 * This is what stops a denied run from being reported as a success: agy exits 0
 * and says "done" even when every tool it needed was auto-denied, so the caller
 * has to look at the transcript rather than the exit code.
 * @param steps - folded step rows.
 * @param logs - agy's non-JSON output lines.
 * @returns `{ tool, message, source }`, or null when nothing was refused.
 */
export function findPermissionDenial(steps, logs = []) {
  for (const step of steps) {
    if (step.toolName !== undefined && isPermissionDenial(step)) {
      return { tool: step.toolName, message: String(step.error.message ?? ''), source: 'step' };
    }
  }
  for (const line of logs) {
    if (/headless mode cannot prompt|auto-denied/i.test(line)) {
      return { tool: 'unknown', message: String(line), source: 'log' };
    }
  }
  return null;
}

/**
 * The failure a denied run deserves: what happened, and the concrete ways out.
 * @param denial - the result of {@link findPermissionDenial}.
 */
export function permissionDenialMessage(denial) {
  return `permission denied for ${denial.tool}: headless agy cannot answer a permission prompt, so the tool was `
    + 'auto-denied and the run changed nothing. Dispatch with full access (the plugin default), grant the tool in '
    + `agy's settings, or widen the workspace with addDirs. agy said: ${excerpt(denial.message, 200)}`;
}

/** One-line human summary of a task's step list, for the tool result. */export function summarizeSteps(steps) {
  const tools = steps.filter((step) => step.toolName !== undefined);
  const answer = steps.find((step) => isAnswerStep(step) && step.text !== '');
  const parts = [`${steps.length} steps`];
  if (tools.length > 0) parts.push(`${tools.length} tool calls (${[...new Set(tools.map((s) => s.toolName))].join(', ')})`);
  if (answer !== undefined) parts.push(`answer: ${excerpt(answer.text, 160)}`);
  return parts.join('; ');
}

/** Trim whitespace and cut to `max` characters with an ellipsis. */
export function excerpt(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
