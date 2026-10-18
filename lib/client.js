/**
 * dsh-delegate — browser half.
 *
 * Two surfaces, both in the frame-wide `shell.overlay` layer:
 *   - a pill while nothing is open (always mounted: several delegations can be
 *     in flight, and the empty state is itself the answer to "is anything
 *     running?"), and
 *   - a right-hand drawer, full window height, listing every task with the three
 *     things a reader actually needs from it: its **input** (the brief), its
 *     **output** (the live answer), and its **status**. Clicking outside — or
 *     Escape — collapses it back to the pill.
 *
 * The full transcript (thinking, tool calls, usage, agy's own log) is NOT
 * rendered here on purpose: it lives in the `agy_task` tool, where an agent can
 * read it without a wall of text in the corner of the screen.
 *
 * Visual language comes from the ui-ux-pro-max skill against the user's
 * reference art (Google I/O 2026 "Gemini Spark"): frosted glass, an
 * indigo→violet accent, and a cyan visor whose mouth carries status by shape as
 * well as colour. Drivers: the skill's glassmorphism rule (blur 10–20px, 1px
 * light border, layered depth) and its indigo/violet palette; the icon lookup
 * has NO sparkle entry, so the brand mark is hand-drawn, and the status glyph
 * follows the database's `pulse`.
 *
 * Kept from the skill's checklist: every surface and all text use semantic DSH
 * theme tokens (both themes), state is never colour-only, controls are real
 * <button>s with `:focus-visible` rings, motion sits behind
 * prefers-reduced-motion, and the counts are announced as a phrase rather than a
 * bare number.
 *
 * Hand-written as a module-loader closure factory: no bundler, no build step.
 * Every component except `AgyWidget` (which owns the polling, the outside-click
 * listener and the expanded row) is a pure function of its props, so
 * `test/client.test.mjs` renders them without a DOM.
 */

