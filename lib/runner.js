/**
 * dsh-agy-delegate — the agy run registry.
 *
 * One `agy --print` child per task, spawned with `--output-format stream-json`
 * so thinking, answer text and tool calls are observable while the task runs —
 * that live stream is the whole reason this plugin exists rather than shelling
 * out to the agy-delegate skill's relay.mjs, whose `--print` transcript only
 * lands at the end.
 *
 * Flags and their guard rails mirror relay.mjs (the skill's hardened runner):
 * a fresh project by default, `--add-dir <cd>` so agy has an explicit workspace,
 * `--read-only` composed as `--sandbox --dangerously-skip-permissions`, and a
 * watchdog 60s past agy's own print timeout. What is deliberately NOT mirrored
 * here: the relay's git fingerprint / `touchedFiles` report and its lane
 * resolution. A reviewer that needs them runs the skill's relay instead.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createParser, findPermissionDenial, isPermissionDenial, permissionDenialMessage } from './parse.js';
import { defaultProjectsDir, findProjectForCwd } from './projects.js';

/** agy's own default print timeout, matching the relay. */
const DEFAULT_PRINT_TIMEOUT = '30m';
/** Grace the watchdog allows past agy's print timeout before it fells the tree. */
const WATCHDOG_GRACE_MS = 60_000;
/** Completed tasks the registry keeps for the widget's panel. */
const KEEP_FINISHED = 20;
/** Per-step text cap, so one runaway answer cannot pin the host's memory. */
const MAX_STEP_TEXT = 400_000;
/** Non-JSON log lines kept per task. */
const MAX_LOGS = 200;
/** Concurrent agy processes allowed. Each one is a full local agent run. */
export const DEFAULT_MAX_CONCURRENT = 4;

/**
 * The refusal message when the concurrency ceiling is reached, or null.
 * @param running - agy tasks currently running.
 * @param max - the configured ceiling.
 */
export function concurrencyRefusal(running, max) {
  if (running < max) return null;
  return `${running} agy tasks are already running (maxConcurrent ${max}); wait for one to settle with agy_task { action: "wait" }, `
    + 'or raise the plugin\'s maxConcurrent.';
}

/**
 * The outcome a finished run deserves.
 *
 * agy exits 0 and reports SUCCESS even when every tool it needed was auto-denied
 * — one of the user's own runs spent 89s, made 27 tool calls, changed nothing and
 * called itself done. A "done" is therefore only believed after the transcript
 * agrees: a refusal anywhere in it makes the run a failure with the actionable
 * reason attached.
 *
 * Pure, so the decision is unit tested against real captured transcripts.
 * @param outcome - the proposed status plus the folded steps and log lines.
 * @returns the final `{ status, error?, deniedTool? }`.
 */
export function settleOutcome({ status, steps, logs }) {
  if (status !== 'done') return { status };
  const denial = findPermissionDenial(steps, logs);
  if (denial === null) return { status: 'done' };
  return { status: 'failed', error: permissionDenialMessage(denial), deniedTool: denial.tool };
}

/** Bail out of the whole run when a duration cannot be parsed. */
function parseDuration(value, fallbackMs) {
  if (typeof value !== 'string' || value.trim() === '') return fallbackMs;
  const match = /^(\d+)(h|m|s)$/.exec(value.trim());
  if (match === null) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2];
  return unit === 'h' ? amount * 3_600_000 : unit === 'm' ? amount * 60_000 : amount * 1_000;
}

/** The run directory root for this install. */
export function runsRoot(home) {
  return join(home, 'agy-delegate', 'runs');
}

/**
 * Kill an agy process and everything it spawned. On Windows the child is not a
 * process-group leader, so `taskkill /t` is the only way to fell the tools agy
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

/** Trim a task's folded steps to what the widget actually renders. */
function projectSteps(steps) {
  return steps.map((step) => ({
    stepIndex: step.stepIndex,
    stepType: step.stepType,
    state: step.state,
    text: step.text.length > MAX_STEP_TEXT ? `${step.text.slice(0, MAX_STEP_TEXT)}\n… (truncated)` : step.text,
    thinking: step.thinking.length > MAX_STEP_TEXT ? step.thinking.slice(0, MAX_STEP_TEXT) : step.thinking,
    deltas: step.deltas,
    ...(step.toolName === undefined ? {} : { toolName: step.toolName }),
    ...(step.tool === undefined ? {} : { tool: step.tool }),
    ...(step.durationSeconds === undefined ? {} : { durationSeconds: step.durationSeconds }),
    ...(step.usage === undefined ? {} : { usage: step.usage }),
    ...(step.error === undefined ? {} : { error: step.error }),
  }));
}

