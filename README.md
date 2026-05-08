# OpenClaw TeamRoom

中文说明请见 [README-CN.md](README-CN.md)。

OpenClaw TeamRoom is a lightweight multi-agent collaboration cockpit for OpenClaw-style agent workspaces. It is not the domain agent itself and not a full chat product. It sits above a Supervisor agent and specialist agents so users can create a room, add agents, publish a task, observe dispatch, watch specialist execution, and review the final handoff.

The project is intentionally small for company intranet deployment:

- no Docker requirement
- no database service
- no Next.js runtime
- no external npm dependencies for the MVP
- static web UI served by the same Node process
- replaceable OpenClaw adapter

## Why This Exists

Single agents are easy to start but hard to coordinate once a task needs domain decomposition, specialist execution, review, and human confirmation. A plain group chat helps humans see messages, but it does not define who owns decomposition, how work is routed, how state is tracked, or when review is required.

By default, TeamRoom treats a Supervisor-led collaboration as:

```text
Room + Supervisor + Specialist Agents + Dynamic Task Graph + Event Stream
```

The default policy is `supervisor`: the task first goes to the Supervisor, the Supervisor returns a machine-readable dispatch plan, TeamRoom executes the requested specialist stages, and the final results go back to the Supervisor for review.

Tasks in the same room share context. TeamRoom injects summaries from completed room tasks into later prompts. In OpenClaw Gateway mode, the same room and agent also reuse the same OpenClaw chat session.

A room can have only one current task at a time. While a task is queued, running, failed, or interrupted, new task creation is blocked. The user can terminate the current task, or send a chat message such as "continue" to resume from the first unfinished stage.

## Quick Start

Requirements:

- Node.js 22 or later

Run the local mock version:

```bash
npm start
```

Open:

```text
http://127.0.0.1:8787
```

The default mock adapter exposes four demo agents:

- supervisor-agent
- frontend-agent
- backend-agent
- reviewer-agent

## Connect To Your Local OpenClaw

If you already have OpenClaw running locally and want TeamRoom to use your existing OpenClaw agents, start TeamRoom with the OpenClaw Gateway adapter.

1. Enter this project directory:

```bash
cd xxx/multi_agent
```

2. Start TeamRoom with your own port, OpenClaw address, and OpenClaw token:

```bash
TEAMROOM_PORT=<choose-a-4-digit-port-for-teamroom> \
TEAMROOM_ADAPTER=openclaw-gateway \
OPENCLAW_BASE_URL=<your-openclaw-url> \
OPENCLAW_TOKEN='<your-openclaw-token>' \
npm start
```

Example:

```bash
TEAMROOM_PORT=8786 \
TEAMROOM_ADAPTER=openclaw-gateway \
OPENCLAW_BASE_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN='replace-with-your-token' \
npm start
```

Then open:

```text
http://127.0.0.1:<your-teamroom-port>
```

For example, if `TEAMROOM_PORT=8786`, open:

```text
http://127.0.0.1:8786
```

## OpenClaw Integration Shape

The implementation has a narrow adapter boundary:

```text
TeamRoom core
  -> adapter.listAgents()
  -> adapter.runAgent(agentId, input, context)
```

For a real OpenClaw deployment, implement those two calls in `src/adapters/openclaw-http.js` or mount the core from an OpenClaw native plugin. The rest of the room, policy, state, and UI code stays unchanged.

## Agent Profiles

The Agents list supports local tags for existing OpenClaw agents. TeamRoom does not modify the OpenClaw agent itself; it stores a local profile in `data/teamroom.json`:

```json
{
  "roles": ["supervisor", "leader"],
  "capabilities": ["dimension", "model"]
}
```

Profiles are used for UI display, room member metadata, Supervisor dispatch prompts, and generic capability routing modes.

## Configuration Workbench

The top-level `配置` button opens a dedicated configuration workbench:

- OpenClaw agent files: view and edit `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `MEMORY.md` for each agent workspace.
- TeamRoom collaboration templates: configure Supervisor dispatch, Specialist work, Supervisor review, previous-output handoff, room-history formatting, and human-message formatting per room.

By default, agent workspaces are discovered under `~/.openclaw`, such as `workspace-agent_1`. Set `OPENCLAW_WORKSPACE_ROOT` to point elsewhere. Before writing an agent file, TeamRoom backs up the previous file under `data/openclaw-file-backups/`.

## Runtime Modes

Mock mode:

```bash
TEAMROOM_ADAPTER=mock npm start
```

Generic HTTP adapter mode:

```bash
TEAMROOM_ADAPTER=openclaw-http \
OPENCLAW_BASE_URL=http://127.0.0.1:3000 \
npm start
```

OpenClaw Gateway RPC mode:

```bash
TEAMROOM_ADAPTER=openclaw-gateway \
OPENCLAW_BASE_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN=your-openclaw-token \
npm start
```

Use this mode when your OpenClaw address opens the OpenClaw Control UI. It connects through the same WebSocket Gateway RPC used by Control UI and calls methods such as `agents.list`, `chat.send`, and `chat.history`.

OpenClaw Gateway OpenAI-compatible mode:

```bash
TEAMROOM_ADAPTER=openclaw-responses \
OPENCLAW_BASE_URL=http://127.0.0.1:3000 \
npm start
```

This mode discovers existing OpenClaw agents from `/v1/models`, then runs a selected agent through `/v1/responses` using the model name `openclaw/<agentId>`.

Useful environment variables:

```text
TEAMROOM_HOST=127.0.0.1
TEAMROOM_PORT=8787
TEAMROOM_DATA_FILE=./data/teamroom.json
TEAMROOM_TOKEN=optional-shared-token
TEAMROOM_ADAPTER=mock | openclaw-gateway | openclaw-http | openclaw-responses
OPENCLAW_BASE_URL=http://127.0.0.1:3000
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_DEVICE_FILE=./data/openclaw-device.json
OPENCLAW_WORKSPACE_ROOT=~/.openclaw
OPENCLAW_AGENT_FILE_BACKUP_DIR=./data/openclaw-file-backups
OPENCLAW_AGENTS_PATH=/api/agents
OPENCLAW_RUN_PATH=/api/agents/:agentId/runs
OPENCLAW_MODELS_PATH=/v1/models
OPENCLAW_RESPONSES_PATH=/v1/responses
OPENCLAW_TOKEN=optional-openclaw-token
OPENCLAW_PASSWORD=optional-openclaw-password
```

If `TEAMROOM_TOKEN` is set, API requests must send:

```text
Authorization: Bearer <token>
```

## API

```text
GET    /health
GET    /api/agents
PUT    /api/agents/:agentId/profile
DELETE /api/agents/:agentId/profile
GET    /api/rooms
POST   /api/rooms
GET    /api/rooms/:roomId
DELETE /api/rooms/:roomId
POST   /api/rooms/:roomId/members
DELETE /api/rooms/:roomId/members/:agentId
POST   /api/rooms/:roomId/messages
POST   /api/rooms/:roomId/tasks
POST   /api/rooms/:roomId/tasks/:taskId/cancel
GET    /api/rooms/:roomId/events
GET    /api/config/prompt-templates
GET    /api/openclaw/agents/:agentId/files
PUT    /api/openclaw/agents/:agentId/files/:fileName
```

Example task:

```bash
curl -X POST http://127.0.0.1:8787/api/rooms/<roomId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"goal":"Build a lightweight visual multi-agent collaboration panel"}'
```

## Documents

- [Architecture](docs/architecture.md)
- [Policy Design](docs/policy-design.md)
- [Connect To OpenClaw](docs/connect-openclaw.md)
- [Chatbot Comparison](docs/chatbot-comparison.md)
- [Example Config](examples/teamroom.yaml)

## Project Layout

```text
public/                 Static UI
src/
  adapters/             OpenClaw and mock adapters
  plugin/               Native plugin mounting sketch
  config.js             Runtime config
  events.js             In-process SSE hub
  orchestrator.js       Task graph execution
  policy.js             Agent selection strategies
  server.js             HTTP API and static server
  store.js              JSON state store
docs/                   Design docs
examples/               Example room policy
data/                   Local state
```

## Design Principle

Keep the collaboration model reusable:

```text
TeamRoom owns process visibility.
Supervisor owns business decomposition.
Specialist agents own bounded domain execution.
```

That makes TeamRoom useful as an internal pattern, not just a one-off tool.
