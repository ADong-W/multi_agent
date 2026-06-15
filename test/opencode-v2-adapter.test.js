import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOpenCodeBackendV2,
  OpenCodeRunTracker,
  parseSseResponse
} from "../src/v2/adapters/opencode.js";

test("OpenCode agents are enriched from opencode.json default_agent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-opencode-agents-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, ".opencode", "agents"), { recursive: true });
  await fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify({
    default_agent: "fox-supervisor-agent"
  }));
  await fs.writeFile(path.join(directory, ".opencode", "agents", "fox-supervisor-agent.md"), [
    "---",
    "description: \"总控 Agent\"",
    "mode: primary",
    "---",
    "",
    "# Supervisor"
  ].join("\n"));
  await fs.writeFile(path.join(directory, ".opencode", "agents", "form-agent.md"), [
    "---",
    "description: \"表单 Agent\"",
    "mode: subagent",
    "---"
  ].join("\n"));

  const backend = createOpenCodeBackendV2({
    opencode: {
      baseUrl: "http://opencode.test",
      directory
    }
  }, {
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/agent") {
        return jsonResponse([
          { id: "fox-supervisor-agent", name: "Fox Supervisor" },
          { id: "form-agent", name: "Form Agent" }
        ]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }
  });

  const agents = await backend.listAgents();
  const supervisor = agents.find((agent) => agent.id === "fox-supervisor-agent");
  const form = agents.find((agent) => agent.id === "form-agent");
  assert.equal(supervisor.isDefaultAgent, true);
  assert.equal(supervisor.isPrimaryAgent, true);
  assert.equal(supervisor.defaultAgentSource, "opencode.json");
  assert.ok(supervisor.roles.includes("main"));
  assert.equal(form.isDefaultAgent, false);
  assert.equal(form.opencodeMode, "subagent");
});

test("OpenCode V2 uses SSE plus prompt_async and waits for explicit idle", async () => {
  const calls = [];
  const encoder = new TextEncoder();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method || "GET"} ${url.pathname}`);
    if (url.pathname === "/event") {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}`,
            "",
            `data: ${JSON.stringify({
              payload: {
                type: "message.part.updated",
                properties: {
                  part: {
                    id: "part_1",
                    sessionID: "session_1",
                    messageID: "assistant_1",
                    type: "text",
                    text: "处理中"
                  }
                }
              }
            })}`,
            "",
            `data: ${JSON.stringify({
              payload: {
                type: "session.idle",
                properties: { sessionID: "session_1" }
              }
            })}`,
            "",
            ""
          ].join("\n")));
          controller.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    if (url.pathname === "/session" && (init.method || "GET") === "POST") {
      return jsonResponse({ id: "session_1" });
    }
    if (url.pathname === "/session/session_1/prompt_async") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/session_1" && (init.method || "GET") === "GET") {
      return jsonResponse({ id: "session_1" });
    }
    if (url.pathname === "/session/status") {
      return jsonResponse({ session_1: { type: "idle" } });
    }
    if (url.pathname === "/session/session_1/children") {
      return jsonResponse([]);
    }
    if (url.pathname === "/session/session_1/message") {
      return jsonResponse([{
        info: { id: "assistant_1", role: "assistant", agent: "main-agent" },
        parts: [{ type: "text", text: "最终回答" }]
      }]);
    }
    throw new Error(`Unexpected request: ${init.method || "GET"} ${url.pathname}`);
  };
  const adapter = createOpenCodeBackendV2({
    adapter: "opencode",
    opencode: {
      baseUrl: "http://opencode.test",
      timeoutMs: 1000
    }
  }, { fetch: fetchImpl });
  const progress = [];
  const sessions = [];

  const result = await adapter.sendMessage({
    agentId: "main-agent",
    content: "直接回答",
    context: {
      roomId: "room_1",
      runId: "run_1",
      conversationId: "conversation_1",
      onProgress: (item) => progress.push(item)
    },
    hooks: {
      onSessionReady: (item) => sessions.push(item)
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary, "最终回答");
  assert.equal(result.completionSource, "session.idle:verified");
  assert.equal(sessions[0].sessionId, "session_1");
  assert.equal(progress[0].text, "处理中");
  assert.ok(calls.indexOf("GET /event") < calls.indexOf("POST /session/session_1/prompt_async"));
});

