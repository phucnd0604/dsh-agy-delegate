/**
 * dsh-agy-delegate — browser half.
 *
 * One floating widget in the frame-wide `shell.overlay` layer: a small pill
 * while an agy task runs, expanding into a panel that lists the tasks and shows
 * one task's live transcript — thinking, answer, tool calls, logs, usage. The
 * data comes from this plugin's own loopback `/api/agy-delegate/*` routes, so
 * there is no client-side protocol to keep in sync beyond those two JSON shapes,
 * and no credential crosses the boundary.
 *
 * Hand-written as a module-loader closure factory: no bundler, no build step.
 * `react` resolves through the loader's injected `require`.
 *
 * Every component except `AgyWidget` (which owns the polling and drag state) is
 * a pure function of its props, so `test/client.test.mjs` can render them
 * without a DOM.
 */

window.__ModuleLoader__.load({
  id: 'dsh-agy-delegate',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Route family of the host half. */
    const API = '/api/agy-delegate';
    /** Poll cadence for the task list and for the open task. */
    const POLL_MS = 1500;
    /** Where the widget remembers its corner. */
    const POS_KEY = 'dsh-agy-delegate.pos';

    /** Status colour, from the theme tokens the overlay can see. */
    const STATUS_COLOR = {
      running: 'var(--dsw-alias-state-warn-primary, #d9a441)',
      done: 'var(--dsw-alias-state-success-primary, #3fa76a)',
      failed: 'var(--dsw-alias-state-error-primary, #d9534f)',
      timeout: 'var(--dsw-alias-state-warn-primary, #d9a441)',
      killed: 'var(--dsw-alias-state-idle-primary, #8a8a8a)',
    };
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const LABEL = 'var(--dsw-alias-label-primary, #e8e8e8)';
    const LABEL_2 = 'var(--dsw-alias-label-secondary, #9a9a9a)';
    const BORDER = 'var(--dsw-alias-border-l2, #3a3a3a)';
    const SURFACE = 'var(--dsw-alias-bg-overlay, #1b1b1b)';
    const LAYER = 'var(--dsw-alias-bg-layer-2, #232323)';

    /** POST one JSON body; transport failures are ignored (the poll resyncs). */
    function post(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.json()).catch(() => null);
    }

    /** The remembered corner, or the default one. */
    function loadPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (typeof parsed.right === 'number' && typeof parsed.bottom === 'number') return parsed;
        }
      } catch {
        // Unreadable storage: fall through to the default corner.
      }
      return { right: 24, bottom: 96 };
    }

    /** Persist the corner; storage may be unavailable, which is not worth failing over. */
    function savePos(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        // Best effort only.
      }
    }

    /** Seconds a task has taken so far. */
    function elapsed(row) {
      return Math.max(0, Math.round(((row.endedAt ?? Date.now()) - row.startedAt) / 1000));
    }

    /** A dot in the task's status colour. */
    function dot(status, size) {
      const px = size ?? 8;
      return h('span', {
        style: {
          width: px,
          height: px,
          borderRadius: '50%',
          background: STATUS_COLOR[status] ?? STATUS_COLOR.killed,
          flex: '0 0 auto',
          display: 'inline-block',
        },
      });
    }

    /** A muted meta line. */
    function meta(text) {
      return h('div', { style: { color: LABEL_2, fontSize: 11, lineHeight: 1.5 } }, text);
    }

    /** A bordered block of monospace text. */
    function pre(text, maxHeight) {
      return h('pre', {
        style: {
          margin: '4px 0 0',
          padding: '6px 8px',
          background: LAYER,
          border: `1px solid ${BORDER}`,
          borderRadius: 6,
          color: LABEL,
          fontFamily: MONO,
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: maxHeight ?? 220,
          overflow: 'auto',
        },
      }, text);
    }

    /** One collapsible section. */
    function section(title, badge, body, open) {
      return h('details', { open: open === true, style: { marginTop: 8 } }, [
        h('summary', {
          key: 'summary',
          style: { cursor: 'pointer', color: LABEL, fontSize: 12, fontWeight: 600 },
        }, badge === undefined ? title : `${title} (${badge})`),
        h('div', { key: 'body' }, body),
      ]);
    }

    /** A small bordered button. */
    function button(label, onClick, color) {
      return h('button', {
        onClick,
        style: {
          background: 'transparent', border: `1px solid ${BORDER}`, borderRadius: 6,
          color: color ?? LABEL_2, cursor: 'pointer', fontSize: 11, padding: '2px 8px',
        },
      }, label);
    }

    /** One row in the task list. */
    function TaskRow(props) {
      const task = props.task;
      return h('div', {
        onClick: () => props.onSelect(task.id),
        style: {
          display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 8px', marginBottom: 6,
          background: LAYER, border: `1px solid ${BORDER}`, borderRadius: 8, cursor: 'pointer',
        },
      }, [
        h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 } }, [
          dot(task.status, 8),
          h('span', { key: 'id', style: { fontFamily: MONO, color: LABEL } }, task.id),
          h('span', { key: 'status', style: { color: STATUS_COLOR[task.status] } }, task.status),
          h('span', { key: 'gap', style: { flex: 1 } }),
          h('span', { key: 'time', style: { color: LABEL_2 } }, `${elapsed(task)}s`),
          h('span', { key: 'tools', style: { color: LABEL_2 } }, `${task.toolCalls ?? 0} ⚙`),
        ]),
        h('div', {
          key: 'brief',
          style: { color: LABEL_2, fontSize: 11, lineHeight: 1.45, maxHeight: 48, overflow: 'hidden' },
        }, String(task.brief ?? '').slice(0, 220)),
        h('div', { key: 'meta', style: { color: LABEL_2, fontSize: 10, fontFamily: MONO } }, `${task.model ?? 'default'} · ${task.cd}`),
      ]);
    }

    /** The task list. */
    function TaskList(props) {
      if (props.tasks.length === 0) return meta('No agy tasks.');
      return h('div', {}, props.tasks.map((task) => h(TaskRow, { key: task.id, task, onSelect: props.onSelect })));
    }

    /** The live transcript of one task: thinking, answer, tool calls, logs, usage. */
    function TaskDetail(props) {
      const task = props.task;
      if (task === null || task === undefined) return meta('Loading task…');
      const steps = task.steps ?? [];
      // A reasoning step must not double as an answer: agy emits plain
      // `agent_response` for the answer, and anything carrying "thinking" is
      // reasoning even when it also streams text. Keep this predicate identical
      // to `isAnswerStep` in lib/parse.js (the browser half cannot import it).
      const isAnswer = (step) => step.stepType.includes('response') && !step.stepType.includes('thinking');
      const thinking = steps.filter((step) => step.thinking !== '' || step.stepType.includes('thinking'));
      const answers = steps.filter((step) => isAnswer(step) && step.text !== '');
      const tools = steps.filter((step) => step.toolName !== undefined);
      const usage = (task.result ?? {}).usage ?? (steps.length > 0 ? steps[steps.length - 1].usage : null);
      const logs = task.logs ?? [];

      const head = h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
        button('← tasks', props.onBack, LABEL_2),
        dot(task.status),
        h('span', { key: 'id', style: { fontFamily: MONO, fontSize: 11, color: LABEL } }, task.id),
        h('span', { key: 'status', style: { fontSize: 11, color: STATUS_COLOR[task.status] } }, task.status),
        h('span', { key: 'gap', style: { flex: 1 } }),
        task.status === 'running'
          ? button('kill', () => props.onKill(task.id), 'var(--dsw-alias-state-error-primary, #d9534f)')
          : button('dismiss', () => props.onDismiss(task.id), LABEL_2),
      ]);

      const facts = [
        task.model ?? 'default model',
        task.effort === null || task.effort === undefined ? null : `effort ${task.effort}`,
        `${elapsed(task)}s`,
        `${task.toolCalls ?? tools.length} tool calls`,
        task.readOnly === true ? 'read-only' : null,
        task.cd,
      ].filter((part) => part !== null && part !== undefined);

      const errorBlock = task.error === null || task.error === undefined ? null : h('div', {
        key: 'error',
        style: {
          marginTop: 8, padding: '6px 8px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
          background: LAYER, borderLeft: '3px solid var(--dsw-alias-state-error-primary, #d9534f)', color: LABEL,
        },
      }, task.error);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
        head,
        meta(facts.join('  ·  ')),
        task.brief === undefined ? null : section('Brief', undefined, pre(task.brief, 140)),
        errorBlock,
        thinking.length === 0 ? null : section(
          'Thinking',
          String(thinking.length),
          thinking.map((step, index) => h('div', { key: index }, pre(step.thinking === '' ? step.text : step.thinking, 260))),
          true,
        ),
        answers.length === 0 ? null : section(
          'Answer',
          String(answers.length),
          answers.map((step, index) => h('div', { key: index }, pre(step.text, 320))),
          true,
        ),
        tools.length === 0 ? null : section('Tool calls', String(tools.length), tools.map((step, index) => h('div', {
          key: index,
          style: { marginTop: 6 },
        }, [
          h('div', { key: 'name', style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 } }, [
            dot(step.state === 'ERROR' ? 'failed' : step.state === 'DONE' ? 'done' : 'running', 6),
            h('span', { key: 'n', style: { fontFamily: MONO, color: LABEL } }, step.toolName),
            h('span', { key: 's', style: { color: LABEL_2 } }, step.state),
            step.durationSeconds === undefined
              ? null
              : h('span', { key: 'd', style: { color: LABEL_2 } }, `${step.durationSeconds.toFixed(1)}s`),
          ]),
          step.tool === undefined || step.tool.parameters === undefined
            ? null
            : pre(JSON.stringify(step.tool.parameters, null, 2), 160),
          step.error === undefined ? null : pre(String(step.error.message ?? JSON.stringify(step.error)), 160),
        ]))),
        usage === null || usage === undefined ? null : meta(
          `tokens in ${usage.input_tokens ?? 0} · out ${usage.output_tokens ?? 0} · thinking ${usage.thinking_tokens ?? 0} · cache ${usage.cache_read_tokens ?? 0}`,
        ),
        logs.length === 0 ? null : section('agy output', String(logs.length), pre(logs.join('\n'), 200)),
      ].filter((node) => node !== null && node !== undefined));
    }

    /** The expanded panel: header (drag handle) plus either the list or one task. */
    function Panel(props) {
      const header = h('div', {
        key: 'header',
        onMouseDown: props.onStartDrag,
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
          borderBottom: `1px solid ${BORDER}`, cursor: 'move', userSelect: 'none',
        },
      }, [
        dot(props.running > 0 ? 'running' : (props.tasks[0]?.status ?? 'killed'), 8),
        h('span', { key: 'title', style: { fontSize: 12, fontWeight: 600, color: LABEL } }, 'agy delegate'),
        h('span', { key: 'count', style: { fontSize: 11, color: LABEL_2 } }, props.running > 0
          ? `${props.running} running`
          : `${props.tasks.length} task${props.tasks.length === 1 ? '' : 's'}`),
        h('span', { key: 'gap', style: { flex: 1 } }),
        props.selected === null ? null : button('list', props.onBackToAll, LABEL_2),
        h('button', {
          key: 'collapse',
          onClick: props.onCollapse,
          title: 'Collapse',
          style: { background: 'transparent', border: 'none', color: LABEL_2, cursor: 'pointer', fontSize: 14, lineHeight: 1 },
        }, '–'),
      ]);

      const body = props.selected === null
        ? h(TaskList, { key: 'list', tasks: props.tasks, onSelect: props.onSelect })
        : h(TaskDetail, {
            key: 'detail',
            task: props.detail,
            onBack: props.onBackToAll,
            onKill: props.onKill,
            onDismiss: props.onDismiss,
          });

      return h('div', {
        style: {
          position: 'fixed', right: props.pos.right, bottom: props.pos.bottom, zIndex: 30, pointerEvents: 'auto',
          width: 460, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(70vh, 620px)',
          display: 'flex', flexDirection: 'column',
          background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10,
          boxShadow: '0 12px 36px rgba(0,0,0,0.34)',
        },
      }, [
        header,
        h('div', { key: 'body', style: { overflow: 'auto', padding: '8px 10px 10px' } }, body),
      ]);
    }

    /** The collapsed pill. */
    function Pill(props) {
      return h('div', {
        onClick: props.onClick,
        title: 'agy delegate — click for live detail',
        style: {
          position: 'fixed', right: props.pos.right, bottom: props.pos.bottom, zIndex: 30, pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999,
          background: SURFACE, border: `1px solid ${BORDER}`, color: LABEL, cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,0.28)', fontSize: 12, userSelect: 'none',
        },
      }, [
        dot(props.running > 0 ? 'running' : (props.tasks[0]?.status ?? 'killed'), 8),
        h('span', { key: 'label', style: { fontWeight: 600 } }, 'agy'),
        h('span', { key: 'count', style: { color: LABEL_2 } }, props.running > 0
          ? `${props.running} running`
          : `${props.tasks.length} task${props.tasks.length === 1 ? '' : 's'}`),
      ]);
    }

    /** The floating widget: owns the polling, the selection and the drag state. */
    function AgyWidget() {
      const [tasks, setTasks] = React.useState([]);
      const [running, setRunning] = React.useState(0);
      const [open, setOpen] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [pos, setPos] = React.useState(loadPos);
      const drag = React.useRef(null);

      // The task list: poll while the tab is visible, so a hidden page burns no
      // loopback round-trips.
      React.useEffect(() => {
        let timer;
        const tick = () => {
          fetch(`${API}/tasks`).then((response) => response.json()).then((json) => {
            if (json === null || json.ok !== true) return;
            setTasks(json.tasks ?? []);
            setRunning(json.running ?? 0);
          }).catch(() => {
            // Ignore transport errors; the next tick resyncs.
          });
        };
        const stop = () => {
          if (timer !== undefined) {
            window.clearInterval(timer);
            timer = undefined;
          }
        };
        const start = () => {
          if (timer === undefined && document.visibilityState === 'visible') timer = window.setInterval(tick, POLL_MS);
        };
        const onVisibility = () => {
          if (document.visibilityState === 'visible') {
            tick();
            start();
          } else stop();
        };
        tick();
        start();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          stop();
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, []);

      // The open task's transcript; polling stops as soon as the task settles.
      React.useEffect(() => {
        if (selected === null) {
          setDetail(null);
          return () => {};
        }
        let timer;
        let cancelled = false;
        const tick = () => {
          fetch(`${API}/task?id=${encodeURIComponent(selected)}`).then((response) => response.json()).then((json) => {
            if (cancelled || json === null || json.ok !== true) return;
            setDetail(json.task);
            if (json.task.status !== 'running' && timer !== undefined) {
              window.clearInterval(timer);
              timer = undefined;
            }
          }).catch(() => {
            // Ignore; the next tick resyncs.
          });
        };
        tick();
        timer = window.setInterval(tick, POLL_MS);
        return () => {
          cancelled = true;
          if (timer !== undefined) window.clearInterval(timer);
        };
      }, [selected]);

      // Drag the header; the corner is remembered when the drag ends.
      React.useEffect(() => {
        const onMove = (event) => {
          const state = drag.current;
          if (state === null) return;
          setPos({
            right: Math.max(4, state.right - (event.clientX - state.x)),
            bottom: Math.max(4, state.bottom - (event.clientY - state.y)),
          });
        };
        const onUp = () => {
          if (drag.current === null) return;
          drag.current = null;
          setPos((current) => {
            savePos(current);
            return current;
          });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }, []);

      const onStartDrag = (event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, right: pos.right, bottom: pos.bottom };
      };

      // Nothing to show until agy has been asked to do something.
      if (tasks.length === 0 && !open) return null;

      const shared = {
        tasks,
        running,
        pos,
        onSelect: setSelected,
        onBackToAll: () => setSelected(null),
        onKill: (id) => { void post(`${API}/kill`, { id }); },
        onDismiss: (id) => {
          void post(`${API}/dismiss`, { id }).then(() => setSelected(null));
        },
      };
      if (!open) return h(Pill, { ...shared, onClick: () => setOpen(true) });
      return h(Panel, {
        ...shared,
        selected,
        detail,
        onCollapse: () => setOpen(false),
        onStartDrag,
      });
    }

    exports.AgyWidget = AgyWidget;
    exports.Pill = Pill;
    exports.Panel = Panel;
    exports.TaskList = TaskList;
    exports.TaskRow = TaskRow;
    exports.TaskDetail = TaskDetail;
    exports.inject = ['slots'];

    /** Seat the widget in the frame-wide overlay layer. */
    exports.apply = function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agy-delegate',
        order: 40,
        label: () => 'agy delegate',
      }, AgyWidget));
    };

    return module.exports;
  },
});
