import { createId, nowIso } from "../utils.js";
import { assertBackendAdapterV2 } from "./backend-contract.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class DirectRunService {
  constructor({ store, events, backend, artifactTracker = null }) {
    this.store = store;
    this.events = events;
    this.backend = assertBackendAdapterV2(backend);
    this.artifactTracker = artifactTracker;
    this.running = new Set();
    this.pendingHumanRequests = new Map();
    this.submittedClientMessages = new Map();
    this.backendInvocationCache = new Map();
  }

  async submitMessage(roomId, request = {}) {
    const duplicate = this.findSubmittedMessage(request.clientMessageId);
    if (duplicate) {
      return duplicate;
    }
    const room = await this.requireRoom(roomId);
    const content = String(request.content || request.message || "").trim();
    if (!content) {
      throw httpError(400, "Message content is required");
    }

    const activeRun = await this.store.getActiveV2Run(roomId);
    if (activeRun) {
      throw httpError(409, `Room already has an active V2 run: ${activeRun.id}`);
    }

    const agent = selectMainAgent(room);
    if (!agent) {
      throw httpError(400, "Room has no agent members");
    }

    const run = await this.store.createV2Run({
      roomId,
      conversationId: request.conversationId || `room:${roomId}:main`,
      agentId: agent.agentId,
      goal: content
    });

    await this.events.publish(roomId, "v2.message.created", {
      runId: run.id,
      taskId: run.id,
      author: "human",
      messageKind: "task",
      content,
      clientMessageId: request.clientMessageId || ""
    });
    await this.events.publish(roomId, "v2.run.created", {
      runId: run.id,
      taskId: run.id,
      agentId: run.agentId,
      goal: run.goal
    });

    queueMicrotask(() => {
      this.execute(run.id).catch((error) => this.failRun(run.id, error));
    });
    this.rememberSubmittedMessage(request.clientMessageId, run);
    return run;
  }

  async execute(runId) {
    if (this.running.has(runId)) {
      return;
    }
    const run = await this.store.getV2Run(runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
      return;
    }

    this.running.add(runId);
    try {
      run.status = "running";
      run.startedAt = run.startedAt || nowIso();
      await this.store.updateV2Run(run);
      await this.events.publish(run.roomId, "v2.run.started", {
        runId: run.id,
        taskId: run.id,
        agentId: run.agentId
      });

      const conversation = typeof this.store.getConversation === "function"
        ? await this.store.getConversation(run.conversationId)
        : null;
      const result = await this.backend.sendMessage({
        agentId: run.agentId,
        content: run.goal,
        context: {
          roomId: run.roomId,
          taskId: run.id,
          runId: run.id,
          conversationId: run.conversationId,
          backendSessionId: conversation?.backendSessionId || null,
          onProgress: (progress) => this.publishProgress(run, progress)
        },
        hooks: {
          onApprovalRequest: (request) => this.requestHumanInput(run, request),
          onSessionReady: (session) => this.registerBackendSession(run, session),
          onInvocationEvent: (event) => this.publishInvocation(run, event)
        }
      });

      const latest = await this.store.getV2Run(run.id);
      if (!latest || latest.status === "cancelled") {
        return;
      }
      const pendingRequests = await this.store.listHumanRequests(latest.id);
      if (pendingRequests.some((request) => request.status === "pending")) {
        latest.status = "waiting_user";
        latest.waitingSince = latest.waitingSince || nowIso();
        latest.artifacts = await this.collectArtifacts(latest, result?.artifacts);
        await this.store.updateV2Run(latest);
        return;
      }
      latest.status = normalizeTerminalStatus(result?.status);
      latest.summary = stripPromptEcho(String(result?.summary || ""), latest.goal);
      latest.artifacts = await this.collectArtifacts(latest, result?.artifacts);
      latest.backendRunId = result?.backendRunId || latest.backendRunId || null;
      if (result?.backendSessionId && typeof this.store.updateConversationBackendSession === "function") {
        await this.store.updateConversationBackendSession(run.conversationId, result.backendSessionId);
      }
      latest.completionSource = result?.completionSource || "backend";
      latest.completedAt = latest.status === "completed" ? nowIso() : null;
      latest.failedAt = latest.status === "failed" ? nowIso() : null;
      latest.error = latest.status === "failed" ? latest.summary || "Backend run failed" : null;
      await this.store.updateV2Run(latest);

      if (latest.summary) {
        await this.events.publish(latest.roomId, "v2.run.output.completed", {
          runId: latest.id,
          taskId: latest.id,
          agentId: latest.agentId,
          content: latest.summary
        });
      }
      await this.events.publish(latest.roomId, `v2.run.${latest.status}`, {
        runId: latest.id,
        taskId: latest.id,
        agentId: latest.agentId,
        completionSource: latest.completionSource
      });
    } finally {
      this.running.delete(runId);
    }
  }

  async respondHumanRequest(roomId, runId, requestId, response = {}) {
    const inMemory = this.pendingHumanRequests.get(requestId);
    const persisted = typeof this.store.getHumanRequest === "function"
      ? await this.store.getHumanRequest(requestId)
      : null;
    const pending = inMemory || persisted;
    if (!pending || pending.roomId !== roomId || pending.runId !== runId) {
      throw httpError(404, `Pending human request not found: ${requestId}`);
    }
    if (pending.status !== "pending") {
      return { request: publicHumanRequest(pending) };
    }

    pending.status = "answered";
    pending.response = normalizeHumanResponse(response);
    pending.answeredAt = nowIso();
    this.pendingHumanRequests.delete(requestId);
    if (!inMemory) {
      const method = pending.type === "permission" ? "answerPermission" : "answerQuestion";
      if (typeof this.backend[method] !== "function") {
        throw httpError(409, `Backend cannot recover ${pending.type} request after restart`);
      }
      await this.backend[method]({
        request: pending,
        response: pending.response
      });
    }
    await this.store.updateHumanRequest(publicHumanRequest(pending));

    const run = await this.store.getV2Run(runId);
    if (run && run.status === "waiting_user") {
      run.status = "running";
      run.waitingSince = null;
      await this.store.updateV2Run(run);
    }
    await this.events.publish(roomId, "v2.human_request.answered", {
      runId,
      taskId: runId,
      request: publicHumanRequest(pending)
    });
    inMemory?.resolve(pending.response);
    if (!inMemory && run && typeof this.backend.watchSession === "function") {
      queueMicrotask(() => {
        this.recoverRun(run).catch((error) => this.failRun(run.id, error));
      });
    }
    return { request: publicHumanRequest(pending) };
  }

  async submitIntervention(roomId, runId, request = {}) {
    const duplicate = this.findSubmittedMessage(request.clientMessageId);
    if (duplicate) {
      return duplicate;
    }
    const run = await this.getRun(roomId, runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw httpError(409, "This run has already ended");
    }
    const content = String(request.content || request.message || "").trim();
    if (!content) {
      throw httpError(400, "Message content is required");
    }
    if (typeof this.backend.sendIntervention !== "function") {
      throw httpError(409, "The current backend cannot accept guidance during a running task");
    }
    const conversation = await this.store.getConversation?.(run.conversationId);
    if (!conversation?.backendSessionId) {
      throw httpError(409, "The backend session is not ready yet");
    }

    await this.events.publish(roomId, "v2.message.created", {
      runId,
      taskId: runId,
      author: "human",
      messageKind: "intervention",
      target: request.target || "main",
      content,
      clientMessageId: request.clientMessageId || ""
    });
    await this.backend.sendIntervention({
      sessionId: conversation.backendSessionId,
      agentId: run.agentId,
      content,
      context: {
        roomId,
        runId,
        taskId: runId,
        conversationId: run.conversationId,
        target: request.target || "main"
      }
    });
    await this.events.publish(roomId, "v2.message.delivered", {
      runId,
      taskId: runId,
      target: request.target || "main"
    });
    const result = { run, delivered: true };
    this.rememberSubmittedMessage(request.clientMessageId, result);
    return result;
  }

  async recoverActiveRuns() {
    if (typeof this.store.listActiveV2Runs !== "function") {
      return;
    }
    for (const run of await this.store.listActiveV2Runs()) {
      const requests = await this.store.listHumanRequests(run.id);
      if (requests.some((request) => request.status === "pending")) {
        run.status = "waiting_user";
        await this.store.updateV2Run(run);
        continue;
      }
      await this.recoverRun(run).catch((error) => this.failRun(run.id, error));
    }
  }

  async checkRun(roomId, runId) {
    const run = await this.getRun(roomId, runId);
    return this.reconcileSnapshot(run);
  }

  async cancelRun(roomId, runId, reason = "Stopped by user") {
    const run = await this.getRun(roomId, runId);
    const conversation = await this.store.getConversation?.(run.conversationId);
    if (conversation?.backendSessionId && typeof this.backend.interrupt === "function") {
      await this.backend.interrupt({ sessionId: conversation.backendSessionId, reason });
    }
    run.status = "cancelled";
    run.cancelledAt = nowIso();
    run.error = reason;
    await this.store.updateV2Run(run);
    await this.events.publish(roomId, "v2.run.cancelled", {
      runId,
      taskId: runId,
      reason
    });
    return run;
  }

  async getRun(roomId, runId) {
    const run = await this.store.getV2Run(runId);
    if (!run || run.roomId !== roomId) {
      throw httpError(404, `V2 run not found: ${runId}`);
    }
    return run;
  }

  async enrichRun(run) {
    if (!run) {
      return run;
    }
    const artifacts = await this.collectArtifacts(run, run.artifacts);
    if (artifacts.length && JSON.stringify(artifacts) !== JSON.stringify(run.artifacts || [])) {
      run.artifacts = artifacts;
      await this.store.updateV2Run(run);
    }
    await this.backfillInvocations(run);
    return {
      ...run,
      invocations: typeof this.store.listInvocations === "function"
        ? await this.store.listInvocations(run.id)
        : [],
      humanRequests: typeof this.store.listHumanRequests === "function"
        ? await this.store.listHumanRequests(run.id)
        : []
    };
  }

  async backfillInvocations(run) {
    if (typeof this.backend.listInvocations !== "function"
      || typeof this.store.upsertInvocation !== "function") {
      return;
    }
    const existing = await this.store.listInvocations(run.id);
    if (existing.length) {
      return;
    }
    const conversation = await this.store.getConversation?.(run.conversationId);
    if (!conversation?.backendSessionId) {
      return;
    }
    const sessionId = conversation.backendSessionId;
    const cached = this.backendInvocationCache.get(sessionId);
    let invocations = cached?.expiresAt > Date.now() ? cached.value : null;
    if (!invocations) {
      invocations = await this.backend.listInvocations({ sessionId });
      this.backendInvocationCache.set(sessionId, {
        value: Array.isArray(invocations) ? invocations : [],
        expiresAt: Date.now() + 15_000
      });
    }
    const startedAt = Date.parse(run.startedAt || run.createdAt || "");
    const endedAt = Date.parse(
      run.completedAt || run.failedAt || run.cancelledAt || new Date().toISOString()
    );
    for (const invocation of invocations) {
      const createdAt = Date.parse(invocation.createdAt || "");
      if (!Number.isFinite(createdAt)
        || createdAt < startedAt - 5000
        || createdAt > endedAt + 5000) {
        continue;
      }
      await this.store.upsertInvocation({
        ...invocation,
        runId: run.id,
        source: "opencode_children"
      });
    }
  }

  async publishProgress(run, progress = {}) {
    const state = String(progress.state || "running");
    if (state === "compaction" || state.startsWith("tool:") || state.startsWith("skill:")) {
      return;
    }
    const text = String(progress.text || progress.content || "").trim();
    if (!text) {
      return;
    }
    const latest = await this.store.getV2Run(run.id).catch(() => run);
    if (isPromptEcho(text, latest?.goal || run.goal)) {
      return;
    }
    await this.events.publish(run.roomId, "v2.run.output.delta", {
      runId: run.id,
      taskId: run.id,
      agentId: run.agentId,
      content: text,
      append: Boolean(progress.append),
      state
    });
  }

  async registerBackendSession(run, session = {}) {
    if (session.sessionId && typeof this.store.updateConversationBackendSession === "function") {
      await this.store.updateConversationBackendSession(run.conversationId, session.sessionId);
    }
    const latest = await this.store.getV2Run(run.id);
    if (latest) {
      latest.backendRunId = session.backendRunId || latest.backendRunId;
      await this.store.updateV2Run(latest);
    }
  }

  async publishInvocation(run, event = {}) {
    await this.events.publish(run.roomId, event.type || "v2.invocation.updated", {
      runId: run.id,
      taskId: run.id,
      invocationId: event.invocationId || "",
      parentRunId: event.parentRunId || null,
      agentId: event.agentId || "",
      sessionId: event.sessionId || "",
      title: event.title || "",
      part: event.part || null,
      session: event.session || null
    });
  }

  async recoverRun(run) {
    const conversation = await this.store.getConversation?.(run.conversationId);
    const sessionId = conversation?.backendSessionId;
    if (!sessionId) {
      run.status = "unknown";
      run.error = "Backend session id is unavailable";
      await this.store.updateV2Run(run);
      return run;
    }
    run.status = "recovering";
    await this.store.updateV2Run(run);
    await this.events.publish(run.roomId, "v2.run.recovering", {
      runId: run.id,
      taskId: run.id,
      sessionId
    });

    const reconciled = await this.reconcileSnapshot(run);
    if (["completed", "failed", "cancelled", "waiting_user"].includes(reconciled.status)) {
      return reconciled;
    }
    if (typeof this.backend.watchSession !== "function") {
      return reconciled;
    }
    const result = await this.backend.watchSession({
      sessionId,
      agentId: run.agentId,
      onProgress: (progress) => this.publishProgress(run, progress),
      hooks: {
        onApprovalRequest: (request) => this.requestHumanInput(run, request),
        onInvocationEvent: (event) => this.publishInvocation(run, event)
      }
    });
    return this.completeRecoveredRun(run.id, result);
  }

  async reconcileSnapshot(run) {
    const conversation = await this.store.getConversation?.(run.conversationId);
    if (!conversation?.backendSessionId || typeof this.backend.getSnapshot !== "function") {
      return run;
    }
    const snapshot = await this.backend.getSnapshot({ sessionId: conversation.backendSessionId });
    const status = String(snapshot?.status?.type || snapshot?.status || "unknown").toLowerCase();
    const requests = await this.store.listHumanRequests(run.id);
    if (requests.some((request) => request.status === "pending")) {
      run.status = "waiting_user";
    } else if (status === "idle") {
      run.status = "completed";
      run.completedAt = run.completedAt || nowIso();
      run.completionSource = "session.status:snapshot";
      run.summary = latestAssistantText(snapshot.messages, run.agentId) || run.summary;
    } else if (["busy", "retry"].includes(status)) {
      run.status = "running";
    } else {
      run.status = "unknown";
    }
    await this.store.updateV2Run(run);
    await this.events.publish(run.roomId, "v2.run.reconciled", {
      runId: run.id,
      taskId: run.id,
      status: run.status,
      backendStatus: status
    });
    return run;
  }

  async completeRecoveredRun(runId, result) {
    const run = await this.store.getV2Run(runId);
    if (!run) return null;
    const pendingRequests = await this.store.listHumanRequests(run.id);
    if (pendingRequests.some((request) => request.status === "pending")) {
      run.status = "waiting_user";
      run.waitingSince = run.waitingSince || nowIso();
      await this.store.updateV2Run(run);
      return run;
    }
    run.status = normalizeTerminalStatus(result?.status);
    run.summary = String(result?.summary || "");
    run.artifacts = await this.collectArtifacts(run, result?.artifacts);
    run.completionSource = result?.completionSource || "recovered_backend";
    run.completedAt = run.status === "completed" ? nowIso() : null;
    run.failedAt = run.status === "failed" ? nowIso() : null;
    await this.store.updateV2Run(run);
    if (run.summary) {
      await this.events.publish(run.roomId, "v2.run.output.completed", {
        runId: run.id,
        taskId: run.id,
        agentId: run.agentId,
        content: run.summary
      });
    }
    await this.events.publish(run.roomId, `v2.run.${run.status}`, {
      runId: run.id,
      taskId: run.id,
      completionSource: run.completionSource
    });
    return run;
  }

  async requestHumanInput(run, request = {}) {
    const requestId = String(request.id || request.externalId || createId("human"));
    const existing = this.pendingHumanRequests.get(requestId);
    if (existing) {
      return existing.promise;
    }

    const humanRequest = {
      id: requestId,
      externalId: request.id || request.externalId || "",
      roomId: run.roomId,
      runId: run.id,
      agentId: request.agentId || run.agentId,
      sessionId: request.sessionId || "",
      type: request.type || "question",
      status: "pending",
      title: request.title || "需要你的确认",
      details: request.details || "",
      questions: Array.isArray(request.questions) ? request.questions : [],
      permission: request.permission || "",
      patterns: Array.isArray(request.patterns) ? request.patterns : [],
      action: request.action || "",
      tool: request.tool || "",
      toolName: request.toolName || "",
      command: request.command || "",
      target: request.target || "",
      path: request.path || "",
      resource: request.resource || "",
      summary: request.summary || "",
      description: request.description || "",
      canAlwaysAllow: Boolean(request.canAlwaysAllow),
      createdAt: nowIso()
    };
    humanRequest.promise = new Promise((resolve) => {
      humanRequest.resolve = resolve;
    });
    this.pendingHumanRequests.set(requestId, humanRequest);
    await this.store.createHumanRequest(publicHumanRequest(humanRequest));

    const latest = await this.store.getV2Run(run.id);
    if (latest && !TERMINAL_RUN_STATUSES.has(latest.status)) {
      latest.status = "waiting_user";
      latest.waitingSince = nowIso();
      await this.store.updateV2Run(latest);
    }
    await this.events.publish(run.roomId, "v2.human_request.created", {
      runId: run.id,
      taskId: run.id,
      request: publicHumanRequest(humanRequest)
    });
    return humanRequest.promise;
  }

  async failRun(runId, error) {
    const run = await this.store.getV2Run(runId);
    if (!run || run.status === "cancelled") {
      return;
    }
    run.status = "failed";
    run.error = error?.message || "V2 run failed";
    run.failedAt = nowIso();
    await this.store.updateV2Run(run);
    await this.events.publish(run.roomId, "v2.run.failed", {
      runId: run.id,
      taskId: run.id,
      agentId: run.agentId,
      error: run.error
    });
  }

  async collectArtifacts(run, reported = []) {
    const explicit = Array.isArray(reported) ? reported.filter(Boolean) : [];
    if (!this.artifactTracker) {
      return explicit;
    }
    const discovered = await this.artifactTracker.collect(run);
    const keyed = new Map();
    for (const artifact of [...explicit, ...discovered]) {
      const key = typeof artifact === "string"
        ? artifact
        : artifact.path || artifact.name || JSON.stringify(artifact);
      keyed.set(key, artifact);
    }
    return [...keyed.values()];
  }

  findSubmittedMessage(clientMessageId) {
    if (!clientMessageId) {
      return null;
    }
    return this.submittedClientMessages.get(clientMessageId)?.value || null;
  }

  rememberSubmittedMessage(clientMessageId, value) {
    if (!clientMessageId) {
      return;
    }
    const now = Date.now();
    this.submittedClientMessages.set(clientMessageId, { value, timestamp: now });
    for (const [id, item] of this.submittedClientMessages) {
      if (now - item.timestamp > 5 * 60 * 1000) {
        this.submittedClientMessages.delete(id);
      }
    }
  }

  async requireRoom(roomId) {
    const room = await this.store.getRoom(roomId);
    if (!room) {
      throw httpError(404, `Room not found: ${roomId}`);
    }
    return room;
  }
}