test("OpenCode text output does not complete a run before session idle", async () => {
  const progress = [];
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_1",
    agentId: "main-agent",
    onProgress: (item) => progress.push(item)
  });

  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        sessionID: "session_1",
        text: "正在处理"
      }
    }
  });

  assert.equal(tracker.isTerminal(), false);
  assert.equal(progress.length, 1);

  await tracker.accept({
    type: "session.idle",
    properties: { sessionID: "session_1" }
  });
  tracker.acceptCompletionSnapshot({
    status: { type: "idle" },
    statuses: { session_1: { type: "idle" } },
    children: []
  });
  assert.equal(tracker.isTerminal(), true);
  assert.equal(tracker.completionSource, "session.idle:verified");
});

test("OpenCode compaction cannot be mistaken for completion", async () => {
  const states = [];
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_1",
    agentId: "main-agent",
    onProgress: (item) => states.push(item.state)
  });

  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part_compaction",
        sessionID: "session_1",
        messageID: "message_1",
        type: "compaction",
        auto: true
      }
    }
  });
  await tracker.accept({
    type: "session.idle",
    properties: { sessionID: "session_1" }
  });
  assert.equal(tracker.isTerminal(), false);

  await tracker.accept({
    type: "session.compacted",
    properties: { sessionID: "session_1" }
  });
  assert.equal(tracker.isTerminal(), false);
  await tracker.accept({
    type: "session.status",
    properties: { sessionID: "session_1", status: { type: "idle" } }
  });
  tracker.acceptCompletionSnapshot({
    status: { type: "idle" },
    statuses: { session_1: { type: "idle" } },
    children: []
  });
  assert.equal(tracker.isTerminal(), true);
  assert.deepEqual(states, []);
});

test("parent idle does not finish while an OpenCode child session is busy", async () => {
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_parent",
    agentId: "main-agent"
  });

  await tracker.accept({
    type: "session.created",
    properties: {
      info: {
        id: "session_child",
        parentID: "session_parent",
        agent: "form-agent"
      }
    }
  });
  await tracker.accept({
    type: "session.idle",
    properties: { sessionID: "session_parent" }
  });
  tracker.acceptCompletionSnapshot({
    status: { type: "idle" },
    statuses: {
      session_parent: { type: "idle" },
      session_child: { type: "busy" }
    },
    children: [{ id: "session_child" }]
  });
  assert.equal(tracker.isTerminal(), false);

  await tracker.accept({
    type: "session.idle",
    properties: { sessionID: "session_child" }
  });
  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        sessionID: "session_parent",
        text: "已汇总子 Agent 结果"
      }
    }
  });
  await tracker.accept({
    type: "session.idle",
    properties: { sessionID: "session_parent" }
  });
  tracker.acceptCompletionSnapshot({
    status: { type: "idle" },
    statuses: { session_parent: { type: "idle" } },
    children: [{ id: "session_child" }]
  });

  assert.equal(tracker.isTerminal(), true);
  assert.equal(tracker.completionSource, "session.idle:verified");
});

test("OpenCode tool parts stay internal while assistant text remains visible", async () => {
  const progress = [];
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_1",
    agentId: "main-agent",
    onProgress: (item) => progress.push(item)
  });

  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "skill",
        sessionID: "session_1",
        state: { status: "running" }
      }
    }
  });
  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        sessionID: "session_1",
        text: "这是返回给用户的文字"
      }
    }
  });

  assert.deepEqual(progress, [{
    text: "这是返回给用户的文字",
    append: false,
    state: "running"
  }]);
});

test("OpenCode task tool parts are projected as child agent invocations", async () => {
  const invocations = [];
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_parent",
    agentId: "main-agent",
    hooks: {
      onInvocationEvent: (event) => invocations.push(event)
    }
  });

  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "task",
        callID: "call_child_1",
        sessionID: "session_parent",
        state: {
          status: "running",
          input: {
            description: "检查表单影响",
            subagent_type: "form-agent"
          }
        }
      }
    }
  });
  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "task",
        callID: "call_child_1",
        sessionID: "session_parent",
        state: {
          status: "completed",
          input: {
            description: "检查表单影响",
            subagent_type: "form-agent"
          },
          output: "<task id=\"session_child_1\" state=\"completed\">done</task>"
        }
      }
    }
  });

  assert.deepEqual(invocations.map((item) => item.type), [
    "v2.invocation.started",
    "v2.invocation.completed"
  ]);
  assert.equal(invocations[1].invocationId, "call_child_1");
  assert.equal(invocations[1].sessionId, "session_child_1");
  assert.equal(invocations[1].agentId, "form-agent");
  assert.equal(invocations[1].title, "检查表单影响");
});

