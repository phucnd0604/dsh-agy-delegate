/**
 * The registry's one piece of branching logic that does not need a live agy:
 * the concurrency ceiling that keeps a fan-out of delegations from stacking
 * local agent runs without limit.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAX_CONCURRENT, concurrencyRefusal } from '../lib/runner.js';

test('refuses to start past the concurrency ceiling', () => {
  assert.equal(concurrencyRefusal(0, 4), null);
  assert.equal(concurrencyRefusal(3, 4), null);

  const atCeiling = concurrencyRefusal(4, 4);
  assert.match(atCeiling, /maxConcurrent 4/);
  assert.match(atCeiling, /agy_task/);

  assert.match(concurrencyRefusal(6, 4), /^6 agy tasks are already running/);
  assert.equal(DEFAULT_MAX_CONCURRENT, 4);
});
