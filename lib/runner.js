/**
 * dsh-delegate — the run registry.
 *
 * One child process per task, spawned from the argv its backend adapter builds,
 * with the adapter's stream parser folding stdout into transcript steps while
 * the task runs — that live stream is the whole reason this plugin exists rather
 * than shelling out to a skill's relay, whose transcript only lands at the end.
 *
 * This module knows no CLI. Everything specific to `agy` or `opencode` (flags,
 * event shapes, how success is judged, project reuse, watchesdog message) lives
 * in `lib/backends/<id>.js` and arrives here through `lib/backends/registry.js`
 * as a descriptor. If a branch here ever needs to ask "which backend is this?",
 * the seam has been broken.
 *
 * Dispatch semantics follow the delegate skills: a self-contained brief, a
 * workspace the run may touch, read-only expressed per backend, and a watchdog
 * past the backend's own timeout.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { answerOf as answerText, costOf, countsOf, trimSteps } from './step.js';

/** Completed tasks the registry keeps for the widget's panel. */
const KEEP_FINISHED = 20;
/** Per-step text cap, so one runaway answer cannot pin the host's memory. */
const MAX_STEP_TEXT = 400_000;
/** Non-JSON log lines kept per task. */
const MAX_LOGS = 200;
/** Concurrent runs allowed. Each one is a full local agent run. */
export const DEFAULT_MAX_CONCURRENT = 4;

/**
 * The refusal message when the concurrency ceiling is reached, or null.
 * The ceiling is machine load, not a per-CLI limit, so it is shared.
 * @param running - tasks currently running, across every backend.
 * @param max - the configured ceiling.
 * @param controlTool - the tool that waits on a task (`agy_task` until #4).
 */
export function concurrencyRefusal(running, max, controlTool = 'agy_task') {
  if (running < max) return null;
  return `${running} tasks are already running (maxConcurrent ${max}); wait for one to settle with ${controlTool} { action: "wait" }, `
    + "or raise the plugin's maxConcurrent.";
}

/** The run directory root for this install. */
export function runsRoot(home) {
  return join(home, 'delegate', 'runs');
}

/**
 * Kill a child process and everything it spawned. On Windows the child is not a
 * process-group leader, so `taskkill /t` is the only way to fell the tools it
 * started; POSIX children lead their own group (see `detached` in spawn).
 */
export function killTree(child) {
  if (child === undefined || child === null || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', timeout: 10_000 });
      return;
    } catch {
      // Fall through to the plain signal: the tree may already be gone.
    }
  }
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already dead.
    }
  }
}

/** Trim a task's normalized steps to what the widget actually renders. */
function projectSteps(steps) {
  return trimSteps(steps, MAX_STEP_TEXT);
}

/** The light row the widget's collapsed pill and task list need. */
export function taskRow(task) {
  return {
    id: task.id,
    backend: task.backend,
    backendLabel: task.label ?? null,
    status: task.status,
    brief: task.brief,
    cd: task.cd,
    model: task.model ?? null,
    effort: task.effort ?? null,
    readOnly: task.readOnly,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitCode: task.exitCode,
    conversationId: task.conversationId ?? null,
    projectId: task.projectId ?? null,
    projectName: task.projectName ?? null,
    reusedProject: task.reusedProject === true,
    stepCount: task.steps.length,
    toolCalls: countsOf(task.steps).toolCalls,
    answer: task.answer ?? '',
    error: task.error,
    cost: costOf(task.steps).usd,
  };
}

/**
 * Create the task registry.
 * @param options - install facts.
 * @param options.home - DSH home (run artifacts live under it).
 * @param options.backends - the backend registry from `lib/backends/registry.js`.
 * @param options.log - host logger (optional).
 * @param options.maxConcurrent - shared concurrency ceiling (default 4).
 * @param options.controlTool - the tool named in the ceiling refusal.
 * @returns the registry.
 */