test("OpenCode child sessions can backfill historical invocation records", async () => {
  const backend = createOpenCodeBackendV2({
    opencode: { baseUrl: "http://127.0.0.1:4096" }
  }, {
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/session/session_parent/children") {
        return jsonResponse([{
          id: "session_child",
          title: "检查表单影响 (@form-agent subagent)",
          agent: "form-agent",
          time: {
            created: 1781352430000,
            updated: 1781352490000
          }
        }]);
      }
      if (pathname === "/session/status") {
        return jsonResponse({ session_child: { type: "idle" } });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }
  });

  const invocations = await backend.listInvocations({ sessionId: "session_parent" });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].agentId, "form-agent");
  assert.equal(invocations[0].title, "检查表单影响");
  assert.equal(invocations[0].status, "completed");
  assert.equal(invocations[0].createdAt, "2026-06-13T12:07:10.000Z");
});

test("OpenCode child sessions are projected as native invocations", async () => {
  const invocations = [];
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_parent",
    agentId: "main-agent",
    hooks: {
      async onInvocationEvent(event) {
        invocations.push(event);
      }
    }
  });
  await tracker.accept({
    type: "session.created",
    properties: {
      info: {
        id: "session_child",
        parentID: "session_parent",
        title: "form-agent"
      }
    }
  });
  await tracker.accept({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part_subtask",
        sessionID: "session_parent",
        messageID: "message_1",
        type: "subtask",
        agent: "form-agent",
        description: "检查表单"
      }
    }
  });

  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].type, "v2.invocation.started");
  assert.equal(invocations[0].sessionId, "session_child");
  assert.equal(invocations[1].agentId, "form-agent");
});

test("OpenCode permission requests are answered once by original request id", async () => {
  const requested = [];
  const answered = [];
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_1",
    agentId: "main-agent",
    hooks: {
      async onApprovalRequest(request) {
        requested.push(request);
        return { reply: "once" };
      }
    }
  });
  const event = {
    type: "permission.asked",
    properties: {
      id: "permission_1",
      sessionID: "session_1",
      permission: "read",
      patterns: ["working/*.xlsx"]
    }
  };
  const responders = {
    async answerPermission(request, response) {
      answered.push({ request, response });
    }
  };

  await tracker.accept(event, responders);
  await tracker.accept(event, responders);

  assert.equal(requested.length, 1);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].request.id, "permission_1");
});

test("OpenCode permission requests preserve command and target context", async () => {
  const requested = [];
  const tracker = new OpenCodeRunTracker({
    sessionId: "session_1",
    agentId: "main-agent",
    hooks: {
      async onApprovalRequest(request) {
        requested.push(request);
        return { reply: "once" };
      }
    }
  });
  const event = {
    type: "permission.asked",
    properties: {
      id: "permission_2",
      sessionID: "session_1",
      permission: "bash",
      tool: "shell",
      command: "npm test",
      path: "/repo",
      patterns: ["test/*.js"]
    }
  };

  await tracker.accept(event, {
    async answerPermission() {}
  });

  assert.equal(requested.length, 1);
  assert.equal(requested[0].permission, "bash");
  assert.equal(requested[0].toolName, "shell");
  assert.equal(requested[0].command, "npm test");
  assert.equal(requested[0].target, "/repo");
  assert.deepEqual(requested[0].patterns, ["test/*.js"]);
  assert.match(requested[0].summary, /shell/);
});

test("SSE parser accepts CRLF and ignores non-JSON heartbeat data", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("event: server.connected\r\ndata: {\"type\":\"server.connected\"}\r\n\r\n"));
      controller.enqueue(encoder.encode(": heartbeat\r\n\r\n"));
      controller.enqueue(encoder.encode("data: {\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"session_1\"}}\n\n"));
      controller.close();
    }
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
  const events = [];
  for await (const event of parseSseResponse(response)) {
    events.push(event);
  }

  assert.deepEqual(events.map((event) => event.type), ["server.connected", "session.idle"]);
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
