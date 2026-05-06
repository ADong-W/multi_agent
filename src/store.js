import fs from "node:fs/promises";
import path from "node:path";
import { createId, nowIso } from "./utils.js";

function defaultData() {
  return {
    rooms: {},
    tasks: {},
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
      policy: {
        mode: policy.mode || "supervisor",
        requireReview: policy.requireReview ?? policy.require_review ?? true,
        maxParallel: Number(policy.maxParallel ?? policy.max_parallel ?? 2)
      },
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
      updatedAt: timestamp,
      completedAt: null,
      error: null
    };
    this.data.tasks[task.id] = task;
    await this.save();
    return task;
  }

  async getTask(taskId) {
    return this.data.tasks[taskId] || null;
  }

  async listTasks(roomId) {
    return Object.values(this.data.tasks)
      .filter((task) => task.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

function unique(values) {
  return [...new Set(values)];
}
