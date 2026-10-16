/**
 * Client-half checks without a browser and without React: the widget's
 * components are pure functions of their props, so a small createElement stub
 * plus a tree walk covers the paths that would otherwise only fail in the GUI —
 * a typo, a missing null guard, a wrong `dsh.client` export.
 *
 * `AgyWidget` itself owns hooks and is deliberately not rendered here; its
 * exports/registration contract is asserted, and the live behaviour is the
 * browser's job.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

/** The registration the module-loader handoff captured. */
let captured;
globalThis.window = {
  __ModuleLoader__: { load: (registration) => { captured = registration; } },
};

/** A React-shaped createElement: enough for the tree walk below. */
function createElement(type, props, ...children) {
  const next = { ...(props ?? {}) };
  if (children.length === 1) next.children = children[0];
  else if (children.length > 1) next.children = children;
  return { type, props: next, $$typeof: Symbol.for('react.element') };
}

/** Enough of the hooks surface for a direct call of the hook-owning widget. */
const reactStub = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};

await import('../lib/client.js');

/** The plugin face the loader asks for. */
const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return reactStub;
  throw new Error(`unexpected require: ${specifier}`);
});

/** Every string in the element tree, resolving function components. */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    texts(node.type(node.props), out);
    return out;
  }
  assert.equal(typeof node.type, 'string', `element type must be a tag or component, got ${String(node.type)}`);
  return texts(node.props?.children, out);
}

/** A finished task with thinking, an answer, a tool call, logs and usage. */
function richTask() {
  return {
    id: 'agy-1',
    status: 'done',
    brief: 'Fix the widget',
    cd: 'C:/repo',
    model: 'gemini-4-argon-high',
    effort: 'high',
    readOnly: false,
    toolCalls: 1,
    startedAt: 1_000,
    endedAt: 4_000,
    error: null,
    result: { usage: { input_tokens: 10, output_tokens: 20, thinking_tokens: 3, cache_read_tokens: 0 } },
    logs: ['jetski: no output produced'],
    steps: [
      { stepIndex: 1, stepType: 'agent_response_thinking', state: 'DONE', text: 'why', thinking: 'let me reason', deltas: 2 },
      { stepIndex: 2, stepType: 'agent_response', state: 'DONE', text: 'Done.', thinking: '', deltas: 1 },
      {
        stepIndex: 3,
        stepType: 'tool',
        state: 'ERROR',
        text: '',
        thinking: '',
        deltas: 0,
        toolName: 'run_command',
        tool: { name: 'run_command', parameters: { CommandLine: 'ls' }, error: { message: 'permission check failed' } },
        durationSeconds: 1.494,
        error: { type: 'TOOL_ERROR', message: 'permission check failed' },
      },
    ],
  };
}

/** Every string in the element tree, joined — substring checks read naturally. */
function flat(node) {
  return texts(node).join('\n');
}

test('registers as a client plugin and seats the widget in shell.overlay', () => {
  assert.equal(captured.id, 'dsh-agy-delegate');
  assert.deepEqual(plugin.inject, ['slots']);
  assert.equal(typeof plugin.apply, 'function');

  const registered = [];
  const injected = [];
  const effects = [];
  plugin.apply({
    effect: (callback, label) => { effects.push(label); return callback(); },
    slots: {
      inject: (name, callback) => { injected.push(name); return callback(); },
      register: (spec, component) => { registered.push({ spec, component }); return () => {}; },
    },
  });

  assert.deepEqual(injected, ['shell.overlay']);
  assert.ok(effects.some((label) => String(label).includes('styles')), 'the stylesheet is installed as an effect');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].spec.name, 'shell.overlay');
  assert.equal(registered[0].spec.id, 'agy-delegate');
  assert.equal(typeof registered[0].spec.label(), 'string');
  assert.equal(registered[0].component, plugin.AgyWidget);
});

test('the collapsed pill says what is running', () => {
  const pos = { right: 24, bottom: 96 };
  const running = flat(plugin.Pill({ tasks: [{ id: 'a', status: 'running', startedAt: Date.now(), endedAt: null, cd: '', brief: '', toolCalls: 0 }], running: 1, pos, onClick: () => {} }));
  assert.ok(running.includes('agy'));
  assert.ok(running.includes('1 running'));
  // The count is announced as a sentence, not a bare number.
  assert.ok(running.includes('1 of 1 agy tasks running'));

  const idle = flat(plugin.Pill({ tasks: [{ id: 'a', status: 'done', startedAt: 1, endedAt: 2, cd: '', brief: '', toolCalls: 0 }, { id: 'b', status: 'done', startedAt: 1, endedAt: 2, cd: '', brief: '', toolCalls: 0 }], running: 0, pos, onClick: () => {} }));
  assert.ok(idle.includes('2 tasks'));

  const one = flat(plugin.Pill({ tasks: [{ id: 'a', status: 'done', startedAt: 1, endedAt: 2, cd: '', brief: '', toolCalls: 0 }], running: 0, pos, onClick: () => {} }));
  assert.ok(one.includes('1 task'));
});

