/**
 * dsh-delegate — the Antigravity CLI (`agy`) stream-json projector.
 *
 * agy's NDJSON lines are folded here, once, into the normalized Step union from
 * `lib/step.js`. Nothing downstream sees a `step_update`, a `text_delta` or a
 * `step_index`; the widget, `renderTask` and `delegate_task detail` read the
 * union only.
 *
 * The measured shapes, kept from real runs on this machine:
 *   { event: 'init', conversation_id, init: { cwd, tools, permission_mode } }
 *   { event: 'step_update', step_update: { step_index, state, step_type,
 *       text_delta?, thinking_delta?, tool_name?, tool_info?, duration_seconds?,
 *       usage? } }
 *   { event: 'result', result: { conversation_id, status, response, usage, … } }
 * plus plain non-JSON lines (headless agy prints one when it auto-denies a tool).
 *
 * The permission rules live here because they are agy facts: agy exits 0 and
 * says SUCCESS even when every tool it needed was denied.
 */

import { excerpt, makeStep } from './step.js';

/** Signature of a real refusal, measured against agy's own error payloads. */
const DENIAL = /permission check failed|user denied permission|headless mode cannot prompt|auto-denied/i;
/** The same refusal when it only arrives as a bare log line. */
const LOG_DENIAL = /headless mode cannot prompt|auto-denied/i;

/**
 * One projector per agy process.
 * @returns `{ push, steps, info, result, logs }`; `push` takes one stdout line
 *   and returns the steps it created or updated.
 */
export function createParser() {
  /** Every step, in the order it first appeared. */
  const steps = [];
  /** Fold key -> the live step object (also held in `steps`). */
  const folded = new Map();
  let info = { conversationId: null, tools: [], cwd: null, permissionMode: null };
  let result = null;

  /**
   * Append a delta to a text step, creating it on first sight. Streaming deltas
   * of one step share a key, so the caller always gets the whole text so far.
   */
  function textStep(key, kind, delta) {
    const existing = folded.get(key);
    if (existing !== undefined) {
      existing.text += delta;
      existing.at = Date.now();
      return existing;
    }
    const created = makeStep(kind, { text: delta });
    folded.set(key, created);
    steps.push(created);
    return created;
  }

  /** Record a one-shot step (session / cost / log) in the transcript. */
  function stepOf(kind, fields) {
    const created = makeStep(kind, fields);
    steps.push(created);
    return created;
  }

  /** Create or update the tool step for one `step_index`. */
  function toolStep(key, update) {
    let step = folded.get(key);
    if (step === undefined) {
      step = makeStep('tool', { name: '' });
      folded.set(key, step);
      steps.push(step);
    }
    const name = typeof update.tool_info?.name === 'string' ? update.tool_info.name : update.tool_name;
    if (typeof name === 'string' && name !== '') step.name = name;
    if (update.tool_info?.parameters !== undefined) step.input = update.tool_info.parameters;
    // A cleared error arrives as null on some updates; never overwrite with it.
    if (update.tool_info?.error !== undefined && update.tool_info.error !== null) step.error = update.tool_info.error;
    step.at = Date.now();
    return step;
  }

  /** The canonical step(s) one line produced. */
  function push(line) {
    const text = String(line ?? '').trim();
    if (text === '') return [];

    let event;
    try {
      event = JSON.parse(text);
    } catch {
      // Not JSON: keep the line, it is the only trace a bare denial leaves.
      return [stepOf('log', { level: 'info', text })];
    }

    const name = typeof event?.event === 'string' ? event.event : '';

    if (name === 'init') {
      info = {
        conversationId: event.conversation_id ?? event.init?.conversation_id ?? null,
        tools: Array.isArray(event.init?.tools) ? [...event.init.tools] : [],
        cwd: event.init?.cwd ?? null,
        permissionMode: event.init?.permission_mode ?? null,
      };
      return info.conversationId === null ? [] : [stepOf('session', { id: info.conversationId })];
    }

    if (name === 'step_update') {
      const update = event.step_update ?? {};
      const type = String(update.step_type ?? '');
      const index = Number.isInteger(update.step_index) ? update.step_index : steps.length;
      const delta = typeof update.text_delta === 'string' ? update.text_delta : '';
      const thinking = typeof update.thinking_delta === 'string' ? update.thinking_delta : '';

      if (type.includes('tool')) return [toolStep(`${index}:tool`, update)];
      if (type.includes('thinking') || type.includes('reasoning')) {
        const reasoning = delta || thinking;
        return reasoning === '' ? [] : [textStep(`${index}:thinking`, 'thinking', reasoning)];
      }
      if (type.includes('response')) {
        const touched = [];
        if (delta !== '') touched.push(textStep(`${index}:answer`, 'answer', delta));
        if (thinking !== '') touched.push(textStep(`${index}:thinking`, 'thinking', thinking));
        return touched;
      }
      // `user_input` (the brief echoed back) and unknown step types are not
      // transcript: the brief is already on the task row.
      return [];
    }

    if (name === 'result') {
      result = event.result ?? null;
      const usd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
      return [stepOf('cost', { usd, tokens: result?.usage ?? null })];
    }

    // Drift alarm: a new agy event shows up in the transcript as a log step
    // instead of vanishing, which is what the conformance fixture watches.
    return [stepOf('log', { level: 'debug', text: `unhandled event "${name === '' ? 'unknown' : name}"` })];
  }

  return {
    push,

    /** Every normalized step so far, in first-seen order. */
    steps() {
      return [...steps];
    },

    /** The `init` facts, or nulls before the first event. */
    info() {
      return info;
    },

    /** The final `result` payload, or null while running. */
    result() {
      return result;
    },

    /** The text of every log step (non-JSON lines and drift alarms). */
    logs() {
      return steps.filter((step) => step.kind === 'log').map((step) => step.text);
    },
  };
}

/**
 * Whether a normalized step is the model's answer rather than its reasoning.
 * @param step - a normalized step.
 */
export function isAnswerStep(step) {
  return step !== null && step !== undefined && step.kind === 'answer';
}

/**
 * Whether a tool step is a permission refusal rather than an ordinary failure.
 *
 * The signature must be exact. Measured on this machine, an ordinary failure
 * carries the word "permissions" in its preamble —
 * `declaring permissions: cortex tool view_file: convert tool call for
 * permissions: model output error: invalid tool call error (invalid_args) …` —
 * while a real refusal says `permission check failed for command "…"`. Matching
 * the bare word would flag missing-file errors as denials and abort good runs.
 * @param step - a normalized step.
 */
export function isPermissionDenial(step) {
  if (step === null || step === undefined || step.kind !== 'tool' || step.error === null || step.error === undefined) return false;
  const text = `${step.error.type ?? ''} ${step.error.message ?? ''}`;
  return DENIAL.test(text);
}

/**
 * The first permission refusal in a run, whichever way agy reported it.
 *
 * This is what stops a denied run from being reported as a success: agy exits 0
 * and says "done" even when every tool it needed was auto-denied, so the caller
 * has to look at the transcript rather than the exit code.
 * @param steps - normalized steps.
 * @param logs - agy's non-JSON output lines.
 * @returns `{ tool, message, source }`, or null when nothing was refused.
 */
export function findPermissionDenial(steps, logs = []) {
  for (const step of steps ?? []) {
    if (step.kind === 'tool' && isPermissionDenial(step)) {
      return { tool: step.name, message: String(step.error.message ?? ''), source: 'step' };
    }
  }
  for (const line of logs) {
    if (LOG_DENIAL.test(line)) {
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
