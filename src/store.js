import fs from "node:fs/promises";
import path from "node:path";
import { createId, nowIso } from "./utils.js";

function defaultData() {
  return {
    rooms: {},
    tasks: {},
    v2Runs: {},
    conversations: {},
    humanRequests: {},
    agentProfiles: {},
    events: []
  };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = defaultData();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = {
        ...defaultData(),
        ...JSON.parse(raw)
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await this.save();
    }
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.filePath);
    });
    return this.writeQueue;
  }

  async listRooms() {
    return Object.values(this.data.rooms).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRoom(roomId) {
    return this.data.rooms[roomId] || null;
  }

  async createRoom({ name, policy = {} }) {
    const timestamp = nowIso();
    const room = {
      id: createId("room"),
      name: name || "Untitled Room",
      policy: normalizePolicyInput(policy),
      members: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.data.rooms[room.id] = room;
    await this.save();
    return room;
  }

  async updateRoom(room) {
    room.updatedAt = nowIso();
    this.data.rooms[room.id] = room;
    await this.save();
    return room;
  }

  async updateRoomPolicy(roomId, policy = {}) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return null;
    }
    room.policy = normalizePolicyInput({
      ...(room.policy || {}),
      ...policy
    });
    return this.updateRoom(room);
  }

  async deleteRoom(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return null;
    }
    delete this.data.rooms[roomId];
    for (const [taskId, task] of Object.entries(this.data.tasks)) {
      if (task.roomId === roomId) {
        delete this.data.tasks[taskId];
      }
    }
    const deletedRunIds = new Set();
    for (const [runId, run] of Object.entries(this.data.v2Runs || {})) {
      if (run.roomId === roomId) {
        deletedRunIds.add(runId);
        delete this.data.v2Runs[runId];
      }
    }
    for (const [requestId, request] of Object.entries(this.data.humanRequests || {})) {
      if (request.roomId === roomId || deletedRunIds.has(request.runId)) {
        delete this.data.humanRequests[requestId];
      }
    }
    this.data.events = this.data.events.filter((event) => event.roomId !== roomId);
    await this.save();
    return room;
  }

  async addMember(roomId, member) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return null;
    }

    const existingIndex = room.members.findIndex((item) => item.agentId === member.agentId);
    const normalized = {
      agentId: member.agentId,
      name: member.name || member.displayName || member.agentId,
      roles: Array.isArray(member.roles) ? member.roles : [],
      capabilities: Array.isArray(member.capabilities) ? member.capabilities : [],
      maxConcurrentTasks: Number(member.maxConcurrentTasks || 1),
      status: "idle",
      updatedAt: nowIso()
    };

    if (existingIndex >= 0) {
      room.members[existingIndex] = {
        ...room.members[existingIndex],
        ...normalized
      };
    } else {
      room.members.push(normalized);
    }
    if (!room.mainAgentId) {
      room.mainAgentId = room.members[0]?.agentId || normalized.agentId;
      room.mainAgentSource = "auto";
    }
    return this.updateRoom(room);
  }

  async setMainAgent(roomId, agentId, options = {}) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return null;
    }
    if (!room.members.some((member) => member.agentId === agentId)) {
      const error = new Error(`Agent is not a member of room: ${agentId}`);
      error.statusCode = 400;
      throw error;
    }
    room.mainAgentId = agentId;
    room.mainAgentSource = options.source || "manual";
    return this.updateRoom(room);
  }

  async getAgentProfile(agentId) {
    return this.data.agentProfiles?.[agentId] || null;
  }

  async upsertAgentProfile(agentId, profile = {}) {
    if (!this.data.agentProfiles) {
      this.data.agentProfiles = {};
    }

    const timestamp = nowIso();
    const existing = this.data.agentProfiles[agentId] || {};
    const normalized = {
      agentId,
      roles: normalizeTags(profile.roles ?? existing.roles ?? []),
      capabilities: normalizeTags(profile.capabilities ?? existing.capabilities ?? []),
      updatedAt: timestamp
    };

    this.data.agentProfiles[agentId] = normalized;
    for (const room of Object.values(this.data.rooms)) {
      const member = room.members.find((item) => item.agentId === agentId);
      if (member) {
        member.roles = normalized.roles;
        member.capabilities = normalized.capabilities;
        member.updatedAt = timestamp;
        room.updatedAt = timestamp;
      }
    }
    await this.save();
    return normalized;
  }

  async deleteAgentProfile(agentId, fallback = {}) {
    if (!this.data.agentProfiles) {
      this.data.agentProfiles = {};
    }
    delete this.data.agentProfiles[agentId];

    const timestamp = nowIso();
    for (const room of Object.values(this.data.rooms)) {
      const member = room.members.find((item) => item.agentId === agentId);
      if (member) {
        member.roles = normalizeTags(fallback.roles || []);
        member.capabilities = normalizeTags(fallback.capabilities || []);
        member.updatedAt = timestamp;
        room.updatedAt = timestamp;
      }
    }
    await this.save();
  }

  async removeMember(roomId, agentId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return null;
    }
    room.members = room.members.filter((member) => member.agentId !== agentId);
    if (room.mainAgentId === agentId) {
      room.mainAgentId = room.members[0]?.agentId || "";
      room.mainAgentSource = room.mainAgentId ? "auto" : "";
    }
    return this.updateRoom(room);
  }

  async setMemberStatus(roomId, agentId, status) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return null;
    }
    const member = room.members.find((item) => item.agentId === agentId);
    if (member) {
      member.status = status;
      member.updatedAt = nowIso();
      await this.updateRoom(room);
    }
    return room;
  }

  async createTask({ roomId, goal, stages }) {
    const timestamp = nowIso();
    const task = {
      id: createId("task"),
      roomId,
      goal,
      status: "queued",
      stages,
      createdAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      deliveredAt: null,
      auditCompletedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      pendingAt: null,
      pendingReason: null,
      pendingStageId: null,
      confirmationPoints: [],
      retryAt: null,
      retryReason: null,
      error: null
    };
    this.data.tasks[task.id] = task;
    await this.save();
    return task;
  }

  async getActiveTask(roomId) {
    return Object.values(this.data.tasks)
      .filter((task) => task.roomId === roomId && !["completed", "cancelled"].includes(task.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  }

  async getTask(taskId) {
    return this.data.tasks[taskId] || null;
  }

  async listTasks(roomId) {
    return Object.values(this.data.tasks)
      .filter((task) => task.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createV2Run({ roomId, conversationId, agentId, goal }) {
    const timestamp = nowIso();
    if (!this.data.conversations[conversationId]) {
      this.data.conversations[conversationId] = {
        id: conversationId,
        roomId,
        agentId,
        backendSessionId: null,
        kind: "room_main",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      };
    }
    const run = {
      id: createId("run"),
      roomId,
      conversationId,
      agentId,
      goal,
      status: "queued",
      backendRunId: null,
      summary: "",
      artifacts: [],
      completionSource: null,
      createdAt: timestamp,
      startedAt: null,
      waitingSince: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      error: null,
      updatedAt: timestamp
    };
    this.data.v2Runs[run.id] = run;
    await this.save();
    return run;
  }

  async getV2Run(runId) {
    return this.data.v2Runs?.[runId] || null;
  }

  async getActiveV2Run(roomId) {
    return Object.values(this.data.v2Runs || {})
      .filter((run) => run.roomId === roomId && !["completed", "failed", "cancelled"].includes(run.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  }

  async listV2Runs(roomId) {
    return Object.values(this.data.v2Runs || {})
      .filter((run) => run.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listActiveV2Runs() {
    return Object.values(this.data.v2Runs || {})
      .filter((run) => !["completed", "failed", "cancelled", "unknown"].includes(run.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateV2Run(run) {
    run.updatedAt = nowIso();
    this.data.v2Runs[run.id] = run;
    await this.save();
    return run;
  }

  async getConversation(conversationId) {
    return this.data.conversations?.[conversationId] || null;
  }

  async updateConversationBackendSession(conversationId, backendSessionId) {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }
    conversation.backendSessionId = backendSessionId;
    conversation.updatedAt = nowIso();
    await this.save();
    return conversation;
  }

  async createHumanRequest(request) {
    this.data.humanRequests[request.id] = request;
    await this.save();
    return request;
  }

  async updateHumanRequest(request) {
    this.data.humanRequests[request.id] = request;
    await this.save();
    return request;
  }

  async getHumanRequest(requestId) {
    return this.data.humanRequests?.[requestId] || null;
  }

  async listHumanRequests(runId) {
    return Object.values(this.data.humanRequests || {})
      .filter((request) => request.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getV2MigrationSnapshot() {
    return {
      runs: Object.values(this.data.v2Runs || {}),
      humanRequests: Object.values(this.data.humanRequests || {}),
      events: (this.data.events || []).filter((event) => String(event.type || "").startsWith("v2."))
    };
  }

  async updateTask(task) {
    task.updatedAt = nowIso();
    this.data.tasks[task.id] = task;
    await this.save();
    return task;
  }

  async appendEvent(event) {
    this.data.events.push(event);
    if (this.data.events.length > 2000) {
      this.data.events = this.data.events.slice(-2000);
    }
    await this.save();
    return event;
  }

  async listEvents(roomId, limit = 100) {
    return this.data.events
      .filter((event) => event.roomId === roomId)
      .slice(-limit);
  }
}

function normalizeTags(value) {
  if (typeof value === "string") {
    return unique(value.split(",").map((item) => item.trim()).filter(Boolean));
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return unique(value.map((item) => String(item).trim()).filter(Boolean));
}

function normalizePolicyInput(policy = {}) {
  return {
    mode: policy.mode || "supervisor",
    requireReview: policy.requireReview ?? policy.require_review ?? true,
    maxParallel: Math.max(1, Number(policy.maxParallel ?? policy.max_parallel ?? 2)),
    fallbackDispatch: normalizeFallbackDispatch(policy.fallbackDispatch ?? policy.fallback_dispatch),
    roomContextLimit: clampInt(policy.roomContextLimit ?? policy.room_context_limit, 6, 0, 20),
    taskMessageLimit: clampInt(policy.taskMessageLimit ?? policy.task_message_limit, 12, 0, 50),
    supervisorExtraPrompt: String(policy.supervisorExtraPrompt ?? policy.supervisor_extra_prompt ?? "").trim(),
    specialistExtraPrompt: String(policy.specialistExtraPrompt ?? policy.specialist_extra_prompt ?? "").trim(),
    reviewExtraPrompt: String(policy.reviewExtraPrompt ?? policy.review_extra_prompt ?? "").trim(),
    promptTemplates: normalizePromptTemplates(policy.promptTemplates ?? policy.prompt_templates)
  };
}

function normalizeFallbackDispatch(value) {
  return ["none", "keyword", "all"].includes(value) ? value : "none";
}

function normalizePromptTemplates(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, template]) => key && typeof template === "string")
      .map(([key, template]) => [key, template])
  );
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function unique(values) {
  return [...new Set(values)];
}