export function selectMainAgent(room) {
  const members = Array.isArray(room?.members) ? room.members : [];
  if (room?.mainAgentId) {
    const selected = members.find((member) => member.agentId === room.mainAgentId);
    if (selected) {
      return selected;
    }
  }
  return members.find((member) => (member.roles || []).some(isMainRole)) || members[0] || null;
}

function isMainRole(role) {
  return ["supervisor", "main", "leader", "总控", "主控"].includes(String(role || "").toLowerCase());
}

function normalizeTerminalStatus(status) {
  return String(status || "").toLowerCase() === "failed" ? "failed" : "completed";
}

function normalizeHumanResponse(response) {
  return {
    reply: response.reply || response.response || "once",
    answers: Array.isArray(response.answers) ? response.answers : [],
    message: String(response.message || ""),
    cancelled: Boolean(response.cancelled)
  };
}

function publicHumanRequest(request) {
  const {
    promise,
    resolve,
    ...publicValue
  } = request;
  return publicValue;
}

function stripPromptEcho(text, prompt) {
  const output = String(text || "").trim();
  const source = String(prompt || "").trim();
  if (!output || !source) {
    return output;
  }
  if (normalizeEchoText(output) === normalizeEchoText(source)) {
    return "";
  }
  if (normalizeEchoText(output).startsWith(normalizeEchoText(source))) {
    return output.slice(source.length).replace(/^[\s:：\-—。；;，,]+/, "").trim();
  }
  return output;
}

function isPromptEcho(text, prompt) {
  const normalizedText = normalizeEchoText(text);
  const normalizedPrompt = normalizeEchoText(prompt);
  return Boolean(normalizedText && normalizedPrompt && (
    normalizedText === normalizedPrompt
    || normalizedPrompt.startsWith(normalizedText)
    || normalizedText.startsWith(normalizedPrompt)
  ));
}

function normalizeEchoText(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[，。；：:,.!?！？“”"'`*_#>\-—\[\]()（）]/g, "")
    .toLowerCase();
}

function latestAssistantText(messages, agentId) {
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    const info = message?.info || {};
    if (info.role !== "assistant" || (agentId && info.agent && info.agent !== agentId)) continue;
    const text = (message.parts || [])
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
  }
  return "";
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