/** The light row the widget's collapsed pill and task list need. */
export function taskRow(task) {
  return {
    id: task.id,
    status: task.status,
    brief: task.brief,
    cd: task.cd,
    model: task.model ?? null,
    effort: task.effort ?? null,
    readOnly: task.readOnly,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitCode: task.exitCode,
    conversationId: task.conversationId,
    projectId: task.projectId,
    projectName: task.projectName,
    reusedProject: task.reusedProject,
    stepCount: task.steps.length,
    toolCalls: task.steps.filter((step) => step.toolName !== undefined).length,
    answer: task.steps.filter((step) => step.stepType.includes('agent_response') && step.text !== '')
      .map((step) => step.text).join('\n').slice(0, 4_000),
    error: task.error,
  };
}

/**
 * Create the task registry.
 * @param options - install facts.
 * @param options.home - DSH home (run artifacts live under it).
 * @param options.agyPath - the agy executable.
 * @param options.log - host logger (optional).
 * @param options.maxConcurrent - concurrent agy ceiling (default 4).
 * @returns the registry.
 */
export function createRegistry({ home, agyPath, log, maxConcurrent, projectsDir, reuseProjects }) {
  /** @type {Map<string, object>} */
  const tasks = new Map();
  const ceiling = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : DEFAULT_MAX_CONCURRENT;
  const registryDir = projectsDir ?? defaultProjectsDir();
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

  /** Write the relay-shaped result.json for a finished task. */
  function writeResult(task) {
    const answer = task.result?.response ?? task.steps.filter((step) => step.stepType.includes('agent_response'))
      .map((step) => step.text).join('');
    if (answer !== '') writeFileSync(task.finalPath, answer, 'utf8');
    const payload = {
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      plugin: 'dsh-agy-delegate',
      taskId: task.id,
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
      usage: task.result?.usage ?? null,
      numTurns: task.result?.num_turns ?? null,
      toolCalls: task.steps.filter((step) => step.toolName !== undefined).length,
      logs: task.logs.slice(-20),
      error: task.error,
      // Deliberately absent: touchedFiles. The skill's relay fingerprints the
      // tree for it; run the relay when the review needs that report.
      artifacts: {
        brief: task.briefPath,
        events: task.eventsPath,
        final: existsSync(task.finalPath) ? task.finalPath : null,
        agyLog: existsSync(task.logPath) ? task.logPath : null,
        stderr: task.stderrPath,
        result: task.resultPath,
      },
    };
    writeFileSync(task.resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  /** Settle a task exactly once. */
  function finish(task, { status, exitCode, signal, error }) {
    if (task.status !== 'running') return;
    task.status = status;
    task.exitCode = exitCode ?? null;
    task.signal = signal ?? null;
    task.endedAt = Date.now();
    task.steps = projectSteps(task.parser.steps());
    task.logs = task.parser.logs().slice(-MAX_LOGS);
    task.result = task.parser.result();
    task.conversationId = task.parser.info().conversationId;
    // A fresh project's id is only in agy's own log (the `init` event carries
    // the conversation, not the project). Same pattern the skill's relay uses.
    if (task.projectId === null && existsSync(task.logPath)) {
      try {
        const created = /project: created project "[^"]*" \(id=([0-9a-f-]+)\)/iu.exec(readFileSync(task.logPath, 'utf8'));
        if (created !== null) task.projectId = created[1];
      } catch {
        // Observability only.
      }
    }
    task.error = error ?? task.error;
    if (task.watchdog !== undefined) {
      clearTimeout(task.watchdog);
      task.watchdog = undefined;
    }
    // agy exits 0 and reports SUCCESS even when every tool it needed was
    // auto-denied. Never call that done: read the transcript first.
    const settled = settleOutcome({ status: task.status, steps: task.steps, logs: task.logs });
    task.status = settled.status;
    if (settled.error !== undefined) {
      task.error ??= settled.error;
      task.deniedTool = settled.deniedTool;
    }
    if (task.status === 'failed' && task.error === undefined && task.logs.some((line) => line.includes('headless mode cannot prompt'))) {
      task.error = 'a tool needed a permission that headless agy cannot prompt for and it was auto-denied — '
        + 'allow the tool in agy settings, or re-run with dangerouslySkipPermissions (or readOnly for a sandboxed review).';
    }
    try {
      writeResult(task);
    } catch (writeError) {
      warn(`dsh-agy-delegate: writing result.json failed: ${String(writeError)}`);
    }
    running -= 1;
    prune();
  }

  /**
   * Start one agy task. Never throws for a spawn failure: it settles the task
   * as failed so the caller always gets an id back.
   * @param options - brief and dispatch flags.
   * @returns the task row.
   */
  function start(options) {
    const refusal = concurrencyRefusal(running, ceiling);
    if (refusal !== null) throw new Error(refusal);
    const id = `agy-${Date.now().toString(36)}-${(counter += 1)}`;
    const cd = resolve(options.cd);
    const runDir = join(runsRoot(home), id);
    mkdirSync(runDir, { recursive: true });

    const task = {
      id,
      brief: options.brief,
      cd,
      model: options.model ?? null,
      effort: options.effort ?? null,
      readOnly: options.readOnly === true,
      sandbox: options.sandbox === true,
      // Full access is the default: headless agy cannot answer a permission
      // prompt, so a run without this flag dies on the first tool that needs
      // one. Callers that pre-grant allow-rules pass false explicitly.
      skipPermissions: options.skipPermissions !== false,
      printTimeout: options.printTimeout ?? DEFAULT_PRINT_TIMEOUT,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      parser: createParser(),
      steps: [],
      logs: [],
      result: null,
      error: null,
      conversationId: null,
      projectId: null,
      projectName: null,
      reusedProject: false,
      runDir,
      briefPath: join(runDir, 'brief.txt'),
      eventsPath: join(runDir, 'events.jsonl'),
      finalPath: join(runDir, 'final.txt'),
      resultPath: join(runDir, 'result.json'),
      logPath: join(runDir, 'agy.log'),
      stderrPath: join(runDir, 'stderr.txt'),
    };
    tasks.set(id, task);
    writeFileSync(task.briefPath, options.brief, 'utf8');
    writeFileSync(task.stderrPath, '', 'utf8');
    writeFileSync(task.eventsPath, '', 'utf8');

    // Which agy project this run belongs to. A root that already has a project
    // is reused rather than spawning another one: repeated briefs against one
    // repository then share its history (and `--resume-last` keeps working),
    // instead of scattering the repo across a project per dispatch.
    const explicitProject = typeof options.project === 'string' && options.project !== '';
    const continuing = options.resumeLast === true || (typeof options.conversation === 'string' && options.conversation !== '');
    let projectId = explicitProject ? options.project : null;
    if (!explicitProject && options.newProject !== true && !continuing && options.reuseProjects !== false && reuseProjects !== false) {
      const existing = findProjectForCwd(cd, options.projectsDir ?? registryDir);
      if (existing !== null) {
        projectId = existing.id;
        task.projectId = existing.id;
        task.projectName = existing.name;
        task.reusedProject = true;
      }
    } else if (explicitProject) {
      task.projectId = projectId;
    }

    const args = [];
    if (projectId !== null) args.push('--project', projectId);
    if (typeof options.conversation === 'string' && options.conversation !== '') args.push('--conversation', options.conversation);
    if (options.resumeLast === true) args.push('--continue');
    if (projectId === null && !continuing) args.push('--new-project');
    args.push('--add-dir', cd);
    for (const dir of options.addDirs ?? []) args.push('--add-dir', isAbsolute(dir) ? dir : resolve(cd, dir));
    if (typeof options.model === 'string' && options.model !== '') args.push('--model', options.model);
    if (typeof options.effort === 'string' && options.effort !== '') args.push('--effort', options.effort);
    if (task.readOnly) args.push('--sandbox', '--dangerously-skip-permissions');
    else {
      if (task.sandbox) args.push('--sandbox');
      if (task.skipPermissions) args.push('--dangerously-skip-permissions');
    }
    if (typeof options.printTimeout === 'string' && options.printTimeout !== '') args.push('--print-timeout', options.printTimeout);
    args.push('--log-file', task.logPath);
    // The whole point of this plugin: NDJSON on stdout while the task runs
    // (init / step_update with text_delta, tool_info / result). Without it agy
    // prints its answer as plain text only when the run is already over.
    args.push('--output-format', 'stream-json');
    // `--print=<brief>` in one argv element: a multi-line brief and paths with
    // spaces survive without a shell.
    args.push(`--print=${options.brief}`);

    const record = (events) => {
      for (const event of events) {
        try {
          appendFileSync(task.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
        } catch {
          // Observability only; never fail a run over the event log.
        }
        if (event.kind === 'log') {
          task.logs.push(event.text);
          if (task.logs.length > MAX_LOGS) task.logs.shift();
        }
        // A refusal means this run cannot do its job, so stop it now instead of
        // letting agy spend minutes on tools that will all be denied too.
        if (event.kind === 'step' && event.step.toolName !== undefined
          && task.deniedTool === undefined && isPermissionDenial(event.step)) {
          task.deniedTool = event.step.toolName;
          task.denied = true;
          task.error = permissionDenialMessage({ tool: event.step.toolName, message: String(event.step.error?.message ?? '') });
          killTree(child);
        }
      }
    };

    running += 1;
    let child;
    try {
      child = spawn(agyPath, args, {
        cwd: cd,
        env: { ...process.env, PWD: cd },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (spawnError) {
      finish(task, { status: 'failed', error: `could not start agy: ${String(spawnError)}` });
      return taskRow(task);
    }
    task.child = child;
    task.pid = child.pid ?? null;

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) record(task.parser.push(line));
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

    task.watchdog = setTimeout(() => {
      if (settled) return;
      task.error = `timed out after ${task.printTimeout} plus ${WATCHDOG_GRACE_MS / 1_000}s grace; the process tree was killed.`;
      task.timedOut = true;
      killTree(child);
    }, parseDuration(task.printTimeout, parseDuration(DEFAULT_PRINT_TIMEOUT, 0)) + WATCHDOG_GRACE_MS);

    child.on('error', (spawnError) => {
      if (settled) return;
      settled = true;
      finish(task, { status: 'failed', error: `agy could not be run: ${String(spawnError)}` });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (stdoutBuffer !== '') record(task.parser.push(stdoutBuffer));
      const result = task.parser.result();
      const succeeded = code === 0 && result !== null && result.status === 'SUCCESS';
      finish(task, {
        status: task.timedOut === true ? 'timeout' : task.denied === true ? 'failed' : task.killed === true ? 'killed' : succeeded ? 'done' : 'failed',
        exitCode: code,
        signal,
        error: succeeded || task.error !== null ? task.error : describeFailure(result, code, signal),
      });
    });

    return taskRow(task);
  }

  /** A failure line that says what actually went wrong, not just the exit code. */
  function describeFailure(result, code, signal) {
    if (result !== null && typeof result.status === 'string' && result.status !== 'SUCCESS') {
      return `agy reported ${result.status}${result.error === undefined ? '' : `: ${String(result.error)}`}`;
    }
    if (signal !== null) return `agy exited on signal ${signal}`;
    return `agy exited with code ${code} before a result`;
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
        const row = taskRow(task);
        return { ...row, steps: projectSteps(task.parser.steps()), logs: task.logs.slice(-MAX_LOGS), info: task.parser.info() };
      }
      return { ...taskRow(task), steps: task.steps, logs: task.logs.slice(-MAX_LOGS), info: task.parser.info() };
    },

    /** Ask one task to stop; the tree is felled so agy's tools die with it. */
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
