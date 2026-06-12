export function createOpenCodeAdapter(config) {
  const options = normalizeOptions(config);
  const sessions = new Map();

  return {
    async listAgents() {
      const payload = await requestJson(options, "/agent");
      const agents = normalizeAgentList(payload, options);
      return dedupeAgents(agents).sort((a, b) => a.id.localeCompare(b.id));
    },

    async runAgent(agentId, input, context = {}, hooks = {}) {
      const sessionId = await ensureSession({ options, sessions, agentId, context });
      const handledRuntimeRequests = new Set();
      let messageSettled = false;
      let watcherError = null;
      const watcher = watchRuntimeRequests({
        options,
        sessionId,
        agentId,
        hooks,
        handled: handledRuntimeRequests,
        isDone: () => messageSettled
      }).catch((error) => {
        watcherError = error;
      });

      let response = await requestJson(options, `/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        timeoutMs: Math.max(options.timeoutMs, 30 * 60 * 1000),
        body: JSON.stringify(buildPromptBody({ options, agentId, input, context }))
      }).finally(async () => {
        messageSettled = true;
        await watcher;
      });

      if (watcherError) {
        throw watcherError;
      }

      response = await waitForAssistantCompletion({
        options,
        sessionId,
        agentId,
        initial: response,
        hooks,
        handled: handledRuntimeRequests,
        onProgress: context.onProgress
      });

      const agentError = extractMessageError(response);
      if (agentError) {
        throw new Error(`OpenCode agent error: ${agentError}`);
      }

      const summary = extractResponseText(response) || await fetchLatestAssistantText(options, sessionId, agentId);
      await emitProgress(context.onProgress, summary, false, "final");
      return {
        status: "completed",
        summary: summary || "OpenCode agent completed the run, but no assistant text was found.",
        artifacts: [],
        nextActions: []
      };
    },

    async getLatestResult(agentId, context = {}) {
      const sessionId = sessions.get(sessionKeyFor(options, agentId, context));
      if (!sessionId) {
        return null;
      }
      const summary = await fetchLatestAssistantText(options, sessionId, agentId);
      if (!summary) {
        return null;
      }
      return {
        status: "completed",
        summary,
        artifacts: [],
        nextActions: []
      };
    },

    async reconnect() {
      sessions.clear();
      const startedAt = Date.now();
      const payload = await requestJson(options, "/agent");
      return {
        status: "connected",
        mode: "opencode",
        agents: normalizeAgentList(payload, options).length,
        elapsedMs: Date.now() - startedAt
      };
    },

    async resetConnection() {
      sessions.clear();
    }
  };
}

async function watchRuntimeRequests({ options, sessionId, agentId, hooks, handled, isDone }) {
  while (!isDone()) {
    await handlePendingPermissions({ options, sessionId, agentId, hooks, handled });
    await handlePendingQuestions({ options, sessionId, agentId, hooks, handled });
    await sleep(1000);
  }
}

async function waitForAssistantCompletion({ options, sessionId, agentId, initial, hooks, handled, onProgress }) {
  let latest = initial;
  let lastProgress = "";
  const messageId = assistantMessageId(initial);
  const deadline = Date.now() + Math.max(options.timeoutMs, 30 * 60 * 1000);
  while (Date.now() < deadline) {
    await handlePendingPermissions({ options, sessionId, agentId, hooks, handled });
    await handlePendingQuestions({ options, sessionId, agentId, hooks, handled });

    const refreshed = messageId
      ? await fetchAssistantMessage(options, sessionId, messageId).catch(() => null)
      : await fetchLatestAssistantPayload(options, sessionId, agentId).catch(() => null);
    if (refreshed) {
      latest = refreshed;
    }
    const progressText = extractResponseText(latest);
    if (progressText && progressText !== lastProgress) {
      lastProgress = progressText;
      await emitProgress(onProgress, progressText, false, "running");
    }

    if (isAssistantComplete(latest)) {
      return latest;
    }
    await sleep(1000);
  }
  return latest;
}

async function emitProgress(onProgress, text, append = false, state = "") {
  if (typeof onProgress !== "function" || !String(text || "").trim()) {
    return;
  }
  await Promise.resolve(onProgress({
    text: String(text),
    append,
    state
  })).catch(() => {});
}

function assistantMessageId(payload) {
  return payload?.info?.id
    || payload?.message?.id
    || payload?.result?.info?.id
    || payload?.data?.info?.id
    || "";
}

async function fetchAssistantMessage(options, sessionId, messageId) {
  return requestJson(options, `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`, {
    timeoutMs: 10000
  });
}

async function fetchLatestAssistantPayload(options, sessionId, agentId) {
  const payload = await requestJson(options, `/session/${encodeURIComponent(sessionId)}/message`, {
    timeoutMs: 10000
  });
  if (!Array.isArray(payload)) {
    return payload;
  }
  return [...payload].reverse().find((message) => {
    const info = message?.info || message?.message || {};
    return info.role === "assistant" && (!agentId || !info.agent || info.agent === agentId);
  }) || null;
}

function isAssistantComplete(payload) {
  if (!payload) {
    return false;
  }
  const info = payload.info || payload.message || payload.result?.info || payload.data?.info || {};
  if (extractMessageError(payload)) {
    return true;
  }
  if (info.time?.completed || info.completedAt || info.finish || info.finish_reason) {
    return true;
  }
  if (info.id && info.role === "assistant" && info.time?.created) {
    return false;
  }
  const text = extractResponseText(payload);
  if (text && !hasRunningToolPart(payload)) {
    return true;
  }
  return false;
}

function hasRunningToolPart(payload) {
  const parts = Array.isArray(payload?.parts)
    ? payload.parts
    : Array.isArray(payload?.message?.parts)
      ? payload.message.parts
      : [];
  return parts.some((part) => {
    const status = String(part?.state?.status || part?.status || "").toLowerCase();
    return ["pending", "running", "queued"].includes(status);
  });
}

async function handlePendingPermissions({ options, sessionId, agentId, hooks, handled }) {
  const permissions = await listOpenCodePermissions(options);
  for (const permission of permissions) {
    if (!permission || permission.sessionID !== sessionId) {
      continue;
    }
    const key = `permission:${permission.id}`;
    if (handled.has(key)) {
      continue;
    }
    handled.add(key);
    if (typeof hooks.onApprovalRequest !== "function") {
      throw new Error(`OpenCode requested permission ${permission.permission || permission.id}, but TeamRoom approval bridge is unavailable.`);
    }
    const response = await hooks.onApprovalRequest(normalizePermissionApproval(permission, agentId));
    await replyOpenCodePermission(options, permission, response);
  }
}

async function handlePendingQuestions({ options, sessionId, agentId, hooks, handled }) {
  const questions = await listOpenCodeQuestions(options);
  for (const question of questions) {
    if (!question || question.sessionID !== sessionId) {
      continue;
    }
    const key = `question:${question.id}`;
    if (handled.has(key)) {
      continue;
    }
    handled.add(key);
    if (typeof hooks.onApprovalRequest !== "function") {
      throw new Error(`OpenCode asked a question ${question.id}, but TeamRoom approval bridge is unavailable.`);
    }
    const response = await hooks.onApprovalRequest(normalizeQuestionApproval(question, agentId));
    await replyOpenCodeQuestion(options, question, response);
  }
}

async function listOpenCodePermissions(options) {
  const payload = await requestJson(options, "/permission", { timeoutMs: 10000 }).catch((error) => {
    if (/404/.test(error.message || "")) {
      return [];
    }
    throw error;
  });
  return Array.isArray(payload) ? payload : [];
}

async function listOpenCodeQuestions(options) {
  const payload = await requestJson(options, "/question", { timeoutMs: 10000 }).catch((error) => {
    if (/404/.test(error.message || "")) {
      return [];
    }
    throw error;
  });
  return Array.isArray(payload) ? payload : [];
}

function normalizePermissionApproval(permission, agentId) {
  const patterns = Array.isArray(permission.patterns) ? permission.patterns.map(String) : [];
  const permissionName = permission.permission || "permission";
  return {
    type: "permission",
    id: permission.id,
    sessionId: permission.sessionID,
    agentId,
    title: `OpenCode 请求确认 ${permissionName}`,
    details: patterns.length
      ? patterns.join("\n")
      : `OpenCode agent ${agentId} 请求执行 ${permissionName}`,
    permission: permissionName,
    patterns,
    canAlwaysAllow: Array.isArray(permission.always) && permission.always.length > 0,
    tool: permission.tool || null,
    raw: permission
  };
}

function normalizeQuestionApproval(question, agentId) {
  return {
    type: "question",
    id: question.id,
    sessionId: question.sessionID,
    agentId,
    title: "OpenCode 请求人工回答",
    details: `${agentId} 正在等待补充信息。`,
    questions: Array.isArray(question.questions) ? question.questions : [],
    tool: question.tool || null,
    raw: question
  };
}

async function replyOpenCodePermission(options, permission, response = {}) {
  const reply = normalizePermissionReply(response);
  try {
    await requestJson(options, `/permission/${encodeURIComponent(permission.id)}/reply`, {
      method: "POST",
      timeoutMs: 10000,
      body: JSON.stringify({
        reply,
        ...(response.message ? { message: String(response.message) } : {})
      })
    });
    return;
  } catch (error) {
    if (/404/.test(error.message || "")) {
      await requestJson(options, `/session/${encodeURIComponent(permission.sessionID)}/permissions/${encodeURIComponent(permission.id)}`, {
        method: "POST",
        timeoutMs: 10000,
        body: JSON.stringify({ response: reply })
      });
      return;
    }
    throw error;
  }
}

async function replyOpenCodeQuestion(options, question, response = {}) {
  if (response.reply === "reject" || response.cancelled) {
    await requestJson(options, `/question/${encodeURIComponent(question.id)}/reject`, {
      method: "POST",
      timeoutMs: 10000
    }).catch((error) => {
      if (!/404/.test(error.message || "")) {
        throw error;
      }
    });
    return;
  }
  const answers = normalizeQuestionAnswers(response.answers, question);
  await requestJson(options, `/question/${encodeURIComponent(question.id)}/reply`, {
    method: "POST",
    timeoutMs: 10000,
    body: JSON.stringify({ answers })
  });
}

function normalizePermissionReply(response = {}) {
  const reply = String(response.reply || response.response || "").trim().toLowerCase();
  if (["once", "always", "reject"].includes(reply)) {
    return reply;
  }
  if (response.cancelled || response.approved === false) {
    return "reject";
  }
  return "once";
}

function normalizeQuestionAnswers(answers, question) {
  const questionCount = Array.isArray(question.questions) ? question.questions.length : 0;
  const normalized = Array.isArray(answers)
    ? answers.map((item) => Array.isArray(item)
      ? item.map(String).filter(Boolean)
      : [String(item)].filter(Boolean))
    : [];
  while (normalized.length < questionCount) {
    normalized.push([]);
  }
  return normalized;
}

function normalizeOptions(config) {
  const opencode = config.opencode || {};
  return {
    baseUrl: String(opencode.baseUrl || "http://127.0.0.1:4096").replace(/\/$/, ""),
    token: opencode.token || "",
    directory: opencode.directory || "",
    workspace: opencode.workspace || "",
    provider: opencode.provider || "",
    model: opencode.model || "",
    variant: opencode.variant || "",
    timeoutMs: Number(opencode.timeoutMs || 180000),
    sessionStrategy: opencode.sessionStrategy || "per-agent-room",
    includeHiddenAgents: Boolean(opencode.includeHiddenAgents)
  };
}

function normalizeAgentList(payload, options) {
  const items = Array.isArray(payload)
    ? payload.map((agent) => [agent?.id || agent?.name, agent])
    : Object.entries(payload?.agents || payload?.data || payload || {});

  return items
    .filter(([, agent]) => options.includeHiddenAgents || !agent?.hidden)
    .map(([id, agent]) => normalizeAgent(agent, id))
    .filter(Boolean);
}

function normalizeAgent(agent, idHint) {
  if (!agent) {
    return null;
  }

  if (typeof agent === "string") {
    return {
      id: agent,
      name: agent,
      roles: inferRoles(agent),
      capabilities: inferCapabilities(agent)
    };
  }

  const id = agent.id || agent.agentId || agent.name || idHint;
  if (!id) {
    return null;
  }

  const name = agent.name || agent.displayName || id;
  const text = [
    id,
    name,
    agent.description || "",
    agent.prompt || "",
    Array.isArray(agent.tags) ? agent.tags.join(" ") : ""
  ].join(" ");

  return {
    id,
    name,
    description: agent.description || "",
    roles: normalizeStringArray(agent.roles).concat(inferRoles(text)),
    capabilities: normalizeStringArray(agent.capabilities || agent.tags).concat(inferCapabilities(text))
  };
}

function dedupeAgents(agents) {
  const byId = new Map();
  for (const agent of agents) {
    byId.set(agent.id, {
      ...agent,
      roles: [...new Set(agent.roles || [])],
      capabilities: [...new Set(agent.capabilities || [])]
    });
  }
  return [...byId.values()];
}

async function ensureSession({ options, sessions, agentId, context }) {
  const key = sessionKeyFor(options, agentId, context);
  const cached = sessions.get(key);
  if (cached) {
    return cached;
  }

  const body = {
    title: sessionTitleFor(agentId, context),
    agent: agentId
  };
  const sessionModel = sessionModelFor(options);
  if (sessionModel) {
    body.model = sessionModel;
  }

  const payload = await requestJson(options, "/session", {
    method: "POST",
    body: JSON.stringify(body)
  });
  const sessionId = payload?.id || payload?.sessionID || payload?.session?.id || payload?.data?.id;
  if (!sessionId) {
    throw new Error(`OpenCode session.create returned no session id: ${JSON.stringify(payload)}`);
  }

  sessions.set(key, sessionId);
  return sessionId;
}

function buildPromptBody({ options, agentId, input, context }) {
  const body = {
    agent: agentId,
    parts: [{
      type: "text",
      text: input,
      metadata: {
        teamroom: {
          roomId: context.roomId,
          taskId: context.taskId,
          stageId: context.stageId,
          stageType: context.stageType
        }
      }
    }]
  };

  const model = messageModelFor(options);
  if (model) {
    body.model = model;
  }
  if (options.variant) {
    body.variant = options.variant;
  }
  return body;
}

async function requestJson(options, path, request = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(request.timeoutMs || options.timeoutMs);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildUrl(options, path), {
      method: request.method || "GET",
      headers: {
        ...authHeaders(options),
        ...jsonHeaders(request.body),
        ...(request.headers || {})
      },
      body: request.body,
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenCode request failed: ${request.method || "GET"} ${path} ${response.status} ${response.statusText} ${text}`);
    }
    if (!text) {
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return JSON.parse(text);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenCode request timed out: ${request.method || "GET"} ${path}`);
    }
    if (error?.message === "fetch failed") {
      throw new Error(`OpenCode request failed: cannot connect to ${options.baseUrl}. Please start opencode serve first.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(options, path) {
  const url = new URL(path, `${options.baseUrl}/`);
  if (options.directory) {
    url.searchParams.set("directory", options.directory);
  }
  if (options.workspace) {
    url.searchParams.set("workspace", options.workspace);
  }
  return url;
}

function authHeaders(options) {
  return options.token
    ? { authorization: `Bearer ${options.token}` }
    : {};
}

function jsonHeaders(body) {
  return body
    ? { "content-type": "application/json" }
    : {};
}

async function fetchLatestAssistantText(options, sessionId, agentId) {
  const payload = await requestJson(options, `/session/${encodeURIComponent(sessionId)}/message`);
  if (!Array.isArray(payload)) {
    return extractResponseText(payload);
  }

  for (const message of [...payload].reverse()) {
    const info = message?.info || message?.message || {};
    if (info.role === "assistant" && (!agentId || !info.agent || info.agent === agentId)) {
      const text = extractResponseText(message);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function extractResponseText(payload) {
  if (!payload) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.content === "string") {
    return payload.content;
  }
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }
  if (typeof payload.summary === "string") {
    return payload.summary;
  }
  if (payload.info?.structured) {
    return JSON.stringify(payload.info.structured, null, 2);
  }
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .map(extractPartText)
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(payload.messages)) {
    return payload.messages
      .map(extractResponseText)
      .filter(Boolean)
      .join("\n");
  }
  if (payload.message) {
    return extractResponseText(payload.message);
  }
  if (payload.result) {
    return extractResponseText(payload.result);
  }
  return "";
}

function extractPartText(part) {
  if (!part) {
    return "";
  }
  if (typeof part === "string") {
    return part;
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (typeof part.content === "string") {
    return part.content;
  }
  if (part.type === "text" && typeof part.value === "string") {
    return part.value;
  }
  return "";
}

function extractMessageError(payload) {
  const error = payload?.info?.error || payload?.error;
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || error.name || JSON.stringify(error);
}

function sessionKeyFor(options, agentId, context) {
  if (options.sessionStrategy === "per-task") {
    return `${context.roomId || "roomless"}:${context.taskId || "taskless"}:${agentId}`;
  }
  if (options.sessionStrategy === "per-stage") {
    return `${context.roomId || "roomless"}:${context.taskId || "taskless"}:${context.stageId || "stageless"}:${agentId}`;
  }
  return `${context.roomId || "roomless"}:${agentId}`;
}

function sessionTitleFor(agentId, context) {
  const room = context.roomId || "room";
  const task = context.taskId ? ` / ${context.taskId}` : "";
  return `TeamRoom ${room}${task} / ${agentId}`;
}

function sessionModelFor(options) {
  const model = modelParts(options);
  if (!model) {
    return null;
  }
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(options.variant ? { variant: options.variant } : {})
  };
}

function messageModelFor(options) {
  const model = modelParts(options);
  if (!model) {
    return null;
  }
  return model;
}

function modelParts(options) {
  if (!options.model && !options.provider) {
    return null;
  }

  if (options.provider && options.model) {
    return {
      providerID: options.provider,
      modelID: options.model
    };
  }

  if (options.model.includes("/")) {
    const [providerID, ...rest] = options.model.split("/");
    return {
      providerID,
      modelID: rest.join("/")
    };
  }

  return null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function inferRoles(text) {
  const lower = String(text || "").toLowerCase();
  const roles = [];
  if (/(supervisor|lead|leader|manager|planner|review|审核|总控|规划|拆解)/i.test(lower)) {
    roles.push("supervisor");
  }
  return roles;
}

function inferCapabilities(text) {
  const lower = String(text || "").toLowerCase();
  const caps = new Set(["general"]);

  if (/(dimension|model|data|schema|维度|模型|数据)/i.test(lower)) {
    caps.add("dimension");
    caps.add("model");
    caps.add("data");
  }
  if (/(form|ui|page|表单|页面|界面)/i.test(lower)) {
    caps.add("form");
    caps.add("ui");
  }
  if (/(permission|auth|role|access|权限|授权|角色)/i.test(lower)) {
    caps.add("permission");
    caps.add("auth");
  }
  if (/(workflow|job|process|flow|作业|流程)/i.test(lower)) {
    caps.add("workflow");
  }
  if (/(review|test|qa|verify|审核|校验|测试)/i.test(lower)) {
    caps.add("review");
    caps.add("quality");
  }
  if (/(write|doc|summary|文案|文档|总结)/i.test(lower)) {
    caps.add("writing");
    caps.add("summary");
  }

  return [...caps];
}
