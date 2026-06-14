import fs from "node:fs/promises";
import path from "node:path";
import { createId } from "../../utils.js";
import { assertBackendAdapterV2 } from "../backend-contract.js";

export function createOpenCodeBackendV2(config, dependencies = {}) {
  const options = normalizeOptions(config);
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const sessions = new Map();

  return assertBackendAdapterV2({
    configure(changes = {}) {
      if (changes.baseUrl) {
        options.baseUrl = String(changes.baseUrl).replace(/\/$/, "");
      }
      if (changes.directory !== undefined) {
        options.directory = String(changes.directory || "");
      }
      return { ...options };
    },

    async probeConnection() {
      const health = await requestJson(fetchImpl, options, "/global/health", { timeoutMs: 10000 });
      return {
        backend: "opencode",
        connected: health?.healthy !== false,
        version: health?.version || "",
        capabilities: {
          streaming: true,
          questions: true,
          permissions: true,
          interrupt: true,
          childInvocations: true,
          eventReplay: false,
          explicitCompletion: true,
          asyncPrompt: true
        }
      };
    },

    async listAgents() {
      const [payload, projectInfo] = await Promise.all([
        requestJson(fetchImpl, options, "/agent", { timeoutMs: 10000 }),
        readOpenCodeProjectInfo(options.directory)
      ]);
      return normalizeAgentList(payload, options, projectInfo);
    },

    async getProjectInfo() {
      return readOpenCodeProjectInfo(options.directory);
    },

    async listInvocations({ sessionId }) {
      const [children, statuses] = await Promise.all([
        requestJson(
          fetchImpl,
          options,
          `/session/${encodeURIComponent(sessionId)}/children`,
          { timeoutMs: 10000 }
        ).catch(() => []),
        requestJson(fetchImpl, options, "/session/status", { timeoutMs: 10000 }).catch(() => ({}))
      ]);
      return (Array.isArray(children) ? children : []).map((child) => {
        const childId = child.id || child.sessionID || child.sessionId || "";
        const statusType = String(statuses?.[childId]?.type || child.status?.type || child.status || "idle")
          .toLowerCase();
        const createdAt = openCodeTimeToIso(child.time?.created || child.time_created);
        const updatedAt = openCodeTimeToIso(child.time?.updated || child.time_updated) || createdAt;
        const running = ["busy", "running", "retry", "pending", "queued"].includes(statusType);
        return {
          id: childId,
          backendSessionId: childId,
          agentId: child.agent || agentFromChildTitle(child.title),
          title: String(child.title || "").replace(/\s*\(@[^)]+\s+subagent\)\s*$/i, ""),
          status: running ? "running" : "completed",
          createdAt,
          updatedAt,
          completedAt: running ? null : updatedAt
        };
      }).filter((invocation) => invocation.id && invocation.createdAt);
    },

    async createSession({ agentId, conversationId, title }) {
      const session = await createSession(fetchImpl, options, {
        title: title || `TeamRoom ${conversationId || "conversation"} / ${agentId}`
      });
      if (conversationId) {
        sessions.set(conversationId, session.id);
      }
      return session;
    },

    async resumeSession(sessionId) {
      const [session, statuses, children] = await Promise.all([
        requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}`, { timeoutMs: 10000 }),
        requestJson(fetchImpl, options, "/session/status", { timeoutMs: 10000 }),
        requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}/children`, { timeoutMs: 10000 })
          .catch(() => [])
      ]);
      return {
        session,
        status: statuses?.[sessionId] || { type: "unknown" },
        children: Array.isArray(children) ? children : []
      };
    },

    async sendMessage({ agentId, content, context = {}, hooks = {} }) {
      const sessionId = await ensureSession({
        fetchImpl,
        options,
        sessions,
        agentId,
        context
      });
      const clientMessageId = createId("msg");
      let eventResponse = await openEventStream(fetchImpl, options);
      await hooks.onSessionReady?.({
        sessionId,
        backendRunId: `${sessionId}:${clientMessageId}`
      });
      const tracker = new OpenCodeRunTracker({
        sessionId,
        agentId,
        hooks,
        onProgress: context.onProgress
      });

      await requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        timeoutMs: 10000,
        body: JSON.stringify(buildPromptBody(options, agentId, content, context))
      });

      const deadline = Date.now() + Math.max(options.timeoutMs, 30 * 60 * 1000);
      let reconnectDelayMs = 1000;
      while (Date.now() < deadline && !tracker.isTerminal()) {
        try {
          for await (const event of parseSseResponse(eventResponse)) {
            await tracker.accept(event, {
              answerPermission: (request, response) =>
                answerPermission(fetchImpl, options, request, response),
              answerQuestion: (request, response) =>
                answerQuestion(fetchImpl, options, request, response)
            });
            if (tracker.consumeCompletionCheck()) {
              await sleep(250);
              tracker.acceptCompletionSnapshot(
                await fetchSessionSnapshot(fetchImpl, options, sessionId)
              );
            }
            if (tracker.isTerminal()) {
              break;
            }
          }
        } finally {
          await eventResponse.body?.cancel().catch(() => {});
        }
        if (!tracker.isTerminal()) {
          const snapshot = await fetchSessionSnapshot(fetchImpl, options, sessionId);
          tracker.acceptSnapshot(snapshot);
        }
        if (!tracker.isTerminal() && Date.now() < deadline) {
          await sleep(reconnectDelayMs);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
          eventResponse = await openEventStream(fetchImpl, options);
        }
      }

      if (!tracker.isTerminal()) {
        const error = new Error(`OpenCode session did not reach an explicit terminal state: ${sessionId}`);
        error.statusCode = 504;
        throw error;
      }
      if (tracker.error) {
        throw new Error(`OpenCode session failed: ${tracker.error}`);
      }

      const summary = await fetchLatestAssistantText(fetchImpl, options, sessionId, agentId);
      return {
        backendSessionId: sessionId,
        backendRunId: `${sessionId}:${clientMessageId}`,
        status: tracker.status === "failed" ? "failed" : "completed",
        summary,
        artifacts: [],
        completionSource: tracker.completionSource
      };
    },

    async watchSession({ sessionId, agentId, hooks = {}, onProgress }) {
      const tracker = new OpenCodeRunTracker({ sessionId, agentId, hooks, onProgress });
      let eventResponse = await openEventStream(fetchImpl, options);
      const deadline = Date.now() + Math.max(options.timeoutMs, 30 * 60 * 1000);
      let reconnectDelayMs = 1000;
      while (Date.now() < deadline && !tracker.isTerminal()) {
        try {
          for await (const event of parseSseResponse(eventResponse)) {
            await tracker.accept(event, {
              answerPermission: (request, response) =>
                answerPermission(fetchImpl, options, request, response),
              answerQuestion: (request, response) =>
                answerQuestion(fetchImpl, options, request, response)
            });
            if (tracker.consumeCompletionCheck()) {
              await sleep(250);
              tracker.acceptCompletionSnapshot(
                await fetchSessionSnapshot(fetchImpl, options, sessionId)
              );
            }
            if (tracker.isTerminal()) break;
          }
        } finally {
          await eventResponse.body?.cancel().catch(() => {});
        }
        if (!tracker.isTerminal()) {
          tracker.acceptSnapshot(await fetchSessionSnapshot(fetchImpl, options, sessionId));
        }
        if (!tracker.isTerminal()) {
          await sleep(reconnectDelayMs);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
          eventResponse = await openEventStream(fetchImpl, options);
        }
      }
      if (!tracker.isTerminal()) {
        throw new Error(`OpenCode session recovery timed out: ${sessionId}`);
      }
      return {
        backendSessionId: sessionId,
        backendRunId: sessionId,
        status: tracker.status === "failed" ? "failed" : "completed",
        summary: await fetchLatestAssistantText(fetchImpl, options, sessionId, agentId),
        artifacts: [],
        completionSource: tracker.completionSource
      };
    },

    async sendIntervention({ sessionId, agentId, content, context = {} }) {
      await requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        timeoutMs: 10000,
        body: JSON.stringify(buildPromptBody(options, agentId, content, {
          ...context,
          intervention: true
        }))
      });
      return { delivered: true, sessionId };
    },

    async getSnapshot({ sessionId }) {
      return fetchSessionSnapshot(fetchImpl, options, sessionId);
    },

    async interrupt({ sessionId }) {
      return requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}/abort`, {
        method: "POST",
        timeoutMs: 10000
      });
    },

    async answerQuestion(input) {
      return answerQuestion(fetchImpl, options, input.request, input.response);
    },

    async answerPermission(input) {
      return answerPermission(fetchImpl, options, input.request, input.response);
    },

    async reconnect() {
      return this.probeConnection();
    }
  });
}

export class OpenCodeRunTracker {
  constructor({ sessionId, agentId, hooks = {}, onProgress }) {
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.hooks = hooks;
    this.onProgress = onProgress;
    this.status = "running";
    this.completionSource = null;
    this.error = null;
    this.compacting = false;
    this.lastText = "";
    this.handledRequests = new Set();
    this.parentIdle = false;
    this.completionCheckPending = false;
    this.activeChildSessions = new Set();
  }

  isTerminal() {
    return ["completed", "failed", "cancelled"].includes(this.status);
  }

  consumeCompletionCheck() {
    const pending = this.completionCheckPending;
    this.completionCheckPending = false;
    return pending;
  }

  async accept(rawEvent, responders = {}) {
    const event = unwrapEvent(rawEvent);
    const properties = event.properties || {};
    const sessionId = eventSessionId(event);
    const isChildSession = sessionId && this.activeChildSessions.has(sessionId);
    if (sessionId && sessionId !== this.sessionId && !isChildSession) {
      return;
    }

    if (event.type === "message.part.updated") {
      await this.acceptPart(properties.part || properties, properties.delta);
      return;
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      const info = properties.info || {};
      if (info.parentID === this.sessionId && info.id) {
        this.activeChildSessions.add(info.id);
      }
      if (info.parentID === this.sessionId && typeof this.hooks.onInvocationEvent === "function") {
        await this.hooks.onInvocationEvent({
          type: event.type === "session.created" ? "v2.invocation.started" : "v2.invocation.updated",
          sessionId: info.id,
          parentRunId: this.sessionId,
          agentId: info.agent || "",
          session: info
        });
      }
      if (info.id === this.sessionId && info.time?.compacting) {
        this.compacting = true;
      }
      return;
    }
    if (event.type === "session.compacting") {
      this.compacting = true;
      return;
    }
    if (event.type === "session.compacted") {
      this.compacting = false;
      return;
    }
    if (event.type === "permission.asked" || event.type === "permission.updated") {
      await this.handlePermission(properties, responders.answerPermission);
      return;
    }
    if (event.type === "question.asked" || event.type === "question.updated") {
      await this.handleQuestion(properties, responders.answerQuestion);
      return;
    }
    if (event.type === "session.error") {
      if (isChildSession) {
        this.activeChildSessions.delete(sessionId);
        await this.hooks.onInvocationEvent?.({
          type: "v2.invocation.failed",
          sessionId,
          parentRunId: this.sessionId,
          agentId: properties.info?.agent || "",
          error: eventError(properties)
        });
        return;
      }
      this.status = "failed";
      this.error = eventError(properties) || "Unknown OpenCode session error";
      this.completionSource = event.type;
      return;
    }
    if (event.type === "session.idle") {
      if (isChildSession) {
        this.activeChildSessions.delete(sessionId);
        await this.hooks.onInvocationEvent?.({
          type: "v2.invocation.completed",
          sessionId,
          parentRunId: this.sessionId,
          agentId: properties.info?.agent || ""
        });
        return;
      }
      if (!this.compacting) {
        this.parentIdle = true;
        this.completionCheckPending = true;
      }
      return;
    }
    if (event.type === "session.status") {
      const status = String(properties.status?.type || properties.type || "").toLowerCase();
      if (isChildSession) {
        if (status === "idle") {
          this.activeChildSessions.delete(sessionId);
        }
        return;
      }
      if (status === "idle" && !this.compacting) {
        this.parentIdle = true;
        this.completionCheckPending = true;
      } else if (status && status !== "unknown") {
        this.parentIdle = false;
      }
    }
  }

  acceptSnapshot(snapshot = {}) {
    const status = String(snapshot.status?.type || snapshot.status || "").toLowerCase();
    if (status === "idle" && !this.compacting && !hasActiveChildren(snapshot)) {
      this.status = "completed";
      this.completionSource = "session.status:snapshot";
    }
  }

  acceptCompletionSnapshot(snapshot = {}) {
    if (!this.parentIdle || this.compacting || hasActiveChildren(snapshot)) {
      return;
    }
    this.status = "completed";
    this.completionSource = "session.idle:verified";
  }

  async acceptPart(part = {}, delta = "") {
    if (part.sessionID && part.sessionID !== this.sessionId) {
      return;
    }
    if (part.type === "text") {
      this.parentIdle = false;
      const text = String(delta || part.text || "");
      if (!text || (!delta && text === this.lastText)) {
        return;
      }
      this.lastText = delta ? `${this.lastText}${delta}` : text;
      await emitProgress(this.onProgress, {
        text,
        append: Boolean(delta),
        state: "running"
      });
      return;
    }
    if (part.type === "tool") {
      const toolStatus = String(part.state?.status || "").toLowerCase();
      if (["pending", "running"].includes(toolStatus)) {
        this.parentIdle = false;
      }
      if (part.tool === "task" && typeof this.hooks.onInvocationEvent === "function") {
        const invocation = normalizeTaskInvocation(part, this.sessionId);
        await this.hooks.onInvocationEvent({
          type: invocationEventType(toolStatus),
          ...invocation,
          part
        });
      }
      return;
    }
    if (part.type === "compaction") {
      this.compacting = true;
      return;
    }
    if (part.type === "subtask" && typeof this.hooks.onInvocationEvent === "function") {
      await this.hooks.onInvocationEvent({
        type: "v2.invocation.updated",
        sessionId: this.sessionId,
        agentId: part.agent || part.agentID || "",
        part
      });
    }
  }

  async handlePermission(properties, responder) {
    const request = normalizePermissionRequest(properties, this.agentId, this.sessionId);
    if (!request.id || typeof this.hooks.onApprovalRequest !== "function" || typeof responder !== "function") {
      return;
    }
    if (this.handledRequests.has(`permission:${request.id}`)) {
      return;
    }
    this.handledRequests.add(`permission:${request.id}`);
    const response = await this.hooks.onApprovalRequest(request);
    await responder(request, response);
  }

  async handleQuestion(properties, responder) {
    const request = normalizeQuestionRequest(properties, this.agentId, this.sessionId);
    if (!request.id || typeof this.hooks.onApprovalRequest !== "function" || typeof responder !== "function") {
      return;
    }
    if (this.handledRequests.has(`question:${request.id}`)) {
      return;
    }
    this.handledRequests.add(`question:${request.id}`);
    const response = await this.hooks.onApprovalRequest(request);
    await responder(request, response);
  }
}

export async function* parseSseResponse(response) {
  if (!response.ok) {
    throw new Error(`OpenCode event stream failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let boundary = buffer.match(/\r?\n\r?\n/);
      while (boundary?.index !== undefined) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          try {
            yield JSON.parse(data);
          } catch {
            // Ignore heartbeat or non-JSON event data.
          }
        }
        boundary = buffer.match(/\r?\n\r?\n/);
      }
      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function ensureSession({ fetchImpl, options, sessions, agentId, context }) {
  const cached = context.backendSessionId || sessions.get(context.conversationId);
  if (cached) {
    sessions.set(context.conversationId, cached);
    return cached;
  }
  const session = await createSession(fetchImpl, options, {
    title: `TeamRoom ${context.roomId || "room"} / ${agentId}`
  });
  sessions.set(context.conversationId, session.id);
  return session.id;
}