export function createRegistry({ home, backends, log, maxConcurrent, controlTool = 'agy_task' }) {
  if (backends === undefined || backends === null || typeof backends.get !== 'function') {
    throw new Error('createRegistry needs a backend registry (see lib/backends/registry.js).');
  }
  /** @type {Map<string, object>} */
  const tasks = new Map();
  const ceiling = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : DEFAULT_MAX_CONCURRENT;
  let counter = 0;
  let running = 0;

  const warn = (message) => {
    if (typeof log === 'function') log(message);
  };

  /** Drop the oldest finished tasks once the panel tail is full. */
  function prune() {
    const finished = [...tasks.values()].filter((task) => task.status !== 'running').sort((a, b) => a.startedAt - b.startedAt);
    for (const task of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) tasks.delete(task.id);
  }

  /** The answer text a task shows: the adapter's reading, else the union's. */
  function answerFor(task, steps) {
    return typeof task.descriptor.answerOf === 'function' ? task.descriptor.answerOf(steps) : answerText(steps);
  }

  /** Write the relay-shaped result.json for a finished task. */
  function writeResult(task) {
    const answer = task.answer ?? '';
    if (answer !== '') writeFileSync(task.finalPath, answer, 'utf8');
    const payload = {
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      plugin: 'dsh-delegate',
      taskId: task.id,
      backend: task.backend,
      backendLabel: task.label ?? null,
      model: task.model ?? null,
      effort: task.effort ?? null,
      readOnly: task.readOnly,
      // Recorded so a "why did nothing change?" report is answerable from the
      // artifacts alone.
      skipPermissions: task.skipPermissions,
      deniedTool: task.deniedTool ?? null,
      conversationId: task.conversationId,
      projectId: task.projectId,
      projectName: task.projectName,
      reusedProject: task.reusedProject,
      durationSeconds: (task.endedAt - task.startedAt) / 1_000,
      finalMessage: answer,
      usage: task.usage ?? null,
      numTurns: task.numTurns ?? null,
      toolCalls: countsOf(task.steps).toolCalls,
      cost: costOf(task.steps).usd,
      logs: task.logs.slice(-20),
      error: task.error,
      // Deliberately absent: touchedFiles. The skill's relay fingerprints the
      // tree for it; run the relay when the review needs that report.
      artifacts: {
        brief: task.briefPath,
        events: task.eventsPath,
        final: existsSync(task.finalPath) ? task.finalPath : null,
        log: existsSync(task.logPath) ? task.logPath : null,
        stderr: task.stderrPath,
        result: task.resultPath,
      },
    };
    writeFileSync(task.resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  /** Settle a task exactly once. */
  function finish(task, { status, exitCode, signal, error, deniedTool }) {
    if (task.status !== 'running') return;
    task.status = status;
    task.exitCode = exitCode ?? null;
    task.signal = signal ?? null;
    task.endedAt = Date.now();
    const stream = task.stream;
    task.steps = projectSteps(stream.steps());
    task.result = stream.result();
    task.info = stream.info();
    task.answer = answerFor(task, task.steps);
    try {
      if (typeof task.descriptor.factsAfterRun === 'function') task.descriptor.factsAfterRun(task, stream);
    } catch (factsError) {
      warn(`dsh-delegate: reading ${task.backend} run facts failed: ${String(factsError)}`);
    }
    task.error = error ?? task.error;
    if (deniedTool !== undefined) task.deniedTool = deniedTool;
    if (task.watchdog !== undefined) {
      clearTimeout(task.watchdog);
      task.watchdog = undefined;
    }
    try {
      writeResult(task);
    } catch (writeError) {
      warn(`dsh-delegate: writing result.json failed: ${String(writeError)}`);
    }
    running -= 1;
    prune();
  }

  /**
   * The status a closed child earns, when nothing else already decided it.
   * Timeouts, kills and live denials are the core's own verdicts; everything
   * else is the adapter's to judge, because "did this run succeed" is a fact
   * about that CLI's exit codes and event stream.
   */
  function statusFor(task, code, signal) {
    if (task.timedOut === true) return { status: 'timeout' };
    if (task.denied === true) return { status: 'failed' };
    if (task.killed === true) return { status: 'killed' };
    const verdict = task.descriptor.settled({ task, stream: task.stream, code, signal });
    return { status: verdict.status, error: verdict.error, deniedTool: verdict.deniedTool };
  }

  /**
   * Start one task on one backend. Never throws for a spawn failure: it settles
   * the task as failed so the caller always gets an id back.
   * @param options - the brief, the backend id and that backend's options bag.
   * @returns the task row.
   */
  function start(options) {
    const refusal = concurrencyRefusal(running, ceiling, controlTool);
    if (refusal !== null) throw new Error(refusal);
    const backendId = typeof options.backend === 'string' && options.backend !== '' ? options.backend : backends.defaultId();
    const entry = backends.get(backendId);
    if (entry === null) {
      throw new Error(`unknown backend "${backendId}"; installed: ${backends.ids().join(', ') || '(none)'}`);
    }
    const { descriptor, config } = entry;
    const id = `${descriptor.id}-${Date.now().toString(36)}-${(counter += 1)}`;
    const cd = resolve(options.cd);
    const runDir = join(runsRoot(home), id);
    mkdirSync(runDir, { recursive: true });

    const task = {
      id,
      backend: descriptor.id,
      label: descriptor.label,
      descriptor,
      brief: options.brief,
      cd,
      model: options.model ?? null,
      effort: options.effort ?? null,
      readOnly: options.readOnly === true,
      sandbox: options.sandbox === true,
      // Full access is the default: a headless CLI cannot answer a permission
      // prompt, so a run without this flag dies on the first tool that needs
      // one. Callers that pre-grant allow-rules pass false explicitly.
      skipPermissions: options.skipPermissions !== false,
      printTimeout: options.printTimeout ?? config.printTimeout ?? descriptor.defaults?.printTimeout ?? null,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      answer: '',
      stream: descriptor.createStream(),
      steps: [],
      logs: [],
      result: null,
      info: null,
      error: null,
      conversationId: null,
      projectId: null,
      projectName: null,
      reusedProject: false,
      options,
      config,
      runDir,
      briefPath: join(runDir, 'brief.txt'),
      eventsPath: join(runDir, 'events.jsonl'),
      finalPath: join(runDir, 'final.txt'),
      resultPath: join(runDir, 'result.json'),
      logPath: join(runDir, `${descriptor.id}.log`),
      stderrPath: join(runDir, 'stderr.txt'),
    };
    tasks.set(id, task);
    writeFileSync(task.briefPath, options.brief, 'utf8');
    writeFileSync(task.stderrPath, '', 'utf8');
    writeFileSync(task.eventsPath, '', 'utf8');

    let plan;
    try {
      plan = descriptor.buildArgv(task) ?? {};
    } catch (planError) {
      finish(task, { status: 'failed', error: `could not build the ${descriptor.label} command line: ${String(planError?.message ?? planError)}` });
      return taskRow(task);
    }
    for (const [key, value] of Object.entries(plan.facts ?? {})) {
      if (value !== null && value !== undefined) task[key] = value;
    }

    const record = (steps) => {
      for (const step of steps) {
        try {
          appendFileSync(task.eventsPath, `${JSON.stringify(step)}\n`, 'utf8');
        } catch {
          // Observability only; never fail a run over the event log.
        }
        if (step.kind === 'log') {
          task.logs.push(step.text);
          if (task.logs.length > MAX_LOGS) task.logs.shift();
        }
        // A refusal means this run cannot do its job, so stop it now instead of
        // letting the CLI spend minutes on tools that will all be denied too.
        if (task.deniedTool === undefined && typeof descriptor.denialIn === 'function') {
          const denial = descriptor.denialIn(step);
          if (denial !== null && denial !== undefined) {
            task.deniedTool = denial.tool;
            task.denied = true;
            task.error = descriptor.denialMessage(denial);
            killTree(child);
          }
        }
      }
    };

    const bin = typeof config.path === 'string' && config.path !== '' ? config.path : descriptor.bin;
    const argv = Array.isArray(plan.argv) ? plan.argv : [];
    const wantsStdin = plan.stdin !== undefined;
    running += 1;
    let child;
    try {
      child = spawn(bin, argv, {
        cwd: cd,
        env: { ...process.env, PWD: cd, ...(plan.env ?? {}) },
        stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (spawnError) {
      finish(task, { status: 'failed', error: `could not start ${descriptor.label}: ${String(spawnError)}` });
      return taskRow(task);
    }
    task.child = child;
    task.pid = child.pid ?? null;
    if (wantsStdin) {
      try {
        child.stdin.end(String(plan.stdin));
      } catch {
        // The child may already be gone; the close handler settles the task.
      }
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) record(task.stream.push(line));
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          appendFileSync(task.stderrPath, `${line}\n`, 'utf8');
        } catch {
          // Best effort.
        }
        task.logs.push(line);
        if (task.logs.length > MAX_LOGS) task.logs.shift();
      }
    });

    const timeoutMs = typeof descriptor.timeoutMs === 'function' ? descriptor.timeoutMs(task) : null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      task.watchdog = setTimeout(() => {
        if (settled) return;
        task.error = typeof descriptor.timeoutMessage === 'function'
          ? descriptor.timeoutMessage(task)
          : `timed out after ${Math.round(timeoutMs / 1_000)}s; the process tree was killed.`;
        task.timedOut = true;
        killTree(child);
      }, timeoutMs);
    }

    child.on('error', (spawnError) => {
      if (settled) return;
      settled = true;
      finish(task, { status: 'failed', error: `${descriptor.label} could not be run: ${String(spawnError)}` });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (stdoutBuffer !== '') record(task.stream.push(stdoutBuffer));
      const verdict = statusFor(task, code, signal);
      finish(task, { status: verdict.status, exitCode: code, signal, error: verdict.error, deniedTool: verdict.deniedTool });
    });

    return taskRow(task);
  }

  return {
    start,

    /** Light rows for the widget, newest first. */
    list() {
      return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).map(taskRow);
    },

    /** Full detail for one task, including folded steps and logs. */
    detail(id) {
      const task = tasks.get(id);
      if (task === undefined) return null;
      if (task.status === 'running') {
        const steps = projectSteps(task.stream.steps());
        const row = taskRow({ ...task, steps, answer: answerFor(task, steps) });
        return { ...row, steps, logs: task.logs.slice(-MAX_LOGS), info: task.stream.info() };
      }
      return { ...taskRow(task), steps: task.steps, logs: task.logs.slice(-MAX_LOGS), info: task.info ?? task.stream.info() };
    },

    /** Ask one task to stop; the tree is felled so its tools die with it. */
    kill(id) {
      const task = tasks.get(id);
      if (task === undefined) return { ok: false, message: `no task ${id}` };
      if (task.status !== 'running') return { ok: false, message: `task ${id} is already ${task.status}` };
      task.killed = true;
      killTree(task.child);
      return { ok: true, message: `killing ${id}` };
    },

    /** Forget a finished task (the run directory on disk stays). */
    dismiss(id) {
      const task = tasks.get(id);
      if (task === undefined) return { ok: false, message: `no task ${id}` };
      if (task.status === 'running') return { ok: false, message: `task ${id} is still running; kill it first` };
      tasks.delete(id);
      return { ok: true, message: `dismissed ${id}` };
    },

    /** Whether any task is still running. */
    running() {
      return running;
    },

    /** Wait for one task to settle, up to `ms`. */
    async wait(id, ms) {
      const task = tasks.get(id);
      if (task === undefined) return null;
      const deadline = Date.now() + ms;
      while (task.status === 'running' && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 250));
      }
      return this.detail(id);
    },

    /** Kill everything (host shutdown). */
    dispose() {
      for (const task of tasks.values()) {
        if (task.status === 'running') killTree(task.child);
      }
    },
  };
}

/** Read a run's events.jsonl back (used by tests and post-mortems). */
export function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}
