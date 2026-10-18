/**
 * The normalized transcript's own contract: the six kinds, the selectors every
 * renderer uses, and the trimming that keeps one runaway answer from pinning the
 * host's memory. Adapters fold their streams into this shape, so these helpers
 * are what "backend-agnostic" actually means.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STEP_KINDS, answerOf, costOf, countsOf, excerpt, isStep, makeStep, sessionOf, summarizeSteps, thinkingOf, toolsOf, trimSteps,
} from '../lib/step.js';

test('makeStep stamps every step with its kind and a timestamp', () => {
  assert.deepEqual(STEP_KINDS, ['thinking', 'answer', 'tool', 'session', 'cost', 'log']);
  const step = makeStep('answer', { text: 'hi' });
  assert.equal(step.kind, 'answer');
  assert.equal(step.text, 'hi');
  assert.equal(typeof step.at, 'number');
  assert.throws(() => makeStep('message', { text: 'hi' }), /unknown step kind "message"/);
  assert.equal(isStep(step), true);
  assert.equal(isStep({ kind: 'nope' }), false);
  assert.equal(isStep(null), false);
});

test('selectors read only the normalized kinds', () => {
  const steps = [
    makeStep('session', { id: 'conv-1' }),
    makeStep('thinking', { text: 'why' }),
    makeStep('answer', { text: 'one' }),
    makeStep('answer', { text: 'two' }),
    makeStep('tool', { name: 'read_file', input: { path: 'a.js' } }),
    makeStep('tool', { name: 'read_file', input: { path: 'b.js' }, error: { type: 'TOOL_ERROR', message: 'gone' } }),
    makeStep('cost', { usd: null, tokens: { total_tokens: 10 } }),
    makeStep('log', { level: 'info', text: 'a note' }),
  ];

  assert.equal(answerOf(steps), 'one\ntwo');
  assert.equal(thinkingOf(steps), 'why');
  assert.deepEqual(toolsOf(steps).map((step) => step.input.path), ['a.js', 'b.js']);
  assert.equal(sessionOf(steps), 'conv-1');
  assert.equal(sessionOf([]), null);
  assert.deepEqual(costOf(steps), { usd: null, tokens: { total_tokens: 10 } });
  assert.deepEqual(countsOf(steps), { steps: 8, toolCalls: 2 });

  // A run that reported no cost at all is null, not undefined: the row shows one.
  assert.deepEqual(costOf([makeStep('answer', { text: 'x' })]), { usd: null, tokens: null });
  assert.equal(answerOf([]), '');
});

test('one-line summary names the tools and shows the answer', () => {
  const steps = [
    makeStep('answer', { text: 'edited lib/index.js' }),
    makeStep('tool', { name: 'view_file' }),
    makeStep('tool', { name: 'view_file' }),
  ];
  assert.match(summarizeSteps(steps), /^3 steps; 2 tool calls \(view_file\); answer: edited lib\/index\.js$/);
  assert.equal(summarizeSteps([]), '0 steps');
  assert.equal(excerpt('a\n\nb', 10), 'a b');
});

test('trimSteps caps text, error messages and oversized inputs only', () => {
  const long = 'x'.repeat(50);
  const steps = [
    makeStep('answer', { text: long }),
    makeStep('tool', { name: 'run', input: { blob: long }, error: { type: 'TOOL_ERROR', message: long } }),
    makeStep('session', { id: 'conv-1' }),
  ];
  const trimmed = trimSteps(steps, 10);

  assert.equal(trimmed[0].text, 'xxxxxxxxxx\n… (truncated)');
  assert.equal(trimmed[1].name, 'run', 'non-text fields survive');
  assert.match(trimmed[1].error.message, /… \(truncated\)$/);
  assert.equal(typeof trimmed[1].input, 'string', 'an oversized input becomes its truncated JSON');
  assert.deepEqual(trimmed[2], steps[2], 'a step with no text is untouched');

  // The originals are not mutated: the live stream keeps its full text.
  assert.equal(steps[0].text, long);
});
