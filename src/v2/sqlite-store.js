import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createId, nowIso } from "../utils.js";

const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_user",
  "recovering",
  "unknown",
  "foreground_delivered",
  "auditing"
];

export class V2SqliteStore {
  constructor(filePath, { legacyStore = null } = {}) {
    this.filePath = filePath;
    this.legacyStore = legacyStore;
    this.db = null;
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  async syncLegacyRooms(rooms = [], connectionProfileId = null) {
    const upsertRoom = this.db.prepare(`
      INSERT INTO rooms (
        id, connection_profile_id, name, main_agent_id, legacy_snapshot_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        connection_profile_id = COALESCE(rooms.connection_profile_id, excluded.connection_profile_id),
        name = excluded.name,
        main_agent_id = excluded.main_agent_id,
        legacy_snapshot_json = excluded.legacy_snapshot_json,
        updated_at = excluded.updated_at
    `);
    const deleteMembers = this.db.prepare("DELETE FROM room_members WHERE room_id = ?");
    const insertMember = this.db.prepare(`
      INSERT INTO room_members (room_id, agent_id, name, roles_json, capabilities_json, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      for (const room of rooms) {
        const members = Array.isArray(room.members) ? room.members : [];
        const mainAgentId = room.mainAgentId || selectLegacyMainAgentId(members);
        upsertRoom.run(
          room.id,
          room.connectionProfileId || connectionProfileId,
          room.name || "Untitled Room",
          mainAgentId,
          json(room),
          room.createdAt || nowIso(),
          room.updatedAt || nowIso()
        );
        deleteMembers.run(room.id);
        members.forEach((member, index) => {
          insertMember.run(
            room.id,
            member.agentId,
            member.name || member.agentId,
            json(member.roles || []),
            json(member.capabilities || []),
            index
          );
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async migrateLegacyV2Data(snapshot = {}) {
    const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
    const requests = Array.isArray(snapshot.humanRequests) ? snapshot.humanRequests : [];
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    for (const run of runs) {
      const room = await this.getRoom(run.roomId);
      if (!room) {
        continue;
      }
      await this.ensureRoomSnapshot(room);
      this.ensureConversation({
        id: run.conversationId,
        roomId: run.roomId,
        agentId: run.agentId
      });
      if (!await this.getV2Run(run.id)) {
        insertRun(this.db, run);
      }
    }
    for (const request of requests) {
      if (await this.getV2Run(request.runId)) {
        await this.createHumanRequest(request);
      }
    }
    for (const event of events) {
      await this.appendEvent(event);
    }
  }

  async ensureConnectionProfile(config = {}, fileArea = {}) {
    const backend = config.adapter || "mock";
    const id = `default:${backend}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO connection_profiles (
        id, name, backend, base_url, launch_mode, workspace_path, file_area_mode,
        file_area_path, capabilities_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        workspace_path = excluded.workspace_path,
        updated_at = excluded.updated_at
    `).run(
      id,
      `Default ${backend}`,
      backend,
      backend === "opencode" ? config.opencode?.baseUrl || "" : config.openclaw?.baseUrl || "",
      backend === "opencode" ? config.opencode?.launchMode || "external" : "external",
      config.opencode?.directory || "",
      fileArea.mode || "automatic",
      fileArea.path || "",
      "{}",
      timestamp,
      timestamp
    );
    return this.getConnectionProfile(id);
  }

  async updateConnectionProfile(id, changes = {}) {
    const current = await this.getConnectionProfile(id);
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      ...changes,
      capabilities: {
        ...(current.capabilities || {}),
        ...(changes.capabilities || {})
      },
      updatedAt: nowIso()
    };
    this.db.prepare(`
      UPDATE connection_profiles SET
        name = ?, base_url = ?, launch_mode = ?, workspace_path = ?,
        file_area_mode = ?, file_area_path = ?, capabilities_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.baseUrl,
      next.launchMode,
      next.workspacePath,
      next.fileAreaMode,
      next.fileAreaPath,
      json(next.capabilities),
      next.updatedAt,
      id
    );
    return this.getConnectionProfile(id);
  }

  async getConnectionProfile(id) {
    const row = this.db.prepare("SELECT * FROM connection_profiles WHERE id = ?").get(id);
    return row ? mapConnectionProfile(row) : null;
  }

  async getRoom(roomId) {
    const legacyRoom = await this.legacyStore?.getRoom(roomId);
    if (legacyRoom) {
      const projection = this.db.prepare(
        "SELECT connection_profile_id FROM rooms WHERE id = ?"
      ).get(roomId);
      return {
        ...legacyRoom,
        connectionProfileId: projection?.connection_profile_id || null
      };
    }
    const room = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!room) {
      return null;
    }
    const members = this.db.prepare("SELECT * FROM room_members WHERE room_id = ? ORDER BY position").all(roomId);
    return {
      id: room.id,
      name: room.name,
      connectionProfileId: room.connection_profile_id || null,
      mainAgentId: room.main_agent_id || "",
      members: members.map(mapRoomMember),
      createdAt: room.created_at,
      updatedAt: room.updated_at
    };
  }

  async createV2Run({ roomId, conversationId, agentId, goal }) {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }
    await this.ensureRoomSnapshot(room);
    const timestamp = nowIso();
    this.ensureConversation({ id: conversationId, roomId, agentId, timestamp });
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
    insertRun(this.db, run);
    return run;
  }

