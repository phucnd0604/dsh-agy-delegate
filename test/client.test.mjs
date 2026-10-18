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

/** Every string in the element tree, joined — substring checks read naturally. */
function flat(node) {
  return texts(node).join('\n');
}

/** A finished task, with an input and an output. */
function richTask() {
  return {
    id: 'agy-1',
    status: 'done',
    brief: 'Fix the number field so 11789480 renders as 11.789.480',
    cd: 'C:/repo',
    model: 'gemini-4-argon-high',
    effort: 'high',
    readOnly: false,
    toolCalls: 1,
    startedAt: 1_000,
    endedAt: 4_000,
    answer: 'Done: the formatter now groups thousands.',
    error: null,
  };
}

/** A task with nothing to show yet. */
function bareTask() {
  return {
    id: 'agy-2',
    status: 'running',
    brief: '',
    cd: 'C:/repo',
    model: null,
    startedAt: Date.now(),
    endedAt: null,
    toolCalls: 0,
    answer: '',
    error: null,
  };
}

/** The props every Panel/TaskList call needs. */
function surface(overrides) {
  return {
    tasks: [],
    running: 0,
    expanded: null,
    onToggle: () => {},
    onKill: () => {},
    onDismiss: () => {},
    onClose: () => {},
    ...overrides,
  };
}

test('registers as a client plugin and seats the widget in shell.overlay', () => {
  assert.equal(captured.id, 'dsh-delegate');
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
  assert.equal(registered[0].spec.id, 'delegate');
  assert.equal(typeof registered[0].spec.label(), 'string');
  assert.equal(registered[0].component, plugin.AgyWidget);
});

test('the collapsed pill says what is running', () => {
  const running = flat(plugin.Pill({ ...surface({ tasks: [{ ...bareTask(), status: 'running' }], running: 1 }), onClick: () => {} }));
  assert.ok(running.includes('agy'));
  assert.ok(running.includes('1 running'));
  // The count is announced as a sentence, not a bare number.
  assert.ok(running.includes('1 of 1 agy tasks running'));

  const two = flat(plugin.Pill({ ...surface({ tasks: [richTask(), richTask()], running: 0 }), onClick: () => {} }));
  assert.ok(two.includes('2 tasks'));
  assert.ok(two.includes('2 agy tasks, none running'));

  const one = flat(plugin.Pill({ ...surface({ tasks: [richTask()], running: 0 }), onClick: () => {} }));
  assert.ok(one.includes('1 task'));
});

test('the widget is always mounted, with an empty list before anything runs', () => {
  const first = plugin.AgyWidget({});
  assert.notEqual(first, null);
  assert.ok(flat(first).includes('agy'));

  const empty = flat(plugin.Pill({ ...surface(), onClick: () => {} }));
  assert.ok(empty.includes('0 tasks'));
});

test('the drawer is docked right at full window height', () => {
  const panel = plugin.Panel({ ...surface({ tasks: [richTask()] }) });
  assert.equal(panel.type, 'aside', 'the drawer is a landmark, not a floating card');
  assert.ok(String(panel.props.className).includes('agd-drawer'));
  assert.equal(panel.props['aria-label'], 'delegate tasks');

  // Docked: pinned to the right edge, spanning top to bottom.
  const drawer = plugin.CSS.slice(plugin.CSS.indexOf('.agd-drawer'), plugin.CSS.indexOf('.agd-head'));
  assert.match(drawer, /position: fixed/);
  assert.match(drawer, /top: 0; right: 0; bottom: 0;/);
  assert.match(drawer, /width: min\(420px, 100vw\)/);
  // The list scrolls inside the drawer instead of growing it.
  assert.match(plugin.CSS, /\.agd-body \{[^}]*min-height: 0/);
  assert.match(plugin.CSS, /prefers-reduced-motion/);
});

test('a task row shows exactly status, input and output', () => {
  const task = richTask();
  const row = flat(plugin.TaskRow({ task, expanded: false, onToggle: () => {}, onKill: () => {}, onDismiss: () => {} }));

  assert.ok(row.includes('agy-1'), 'the id');
  assert.ok(row.includes('done · 3s'), 'the status in words');
  assert.ok(row.includes('input') && row.includes('Fix the number field so 11789480 renders as 11.789.480'), 'the input');
  assert.ok(row.includes('output') && row.includes('Done: the formatter now groups thousands.'), 'the output');
  assert.ok(row.includes('gemini-4-argon-high · C:/repo'), 'the model and root');
  assert.ok(row.includes('clear'), 'a finished task can be cleared');

  // The wall of text the user asked to remove stays out of the widget.
  for (const dropped of ['Thinking', 'Answer', 'Tool calls', 'agy output', 'tokens in', 'cache ']) {
    assert.ok(!row.includes(dropped), `the widget must not render "${dropped}"`);
  }
});