test('the widget is always mounted, with an empty list before anything runs', () => {
  // The widget never returns null: several delegations can be in flight, and
  // with none the panel's empty state is still the place to look.
  const first = plugin.AgyWidget({});
  assert.notEqual(first, null);
  assert.ok(flat(first).includes('agy'));

  const empty = flat(plugin.Pill({ tasks: [], running: 0, pos: { right: 24, bottom: 96 }, onClick: () => {} }));
  assert.ok(empty.includes('0 tasks'));
});

test('the panel lists tasks and, when one is selected, its live transcript', () => {
  const task = richTask();
  const base = {
    tasks: [task],
    running: 0,
    pos: { right: 24, bottom: 96 },
    onSelect: () => {},
    onBackToAll: () => {},
    onKill: () => {},
    onDismiss: () => {},
    onCollapse: () => {},
    onStartDrag: () => {},
    onNudge: () => {},
    onResetPos: () => {},
  };

  const list = flat(plugin.Panel({ ...base, selected: null, detail: null }));
  assert.ok(list.includes('agy delegate'));
  assert.ok(list.includes('agy-1'));
  assert.ok(list.includes('Fix the widget'));
  assert.ok(list.includes('gemini-4-argon-high · C:/repo'));
  assert.ok(list.includes('1 agy task, none running'));

  const detail = flat(plugin.Panel({ ...base, selected: 'agy-1', detail: task }));
  for (const expected of ['Thinking', 'Answer', 'Tool calls', 'run_command', 'permission check failed', 'agy output', 'in 10', 'out 20', 'thinking 3', 'cache 0', '3s', 'dismiss', 'all tasks']) {
    assert.ok(detail.includes(expected), `detail should show ${expected}`);
  }
  assert.ok(!detail.includes('kill'), 'a finished task offers dismiss, not kill');
});

test('the widget keeps itself inside the frame', () => {
  // Regression: the panel used to grow past the viewport, pushing its header —
  // the only drag/reset/collapse handle — off the top of the screen.
  assert.deepEqual(plugin.clampPos({ right: 24, bottom: 96 }, 1280, 860), { right: 24, bottom: 96 });
  assert.deepEqual(plugin.clampPos({ right: -50, bottom: 9_999 }, 1280, 860), { right: 4, bottom: 580 });
  assert.deepEqual(plugin.clampPos({ right: 1_999, bottom: -20 }, 1280, 860), { right: 1_180, bottom: 4 });

  assert.equal(plugin.panelWidth(1280), 470);
  assert.equal(plugin.panelWidth(360), 336);
  assert.equal(plugin.panelWidth(200), 240, 'a floor keeps the panel usable on absurd widths');

  // Whatever the corner, min(70vh, 620, room above the corner) leaves the panel
  // fully on screen.
  assert.equal(plugin.panelMaxHeight(860, 96), 602);
  assert.equal(plugin.panelMaxHeight(860, 580), 264);
  assert.equal(plugin.panelMaxHeight(1_200, 40), 620);
  for (const bottom of [4, 96, 300, 580]) {
    const max = plugin.panelMaxHeight(860, bottom);
    assert.ok(bottom + max <= 860, `panel fits above the corner at bottom=${bottom}`);
  }

  // The rendered panel applies both bounds.
  const panel = plugin.Panel({ tasks: [], running: 0, pos: { right: 24, bottom: 96 }, selected: null, detail: null, onSelect: () => {}, onBackToAll: () => {}, onKill: () => {}, onDismiss: () => {}, onCollapse: () => {}, onStartDrag: () => {}, onNudge: () => {}, onResetPos: () => {} });
  assert.equal(panel.props.style.width, 470);
  assert.equal(panel.props.style.maxHeight, 602);
  assert.ok(plugin.CSS.includes('min-height: 0'), 'the scrolling body must be a shrinkable flex child');
  assert.ok(plugin.CSS.includes('max-height'), 'the panel needs its own height ceiling');
});

test('a running task offers kill, and thin payloads render without throwing', () => {
  const running = richTask();
  running.status = 'running';
  running.endedAt = null;
  running.steps = [];
  running.logs = [];
  running.result = null;
  const markup = flat(plugin.TaskDetail({ task: running, onBack: () => {}, onKill: () => {}, onDismiss: () => {} }));
  assert.ok(markup.includes('kill'));
  assert.ok(!markup.includes('Thinking'), 'no thinking section when there is no thinking');

  // The shapes the routes actually send for a task that has barely started.
  const bare = { id: 'agy-2', status: 'running', startedAt: Date.now(), endedAt: null, cd: 'C:/repo', brief: '', toolCalls: 0, error: null, steps: [], logs: [] };
  assert.ok(flat(plugin.TaskDetail({ task: bare })).includes('agy-2'));
  assert.ok(flat(plugin.TaskDetail({})).includes('Loading task…'));
  assert.ok(flat(plugin.TaskList({ tasks: [], onSelect: () => {} })).includes('No agy tasks yet'));
  assert.ok(flat(plugin.TaskList({ tasks: [bare], onSelect: () => {} })).includes('agy-2'));
});
