# Connect To Existing OpenClaw Agents

TeamRoom starts in mock mode by default. To connect it to real OpenClaw agents, switch the adapter.

## Option 1: OpenClaw Control Gateway RPC

Use this when your OpenClaw address opens the OpenClaw Control UI, for example:

```text
http://127.0.0.1:18789/
```

Start TeamRoom:

```bash
TEAMROOM_ADAPTER=openclaw-gateway \
OPENCLAW_BASE_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN=your-openclaw-token \
npm start
```

This adapter connects to:

```text
ws://127.0.0.1:18789
```

and calls Gateway RPC methods:

```text
agents.list
chat.send
chat.history
```

If your Gateway URL is different from `OPENCLAW_BASE_URL`, set it explicitly:

```bash
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
```

The adapter creates a stable device identity at:

```text
data/openclaw-device.json
```

Keep this file if OpenClaw requires device pairing or approval.

If you see:

```text
gateway token missing
```

copy the token from OpenClaw Control UI's access/settings area and pass it as `OPENCLAW_TOKEN`.

## Option 2: OpenAI-Compatible Gateway

Use this when your OpenClaw Gateway exposes:

```text
GET  /v1/models
POST /v1/responses
```

Start TeamRoom:

```bash
TEAMROOM_ADAPTER=openclaw-responses \
OPENCLAW_BASE_URL=http://127.0.0.1:3000 \
npm start
```

If OpenClaw requires a token:

```bash
TEAMROOM_ADAPTER=openclaw-responses \
OPENCLAW_BASE_URL=http://127.0.0.1:3000 \
OPENCLAW_TOKEN=your-openclaw-token \
npm start
```

Discovery works by reading model IDs such as:

```text
openclaw/default
openclaw/frontend-agent
openclaw/reviewer-agent
```

TeamRoom displays them as:

```text
default
frontend-agent
reviewer-agent
```

When a task stage is assigned to `frontend-agent`, TeamRoom calls `/v1/responses` with:

```json
{
  "model": "openclaw/frontend-agent",
  "input": "..."
}
```

## Option 3: Custom OpenClaw HTTP API

Use this when your OpenClaw deployment exposes custom endpoints for listing and running agents.

Start TeamRoom:

```bash
TEAMROOM_ADAPTER=openclaw-http \
OPENCLAW_BASE_URL=http://127.0.0.1:3000 \
OPENCLAW_AGENTS_PATH=/api/agents \
OPENCLAW_RUN_PATH=/api/agents/:agentId/runs \
npm start
```

Expected list response shapes:

```json
[
  {
    "id": "frontend-agent",
    "name": "Frontend Agent",
    "capabilities": ["frontend", "ui", "coding"]
  }
]
```

or:

```json
{
  "agents": [
    {
      "id": "frontend-agent",
      "name": "Frontend Agent"
    }
  ]
}
```

Run requests are sent as:

```json
{
  "agentId": "frontend-agent",
  "input": "...",
  "context": {
    "roomId": "...",
    "taskId": "...",
    "stageId": "...",
    "stageType": "implementation"
  }
}
```

## Quick Verification

Check OpenClaw discovery:

```bash
curl http://127.0.0.1:3000/v1/models
```

Then start TeamRoom with `TEAMROOM_ADAPTER=openclaw-responses` and open:

```text
http://127.0.0.1:8787
```

The left-side agent list should show your existing OpenClaw agents instead of the mock agents.
