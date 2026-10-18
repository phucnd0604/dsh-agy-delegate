/**
 * dsh-delegate — the normalized transcript.
 *
 * Every backend folds its own event stream into these six kinds, and everything
 * downstream (the task row, `renderTask`, `delegate_task detail`, the widget)
 * reads only this shape. That is what makes "which CLI produced this run?" a
 * display detail instead of a code path: add an adapter, and the transcript
 * renders the same.
 *
 * `at` is epoch milliseconds. Fields are additive: a renderer that does not know
 * a key ignores it, so a backend may carry extra facts inside a known kind
 * without breaking the others.
 */

/** The kinds a normalized step may have. */
export const STEP_KINDS = Object.freeze(['thinking', 'answer', 'tool', 'session', 'cost', 'log']);

/**
 * Build one normalized step.
 * @param kind - one of {@link STEP_KINDS}.
 * @param fields - the kind's own fields (text / name / id / …).
 * @returns the step, with `at` stamped.
 */
export function makeStep(kind, fields = {}) {
  if (!STEP_KINDS.includes(kind)) throw new Error(`unknown step kind "${kind}"; expected one of ${STEP_KINDS.join(', ')}`);
  return { kind, ...fields, at: Date.now() };
}

/** Whether a value claims to be a normalized step. */
export function isStep(value) {
  return value !== null && typeof value === 'object' && STEP_KINDS.includes(value.kind);
}

/** The answer text a run produced: answer steps joined, in order. */
export function answerOf(steps) {
  return (steps ?? [])
    .filter((step) => step.kind === 'answer' && typeof step.text === 'string' && step.text !== '')
    .map((step) => step.text)
    .join('\n');
}

/** The reasoning text a run produced, for a reader that wants it. */
export function thinkingOf(steps) {
  return (steps ?? [])
    .filter((step) => step.kind === 'thinking' && typeof step.text === 'string' && step.text !== '')
    .map((step) => step.text)
    .join('\n');
}

/** Every tool call in the transcript, in order. */
export function toolsOf(steps) {
  return (steps ?? []).filter((step) => step.kind === 'tool');
}

/** The conversation/session id a run reported, or null. */
export function sessionOf(steps) {
  const step = (steps ?? []).find((entry) => entry.kind === 'session');
  return step === undefined || step.id === undefined ? null : step.id;
}

/**
 * The cost facts a run reported.
 * @returns `{ usd, tokens }`; both null when the backend reports neither (agy
 *   exposes no price at all, only token counts).
 */
export function costOf(steps) {
  let usd = null;
  let tokens = null;
  for (const step of steps ?? []) {
    if (step.kind !== 'cost') continue;
    if (typeof step.usd === 'number') usd = step.usd;
    if (step.tokens !== null && typeof step.tokens === 'object') tokens = step.tokens;
  }
  return { usd, tokens };
}

/** `{ steps, toolCalls }` — the counts every row and detail view needs. */
export function countsOf(steps) {
  const list = steps ?? [];
  return { steps: list.length, toolCalls: list.filter((step) => step.kind === 'tool').length };
}

/** One-line human summary of a transcript, for a tool result. */
export function summarizeSteps(steps) {
  const list = steps ?? [];
  const parts = [`${list.length} steps`];
  const tools = toolsOf(list);
  if (tools.length > 0) parts.push(`${tools.length} tool calls (${[...new Set(tools.map((step) => step.name))].join(', ')})`);
  const answer = answerOf(list);
  if (answer !== '') parts.push(`answer: ${excerpt(answer, 160)}`);
  return parts.join('; ');
}

/** Shorten a string with an ellipsis, collapsing whitespace first. */
export function excerpt(text, max) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** A step's text, truncated to `limit` characters. */
function trimText(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}

/**
 * Cap the text a transcript step carries, so one runaway answer cannot pin the
 * host's memory. Everything else about the step survives unchanged.
 * @param steps - normalized steps.
 * @param limit - characters per text field.
 */
export function trimSteps(steps, limit = 400_000) {
  return (steps ?? []).map((step) => {
    const copy = { ...step };
    if (typeof copy.text === 'string') copy.text = trimText(copy.text, limit);
    if (copy.error !== null && typeof copy.error === 'object' && typeof copy.error.message === 'string') {
      copy.error = { ...copy.error, message: trimText(copy.error.message, limit) };
    }
    if (copy.input !== undefined) {
      try {
        const json = JSON.stringify(copy.input);
        if (json.length > limit) copy.input = `${json.slice(0, limit)}… (truncated)`;
      } catch {
        // Keep the original: an unserializable input is the backend's problem.
      }
    }
    return copy;
  });
}
