/**
 * dsh-delegate — the OpenCode event stream, folded onto the Step union.
 *
 * `opencode run --format json` prints one JSON object per line; the shapes below
 * were recorded from opencode 2.0.32 and live in `test/fixtures` next to the
 * tests that pin them. This module is the only place that knows them, exactly as
 * `lib/parse.js` is the only place that knows agy's NDJSON — an unknown event
 * becomes a `debug` log step rather than a silent drop, so schema drift shows up
 * in the transcript instead of a mysteriously empty answer.
 *
 * Observed types: `step_start`, `text`, `reasoning`, `tool_use`, `step_finish`
 * (carries `part.cost` and `part.tokens`), `error` (carries `error.type` and
 * `error.message`). Every event carries `sessionID` when a session exists.
 */

import { makeStep } from '../step.js';

/** Event types that are structural noise (they shape turns, not the transcript). */
const SILENT = new Set(['step_start', 'step_started', 'message_start', 'message_end', 'message_update']);

/** An error value from a tool result, normalized to `{ message }`-shaped data. */
function asError(value, fallback) {
  if (value === null || value === undefined) return { message: fallback };
  if (typeof value === 'string') return { message: value };
  if (typeof value === 'object' && typeof value.message === 'string') return value;
  return { message: fallback, detail: value };
}

/**
 * One projector per opencode process.
 * @returns `{ push, steps, info, result, logs }`, the shape every adapter stream has.
 */
export function createOpencodeStream() {
  const steps = [];
  /** part id -> the step it owns, so streamed updates rewrite rather than duplicate. */
  const byPart = new Map();
  let sessionId = null;
  let lastError = null;
  let tokens = null;
  let costStep = null;

  const add = (step) => {
    steps.push(step);
    return step;
  };

  const oneShot = (kind, fields) => add(makeStep(kind, fields));

  /**
   * The session step is returned on the line that reveals the session id, so the
   * runner writes it to events.jsonl like any other step (it is what makes the
   * run resumable).
   */
  const rememberSession = (event) => {
    if (typeof event.sessionID !== 'string' || event.sessionID === '') return [];
    if (sessionId === event.sessionID) return [];
    sessionId = event.sessionID;
    if (steps.some((step) => step.kind === 'session')) return [];
    return [oneShot('session', { id: sessionId })];
  };

  const textLike = (event, kind) => {
    const part = event.part;
    if (event.type === 'text' && kind === 'answer' && part?.type !== 'text') return [];
    if (typeof part?.text !== 'string') return [];
    const key = part.id !== undefined ? `part:${part.id}` : null;
    const existing = key === null ? undefined : byPart.get(key);
    if (existing !== undefined) {
      existing.text = part.text;
      return [existing];
    }
    const step = oneShot(kind, { text: part.text });
    if (key !== null) byPart.set(key, step);
    return [step];
  };

  const toolUse = (event) => {
    const part = event.part;
    if (part === null || typeof part !== 'object') return [];
    const name = typeof part.tool === 'string' && part.tool !== '' ? part.tool : (typeof part.name === 'string' && part.name !== '' ? part.name : 'tool');
    const state = part.state !== null && typeof part.state === 'object' ? part.state : {};
    const key = `tool:${part.partID ?? part.id ?? steps.length}`;
    const fields = { name };
    if (state.input !== undefined) fields.input = state.input;
    if (state.status === 'error') fields.error = asError(state.error ?? state.metadata?.error ?? null, `${name} failed`);
    const existing = byPart.get(key);
    if (existing !== undefined) {
      existing.name = fields.name;
      if (fields.input !== undefined) existing.input = fields.input;
      // A retried tool goes pending -> running -> done; the stale error has to go.
      if (fields.error !== undefined) existing.error = fields.error;
      else delete existing.error;
      return [existing];
    }
    const step = oneShot('tool', fields);
    byPart.set(key, step);
    return [step];
  };

  const stepFinish = (event) => {
    const part = event.part;
    if (part === null || typeof part !== 'object') return [];
    const hasCost = typeof part.cost === 'number';
    if (part.tokens !== null && typeof part.tokens === 'object') tokens = part.tokens;
    if (!hasCost) return [];
    if (costStep === null) {
      costStep = oneShot('cost', { usd: part.cost, tokens: part.tokens ?? null });
      return [costStep];
    }
    // A run has several steps; the run's cost is their sum, so one cost step grows.
    costStep.usd = Number((costStep.usd + part.cost).toFixed(6));
    if (part.tokens !== null && typeof part.tokens === 'object') costStep.tokens = part.tokens;
    return [costStep];
  };

  return {
    /**
     * Fold one stdout line.
     * @returns the steps this line created or rewrote (empty for noise).
     */
    push(line) {
      const text = String(line ?? '').trim();
      if (text === '') return [];
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return [oneShot('log', { level: 'info', text })];
      }
      if (event === null || typeof event !== 'object') {
        return [oneShot('log', { level: 'debug', text: `unhandled event "${typeof event}"` })];
      }
      const session = rememberSession(event);
      switch (event.type) {
        case 'text':
          return [...session, ...textLike(event, 'answer')];
        case 'reasoning':
          return [...session, ...textLike(event, 'thinking')];
        case 'tool_use':
          return [...session, ...toolUse(event)];
        case 'step_finish':
          return [...session, ...stepFinish(event)];
        case 'error': {
          const error = event.error !== null && typeof event.error === 'object' ? event.error : { message: String(event.error ?? 'unknown error') };
          const message = `${error.type ?? 'error'}: ${error.message ?? 'no message'}`;
          lastError = message;
          return [...session, oneShot('log', { level: 'error', text: message })];
        }
        default:
          if (SILENT.has(event.type)) return session;
          return [...session, oneShot('log', { level: 'debug', text: `unhandled event "${String(event.type)}"` })];
      }
    },

    steps() {
      return steps;
    },

    logs() {
      return steps.filter((step) => step.kind === 'log').map((step) => step.text);
    },

    info() {
      return { conversationId: sessionId };
    },

    result() {
      return {
        status: lastError === null ? 'SUCCESS' : 'ERROR',
        error: lastError ?? undefined,
        sessionId,
        tokens,
      };
    },
  };
}