async function createSession(fetchImpl, options, body) {
  const payload = await requestJson(fetchImpl, options, "/session", {
    method: "POST",
    body: JSON.stringify(body)
  });
  const id = payload?.id || payload?.sessionID || payload?.data?.id;
  if (!id) {
    throw new Error("OpenCode session.create returned no session id");
  }
  return { ...payload, id };
}

async function openEventStream(fetchImpl, options) {
  return fetchImpl(buildUrl(options, "/event"), {
    headers: authHeaders(options)
  });
}

async function fetchSessionSnapshot(fetchImpl, options, sessionId) {
  const [session, statuses, children, messages] = await Promise.all([
    requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}`, { timeoutMs: 10000 }),
    requestJson(fetchImpl, options, "/session/status", { timeoutMs: 10000 }),
    requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}/children`, { timeoutMs: 10000 })
      .catch(() => []),
    requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}/message`, { timeoutMs: 10000 })
      .catch(() => [])
  ]);
  return {
    session,
    status: statuses?.[sessionId] || { type: "unknown" },
    statuses: statuses || {},
    children: Array.isArray(children) ? children : [],
    messages: Array.isArray(messages) ? messages : []
  };
}

function hasActiveChildren(snapshot = {}) {
  const statuses = snapshot.statuses || {};
  return (snapshot.children || []).some((child) => {
    const childId = child?.id || child?.sessionID || child?.sessionId;
    const status = String(
      statuses?.[childId]?.type
      || statuses?.[childId]
      || child?.status?.type
      || child?.status
      || ""
    ).toLowerCase();
    return ["busy", "running", "retry", "pending", "queued"].includes(status);
  });
}

async function fetchLatestAssistantText(fetchImpl, options, sessionId, agentId) {
  const messages = await requestJson(fetchImpl, options, `/session/${encodeURIComponent(sessionId)}/message`, {
    timeoutMs: 10000
  });
  if (!Array.isArray(messages)) {
    return extractText(messages);
  }
  for (const message of [...messages].reverse()) {
    const info = message?.info || {};
    if (info.role === "assistant" && (!agentId || !info.agent || info.agent === agentId)) {
      const text = extractText(message);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

async function answerPermission(fetchImpl, options, request, response = {}) {
  const reply = normalizePermissionReply(response);
  return requestJson(
    fetchImpl,
    options,
    `/session/${encodeURIComponent(request.sessionId)}/permissions/${encodeURIComponent(request.id)}`,
    {
      method: "POST",
      timeoutMs: 10000,
      body: JSON.stringify({
        response: reply,
        remember: reply === "always"
      })
    }
  );
}

async function answerQuestion(fetchImpl, options, request, response = {}) {
  if (response.reply === "reject" || response.cancelled) {
    return requestJson(fetchImpl, options, `/question/${encodeURIComponent(request.id)}/reject`, {
      method: "POST",
      timeoutMs: 10000
    });
  }
  return requestJson(fetchImpl, options, `/question/${encodeURIComponent(request.id)}/reply`, {
    method: "POST",
    timeoutMs: 10000,
    body: JSON.stringify({ answers: response.answers || [] })
  });
}

async function requestJson(fetchImpl, options, apiPath, request = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs || options.timeoutMs);
  try {
    const response = await fetchImpl(buildUrl(options, apiPath), {
      method: request.method || "GET",
      headers: {
        ...authHeaders(options),
        ...(request.body ? { "content-type": "application/json" } : {})
      },
      body: request.body,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenCode request failed: ${request.method || "GET"} ${apiPath} ${response.status}${text ? ` - ${text}` : ""}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPromptBody(options, agentId, content, context) {
  const body = {
    agent: agentId,
    parts: [{
      type: "text",
      text: content,
      metadata: {
        teamroom: {
          roomId: context.roomId,
          runId: context.runId,
          conversationId: context.conversationId
        }
      }
    }]
  };
  const model = modelParts(options);
  if (model) {
    body.model = model;
  }
  if (options.variant) {
    body.variant = options.variant;
  }
  return body;
}

function normalizeOptions(config) {
  const opencode = config.opencode || {};
  return {
    baseUrl: String(opencode.baseUrl || "http://127.0.0.1:4096").replace(/\/$/, ""),
    username: opencode.username || "opencode",
    password: opencode.password || "",
    token: opencode.token || "",
    directory: opencode.directory || "",
    provider: opencode.provider || "",
    model: opencode.model || "",
    variant: opencode.variant || "",
    timeoutMs: Number(opencode.timeoutMs || 180000),
    includeHiddenAgents: Boolean(opencode.includeHiddenAgents)
  };
}

async function readOpenCodeProjectInfo(directory) {
  const workspace = String(directory || "").trim();
  if (!workspace) {
    return { defaultAgentId: "", agents: {}, source: "none" };
  }
  const info = {
    defaultAgentId: "",
    agents: {},
    source: workspace
  };

  try {
    const rawConfig = await fs.readFile(path.join(workspace, "opencode.json"), "utf8");
    const config = JSON.parse(rawConfig);
    info.defaultAgentId = String(config.default_agent || config.defaultAgent || "").trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      info.configError = error.message;
    }
  }

  try {
    const agentsDir = path.join(workspace, ".opencode", "agents");
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const id = entry.name.replace(/\.md$/i, "");
        const raw = await fs.readFile(path.join(agentsDir, entry.name), "utf8");
        const frontmatter = parseFrontmatter(raw);
        info.agents[id] = {
          id,
          description: frontmatter.description || "",
          mode: frontmatter.mode || "",
          source: "opencode_agent_file"
        };
      }));
  } catch (error) {
    if (error.code !== "ENOENT") {
      info.agentsError = error.message;
    }
  }

  return info;
}

function parseFrontmatter(markdown) {
  const match = String(markdown || "").match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!match) {
    return {};
  }
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    result[item[1]] = item[2].trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

function normalizeAgentList(payload, options, projectInfo = {}) {
  const agents = Array.isArray(payload) ? payload : Object.values(payload || {});
  const normalized = agents
    .filter((agent) => options.includeHiddenAgents || !agent?.hidden)
    .map((agent) => enrichAgentWithProjectInfo({
      id: agent.id || agent.name,
      name: agent.name || agent.id,
      description: agent.description || "",
      roles: Array.isArray(agent.roles) ? agent.roles : [],
      capabilities: Array.isArray(agent.capabilities || agent.tags) ? agent.capabilities || agent.tags : []
    }, projectInfo))
    .filter((agent) => agent.id);

  const knownIds = new Set(normalized.map((agent) => agent.id));
  for (const projectAgent of Object.values(projectInfo.agents || {})) {
    if (!knownIds.has(projectAgent.id)) {
      normalized.push(enrichAgentWithProjectInfo({
        id: projectAgent.id,
        name: projectAgent.id,
        description: projectAgent.description || "",
        roles: [],
        capabilities: []
      }, projectInfo));
    }
  }
  return normalized;
}

function enrichAgentWithProjectInfo(agent, projectInfo = {}) {
  const id = agent.id || agent.agentId || "";
  const projectAgent = projectInfo.agents?.[id] || {};
  const isDefaultAgent = Boolean(projectInfo.defaultAgentId && id === projectInfo.defaultAgentId);
  const isPrimaryAgent = String(projectAgent.mode || "").toLowerCase() === "primary";
  const roles = new Set(agent.roles || []);
  if (isDefaultAgent || isPrimaryAgent) {
    roles.add("main");
    roles.add("primary");
  }
  if (projectAgent.mode) {
    roles.add(projectAgent.mode);
  }
  return {
    ...agent,
    description: agent.description || projectAgent.description || "",
    roles: [...roles],
    opencodeMode: projectAgent.mode || "",
    isDefaultAgent,
    isPrimaryAgent,
    defaultAgentSource: isDefaultAgent
      ? "opencode.json"
      : isPrimaryAgent
        ? ".opencode/agents"
        : ""
  };
}

function normalizePermissionRequest(properties, agentId, sessionId) {
  const permission = properties.permission || properties;
  return {
    id: permission.id || properties.id || "",
    externalId: permission.id || properties.id || "",
    type: "permission",
    sessionId: permission.sessionID || properties.sessionID || sessionId,
    agentId,
    title: `OpenCode 请求执行 ${permission.permission || permission.type || "受限操作"}`,
    details: permission.pattern || permission.patterns?.join("\n") || "",
    permission: permission.permission || permission.type || "",
    patterns: permission.patterns || (permission.pattern ? [permission.pattern] : []),
    canAlwaysAllow: true
  };
}

function normalizeQuestionRequest(properties, agentId, sessionId) {
  const question = properties.question || properties;
  return {
    id: question.id || properties.id || "",
    externalId: question.id || properties.id || "",
    type: "question",
    sessionId: question.sessionID || properties.sessionID || sessionId,
    agentId,
    title: "OpenCode 请求人工回答",
    details: "",
    questions: Array.isArray(question.questions) ? question.questions : []
  };
}

function normalizeTaskInvocation(part, parentSessionId) {
  const output = String(part.state?.output || "");
  const childSessionId = output.match(/<task\s+id=["']([^"']+)["']/i)?.[1] || "";
  return {
    invocationId: part.callID || part.id || childSessionId,
    sessionId: childSessionId,
    parentRunId: parentSessionId,
    agentId: part.state?.input?.subagent_type || part.agent || part.agentID || "",
    title: part.state?.input?.description || ""
  };
}

function invocationEventType(status) {
  if (status === "completed") {
    return "v2.invocation.completed";
  }
  if (status === "error" || status === "failed") {
    return "v2.invocation.failed";
  }
  if (status === "pending" || status === "running") {
    return "v2.invocation.started";
  }
  return "v2.invocation.updated";
}

function openCodeTimeToIso(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string" && Number.isNaN(Number(value))) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  const numeric = Number(value);
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function agentFromChildTitle(title) {
  return String(title || "").match(/\(@([^\s)]+)\s+subagent\)/i)?.[1] || "";
}

function unwrapEvent(rawEvent) {
  return rawEvent?.payload?.type
    ? rawEvent.payload
    : rawEvent?.event?.type
      ? rawEvent.event
      : rawEvent || {};
}

function eventSessionId(event) {
  const properties = event.properties || {};
  return properties.sessionID
    || properties.sessionId
    || properties.info?.sessionID
    || properties.part?.sessionID
    || properties.permission?.sessionID
    || properties.question?.sessionID
    || "";
}

function eventError(properties) {
  const error = properties.error || properties;
  return typeof error === "string" ? error : error?.message || error?.name || "";
}

function extractText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload.text === "string") return payload.text;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  return parts.filter((part) => part?.type === "text" && part.text).map((part) => part.text).join("\n");
}

function normalizePermissionReply(response = {}) {
  const reply = String(response.reply || response.response || "").toLowerCase();
  if (["once", "always", "reject"].includes(reply)) {
    return reply;
  }
  return response.cancelled || response.approved === false ? "reject" : "once";
}

function modelParts(options) {
  if (options.provider && options.model) {
    return { providerID: options.provider, modelID: options.model };
  }
  if (options.model.includes("/")) {
    const [providerID, ...modelID] = options.model.split("/");
    return { providerID, modelID: modelID.join("/") };
  }
  return null;
}

function buildUrl(options, apiPath) {
  const url = new URL(apiPath, `${options.baseUrl}/`);
  if (options.directory) {
    url.searchParams.set("directory", options.directory);
  }
  return url;
}

function authHeaders(options) {
  if (options.password) {
    return {
      authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`
    };
  }
  return options.token ? { authorization: `Bearer ${options.token}` } : {};
}

async function emitProgress(handler, progress) {
  if (typeof handler === "function") {
    await Promise.resolve(handler(progress));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