test('a row without output says so, and a running row offers stop', () => {
  const running = flat(plugin.TaskRow({ task: bareTask(), expanded: false, onToggle: () => {}, onKill: () => {}, onDismiss: () => {} }));
  assert.ok(running.includes('running · '), 'the status');
  assert.ok(running.includes('(no brief)'));
  assert.ok(running.includes('waiting for output…'));
  assert.ok(running.includes('stop'));
  assert.ok(!running.includes('clear'), 'a running task is not cleared away');

  const failed = flat(plugin.TaskRow({
    task: { ...richTask(), status: 'failed', error: 'permission check failed: headless mode cannot prompt' },
    expanded: false,
    onToggle: () => {},
    onKill: () => {},
    onDismiss: () => {},
  }));
  assert.ok(failed.includes('failed · 3s'));
  assert.ok(failed.includes('permission check failed'));
});

test('the whole row is the expand control, and the action inside it does not toggle', () => {
  const task = richTask();
  const toggled = [];
  const dismissed = [];
  const row = plugin.TaskRow({
    task,
    expanded: false,
    onToggle: (id) => toggled.push(id),
    onKill: () => {},
    onDismiss: (id) => dismissed.push(id),
  });

  assert.equal(row.props.role, 'button', 'the row itself is the control');
  assert.equal(row.props.tabIndex, 0);
  assert.equal(row.props['aria-expanded'], false);
  assert.match(row.props['aria-label'], /expand the input and output/);

  // Clicking the row toggles it; Enter and Space work for the keyboard.
  row.props.onClick();
  row.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
  const space = { key: ' ', prevented: false, preventDefault() { this.prevented = true; } };
  row.props.onKeyDown(space);
  row.props.onKeyDown({ key: 'a', preventDefault: () => { throw new Error('unrelated keys must be ignored'); } });
  assert.deepEqual(toggled, ['agy-1', 'agy-1', 'agy-1']);
  assert.equal(space.prevented, true, 'Space must not also scroll the page');

  // The expanded row flips the flag's wording and the clamp.
  const open = plugin.TaskRow({ task, expanded: true, onToggle: () => {}, onKill: () => {}, onDismiss: () => {} });
  assert.equal(open.props['aria-expanded'], true);
  assert.ok(flat(open).includes('click to collapse'));

  // There is no more/less button any more: the only button is the row's own action.
  const buttons = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'button') buttons.push(node);
    if (typeof node.type === 'function') { walk(node.type(node.props)); return; }
    walk(node.props?.children);
  };
  walk(row);
  assert.deepEqual(buttons.map((node) => node.props.children), ['clear'], 'a finished task offers only its clear action');

  // And that action must not bubble into the row's toggle.
  const event = { stopped: false, stopPropagation() { this.stopped = true; } };
  buttons[0].props.onClick(event);
  assert.equal(event.stopped, true, 'clear must not also toggle the row');
  assert.deepEqual(dismissed, ['agy-1']);
  assert.deepEqual(toggled, ['agy-1', 'agy-1', 'agy-1'], 'no extra toggle from the action click');
});

test('the drawer stays between the window header and the status bar', () => {
  // Measured on the real app: a 40px drag header at the top, and a composer /
  // status band along the bottom that the drawer must not cover.
  const panel = plugin.Panel({ ...surface({ tasks: [richTask()] }), insetTop: 40, insetBottom: 47 });
  assert.equal(panel.props.style.top, 40);
  assert.equal(panel.props.style.bottom, 47);

  // The band finder: only page-wide flow bands touching the bottom edge count.
  const band = { top: 813, bottom: 860, width: 688, height: 47 };
  assert.equal(plugin.bottomInset(860, [band]), 47);
  // A taller viewport with the same band hugging its bottom.
  assert.equal(plugin.bottomInset(1000, [{ top: 953, bottom: 1000, width: 688, height: 47 }]), 47);
  // The topmost of several bands wins, so a nested row cannot shorten the inset.
  assert.equal(plugin.bottomInset(860, [band, { top: 840, bottom: 860, width: 300, height: 20 }]), 47);
  // Nothing along the bottom edge: no inset.
  assert.equal(plugin.bottomInset(860, []), 0);
  assert.equal(plugin.bottomInset(860, [{ top: 100, bottom: 200, width: 900, height: 100 }]), 0);
  // A full-height column (the drawer itself, or a sidebar) is not a band.
  assert.equal(plugin.bottomInset(860, [{ top: 0, bottom: 860, width: 300, height: 860 }]), 0);
  // Nor is a narrow control.
  assert.equal(plugin.bottomInset(860, [{ top: 820, bottom: 860, width: 40, height: 40 }]), 0);
});

test('the list renders every task and the calm empty state', () => {
  assert.ok(flat(plugin.TaskList(surface())).includes('No delegate tasks yet'));
  const two = flat(plugin.TaskList(surface({ tasks: [richTask(), bareTask()] })));
  assert.ok(two.includes('agy-1') && two.includes('agy-2'));
  assert.ok(two.includes('done · 3s') && two.includes('running · '));
});
