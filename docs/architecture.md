# Architecture

OpenClaw TeamRoom is a small control plane for multi-agent collaboration. It does not try to become a full chat product or replace the domain Supervisor agent. It provides just enough UI, state, routing, and policy logic to make Supervisor-led agent work observable and manageable.

## Goals

- Run in a company intranet without Docker.
- Keep deployment to one Node process and static files.
- Avoid external database services.
- Keep OpenClaw-specific integration behind a small adapter.
- Support a Supervisor-led default flow plus optional generic routing strategies.
- Make every agent action visible as an event.

## Non-Goals

- Full user account system.
- Long-term knowledge base.
- Heavy attachment management.
- Rich product chat features.
- Replacing OpenClaw's agent runtime.
- Taking over domain decomposition from the Supervisor agent.

## Components

```text
Browser UI
  |
  | HTTP + SSE
  v
TeamRoom Server
  |
  +-- Room API
  +-- Policy Engine
  +-- Orchestrator
  +-- Event Hub
  +-- JSON Store
  |
  v
OpenClaw Adapter
  |
  v
OpenClaw Agents
```

For the implementation-design assistant project, TeamRoom sits above the existing Supervisor and specialist agents:

```text
Implementation BA / User
  -> TeamRoom cockpit
  -> Supervisor agent
  -> Dimension/Model, Form, Permission, Rules, Integration agents
  -> Skills and deterministic tools
  -> Delivery artifacts
```

## Core Objects

### Room

A room is the collaboration boundary. It contains members, a policy, tasks, and an event stream.

```json
{
  "id": "room_abc",
  "name": "Engineering Room",
  "policy": {
    "mode": "supervisor",
    "requireReview": true,
    "maxParallel": 2,
    "fallbackDispatch": "none",
    "roomContextLimit": 6,
    "taskMessageLimit": 12,
    "supervisorExtraPrompt": "",
    "specialistExtraPrompt": "",
    "reviewExtraPrompt": "",
    "promptTemplates": {
      "supervisorDispatch": "...",
      "specialistWork": "...",
      "supervisorReview": "...",
      "previousOutputItem": "...",
      "roomContextItem": "...",
      "taskMessageItem": "..."
    }
  },
  "members": []
}
```

### Agent Member

An agent member is an OpenClaw agent plus room-local metadata.

```json
{
  "agentId": "agent_1",
  "name": "Supervisor Agent",
  "roles": ["supervisor", "leader"],
  "capabilities": ["supervisor", "analysis", "planning"],
  "maxConcurrentTasks": 1
}
```

The same OpenClaw agent can appear in different rooms with different room-local roles.

Rooms are also the context boundary. Completed task summaries in the same room are injected into later task prompts. For the OpenClaw Gateway adapter, session keys are room-scoped per agent, so the same agent keeps a continuous OpenClaw chat history inside a room.

### Task

A task is the user goal plus the generated task graph.

```json
{
  "id": "task_abc",
  "roomId": "room_abc",
  "goal": "Build a visual multi-agent panel",
  "status": "running",
  "stages": []
}
```

### Stage

A stage is the schedulable unit in the task graph.

```json
{
  "id": "stage_abc",
  "type": "specialist_work",
  "title": "Form impact analysis",
  "needs": ["form"],
  "assignedAgentId": "agent_3",
  "status": "running"
}
```

### Event

Events are append-only records shown in the UI and persisted in the JSON store.

```json
{
  "id": "evt_abc",
  "roomId": "room_abc",
  "taskId": "task_abc",
  "type": "stage.completed",
  "timestamp": "2026-05-06T08:00:00.000Z",
  "payload": {}
}
```

## Request Flow

```text
User submits task
  -> server creates task
  -> orchestrator sends dispatch stage to Supervisor
  -> Supervisor returns a machine-readable collaboration plan
  -> orchestrator creates specialist stages from that plan
  -> adapter runs assigned specialist agents
  -> Supervisor reviews all returned results
  -> event hub pushes state through SSE
  -> store persists room, task, and event state
```

## Adapter Boundary

The adapter intentionally has only two required methods:

```js
await adapter.listAgents()
await adapter.runAgent(agentId, input, context)
```

This keeps the TeamRoom core independent from OpenClaw version details. A native plugin can call OpenClaw APIs directly; the standalone server can call OpenClaw over HTTP.

## State

The MVP uses a single JSON file:

```text
data/teamroom.json
```

This is enough for intranet demos, small teams, and internal sharing. If the deployment later needs stronger concurrency or audit trails, the store can be replaced with SQLite without changing policy or UI logic.

## Realtime Updates

The UI subscribes to:

```text
GET /api/rooms/:roomId/events
```

The endpoint uses Server-Sent Events because it is simple, proxy-friendly, and sufficient for one-way status updates.

## Security Model

For the lightweight intranet version:

- bind to `127.0.0.1` by default
- optional shared bearer token
- no cookies
- no user database
- no destructive OpenClaw action without explicit adapter support

For company deployment, put the service behind an internal reverse proxy or SSO gateway if needed.

## Native Plugin Path

The preferred long-term shape is:

```text
OpenClaw native plugin
  -> registers /teamroom static UI
  -> registers /teamroom/api routes
  -> calls OpenClaw agent runtime in-process
```

The current code also runs standalone so it can be tested and shared without requiring every teammate to install or rebuild OpenClaw.
