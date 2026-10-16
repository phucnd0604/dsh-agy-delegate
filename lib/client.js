/**
 * dsh-agy-delegate — browser half.
 *
 * One floating widget in the frame-wide `shell.overlay` layer: a small pill
 * while an agy task runs, expanding into a panel that lists the tasks and shows
 * one task's live transcript — thinking, answer, tool calls, logs, usage. The
 * data comes from this plugin's own loopback `/api/agy-delegate/*` routes, so
 * there is no client-side protocol to keep in sync beyond those two JSON shapes.
 *
 * Hand-written as a module-loader closure factory: no bundler, no build step.
 * `react` resolves through the loader's injected `require`.
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
    /** List poll cadence, and the cadence for an open task. */
    const POLL_MS = 1500;
    /** Where the widget remembers its corner. */
    const POS_KEY = 'dsh-agy-delegate.pos';

    /** One status colour, from the theme tokens the overlay can see. */
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

    /** POST one JSON body, ignoring transport failures (the poll resyncs). */
    function post(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((res) => res.json()).catch(() => null);
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

    /** Persist the corner; storage may be unavailable and is not worth failing over. */
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

    /** The live view of one task. */
    function TaskDetail(props) {
      const task = props.task;
      if (task === null || task === undefined) return meta('Loading task…');
      const steps = task.steps ?? [];
      const thinking = steps.filter((step) => step.thinking !== '' || step.stepType.includes('thinking'));
      const answers = steps.filter((step) => step.stepType.includes('agent_response') && step.text !== '');
      const tools = steps.filter((step) => step.toolName !== undefined);
      const usage = (task.result ?? {}).usage ?? (steps.length > 0 ? steps[steps.length - 1].usage : null);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h('button', {
            key: 'back',
            onClick: props.onBack,
            style: {
              background: 'transparent', border: `1px solid ${BORDER}`, borderRadius: 6, color: LABEL_2,
              cursor: 'pointer', fontSize: 11, padding: '2px 8px',
            },
          }, '← tasks'),
          dot(task.status),
          h('span', { key: 'id', style: { fontFamily: MONO, fontSize: 11, color: LABEL } }, task.id),
          h('span', { key: 'status', style: { fontSize: 11, color: STATUS_COLOR[task.status] } }, task.status),
          h('span', { key: 'gap', style: { flex: 1 } }),
          task.status === 'running'
            ? h('button', {
                key: 'kill',
                onClick: () => { void post(`${API}/kill`, { id: task.id }); },
                style: {
                  background: 'transparent', border: `1px solid ${BORDER}`, borderRadius: 6,
                  color: 'var(--dsw-alias-state-error-primary, #d9534f)', cursor: 'pointer', fontSize: 11, padding: '2px 8px',
                },
              }, 'kill')
            : h('button', {
                key: 'dismiss',
                onClick: () => { void post(`${API}/dismiss`, { id: task.id }); props.onBack(); },
                style: {
                  background: 'transparent', border: `1px solid ${BORDER}`, borderRadius: 6, color: LABEL_2,
                  cursor: 'pointer', fontSize: 11, padding: '2px 8px',
                },
              }, 'dismiss'),
        ]),
        meta([
          task.model ?? 'default model',
          task.effort === null ? null : `effort ${task.effort}`,
          `${elapsed(task)}s`,
          `${task.toolCalls ?? tools.length} tool calls`,
          task.readOnly ? 'read-only' : null,
          task.cd,
        ].filter((part) => part !== null && part !== undefined).join('  ·  ')),
        task.brief === undefined ? null : section('Brief', undefined, pre(task.brief, 140)),
        task.error === null || task.error === undefined ? null : h('div', {
          key: 'error',
          style: {
            marginTop: 8, padding: '6px 8px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
            background: LAYER, borderLeft: '3px solid var(--dsw-alias-state-error-primary, #d9534f)', color: LABEL,
          },
        }, task.error),
        thinking.length === 0 ? null : section(
          'Thinking',
          `${thinking.length}`,
          thinking.map((step, index) => h('div', { key: index }, pre(step.thinking === '' ? step.text : step.thinking, 260))),
          true,
        ),
        answers.length === 0 ? null : section(
          'Answer',
          `${answers.length}`,
          answers.map((step, index) => h('div', { key: index }, pre(step.text, 320))),
          true,
        ),
        tools.length === 0 ? null : section('Tool calls', `${tools.length}`, tools.map((step, index) => h('div', {
          key: index,
          style: { marginTop: 6 },
        }, [
          h('div', { key: 'name', style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 } }, [
            dot(step.state === 'ERROR' ? 'failed' : step.state === 'DONE' ? 'done' : 'running', 6),
            h('span', { key: 'n', style: { fontFamily: MONO, color: LABEL } }, step.toolName),
            h('span', { key: 's', style: { color: LABEL_2 } }, step.state),
            step.durationSeconds === undefined ? null : h('span', { key: 'd', style: { color: LABEL_2 } }, `${step.durationSeconds.toFixed(1)}s`),
          ]),
          step.tool !== undefined && step.tool.parameters !== undefined
            ? pre(JSON.stringify(step.tool.parameters, null, 2), 160)
            : null,
          step.error === undefined ? null : pre(String(step.error.message ?? JSON.stringify(step.error)), 160),
        ]))),
        usage === null || usage === undefined ? null : meta(
          `tokens in ${usage.input_tokens} · out ${usage.output_tokens} · thinking ${usage.thinking_tokens ?? 0} · cache ${usage.cache_read_tokens ?? 0}`,
        ),
        task.logs === undefined || task.logs.length === 0 ? null : section('agy output', `${task.logs.length}`, pre(task.logs.join('\n'), 200)),
      ].filter((node) => node !== null && node !== undefined));
    }

    /** The floating widget: pill when collapsed, panel when expanded. */
    function AgyWidget() {
      const [tasks, setTasks] = React.useState([]);
      const [running, setRunning] = React.useState(0);
      const [open, setOpen] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [pos, setPos] = React.useState(loadPos);
      const drag = React.useRef(null);

      // The task list: poll while the tab is visible, so a hidden page does not
      // burn loopback round-trips.
      React.useEffect(() => {
        let timer;
        const tick = () => {
          fetch(`${API}/tasks`).then((res) => res.json()).then((json) => {
            if (json !== null && json.ok === true) {
              setTasks(json.tasks ?? []);
              setRunning(json.running ?? 0);
            }
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

      // The open task's transcript. Polling stops as soon as the task settles.
      React.useEffect(() => {
        if (selected === null) {
          setDetail(null);
          return () => {};
        }
        let timer;
        let cancelled = false;
        const tick = () => {
          fetch(`${API}/task?id=${encodeURIComponent(selected)}`).then((res) => res.json()).then((json) => {
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

      // Drag the header; the corner is remembered.
      React.useEffect(() => {
        const onMove = (event) => {
          const state = drag.current;
          if (state === null) return;
          const next = {
            right: Math.max(4, state.right - (event.clientX - state.x)),
            bottom: Math.max(4, state.bottom - (event.clientY - state.y)),
          };
          setPos(next);
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

      const startDrag = (event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, right: pos.right, bottom: pos.bottom };
      };

      // Nothing to show until agy has been asked to do something.
      if (tasks.length === 0 && !open) return null;

      const anchor = { position: 'fixed', right: pos.right, bottom: pos.bottom, zIndex: 30, pointerEvents: 'auto' };

      if (!open) {
        return h('div', {
          style: {
            ...anchor,
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999,
            background: SURFACE, border: `1px solid ${BORDER}`, color: LABEL, cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(0,0,0,0.28)', fontSize: 12, userSelect: 'none',
          },
          onClick: () => setOpen(true),
          title: 'agy delegate — click for live detail',
        }, [
          dot(running > 0 ? 'running' : tasks[0].status, 8),
          h('span', { key: 'label', style: { fontWeight: 600 } }, 'agy'),
          h('span', { key: 'count', style: { color: LABEL_2 } }, running > 0 ? `${running} running` : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`),
        ]);
      }

      return h('div', {
        style: {
          ...anchor,
          width: 460,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'min(70vh, 620px)',
          display: 'flex', flexDirection: 'column',
          background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10,
          boxShadow: '0 12px 36px rgba(0,0,0,0.34)',
        },
      }, [
        h('div', {
          key: 'header',
          onMouseDown: startDrag,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
            borderBottom: `1px solid ${BORDER}`, cursor: 'move', userSelect: 'none',
          },
        }, [
          dot(running > 0 ? 'running' : (tasks[0]?.status ?? 'killed'), 8),
          h('span', { key: 'title', style: { fontSize: 12, fontWeight: 600, color: LABEL } }, 'agy delegate'),
          h('span', { key: 'count', style: { fontSize: 11, color: LABEL_2 } }, running > 0 ? `${running} running` : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`),
          h('span', { key: 'gap', style: { flex: 1 } }),
          selected === null ? null : h('button', {
            key: 'list',
            onClick: () => setSelected(null),
            style: { background: 'transparent', border: 'none', color: LABEL_2, cursor: 'pointer', fontSize: 11 },
          }, 'list'),
          h('button', {
            key: 'close',
            onClick: () => setOpen(false),
            title: 'Collapse',
            style: { background: 'transparent', border: 'none', color: LABEL_2, cursor: 'pointer', fontSize: 14, lineHeight: 1 },
          }, '–'),
        ]),
        h('div', {
          key: 'body',
          style: { overflow: 'auto', padding: '8px 10px 10px' },
        }, selected !== null
          ? h(TaskDetail, { key: 'detail', task: detail, onBack: () => setSelected(null) })
          : tasks.map((task) => h('div', {
              key: task.id,
              onClick: () => setSelected(task.id),
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
                h('span', { key: 'tools', style: { color: LABEL_2 } }, `${task.toolCalls} ⚙`),
              ]),
              h('div', { key: 'brief', style: { color: LABEL_2, fontSize: 11, lineHeight: 1.45, maxHeight: 48, overflow: 'hidden' } }, String(task.brief ?? '').slice(0, 220)),
              h('div', { key: 'meta', style: { color: LABEL_2, fontSize: 10, fontFamily: MONO } }, `${task.model ?? 'default'} · ${task.cd}`),
            ]))),
      ]);
    }

    exports.AgyWidget = AgyWidget;
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