  async getV2Run(runId) {
    const row = this.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId);
    return row ? mapRun(row) : null;
  }

  async getActiveV2Run(roomId) {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
    const row = this.db.prepare(`
      SELECT * FROM task_runs
      WHERE room_id = ? AND status IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT 1
    `).get(roomId, ...ACTIVE_RUN_STATUSES);
    return row ? mapRun(row) : null;
  }

  async listV2Runs(roomId) {
    return this.db.prepare("SELECT * FROM task_runs WHERE room_id = ? ORDER BY created_at DESC")
      .all(roomId)
      .map(mapRun);
  }

  async listActiveV2Runs() {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT * FROM task_runs
      WHERE status IN (${placeholders})
      ORDER BY created_at
    `).all(...ACTIVE_RUN_STATUSES).map(mapRun);
  }

  async updateV2Run(run) {
    run.updatedAt = nowIso();
    this.db.prepare(`
      UPDATE task_runs SET
        backend_run_id = ?, status = ?, goal = ?, summary = ?, artifacts_json = ?,
        completion_source = ?, started_at = ?, waiting_since = ?, foreground_delivered_at = ?,
        completed_at = ?, failed_at = ?, cancelled_at = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      run.backendRunId,
      run.status,
      run.goal,
      run.summary || "",
      json(run.artifacts || []),
      run.completionSource,
      run.startedAt,
      run.waitingSince,
      run.foregroundDeliveredAt || null,
      run.completedAt,
      run.failedAt,
      run.cancelledAt,
      run.error,
      run.updatedAt,
      run.id
    );
    return run;
  }

  async getConversation(conversationId) {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
    return row ? mapConversation(row) : null;
  }

  async updateConversationBackendSession(conversationId, backendSessionId) {
    this.db.prepare(`
      UPDATE conversations SET backend_session_id = ?, updated_at = ? WHERE id = ?
    `).run(backendSessionId, nowIso(), conversationId);
    return this.getConversation(conversationId);
  }

  async createHumanRequest(request) {
    this.db.prepare(`
      INSERT INTO human_requests (
        id, external_id, room_id, run_id, agent_id, session_id, type, status,
        title, payload_json, response_json, created_at, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      request.id,
      request.externalId || "",
      request.roomId,
      request.runId,
      request.agentId || "",
      request.sessionId || "",
      request.type,
      request.status,
      request.title || "",
      json(humanRequestPayload(request)),
      request.response ? json(request.response) : null,
      request.createdAt,
      request.answeredAt || null
    );
    return request;
  }

  async updateHumanRequest(request) {
    this.db.prepare(`
      UPDATE human_requests SET status = ?, response_json = ?, answered_at = ?
      WHERE id = ?
    `).run(
      request.status,
      request.response ? json(request.response) : null,
      request.answeredAt || null,
      request.id
    );
    return request;
  }

  async getHumanRequest(requestId) {
    const row = this.db.prepare("SELECT * FROM human_requests WHERE id = ?").get(requestId);
    return row ? mapHumanRequest(row) : null;
  }

  async listHumanRequests(runId) {
    return this.db.prepare("SELECT * FROM human_requests WHERE run_id = ? ORDER BY created_at")
      .all(runId)
      .map(mapHumanRequest);
  }

  async appendEvent(event) {
    this.db.prepare(`
      INSERT OR IGNORE INTO backend_events (
        id, room_id, run_id, type, timestamp, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.roomId,
      event.payload?.runId || event.taskId || null,
      event.type,
      event.timestamp,
      json(event.payload || {})
    );
    if (String(event.type || "").startsWith("v2.invocation.")) {
      this.projectInvocation(event);
    }
    return event;
  }

  async listEvents(roomId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT rowid AS sequence, * FROM backend_events
        WHERE room_id = ?
        ORDER BY rowid DESC
        LIMIT ?
      ) ORDER BY sequence ASC
    `).all(roomId, limit).map(mapEvent);
  }

  async listInvocations(runId) {
    return this.db.prepare(`
      SELECT * FROM agent_invocations WHERE run_id = ? ORDER BY created_at
    `).all(runId).map(mapInvocation);
  }

  async upsertInvocation(invocation) {
    const createdAt = invocation.createdAt || nowIso();
    const updatedAt = invocation.updatedAt || invocation.completedAt || createdAt;
    this.db.prepare(`
      INSERT INTO agent_invocations (
        id, run_id, parent_invocation_id, agent_id, backend_session_id, status,
        payload_json, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        agent_id = CASE WHEN excluded.agent_id = '' THEN agent_invocations.agent_id ELSE excluded.agent_id END,
        backend_session_id = CASE WHEN excluded.backend_session_id = '' THEN agent_invocations.backend_session_id ELSE excluded.backend_session_id END,
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).run(
      invocation.id,
      invocation.runId,
      invocation.parentInvocationId || null,
      invocation.agentId || "",
      invocation.backendSessionId || "",
      invocation.status || "completed",
      json({ title: invocation.title || "", source: invocation.source || "backend_snapshot" }),
      createdAt,
      updatedAt,
      invocation.completedAt || null
    );
    return invocation;
  }

  async ensureRoomSnapshot(room) {
    const existing = this.db.prepare("SELECT id FROM rooms WHERE id = ?").get(room.id);
    if (existing) {
      return;
    }
    await this.syncLegacyRooms([room]);
  }

  async bindRoomConnectionProfile(roomId, connectionProfileId) {
    const result = this.db.prepare(`
      UPDATE rooms SET connection_profile_id = ?, updated_at = ? WHERE id = ?
    `).run(connectionProfileId, nowIso(), roomId);
    if (result.changes === 0) {
      return null;
    }
    return this.getRoom(roomId);
  }

  ensureConversation({ id, roomId, agentId, timestamp = nowIso() }) {
    const conversation = this.db.prepare("SELECT id FROM conversations WHERE id = ?").get(id);
    if (!conversation) {
      this.db.prepare(`
        INSERT INTO conversations (id, room_id, agent_id, kind, status, created_at, updated_at)
        VALUES (?, ?, ?, 'room_main', 'active', ?, ?)
      `).run(id, roomId, agentId, timestamp, timestamp);
    }
  }

  projectInvocation(event) {
    const payload = event.payload || {};
    const session = payload.session || {};
    const part = payload.part || {};
    const id = payload.invocationId || payload.sessionId || part.callID || part.id || createId("inv");
    const status = event.type.endsWith(".completed")
      ? "completed"
      : event.type.endsWith(".failed")
        ? "failed"
        : "running";
    this.db.prepare(`
      INSERT INTO agent_invocations (
        id, run_id, parent_invocation_id, agent_id, backend_session_id, status,
        payload_json, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_invocation_id = excluded.parent_invocation_id,
        agent_id = CASE WHEN excluded.agent_id = '' THEN agent_invocations.agent_id ELSE excluded.agent_id END,
        backend_session_id = CASE WHEN excluded.backend_session_id = '' THEN agent_invocations.backend_session_id ELSE excluded.backend_session_id END,
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).run(
      id,
      payload.runId || event.taskId,
      payload.parentRunId || null,
      payload.agentId || part.agent || session.agent || "",
      payload.sessionId || session.id || "",
      status,
      json(payload),
      event.timestamp,
      event.timestamp,
      status === "completed" ? event.timestamp : null
    );
  }
}

function insertRun(db, run) {
  db.prepare(`
    INSERT INTO task_runs (
      id, room_id, conversation_id, agent_id, backend_run_id, status, goal, summary,
      artifacts_json, completion_source, created_at, started_at, waiting_since,
      foreground_delivered_at, completed_at, failed_at, cancelled_at, error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.roomId,
    run.conversationId,
    run.agentId,
    run.backendRunId,
    run.status,
    run.goal,
    run.summary,
    json(run.artifacts),
    run.completionSource,
    run.createdAt,
    run.startedAt,
    run.waitingSince,
    null,
    run.completedAt,
    run.failedAt,
    run.cancelledAt,
    run.error,
    run.updatedAt
  );
}

function mapRun(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    backendRunId: row.backend_run_id,
    status: row.status,
    goal: row.goal,
    summary: row.summary || "",
    artifacts: parseJson(row.artifacts_json, []),
    completionSource: row.completion_source,
    createdAt: row.created_at,
    startedAt: row.started_at,
    waitingSince: row.waiting_since,
    foregroundDeliveredAt: row.foreground_delivered_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    cancelledAt: row.cancelled_at,
    error: row.error,
    updatedAt: row.updated_at
  };
}

