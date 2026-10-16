/**
 * dsh-agy-delegate — browser half.
 *
 * One floating widget in the frame-wide `shell.overlay` layer: a small pill
 * while agy tasks run — always mounted, since several delegations can be in
 * flight — expanding into a panel that lists the tasks and shows one task's
 * live transcript (thinking, answer, tool calls, logs, usage).
 *
 * ## Visual language
 *
 * Reskinned with the ui-ux-pro-max skill against the user's reference art
 * (Google I/O 2026 "Gemini Spark"): pastel-glass surfaces, an indigo→violet
 * accent, a cyan visor glow, and a four-point sparkle as the brand mark.
 * Two lookups drove it: `--domain style glassmorphism` (frosted glass,
 * blur 10–20px, translucent 15–30%, 1px light border, layered depth) and
 * `--domain color` (indigo #4338CA / #6366F1 / #7C3AED). The icon lookup has
 * NO "sparkle" entry, so the sparkle is a hand-drawn SVG traced from the
 * reference; the status glyphs follow the database's `pulse` and `check`.
 *
 * Rules kept from the skill's checklist:
 *   - every surface/text/border colour is a DSH theme token (both themes), and
 *     the accent is confined to decorative marks, never to text contrast;
 *   - state is never colour-only: the visor mouth changes SHAPE per status;
 *   - clickable things are real <button>s with `:focus-visible` rings;
 *   - dragging is not the only way to reposition (the header has a reset);
 *   - the running glow is gated behind `prefers-reduced-motion`;
 *   - counts are announced with a contextual phrase, not a bare number.
 *
 * Hand-written as a module-loader closure factory: no bundler, no build step.
 * `react` resolves through the loader's injected `require`, the stylesheet is
 * injected (and removed) by `apply`, and every component except `AgyWidget`
 * (which owns the polling and drag state) is a pure function of its props, so
 * `test/client.test.mjs` renders them without a DOM.
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
    /** The corner a reset returns to. */
    const DEFAULT_POS = { right: 24, bottom: 96 };

    /**
     * The stylesheet. Every colour is a semantic DSH token or a translucent
     * mix of one, so both themes come from the host rather than from here; the
     * indigo/violet/cyan triple is the widget's own brand accent and is used
     * only for marks, borders and glows — never for text that must be legible.
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
  --agd-shadow: 0 18px 44px color-mix(in srgb, var(--agd-accent-deep) 26%, transparent), 0 2px 8px rgba(0, 0, 0, 0.26);
  --agd-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
}
.agd-layer { position: fixed; z-index: 30; pointer-events: auto; }
.agd-glass {
  background: var(--agd-surface);
  backdrop-filter: blur(20px) saturate(1.45);
  -webkit-backdrop-filter: blur(20px) saturate(1.45);
  border: 1px solid var(--agd-line);
  box-shadow: var(--agd-shadow);
  color: var(--agd-label);
}
.agd-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 13px 6px 8px; border-radius: 999px;
  font: inherit; font-size: 12px; letter-spacing: 0.01em;
  cursor: pointer;
  transition: transform 0.2s var(--agd-ease), border-color 0.2s var(--agd-ease), box-shadow 0.2s var(--agd-ease);
}
.agd-pill:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--agd-accent) 46%, transparent); }
.agd-pill:active { transform: translateY(0); }
.agd-pill[data-running='true'] { border-color: color-mix(in srgb, var(--agd-accent) 34%, transparent); }
.agd-panel {
  width: 470px; max-width: calc(100vw - 24px);
  max-height: min(70vh, 620px);
  display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px;
  animation: agd-in 0.22s var(--agd-ease);
}
.agd-head {
  display: flex; align-items: center; gap: 9px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--agd-line);
  background:
    radial-gradient(120% 190% at 0% -40%, color-mix(in srgb, var(--agd-accent) 20%, transparent), transparent 62%),
    radial-gradient(90% 160% at 100% -60%, color-mix(in srgb, var(--agd-accent-soft) 16%, transparent), transparent 58%);
  cursor: grab;
}
.agd-head:active { cursor: grabbing; }
.agd-head:focus-visible { outline: 2px solid var(--agd-accent); outline-offset: -2px; }
.agd-title { font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; }
.agd-sub { font-size: 10.5px; color: var(--agd-label-2); }
.agd-grow { flex: 1 1 auto; }
.agd-spark { color: var(--agd-accent); display: inline-flex; }
.agd-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--agd-line);
  background: color-mix(in srgb, var(--agd-accent) 12%, transparent);
  font-size: 10.5px; color: var(--agd-label);
  white-space: nowrap;
}
.agd-chip[data-tone='muted'] { background: color-mix(in srgb, var(--agd-label) 8%, transparent); color: var(--agd-label-2); }
.agd-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 9px; border-radius: 8px;
  border: 1px solid var(--agd-line); background: transparent;
  color: var(--agd-label-2); font: inherit; font-size: 11px; cursor: pointer;
  transition: background 0.18s var(--agd-ease), color 0.18s var(--agd-ease), border-color 0.18s var(--agd-ease);
}
.agd-btn:hover { color: var(--agd-label); background: color-mix(in srgb, var(--agd-label) 8%, transparent); }
.agd-btn[data-tone='danger']:hover { color: var(--dsw-alias-state-error-primary, #d9534f); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d9534f) 50%, transparent); }
.agd-btn[data-icon='true'] { padding: 5px; border-color: transparent; }
/* min-height:0 is load-bearing: a flex child keeps min-height:auto by default,
   which would let the body grow the panel past its max-height instead of
   scrolling inside it. */
