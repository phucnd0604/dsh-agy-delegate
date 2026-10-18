# lib — plugin runtime

The DSH plugin that carries a brief to a coding CLI as a background task and surfaces that task as agent tools, loopback routes, and a floating browser widget.

## Language

**Backend**:
A coding CLI that takes a brief and works in its own conversation. This plugin ships two: `agy` and `opencode`, and is built to take more.
_Avoid_: provider, engine, runner

**Brief**:
The self-contained text handed to a backend. A backend sees no chat history, so the brief carries the goal, the current state, the constraints, the gate commands, and the report contract.
_Avoid_: prompt, instructions, message

**Task**:
One dispatched brief, tracked as a registry row with its own status and live transcript.
_Avoid_: run, job, session

**Dispatch**:
To start a task from a brief — the act that creates the row and spawns the backend.
_Avoid_: launch, submit, enqueue

**Implementer**:
The backend acting on a brief. It edits the working tree and never commits.
_Avoid_: worker, subagent

**Orchestrator**:
The agent that writes the brief, reviews the implementer's work, and lands the commit.
_Avoid_: delegator, caller

**Widget**:
The floating browser overlay that renders live tasks, one row per task.
_Avoid_: panel, dashboard
**Backend adapter**:
The per-CLI module that turns a task into an argv, parses that CLI's event stream into steps, and declares its capabilities.
_Avoid_: driver, plugin, integration

**Transcript**:
The ordered, backend-agnostic record of one task: thinking, answer, tool calls, session id, cost, logs.
_Avoid_: log, output, stream

**Step**:
One entry in a transcript.
_Avoid_: event, message, chunk

**Capability**:
A flag a backend adapter declares about itself — `modelRequired`, `modelList`, `readOnly` mapping, `resume` kinds, `auto` — so the core never hard-codes one CLI's quirks.
_Avoid_: feature, flag