function mapHumanRequest(row) {
  return {
    id: row.id,
    externalId: row.external_id || "",
    roomId: row.room_id,
    runId: row.run_id,
    agentId: row.agent_id || "",
    sessionId: row.session_id || "",
    type: row.type,
    status: row.status,
    title: row.title || "",
    ...parseJson(row.payload_json, {}),
    response: parseJson(row.response_json, null),
    createdAt: row.created_at,
    answeredAt: row.answered_at
  };
}

function mapEvent(row) {
  const payload = parseJson(row.payload_json, {});
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: payload.taskId || row.run_id,
    stageId: payload.stageId,
    type: row.type,
    timestamp: row.timestamp,
    payload
  };
}

function mapConnectionProfile(row) {
  return {
    id: row.id,
    name: row.name,
    backend: row.backend,
    baseUrl: row.base_url,
    launchMode: row.launch_mode,
    workspacePath: row.workspace_path,
    fileAreaMode: row.file_area_mode,
    fileAreaPath: row.file_area_path,
    capabilities: parseJson(row.capabilities_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapConversation(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    agentId: row.agent_id,
    backendSessionId: row.backend_session_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapInvocation(row) {
  const payload = parseJson(row.payload_json, {});
  return {
    id: row.id,
    runId: row.run_id,
    parentInvocationId: row.parent_invocation_id,
    agentId: row.agent_id,
    backendSessionId: row.backend_session_id,
    status: row.status,
    title: payload.title || payload.part?.state?.input?.description || "",
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function mapRoomMember(row) {
  return {
    agentId: row.agent_id,
    name: row.name,
    roles: parseJson(row.roles_json, []),
    capabilities: parseJson(row.capabilities_json, [])
  };
}

function humanRequestPayload(request) {
  return {
    details: request.details || "",
    questions: request.questions || [],
    permission: request.permission || "",
    patterns: request.patterns || [],
    action: request.action || "",
    tool: request.tool || "",
    toolName: request.toolName || "",
    command: request.command || "",
    target: request.target || "",
    path: request.path || "",
    resource: request.resource || "",
    summary: request.summary || "",
    description: request.description || "",
    canAlwaysAllow: Boolean(request.canAlwaysAllow)
  };
}

function selectLegacyMainAgentId(members) {
  const main = members.find((member) => (member.roles || []).some((role) =>
    ["supervisor", "main", "leader", "总控", "主控"].includes(String(role).toLowerCase())
  ));
  return main?.agentId || members[0]?.agentId || "";
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');

CREATE TABLE IF NOT EXISTS connection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  backend TEXT NOT NULL,
  base_url TEXT,
  launch_mode TEXT NOT NULL,
  workspace_path TEXT,
  file_area_mode TEXT NOT NULL,
  file_area_path TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  connection_profile_id TEXT,
  name TEXT NOT NULL,
  main_agent_id TEXT,
  legacy_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  roles_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, agent_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  backend_session_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  backend_run_id TEXT,
  status TEXT NOT NULL,
  goal TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  completion_source TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  waiting_since TEXT,
  foreground_delivered_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  cancelled_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS task_runs_room_status_idx ON task_runs(room_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_invocation_id TEXT,
  agent_id TEXT,
  backend_session_id TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_invocations_run_idx ON agent_invocations(run_id, created_at);

CREATE TABLE IF NOT EXISTS human_requests (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  room_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS human_requests_run_status_idx ON human_requests(run_id, status);

CREATE TABLE IF NOT EXISTS backend_events (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS backend_events_room_idx ON backend_events(room_id, timestamp);
`;