.agd-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 7px; }
.agd-body::-webkit-scrollbar { width: 9px; }
.agd-body::-webkit-scrollbar-thumb { background: var(--agd-line); border-radius: 999px; }
.agd-row {
  display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left;
  padding: 10px 11px; border-radius: 12px;
  border: 1px solid var(--agd-line); background: var(--agd-sunken);
  font: inherit; color: var(--agd-label); cursor: pointer;
  transition: transform 0.2s var(--agd-ease), border-color 0.2s var(--agd-ease), background 0.2s var(--agd-ease);
}
.agd-row:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--agd-accent) 42%, transparent); }
.agd-row[data-status='running'] { border-left: 3px solid var(--agd-accent); }
.agd-row[data-status='failed'], .agd-row[data-status='timeout'] { border-left: 3px solid var(--dsw-alias-state-error-primary, #d9534f); }
.agd-row[data-status='done'] { border-left: 3px solid var(--dsw-alias-state-success-primary, #3fa76a); }
.agd-id { font-family: var(--agd-mono); font-size: 11px; }
.agd-meta { font-size: 10.5px; color: var(--agd-label-2); line-height: 1.5; }
.agd-brief { font-size: 11.5px; line-height: 1.5; color: var(--agd-label-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.agd-pre {
  margin: 5px 0 0; padding: 8px 10px; border-radius: 10px;
  background: var(--agd-sunken); border: 1px solid var(--agd-line);
  font-family: var(--agd-mono); font-size: 11px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto;
}
.agd-sec { border-top: 1px solid var(--agd-line); padding-top: 6px; margin-top: 4px; }
.agd-sum { display: flex; align-items: center; gap: 7px; padding: 5px 0; font-size: 11.5px; font-weight: 600; cursor: pointer; list-style: none; }
.agd-sum::-webkit-details-marker { display: none; }
.agd-sum:hover { color: var(--agd-accent); }
.agd-tool { border: 1px solid var(--agd-line); border-radius: 10px; padding: 8px 9px; margin-top: 6px; background: var(--agd-sunken); }
.agd-tool[data-state='ERROR'] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d9534f) 42%, transparent); }
.agd-toolname { font-family: var(--agd-mono); font-size: 11px; }
.agd-error {
  margin-top: 7px; padding: 7px 9px; border-radius: 9px; font-size: 11px; line-height: 1.5;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d9534f) 12%, transparent);
  border-left: 3px solid var(--dsw-alias-state-error-primary, #d9534f);
}
.agd-empty { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 26px 12px 24px; text-align: center; }
.agd-empty .agd-spark { opacity: 0.5; }
.agd-empty-title { font-size: 12.5px; font-weight: 600; }
.agd-usage { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.agd-mouth { transition: opacity 0.3s var(--agd-ease); }
.agd-led { animation: agd-breathe 2.4s var(--agd-ease) infinite; }
.agd-pill[data-running='true'] .agd-orb-halo { animation: agd-halo 2.6s var(--agd-ease) infinite; }
@keyframes agd-breathe { 0%, 100% { opacity: 0.62; } 50% { opacity: 1; } }
@keyframes agd-halo { 0%, 100% { opacity: 0.35; transform: scale(0.94); } 50% { opacity: 0.75; transform: scale(1.06); } }
@keyframes agd-in { from { opacity: 0; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .agd-pill, .agd-row, .agd-btn, .agd-panel { transition: none !important; animation: none !important; }
  .agd-led, .agd-orb-halo { animation: none !important; }
}
`;

    /** Install the stylesheet once; a missing DOM (tests) is not an error. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.dataset.dshPlugin = 'agy-delegate';
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
      return DEFAULT_POS;
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

    /** Viewport facts, with a safe fallback for the DOM-free tests. */
    function viewport() {
      if (typeof window === 'undefined') return { width: 1280, height: 860 };
      return { width: window.innerWidth || 1280, height: window.innerHeight || 860 };
    }

    /** Panel width bounds. */
    const PANEL_MIN_WIDTH = 240;
    const PANEL_MAX_WIDTH = 470;
    /** Panel height bounds. */
    const PANEL_MIN_HEIGHT = 240;
    const PANEL_MAX_HEIGHT = 620;
    /** Room the corner must leave so the header stays on screen. */
    const EDGE_X = 100;
    const EDGE_Y = 280;

    /**
     * Keep the widget reachable: a corner stored before a window resize (or a
     * drag towards the edge) must never park it outside the frame, where its
     * header — the only way to drag, reset or collapse it — is unreachable.
     * @param pos - the requested corner.
     * @param width - viewport width.
     * @param height - viewport height.
     */
    function clampPos(pos, width, height) {
      return {
        right: Math.min(Math.max(4, Math.round(pos.right)), Math.max(4, width - EDGE_X)),
        bottom: Math.min(Math.max(4, Math.round(pos.bottom)), Math.max(4, height - EDGE_Y)),
      };
    }

    /** The panel's width for this viewport: never wider than the frame. */
    function panelWidth(viewportWidth) {
      return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(viewportWidth - 24)));
    }

    /**
     * The tallest the panel may be at this corner, so an expanded detail still
     * fits above the bottom offset instead of growing off the top of the frame
     * (the clamp above guarantees at least PANEL_MIN_HEIGHT of room).
     */
    function panelMaxHeight(viewportHeight, bottom) {
      return Math.max(
        PANEL_MIN_HEIGHT,
        Math.min(PANEL_MAX_HEIGHT, Math.round(viewportHeight * 0.7), Math.round(viewportHeight - bottom - 16)),
      );
    }

    /** The human sentence a status deserves, for chips and announcements. */
    function statusText(row) {
      const seconds = elapsed(row);
      const tools = row.toolCalls ?? 0;
      switch (row.status) {
        case 'running': return `${seconds}s · ${tools} tool${tools === 1 ? '' : 's'}`;
        case 'done': return `${seconds}s · done`;
        case 'failed': return `${seconds}s · failed`;
        case 'timeout': return `${seconds}s · timed out`;
        case 'killed': return `${seconds}s · killed`;
        default: return `${seconds}s · ${row.status}`;
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
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('path', {
          key: 'star',
          d: 'M12 1.6c.5 3.9 1.9 6.4 5.4 7.4L22.4 10.4c-3.5 1-4.9 3.5-5.4 7.4-.5 3.9-1.3 4.9-2.5 4.9s-2-1-2.5-4.9c-.5-3.9-1.9-6.4-5.4-7.4L1.6 9c3.5-1 4.9-3.5 5.4-7.4.5-3.9 1.3-3.9 2.5-3.9s2 0 2.5 3.9Z',
          fill: 'currentColor',
          transform: 'translate(0 3.2) scale(0.92)',
        }),
      ]);
    }

    /**
     * The mascot's visor: a glossy dark tile whose mouth is the status. Shape
     * carries the state as well as colour (smile / flat / frown / check).
     */
    function Orb(props) {
      const status = props.status;
      const width = props.width ?? 24;
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
        width,
        height,
        viewBox: '0 0 19 16',
        'aria-hidden': 'true',
        focusable: 'false',
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

    /** A database-backed status glyph: `pulse` for live work, `check` for done. */
    function StatusIcon(props) {
      const status = props.status;
      const size = props.size ?? 12;
      const tone = TONE[status] ?? TONE.killed;
      const path = status === 'running'
        ? 'M2 12h4l2.4-6 3.2 12 2.6-7 1.8 1h4'
        : status === 'done'
          ? 'M4.5 12.5l4.6 4.5L19.5 7'
          : status === 'failed' || status === 'timeout'
            ? 'M6.5 6.5l11 11M17.5 6.5l-11 11'
            : 'M5 12h14';
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
        style: { flex: '0 0 auto', color: tone },
      }, h('path', {
        d: path, fill: 'none', stroke: 'currentColor', strokeWidth: '2.1', strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    /** A chevron for a collapsible section. */
    function Chevron() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', className: 'agd-chev' },
        h('path', { d: 'M9 5l7 7-7 7', fill: 'none', stroke: 'currentColor', strokeWidth: '2.4', strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    /** A tiny inline glyph button label pair. */
    function Glyph(props) {
      const d = props.d ?? 'M4 12h16';
      return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    /** A collapsible section with the skill's summary affordances. */
    function section(title, badge, body, open) {
      return h('details', { className: 'agd-sec', open: open === true }, [
        h('summary', { className: 'agd-sum', key: 'summary' }, [
          h(Chevron, { key: 'c' }),
          h('span', { key: 't' }, title),
          badge === undefined ? null : h('span', { key: 'b', className: 'agd-chip', 'data-tone': 'muted' }, badge),
        ]),
        h('div', { key: 'body' }, body),
      ]);
    }

    /** A monospace block. */
    function pre(text, maxHeight) {
      return h('pre', { className: 'agd-pre', style: { maxHeight: maxHeight ?? 220 } }, text);
    }

    /** One row in the task list: real <button>, status in shape + words. */
    function TaskRow(props) {
      const task = props.task;
      return h('button', {
        type: 'button',
        className: 'agd-row',
        'data-status': task.status,
        onClick: () => props.onSelect(task.id),
        'aria-label': `${task.id}, ${task.status}, ${statusText(task)}`,
      }, [
        h(Orb, { key: 'orb', status: task.status, width: 19 }),
        h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 } }, [
          h('div', { key: 'top', style: { display: 'flex', alignItems: 'center', gap: 7 } }, [
            h('span', { key: 'id', className: 'agd-id' }, task.id),
            h('span', { key: 'gap', className: 'agd-grow' }),
            h('span', { key: 'time', className: 'agd-chip', 'data-tone': 'muted' }, statusText(task)),
          ]),
          h('span', { key: 'brief', className: 'agd-brief' }, String(task.brief ?? '').slice(0, 240) || '(no brief)'),
          h('span', { key: 'meta', className: 'agd-meta' }, `${task.model ?? 'default model'}${task.readOnly === true ? ' · read-only' : ''} · ${task.cd}`),
          task.error === null || task.error === undefined ? null : h('span', { key: 'error', className: 'agd-error', style: { marginTop: 0 } }, task.error),
        ]),
      ]);
    }

    /** The task list, or the calm empty state. */
    function TaskList(props) {
      if (props.tasks.length === 0) {
        return h('div', { className: 'agd-empty' }, [
          h(Sparkle, { key: 's', size: 26 }),
          h('div', { key: 't', className: 'agd-empty-title' }, 'No agy tasks yet'),
          h('div', { key: 'h', className: 'agd-meta', style: { maxWidth: 280 } }, 'Dispatch a brief with agy_delegate and its thinking, answer and tool calls appear here live.'),
        ]);
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } }, props.tasks.map((task) => h(TaskRow, { key: task.id, task, onSelect: props.onSelect })));
    }

    /** The live transcript of one task. */
    function TaskDetail(props) {
      const task = props.task;
      if (task === null || task === undefined) return h('div', { className: 'agd-meta' }, 'Loading task…');
      const steps = task.steps ?? [];
      // A reasoning step must not double as an answer: anything carrying
      // "thinking" is reasoning even when it also streams text. Keep this
      // predicate identical to `isAnswerStep` in lib/parse.js (the browser half
      // cannot import it).
      const isAnswer = (step) => step.stepType.includes('response') && !step.stepType.includes('thinking');
      const thinking = steps.filter((step) => step.thinking !== '' || step.stepType.includes('thinking'));
      const answers = steps.filter((step) => isAnswer(step) && step.text !== '');
      const tools = steps.filter((step) => step.toolName !== undefined);
      // The final `result` carries the authoritative usage; while a run is live,
      // take the newest step that actually reported usage (a trailing tool step
      // rarely does).
      const usage = (task.result ?? {}).usage
        ?? [...steps].reverse().find((step) => step.usage !== undefined)?.usage
        ?? null;
      const logs = task.logs ?? [];

      const facts = [task.effort === null || task.effort === undefined ? null : `effort ${task.effort}`, task.model ?? 'default model', task.cd]
        .filter((part) => part !== null);

      return h('div', { style: { display: 'flex', flexDirection: 'column' } }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h(Orb, { key: 'orb', status: task.status, width: 22 }),
          h('span', { key: 'id', className: 'agd-id' }, task.id),
          h('span', { key: 'chip', className: 'agd-chip' }, statusText(task)),
          h('span', { key: 'gap', className: 'agd-grow' }),
          task.status === 'running'
            ? h('button', {
                key: 'kill', type: 'button', className: 'agd-btn', 'data-tone': 'danger',
                onClick: () => props.onKill(task.id),
              }, [h(Glyph, { key: 'g', d: 'M7 7l10 10M17 7L7 17' }), h('span', { key: 'l' }, 'kill')])
            : h('button', {
                key: 'dismiss', type: 'button', className: 'agd-btn',
                onClick: () => props.onDismiss(task.id),
              }, 'dismiss'),
        ]),
        h('div', { key: 'facts', className: 'agd-meta', style: { marginTop: 5 } }, facts.join('  ·  ')),
        task.error === null || task.error === undefined ? null : h('div', { key: 'error', className: 'agd-error' }, task.error),
        task.brief === undefined || task.brief === '' ? null : section('Brief', undefined, pre(task.brief, 150)),
        thinking.length === 0 ? null : section(
          'Thinking',
          String(thinking.length),
          thinking.map((step, index) => h('div', { key: index }, pre(step.thinking === '' ? step.text : step.thinking, 280))),
          true,
        ),
        answers.length === 0 ? null : section(
          'Answer',
          String(answers.length),
          answers.map((step, index) => h('div', { key: index }, pre(step.text, 340))),
          true,
        ),
        tools.length === 0 ? null : section('Tool calls', String(tools.length), tools.map((step, index) => h('div', {
          key: index,
          className: 'agd-tool',
          'data-state': step.state,
        }, [
          h('div', { key: 'name', style: { display: 'flex', alignItems: 'center', gap: 7 } }, [
            h(StatusIcon, { key: 'i', status: step.state === 'ERROR' ? 'failed' : step.state === 'DONE' ? 'done' : 'running' }),
            h('span', { key: 'n', className: 'agd-toolname' }, step.toolName),
            h('span', { key: 'gap', className: 'agd-grow' }),
            h('span', { key: 's', className: 'agd-meta' }, step.durationSeconds === undefined ? step.state : `${step.state} · ${step.durationSeconds.toFixed(1)}s`),
          ]),
          step.tool === undefined || step.tool.parameters === undefined ? null : pre(JSON.stringify(step.tool.parameters, null, 2), 170),
          step.error === undefined ? null : h('div', { key: 'e', className: 'agd-error', style: { marginTop: 6 } }, String(step.error.message ?? JSON.stringify(step.error))),
        ]))),
        usage === null || usage === undefined ? null : h('div', { key: 'usage', className: 'agd-usage' }, [
          h('span', { key: 'i', className: 'agd-chip', 'data-tone': 'muted' }, `in ${usage.input_tokens ?? 0}`),
          h('span', { key: 'o', className: 'agd-chip', 'data-tone': 'muted' }, `out ${usage.output_tokens ?? 0}`),
          h('span', { key: 't', className: 'agd-chip', 'data-tone': 'muted' }, `thinking ${usage.thinking_tokens ?? 0}`),
          h('span', { key: 'c', className: 'agd-chip', 'data-tone': 'muted' }, `cache ${usage.cache_read_tokens ?? 0}`),
        ]),
        logs.length === 0 ? null : section('agy output', String(logs.length), pre(logs.join('\n'), 200)),
      ].filter((node) => node !== null && node !== undefined));
    }

    /** The expanded panel: glass card, draggable header, list or one task. */
    function Panel(props) {
      const running = props.running;
      const vp = viewport();
      return h('div', {
        className: 'agd-layer agd-root agd-glass agd-panel',
        style: {
          right: props.pos.right,
          bottom: props.pos.bottom,
          width: panelWidth(vp.width),
          maxHeight: panelMaxHeight(vp.height, props.pos.bottom),
        },
      }, [
        h('div', {
          key: 'head',
          className: 'agd-head',
          onMouseDown: props.onStartDrag,
          role: 'toolbar',
          tabIndex: 0,
          'aria-label': 'agy delegate header — drag to move, or use the reset button',
          onKeyDown: (event) => {
            // Keyboard alternative to dragging (WCAG 2.2 "dragging movements").
            const step = event.shiftKey ? 48 : 12;
            if (event.key === 'ArrowLeft') props.onNudge(step, 0);
            else if (event.key === 'ArrowRight') props.onNudge(-step, 0);
            else if (event.key === 'ArrowUp') props.onNudge(0, step);
            else if (event.key === 'ArrowDown') props.onNudge(0, -step);
            else return;
            event.preventDefault();
          },
        }, [
          h(Orb, { key: 'orb', status: running > 0 ? 'running' : (props.tasks[0]?.status ?? 'killed'), width: 24 }),
          h('div', { key: 'title', style: { display: 'flex', flexDirection: 'column' } }, [
            h('span', { key: 't', className: 'agd-title' }, 'agy delegate'),
            h('span', { key: 's', className: 'agd-sub' }, announce(props.tasks, running)),
          ]),
          h(Sparkle, { key: 'spark', size: 11 }),
          h('span', { key: 'gap', className: 'agd-grow' }),
          props.selected === null ? null : h('button', {
            key: 'all', type: 'button', className: 'agd-btn', onClick: props.onBackToAll,
          }, 'all tasks'),
          h('button', {
            key: 'reset', type: 'button', className: 'agd-btn', 'data-icon': 'true',
            title: 'Reset position', 'aria-label': 'Reset widget position',
            onClick: props.onResetPos,
          }, h(Glyph, { key: 'g', d: 'M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8' })),
          h('button', {
            key: 'collapse', type: 'button', className: 'agd-btn', 'data-icon': 'true',
            title: 'Collapse', 'aria-label': 'Collapse the agy widget', onClick: props.onCollapse,
          }, h(Glyph, { key: 'g', d: 'M6 12h12' })),
        ]),
        h('div', { key: 'body', className: 'agd-body' }, props.selected === null
          ? h(TaskList, { key: 'list', tasks: props.tasks, onSelect: props.onSelect })
          : h(TaskDetail, {
              key: 'detail',
              task: props.detail,
              onBack: props.onBackToAll,
              onKill: props.onKill,
              onDismiss: props.onDismiss,
            })),
      ]);
    }

    /** The collapsed pill: always mounted, the mascot plus a spoken count. */
    function Pill(props) {
      const running = props.running;
      const status = running > 0 ? 'running' : (props.tasks[0]?.status ?? 'killed');
      return h('button', {
        type: 'button',
        className: 'agd-layer agd-root agd-glass agd-pill',
        'data-running': running > 0 ? 'true' : 'false',
        style: { right: props.pos.right, bottom: props.pos.bottom },
        onClick: props.onClick,
        'aria-expanded': false,
        'aria-label': `agy delegate — ${announce(props.tasks, running)}. Open the panel.`,
      }, [
        h(Orb, { key: 'orb', status, width: 20 }),
        h('span', { key: 'label', style: { fontWeight: 600 } }, 'agy'),
        h(Sparkle, { key: 'spark', size: 10 }),
        h('span', { key: 'count', className: 'agd-chip', 'data-tone': running > 0 ? undefined : 'muted' },
          running > 0 ? `${running} running` : `${props.tasks.length} task${props.tasks.length === 1 ? '' : 's'}`),
        h(StatusIcon, { key: 'icon', status }),
        h('span', {
          key: 'live',
          role: 'status',
          'aria-atomic': 'true',
          style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
        }, announce(props.tasks, running)),
      ]);
    }

    /** The floating widget: owns polling, selection, drag and position. */
    function AgyWidget() {
      const [tasks, setTasks] = React.useState([]);
      const [running, setRunning] = React.useState(0);
      const [open, setOpen] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [pos, setPos] = React.useState(() => {
        const vp = viewport();
        return clampPos(loadPos(), vp.width, vp.height);
      });
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

      // Drag the header; the corner is remembered when the drag ends. Every
      // position is clamped, so the header can never be dragged out of reach.
      React.useEffect(() => {
        const onMove = (event) => {
          const state = drag.current;
          if (state === null) return;
          setPos(clampPos(
            { right: state.right - (event.clientX - state.x), bottom: state.bottom - (event.clientY - state.y) },
            window.innerWidth,
            window.innerHeight,
          ));
        };
        const onUp = () => {
          if (drag.current === null) return;
          drag.current = null;
          setPos((current) => {
            savePos(current);
            return current;
          });
        };
        // A shrunken window must not leave the widget parked off-frame.
        const onResize = () => {
          setPos((current) => {
            const next = clampPos(current, window.innerWidth, window.innerHeight);
            if (next.right !== current.right || next.bottom !== current.bottom) savePos(next);
            return next;
          });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('resize', onResize);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          window.removeEventListener('resize', onResize);
        };
      }, []);

      const onStartDrag = (event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, right: pos.right, bottom: pos.bottom };
      };
      const onNudge = (dx, dy) => {
        setPos((current) => {
          const next = clampPos({ right: current.right + dx, bottom: current.bottom + dy }, window.innerWidth, window.innerHeight);
          savePos(next);
          return next;
        });
      };
      const onResetPos = () => {
        savePos(DEFAULT_POS);
        setPos(DEFAULT_POS);
      };

      // The widget is always present, not only while something runs: several
      // delegations can be in flight, and the empty list is itself the place you
      // go to see that nothing is running.
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
        onResetPos,
      };
      if (!open) return h(Pill, { ...shared, onClick: () => setOpen(true) });
      return h(Panel, {
        ...shared,
        selected,
        detail,
        onCollapse: () => setOpen(false),
        onStartDrag,
        onNudge,
      });
    }

    exports.AgyWidget = AgyWidget;
    exports.Pill = Pill;
    exports.Panel = Panel;
    exports.TaskList = TaskList;
    exports.TaskRow = TaskRow;
    exports.TaskDetail = TaskDetail;
    exports.Orb = Orb;
    exports.Sparkle = Sparkle;
    exports.CSS = CSS;
    exports.clampPos = clampPos;
    exports.panelWidth = panelWidth;
    exports.panelMaxHeight = panelMaxHeight;
    exports.inject = ['slots'];

    /** Seat the widget in the frame-wide overlay layer, with its stylesheet. */
    exports.apply = function apply(ctx) {
      ctx.effect(() => installStyles(), 'agy-delegate: styles');
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