window.__ModuleLoader__.load({
  id: 'dsh-delegate',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Route family of the host half. */
    const API = '/api/delegate';
    /** Poll cadence for the task list. */
    const POLL_MS = 1500;

    /**
     * The stylesheet. Colours are semantic DSH tokens or translucent mixes of
     * one, so both themes come from the host; the indigo/violet/cyan triple is
     * the widget's own accent and is used only for marks, borders and glows.
     */
    const CSS = `
.agd-root {
  --agd-accent: #6366f1;
  --agd-accent-deep: #4338ca;
  --agd-accent-soft: #7c3aed;
  --agd-glow: #22d3ee;
  --agd-surface: color-mix(in srgb, var(--dsw-alias-bg-overlay, #1b1b1b) 95%, transparent);
  --agd-sunken: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #232323) 90%, transparent);
  --agd-line: color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 15%, transparent);
  --agd-label: var(--dsw-alias-label-primary, #e8e8e8);
  --agd-label-2: var(--dsw-alias-label-secondary, #9a9a9a);
  --agd-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --agd-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
}
/* One rule for the whole surface: without border-box, a full-width row adds its
   own padding and border on top of the container and pushes its action buttons
   past the drawer's rounded edge, where they get clipped. */
.agd-root, .agd-root *, .agd-root *::before, .agd-root *::after { box-sizing: border-box; }
.agd-glass {
  /* Two layers on purpose: the token wash sits on the app's opaque base colour,
     so an overlay token that is itself translucent cannot let the page behind
     bleed through the drawer. */
  background:
    linear-gradient(var(--agd-surface), var(--agd-surface)),
    var(--dsw-alias-bg-base, #ffffff);
  backdrop-filter: blur(20px) saturate(1.45);
  -webkit-backdrop-filter: blur(20px) saturate(1.45);
  border: 1px solid var(--agd-line);
  color: var(--agd-label);
}
.agd-pill {
  position: fixed; z-index: 30; pointer-events: auto;
  right: 20px; bottom: 88px;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 7px 14px 7px 9px; border-radius: 999px;
  font: inherit; font-size: 12px; cursor: pointer;
  box-shadow: 0 12px 30px color-mix(in srgb, var(--agd-accent-deep) 26%, transparent), 0 2px 8px rgba(0, 0, 0, 0.24);
  transition: transform 0.2s var(--agd-ease), border-color 0.2s var(--agd-ease);
}
.agd-pill:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--agd-accent) 46%, transparent); }
.agd-pill[data-running='true'] { border-color: color-mix(in srgb, var(--agd-accent) 34%, transparent); }
/* The drawer: docked right, spanning the app's content area — its top and bottom
   insets are measured at open time (the window header carries the window
   buttons; the composer/status band hugs the bottom edge), so the declarations
   here are only the pre-measurement fallback. */
.agd-drawer {
  position: fixed; z-index: 30; pointer-events: auto;
  top: 0; right: 0; bottom: 0;
  width: min(420px, 100vw);
  display: flex; flex-direction: column;
  border-right: none; border-top: none; border-bottom: none;
  border-radius: 16px 0 0 16px;
  box-shadow: -16px 0 44px color-mix(in srgb, var(--agd-accent-deep) 24%, transparent);
  animation: agd-slide 0.2s var(--agd-ease);
}
.agd-head {
  display: flex; align-items: center; gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--agd-line);
  background:
    radial-gradient(120% 190% at 0% -40%, color-mix(in srgb, var(--agd-accent) 20%, transparent), transparent 62%),
    radial-gradient(90% 160% at 100% -60%, color-mix(in srgb, var(--agd-accent-soft) 16%, transparent), transparent 58%);
}
.agd-title { font-size: 13px; font-weight: 600; }
.agd-sub { font-size: 11px; color: var(--agd-label-2); }
.agd-grow { flex: 1 1 auto; }
.agd-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--agd-line);
  background: color-mix(in srgb, var(--agd-label) 8%, transparent);
  font-size: 10.5px; color: var(--agd-label-2); white-space: nowrap;
}
.agd-chip[data-tone='live'] { background: color-mix(in srgb, var(--agd-accent) 14%, transparent); color: var(--agd-label); }
.agd-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 9px; border-radius: 8px;
  border: 1px solid var(--agd-line); background: transparent;
  color: var(--agd-label-2); font: inherit; font-size: 11px; cursor: pointer;
  transition: background 0.18s var(--agd-ease), color 0.18s var(--agd-ease), border-color 0.18s var(--agd-ease);
}
.agd-btn:hover { color: var(--agd-label); background: color-mix(in srgb, var(--agd-label) 8%, transparent); }
.agd-btn:focus-visible, .agd-row:focus-visible, .agd-pill:focus-visible {
  outline: 2px solid var(--agd-accent); outline-offset: 2px;
}
.agd-body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.agd-body::-webkit-scrollbar { width: 9px; }
.agd-body::-webkit-scrollbar-thumb { background: var(--agd-line); border-radius: 999px; }
/* min-width: 0 on the list and the row is load-bearing: a flex item defaults to
   min-width: auto, so one long unbreakable string would widen the whole column
   past the drawer's edge and clip the row's own action buttons. */
.agd-list { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.agd-row {
  display: flex; flex-direction: column; gap: 7px; width: 100%; min-width: 0; text-align: left;
  padding: 11px 12px; border-radius: 12px;
  border: 1px solid var(--agd-line); background: var(--agd-sunken);
  font: inherit; color: var(--agd-label); cursor: pointer;
  transition: border-color 0.2s var(--agd-ease), background 0.2s var(--agd-ease);
}
.agd-row:hover { border-color: color-mix(in srgb, var(--agd-accent) 42%, transparent); }
.agd-row[data-status='running'] { border-left: 3px solid var(--agd-accent); }
.agd-row[data-status='failed'], .agd-row[data-status='timeout'] { border-left: 3px solid var(--dsw-alias-state-error-primary, #d9534f); }
.agd-row[data-status='done'] { border-left: 3px solid var(--dsw-alias-state-success-primary, #3fa76a); }
.agd-rowtop { display: flex; align-items: center; gap: 8px; width: 100%; flex-wrap: wrap; row-gap: 4px; }
/* Long ids and long paths must ellipsize rather than push the row's action out
   past the drawer's rounded edge, where it would be clipped. */
.agd-id { font-family: var(--agd-mono); font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agd-chip { flex: 0 0 auto; }
.agd-btn { flex: 0 0 auto; }
.agd-id { font-family: var(--agd-mono); font-size: 11px; }
.agd-field { display: flex; flex-direction: column; gap: 2px; }
.agd-field-label { font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--agd-label-2); }
.agd-field-text { font-size: 12px; line-height: 1.5; color: var(--agd-label); overflow-wrap: anywhere; }
.agd-field-text[data-clamp='true'] { display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.agd-field-text[data-empty='true'] { color: var(--agd-label-2); font-style: italic; }
.agd-meta { font-size: 10.5px; color: var(--agd-label-2); min-width: 0; overflow-wrap: anywhere; }
.agd-error {
  padding: 7px 9px; border-radius: 9px; font-size: 11px; line-height: 1.5;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d9534f) 12%, transparent);
  border-left: 3px solid var(--dsw-alias-state-error-primary, #d9534f);
}
.agd-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 14px; text-align: center; }
.agd-empty .agd-spark { opacity: 0.5; }
.agd-empty-title { font-size: 13px; font-weight: 600; }
.agd-mouth { transition: opacity 0.3s var(--agd-ease); }
.agd-led { animation: agd-breathe 2.4s var(--agd-ease) infinite; }
.agd-pill[data-running='true'] .agd-orb-halo { animation: agd-halo 2.6s var(--agd-ease) infinite; }
@keyframes agd-breathe { 0%, 100% { opacity: 0.62; } 50% { opacity: 1; } }
@keyframes agd-halo { 0%, 100% { opacity: 0.35; transform: scale(0.94); } 50% { opacity: 0.75; transform: scale(1.06); } }
@keyframes agd-slide { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .agd-pill, .agd-row, .agd-btn, .agd-drawer { transition: none !important; animation: none !important; }
  .agd-led, .agd-orb-halo { animation: none !important; }
}
`;

    /** Install the stylesheet once; a missing DOM (tests) is not an error. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.dataset.dshPlugin = 'delegate';
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => style.remove();
    }

    /** POST one JSON body; transport failures are ignored (the poll resyncs). */
    function post(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.json()).catch(() => null);
    }

    /**
     * How much of the bottom edge the app's own composer/status band occupies.
     *
     * The drawer is docked full height, so without this it covers the status bar
     * along the bottom of the window. The band is measured rather than assumed,
     * because its height depends on the profile's skin, the composer contents and
     * the window width.
     *
     * The filter is deliberately narrow: only page-wide, flow-positioned bands
     * that touch the bottom edge count. The widget's own surfaces are all
     * `position: fixed`, so they can never feed back into their own inset.
     * @param height - the window's inner height.
     * @param rects - candidate rectangles, in page coordinates.
     * @returns the inset in pixels (0 when the layout declares no such band).
     */
    function bottomInset(height, rects) {
      const bands = rects.filter((rect) => rect.width > 200 && rect.height > 6 && rect.height < 120
        && rect.bottom >= height - 6 && rect.top > height * 0.6);
      if (bands.length === 0) return 0;
      return Math.max(0, Math.round(height - Math.min(...bands.map((rect) => rect.top))));
    }

    /**
     * Measure the app chrome the drawer must stay between: the window's own drag
     * header (which carries the window buttons) at the top, and the
     * composer/status band at the bottom.
     * @returns `{ top, bottom }` insets in pixels.
     */
    function measureChrome() {
      if (typeof document === 'undefined') return { top: 0, bottom: 0 };
      const header = document.querySelector('header[data-window-drag]');
      const top = header === null ? 0 : Math.max(0, Math.round(header.getBoundingClientRect().bottom));
      const rects = [...document.querySelectorAll('body *')]
        .filter((node) => {
          const style = getComputedStyle(node);
          return style.position !== 'fixed' && style.position !== 'absolute';
        })
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        });
      return { top, bottom: bottomInset(window.innerHeight, rects) };
    }

    /** Seconds a task has taken so far. */
    function elapsed(row) {
      return Math.max(0, Math.round(((row.endedAt ?? Date.now()) - row.startedAt) / 1000));
    }

    /** The words that accompany the status colour. */
    function statusText(row) {
      const seconds = elapsed(row);
      switch (row.status) {
        case 'running': return `running · ${seconds}s`;
        case 'done': return `done · ${seconds}s`;
        case 'failed': return `failed · ${seconds}s`;
        case 'timeout': return `timed out · ${seconds}s`;
        case 'killed': return `killed · ${seconds}s`;
        default: return `${row.status} · ${seconds}s`;
      }
    }

    /** The contextual live-region phrase (never a bare count). */
    function announce(tasks, running) {
      if (tasks.length === 0) return 'No agy tasks';
      if (running > 0) return `${running} of ${tasks.length} agy tasks running`;
      return `${tasks.length} agy task${tasks.length === 1 ? '' : 's'}, none running`;
    }

    /** Tone per status, mapped onto host state tokens. */
    const TONE = {
      running: 'var(--dsw-alias-state-warn-primary, #d9a441)',
      done: 'var(--dsw-alias-state-success-primary, #3fa76a)',
      failed: 'var(--dsw-alias-state-error-primary, #d9534f)',
      timeout: 'var(--dsw-alias-state-warn-primary, #d9a441)',
      killed: 'var(--dsw-alias-state-idle-primary, #8a8a8a)',
    };

    /**
     * The four-point sparkle from the reference art. Hand-drawn: the skill's
     * icon database has no "sparkle" entry (checked, 0 hits), so this is
     * explicitly custom rather than a lookup result.
     */
    function Sparkle(props) {
      const size = props.size ?? 12;
      return h('svg', {
        className: 'agd-spark',
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
        style: { flex: '0 0 auto' },
      }, h('path', {
        d: 'M12 1.6c.5 3.9 1.9 6.4 5.4 7.4L22.4 10.4c-3.5 1-4.9 3.5-5.4 7.4-.5 3.9-1.3 4.9-2.5 4.9s-2-1-2.5-4.9c-.5-3.9-1.9-6.4-5.4-7.4L1.6 9c3.5-1 4.9-3.5 5.4-7.4.5-3.9 1.3-3.9 2.5-3.9s2 0 2.5 3.9Z',
        fill: 'currentColor',
        transform: 'translate(0 3.2) scale(0.92)',
      }));
    }

    /**
     * The mascot's visor: a glossy dark tile whose mouth is the status, so the
     * state reads by shape as well as colour.
     */
    function Orb(props) {
      const status = props.status;
      const width = props.width ?? 20;
      const height = Math.round(width * 0.82);
      const tone = TONE[status] ?? TONE.killed;
      const mouth = status === 'running'
        ? h('path', { key: 'm', className: 'agd-led', d: 'M7 11.4c1.2 1.7 2.6 2.5 4 2.5s2.8-.8 4-2.5', stroke: 'var(--agd-glow)', strokeWidth: '2', strokeLinecap: 'round', fill: 'none' })
        : status === 'done'
          ? h('path', { key: 'm', d: 'M7.4 11c1.1 1.5 2.3 2.2 3.6 2.2s2.5-.7 3.6-2.2', stroke: tone, strokeWidth: '2', strokeLinecap: 'round', fill: 'none' })
          : status === 'failed' || status === 'timeout'
            ? h('path', { key: 'm', d: 'M7.4 13.2c1.1-1.5 2.3-2.2 3.6-2.2s2.5.7 3.6 2.2', stroke: tone, strokeWidth: '2', strokeLinecap: 'round', fill: 'none' })
            : h('path', { key: 'm', d: 'M7.6 11.6h6.8', stroke: tone, strokeWidth: '2', strokeLinecap: 'round', fill: 'none' });

      return h('svg', {
        className: 'agd-orb',
        width, height, viewBox: '0 0 19 16', 'aria-hidden': 'true', focusable: 'false',
        style: { flex: '0 0 auto', overflow: 'visible' },
      }, [
        status === 'running'
          ? h('circle', { key: 'halo', className: 'agd-orb-halo', cx: '9.5', cy: '8', r: '9', fill: 'var(--agd-accent)', opacity: '0.4' })
          : null,
        h('rect', { key: 'visor', x: '0', y: '0.6', width: '19', height: '14.8', rx: '7', fill: 'color-mix(in srgb, #05060c 88%, transparent)' }),
        h('rect', { key: 'gloss', x: '2.3', y: '2', width: '7.4', height: '3.4', rx: '1.7', fill: 'rgba(255,255,255,0.16)' }),
        mouth,
        h('circle', { key: 'eye-l', cx: '6.4', cy: '7.6', r: '1.35', fill: status === 'running' ? 'var(--agd-glow)' : 'rgba(255,255,255,0.85)' }),
        h('circle', { key: 'eye-r', cx: '12.6', cy: '7.6', r: '1.35', fill: status === 'running' ? 'var(--agd-glow)' : 'rgba(255,255,255,0.85)' }),
      ]);
    }

    /** One labelled field: the whole point of this panel is input and output. */
    function Field(props) {
      const text = typeof props.text === 'string' ? props.text.trim() : '';
      const clamped = props.clamped === true && text !== '';
      return h('div', { className: 'agd-field' }, [
        h('span', { key: 'label', className: 'agd-field-label' }, props.label),
        h('span', {
          key: 'text',
          className: 'agd-field-text',
          'data-clamp': clamped ? 'true' : 'false',
          'data-empty': text === '' ? 'true' : 'false',
        }, text === '' ? props.placeholder : text),
      ]);
    }

    /**
     * One task: status, input, output — and nothing else. The whole row is the
     * expand/collapse control (no separate more/less button); the stop/clear
     * action inside it stops the click from bubbling so it never toggles too.
     */
    function TaskRow(props) {
      const task = props.task;
      const expanded = props.expanded === true;
      const answer = typeof task.answer === 'string' ? task.answer : '';
      const actions = (run) => (event) => {
        event.stopPropagation();
        run(task.id);
      };
      return h('div', {
        className: 'agd-row',
        'data-status': task.status,
        role: 'button',
        tabIndex: 0,
        'aria-expanded': expanded,
        'aria-label': `${task.id}, ${task.status} — ${expanded ? 'collapse' : 'expand'} the input and output`,
        title: expanded ? 'Click to collapse' : 'Click to show the full input and output',
        onClick: () => props.onToggle(task.id),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          props.onToggle(task.id);
        },
      }, [
        h('div', { key: 'top', className: 'agd-rowtop' }, [
          h(Orb, { key: 'orb', status: task.status, width: 19 }),
          h('span', { key: 'id', className: 'agd-id' }, task.id),
          h('span', { key: 'gap', className: 'agd-grow' }),
          h('span', { key: 'chip', className: 'agd-chip', 'data-tone': task.status === 'running' ? 'live' : 'muted' }, statusText(task)),
          task.status === 'running'
            ? h('button', {
                key: 'kill', type: 'button', className: 'agd-btn',
                onClick: actions(props.onKill), title: 'Stop this run', 'aria-label': `Stop ${task.id}`,
              }, 'stop')
            : h('button', {
                key: 'dismiss', type: 'button', className: 'agd-btn',
                onClick: actions(props.onDismiss), title: 'Forget this task', 'aria-label': `Dismiss ${task.id}`,
              }, 'clear'),
        ]),
        h(Field, { key: 'in', label: 'input', text: task.brief, clamped: !expanded, placeholder: '(no brief)' }),
        h(Field, {
          key: 'out',
          label: 'output',
          text: answer,
          clamped: !expanded,
          placeholder: task.status === 'running' ? 'waiting for output…' : '(no output)',
        }),
        task.error === null || task.error === undefined ? null : h('div', { key: 'err', className: 'agd-error' }, task.error),
        h('div', { key: 'foot', className: 'agd-rowtop' }, [
          h('span', { key: 'meta', className: 'agd-meta' }, `${task.model ?? 'default model'} · ${task.cd}`),
          h('span', { key: 'gap', className: 'agd-grow' }),
          h('span', { key: 'hint', className: 'agd-meta' }, expanded ? 'click to collapse' : 'click for full text'),
        ]),
      ]);
    }

    /** Every task, or the calm empty state. */
    function TaskList(props) {
      if (props.tasks.length === 0) {
        return h('div', { className: 'agd-empty' }, [
          h(Sparkle, { key: 's', size: 26 }),
          h('div', { key: 't', className: 'agd-empty-title' }, 'No agy tasks yet'),
          h('div', { key: 'h', className: 'agd-meta', style: { maxWidth: 280 } }, 'Dispatch a brief with agy_delegate; its input, output and status appear here.'),
        ]);
      }
      return h('div', { className: 'agd-list' },
        props.tasks.map((task) => h(TaskRow, {
          key: task.id,
          task,
          expanded: props.expanded === task.id,
          onToggle: props.onToggle,
          onKill: props.onKill,
          onDismiss: props.onDismiss,
        })));
    }

    /** The docked drawer: header, then the task list. */
    function Panel(props) {
      return h('aside', {
        className: 'agd-root agd-glass agd-drawer',
        'aria-label': 'delegate tasks',
        ref: props.rootRef,
        // Docked between the window header and the status bar, so neither the
        // window buttons nor the status bar end up underneath it.
        style: { top: props.insetTop, bottom: props.insetBottom },
      }, [
        h('div', { key: 'head', className: 'agd-head' }, [
          h(Orb, { key: 'orb', status: props.running > 0 ? 'running' : (props.tasks[0]?.status ?? 'killed'), width: 24 }),
          h('div', { key: 'title', style: { display: 'flex', flexDirection: 'column' } }, [
            h('span', { key: 't', className: 'agd-title' }, 'delegate'),
            h('span', { key: 's', className: 'agd-sub' }, announce(props.tasks, props.running)),
          ]),
          h(Sparkle, { key: 'spark', size: 11 }),
          h('span', { key: 'gap', className: 'agd-grow' }),
          h('button', {
            key: 'close', type: 'button', className: 'agd-btn',
            onClick: props.onClose, title: 'Collapse (Esc)', 'aria-label': 'Collapse the delegate panel',
          }, 'collapse'),
        ]),
        h('div', { key: 'body', className: 'agd-body' }, h(TaskList, {
          tasks: props.tasks,
          expanded: props.expanded,
          onToggle: props.onToggle,
          onKill: props.onKill,
          onDismiss: props.onDismiss,
        })),
      ]);
    }

    /** The collapsed pill: always mounted, with a spoken count. */
    function Pill(props) {
      const running = props.running;
      const status = running > 0 ? 'running' : (props.tasks[0]?.status ?? 'killed');
      return h('button', {
        type: 'button',
        className: 'agd-root agd-glass agd-pill',
        'data-running': running > 0 ? 'true' : 'false',
        onClick: props.onClick,
        'aria-label': `delegate — ${announce(props.tasks, running)}. Open the panel.`,
      }, [
        h(Orb, { key: 'orb', status, width: 20 }),
        h('span', { key: 'label', style: { fontWeight: 600 } }, 'agy'),
        h(Sparkle, { key: 'spark', size: 10 }),
        h('span', { key: 'count', className: 'agd-chip', 'data-tone': running > 0 ? 'live' : 'muted' },
          running > 0 ? `${running} running` : `${props.tasks.length} task${props.tasks.length === 1 ? '' : 's'}`),
        h('span', {
          key: 'live',
          role: 'status',
          'aria-atomic': 'true',
          style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
        }, announce(props.tasks, running)),
      ]);
    }

    /** The floating widget: owns polling, the open state and the expanded row. */
    function AgyWidget() {
      const [tasks, setTasks] = React.useState([]);
      const [running, setRunning] = React.useState(0);
      const [open, setOpen] = React.useState(false);
      const [expanded, setExpanded] = React.useState(null);
      const [chrome, setChrome] = React.useState(measureChrome);
      const drawer = React.useRef(null);

      // The chrome insets follow window resizes and profile skins.
      React.useEffect(() => {
        const onResize = () => setChrome(measureChrome());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

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

      // Click outside (or Escape) collapses the drawer — the "just get out of my
      // way" affordance. The listener is only mounted while it is open, and the
      // chrome is measured here: the drawer's own layout only matters once it is
      // on screen, and by then the app's header and composer exist.
      React.useEffect(() => {
        if (!open) return () => {};
        setChrome(measureChrome());
        const onPointerDown = (event) => {
          const node = drawer.current;
          if (node !== null && typeof node.contains === 'function' && node.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const shared = {
        tasks,
        running,
        expanded,
        onToggle: (id) => setExpanded((current) => (current === id ? null : id)),
        onKill: (id) => { void post(`${API}/kill`, { id }); },
        onDismiss: (id) => {
          void post(`${API}/dismiss`, { id }).then(() => setExpanded((current) => (current === id ? null : current)));
        },
      };
      // The widget is always present, not only while something runs: several
      // delegations can be in flight, and the empty list is itself the place you
      // go to see that nothing is running.
      if (!open) return h(Pill, { ...shared, onClick: () => setOpen(true) });
      return h(Panel, {
        ...shared,
        insetTop: chrome.top,
        insetBottom: chrome.bottom,
        onClose: () => setOpen(false),
        rootRef: drawer,
      });
    }

    exports.AgyWidget = AgyWidget;
    exports.Pill = Pill;
    exports.Panel = Panel;
    exports.TaskList = TaskList;
    exports.TaskRow = TaskRow;
    exports.Field = Field;
    exports.Orb = Orb;
    exports.Sparkle = Sparkle;
    exports.CSS = CSS;
    exports.announce = announce;
    exports.statusText = statusText;
    exports.bottomInset = bottomInset;
    exports.inject = ['slots'];

    /** Seat the widget in the frame-wide overlay layer, with its stylesheet. */
    exports.apply = function apply(ctx) {
      ctx.effect(() => installStyles(), 'delegate: styles');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'delegate',
        order: 40,
        label: () => 'delegate',
      }, AgyWidget));
    };

    return module.exports;
  },
});

