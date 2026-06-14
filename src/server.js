import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { EventHub } from "./events.js";
import { JsonStore } from "./store.js";
import { readJsonBody, sendError, sendJson } from "./utils.js";
import { DirectRunService } from "./v2/direct-run-service.js";
import { V2SqliteStore } from "./v2/sqlite-store.js";
import { createBackendV2 } from "./v2/adapters/index.js";
import { resolveFileArea } from "./v2/file-area.js";
import { diagnoseRuntimeError, OpenCodeProcessManager } from "./v2/opencode-process-manager.js";
import { ArtifactTracker } from "./v2/artifact-tracker.js";
import { pickDirectory } from "./v2/directory-picker.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

export async function createTeamRoomServer(config = loadConfig()) {
  const store = new JsonStore(config.dataFile);
  await store.load();

  const v2Store = new V2SqliteStore(config.v2DatabaseFile, { legacyStore: store });
  await v2Store.load();
  const detectedFileArea = await resolveFileArea(config);
  let connectionProfile = await v2Store.ensureConnectionProfile(config, detectedFileArea);
  await v2Store.syncLegacyRooms(await store.listRooms(), connectionProfile.id);
  await v2Store.migrateLegacyV2Data(await store.getV2MigrationSnapshot());
  const effectiveFileArea = await resolveFileArea(config, connectionProfile.fileAreaMode);
  if (connectionProfile.fileAreaMode !== effectiveFileArea.mode
    || connectionProfile.fileAreaPath !== effectiveFileArea.path) {
    connectionProfile = await v2Store.updateConnectionProfile(connectionProfile.id, {
      fileAreaMode: effectiveFileArea.mode,
      fileAreaPath: effectiveFileArea.path
    });
  }
  const v2Events = new EventHub({ store: v2Store });
  const backendV2 = createBackendV2(config);
  const runtimeManager = new OpenCodeProcessManager(config);
  runtimeManager.configure(connectionProfile, config);
  const artifactTracker = new ArtifactTracker({
    getRoots: () => {
      const workspace = connectionProfile.workspacePath || config.opencode?.directory || "";
      const roots = workspace ? [path.join(workspace, "working")] : [];
      if (connectionProfile.fileAreaMode === "teamroom_default" && connectionProfile.fileAreaPath) {
        roots.push(connectionProfile.fileAreaPath);
      }
      return roots;
    }
  });
  const directRuns = new DirectRunService({
    store: v2Store,
    events: v2Events,
    backend: backendV2,
    artifactTracker
  });
  if (connectionProfile.backend === "opencode" && connectionProfile.launchMode === "managed") {
    queueMicrotask(() => {
      runtimeManager.ensureStarted().catch((error) => {
        console.error("Failed to start managed OpenCode:", error.message);
      });
    });
  }
  queueMicrotask(() => {
    directRuns.recoverActiveRuns().catch((error) => {
      console.error("Failed to recover V2 runs:", error);
    });
  });
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest({
        req,
        res,
        config,
        store,
        backendV2,
        runtimeManager,
        directRuns,
        v2Store,
        v2Events,
        connectionProfile,
        detectedFileArea
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendError(res, statusCode, error.message || "Internal server error");
    }
  });
  server.on("close", () => {
    runtimeManager.stop().catch(() => {});
  });

  return {
    server,
    store,
    backendV2,
    runtimeManager,
    directRuns,
    v2Store,
    v2Events,
    connectionProfile,
    detectedFileArea
  };
}

async function handleRequest(context) {
  const { req, res, config } = context;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "openclaw-teamroom" });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isAuthorized(req, config, url)) {
      sendError(res, 401, "Unauthorized");
      return;
    }
    await routeApi(context, url);
    return;
  }

  await serveStatic(res, config.publicDir, url.pathname);
}

async function routeApi({
  req,
  res,
  store,
  backendV2,
  runtimeManager,
  directRuns,
  v2Store,
  v2Events,
  connectionProfile,
  config
}, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/v2/runtime") {
    sendJson(res, 200, await probeRuntime({
      backendV2,
      runtimeManager,
      connectionProfile
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v2/runtime/reconnect") {
    try {
      if (connectionProfile.backend === "opencode" && connectionProfile.launchMode === "managed") {
        await runtimeManager.reconnect();
      }
    } catch (error) {
      const result = runtimeFailure(error, connectionProfile, runtimeManager.status());
      sendJson(res, 502, { ok: false, result });
      return;
    }
    const result = await probeRuntime({ backendV2, runtimeManager, connectionProfile });
    sendJson(res, result.connected ? 200 : 502, { ok: result.connected, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v2/agents") {
    sendJson(res, 200, { agents: await listProfiledAgents(backendV2, store) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v2/files") {
    const body = await readJsonBody(req);
    const file = await saveUploadedFile(body, connectionProfile, config);
    sendJson(res, 201, { file });
    return;
  }

  if (parts[0] === "api" && parts[1] === "v2" && parts[2] === "agents" && parts[3] && parts[4] === "profile") {
    const agentId = decodeURIComponent(parts[3]);
    const agents = await backendV2.listAgents().catch(() => []);
    const known = agents.find((agent) => agent.id === agentId || agent.agentId === agentId) || { id: agentId };
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const profile = await store.upsertAgentProfile(agentId, {
        roles: body.roles,
        capabilities: body.capabilities
      });
      await v2Store.syncLegacyRooms(await store.listRooms(), connectionProfile.id);
      sendJson(res, 200, { profile, agent: mergeAgentProfile(known, profile) });
      return;
    }
    if (req.method === "DELETE") {
      await store.deleteAgentProfile(agentId, known);
      await v2Store.syncLegacyRooms(await store.listRooms(), connectionProfile.id);
      sendJson(res, 200, { agent: mergeAgentProfile(known, null) });
      return;
    }
    sendError(res, 405, "Method not allowed");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v2/rooms") {
    const rooms = await Promise.all((await store.listRooms()).map((room) =>
      applyConfiguredMainAgent(room, backendV2, store)
    ));
    await v2Store.syncLegacyRooms(rooms, connectionProfile.id);
    sendJson(res, 200, {
      rooms: await Promise.all(rooms.map((room) => v2Store.getRoom(room.id)))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v2/rooms") {
    const body = await readJsonBody(req);
    const room = await store.createRoom({ name: body.name });
    await v2Store.syncLegacyRooms([room], connectionProfile.id);
    const v2Room = await v2Store.getRoom(room.id);
    await v2Events.publish(room.id, "room.created", { roomId: room.id, room: v2Room });
    sendJson(res, 201, { room: v2Room });
    return;
  }

  if (url.pathname === "/api/v2/setup") {
    if (req.method === "GET") {
      const currentProfile = await v2Store.getConnectionProfile(connectionProfile.id);
      const fileArea = await resolveFileArea(
        configWithWorkspace(config, currentProfile.workspacePath),
        currentProfile.fileAreaMode
      );
      sendJson(res, 200, {
        connectionProfile: currentProfile,
        fileArea
      });
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      if (body.backend && body.backend !== connectionProfile.backend) {
        sendError(
          res,
          409,
          `This TeamRoom instance is running on ${connectionProfile.backend}. Restart it with TEAMROOM_ADAPTER=${body.backend} to switch backend.`
        );
        return;
      }
      const currentProfile = await v2Store.getConnectionProfile(connectionProfile.id);
      const workspacePath = String(body.workspacePath ?? currentProfile.workspacePath ?? "").trim();
      if (body.launchMode === "managed" && body.backend === "opencode" && !workspacePath) {
        sendError(res, 400, "请选择运行 OpenCode 的项目文件夹");
        return;
      }
      const requestedMode = normalizeFileAreaMode(body.fileAreaMode ?? currentProfile.fileAreaMode);
      const fileAreaConfig = {
        ...config,
        opencode: {
          ...config.opencode,
          directory: workspacePath
        }
      };
      const fileArea = await resolveFileArea(fileAreaConfig, requestedMode);
      if (requestedMode === "project_input" && !fileArea.projectInputAvailable) {
        sendError(res, 409, "Project input directory was not detected");
        return;
      }
      const previousLaunchMode = currentProfile.launchMode;
      const updated = await v2Store.updateConnectionProfile(connectionProfile.id, {
        baseUrl: body.baseUrl || currentProfile.baseUrl,
        launchMode: body.launchMode || currentProfile.launchMode,
        workspacePath,
        fileAreaMode: fileArea.mode,
        fileAreaPath: fileArea.path
      });
      Object.assign(connectionProfile, updated);
      if (typeof backendV2.configure === "function") {
        backendV2.configure({
          baseUrl: updated.baseUrl,
          directory: updated.workspacePath
        });
      }
      runtimeManager.configure(connectionProfile, config);
      if (previousLaunchMode === "managed" && updated.launchMode !== "managed") {
        await runtimeManager.stop();
      }
      let runtime = null;
      if (updated.backend === "opencode" && updated.launchMode === "managed") {
        try {
          await runtimeManager.ensureStarted();
          runtime = await probeRuntime({ backendV2, runtimeManager, connectionProfile });
        } catch (error) {
          runtime = runtimeFailure(error, connectionProfile, runtimeManager.status());
        }
      }
      sendJson(res, 200, { connectionProfile: updated, fileArea, runtime });
      return;
    }
    sendError(res, 405, "Method not allowed");
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v2/setup/preview") {
    const body = await readJsonBody(req);
    if (body.backend && body.backend !== connectionProfile.backend) {
      sendError(
        res,
        409,
        `This TeamRoom instance is running on ${connectionProfile.backend}. Restart it with TEAMROOM_ADAPTER=${body.backend} to switch backend.`
      );
      return;
    }
    const currentProfile = await v2Store.getConnectionProfile(connectionProfile.id);
    const candidate = buildSetupCandidate(body, currentProfile, config);
    const fileArea = await resolveFileArea(
      configWithWorkspace(config, candidate.workspacePath),
      candidate.fileAreaMode
    );
    const candidateProfile = {
      ...currentProfile,
      ...candidate,
      fileAreaMode: fileArea.mode,
      fileAreaPath: fileArea.path
    };
    let runtime = null;
    if (body.testRuntime) {
      runtime = await probeRuntimeCandidate({
        backendV2,
        config,
        profile: candidateProfile,
        savedProfile: connectionProfile
      });
    }
    sendJson(res, 200, {
      connectionProfile: candidateProfile,
      fileArea,
      runtime
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v2/setup/select-workspace") {
    const body = await readJsonBody(req);
    const result = await pickDirectory({
      prompt: "选择运行 OpenCode 的项目文件夹",
      initialPath: body.initialPath || connectionProfile.workspacePath || config.opencode?.directory
    });
    sendJson(res, 200, result);
    return;
  }

  if (parts[0] === "api" && parts[1] === "v2" && parts[2] === "rooms" && parts[3]) {
    const roomId = decodeURIComponent(parts[3]);

    if (req.method === "GET" && parts.length === 4) {
      let legacyRoom = await store.getRoom(roomId);
      if (legacyRoom) {
        legacyRoom = await applyConfiguredMainAgent(legacyRoom, backendV2, store);
        await v2Store.syncLegacyRooms([legacyRoom], connectionProfile.id);
      }
      const room = await v2Store.getRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      sendJson(res, 200, { room });
      return;
    }

    if (req.method === "DELETE" && parts.length === 4) {
      const room = await store.deleteRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      await v2Events.publish(roomId, "room.deleted", { roomId });
      sendJson(res, 200, { roomId, deleted: true });
      return;
    }

    if (req.method === "PUT" && parts[4] === "main-agent" && !parts[5]) {
      const body = await readJsonBody(req);
      const agentId = String(body.agentId || "").trim();
      if (!agentId) {
        sendError(res, 400, "agentId is required");
        return;
      }
      const room = await store.setMainAgent(roomId, agentId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      await v2Store.syncLegacyRooms([room], connectionProfile.id);
      await v2Events.publish(roomId, "room.main_agent_updated", { roomId, agentId });
      sendJson(res, 200, { room: await v2Store.getRoom(roomId) });
      return;
    }

    if (req.method === "POST" && parts[4] === "members" && !parts[5]) {
      const body = await readJsonBody(req);
      const member = await enrichMember(body, backendV2, store);
      if (!member.agentId) {
        sendError(res, 400, "agentId is required");
        return;
      }
      let room = await store.addMember(roomId, member);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      room = await applyConfiguredMainAgent(room, backendV2, store);
      await v2Store.syncLegacyRooms([room], connectionProfile.id);
      await v2Events.publish(roomId, "member.added", { roomId, member });
      sendJson(res, 200, { room: await v2Store.getRoom(roomId) });
      return;
    }

    if (req.method === "DELETE" && parts[4] === "members" && parts[5]) {
      const agentId = decodeURIComponent(parts[5]);
      let room = await store.removeMember(roomId, agentId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      room = await applyConfiguredMainAgent(room, backendV2, store);
      await v2Store.syncLegacyRooms([room], connectionProfile.id);
      await v2Events.publish(roomId, "member.removed", { roomId, agentId });
      sendJson(res, 200, { room: await v2Store.getRoom(roomId) });
      return;
    }

    if (req.method === "GET" && parts[4] === "events" && parts[5] === "history") {
      const room = await v2Store.getRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      const limit = clampInt(url.searchParams.get("limit"), 500, 50, 2000);
      sendJson(res, 200, { events: await v2Store.listEvents(roomId, limit) });
      return;
    }

    if (req.method === "GET" && parts[4] === "events") {
      const room = await v2Store.getRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      await v2Events.subscribe(roomId, res);
      return;
    }

    if (req.method === "POST" && parts[4] === "messages") {
      const body = await readJsonBody(req);
      const run = await directRuns.submitMessage(roomId, body);
      sendJson(res, 202, { run });
      return;
    }

    if (req.method === "POST"
      && parts[4] === "runs"
      && parts[5]
      && parts[6] === "messages") {
      const body = await readJsonBody(req);
      const result = await directRuns.submitIntervention(
        roomId,
        decodeURIComponent(parts[5]),
        body
      );
      sendJson(res, 202, result);
      return;
    }

    if (req.method === "GET" && parts[4] === "runs" && !parts[5]) {
      const room = await v2Store.getRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      const runs = await v2Store.listV2Runs(roomId);
      sendJson(res, 200, {
        runs: await Promise.all(runs.map((run) => directRuns.enrichRun(run)))
      });
      return;
    }

    if (req.method === "GET" && parts[4] === "runs" && parts[5]) {
      const runId = decodeURIComponent(parts[5]);
      const run = await directRuns.enrichRun(await directRuns.getRun(roomId, runId));
      const humanRequests = await v2Store.listHumanRequests(runId);
      const invocations = await v2Store.listInvocations(runId);
      const conversation = await v2Store.getConversation(run.conversationId);
      sendJson(res, 200, {
        run,
        humanRequests,
        invocations,
        backendSessionId: conversation?.backendSessionId || ""
      });
      return;
    }

    if (req.method === "POST" && parts[4] === "runs" && parts[5] && parts[6] === "check") {
      const run = await directRuns.checkRun(roomId, decodeURIComponent(parts[5]));
      sendJson(res, 200, { run });
      return;
    }

    if (req.method === "POST" && parts[4] === "runs" && parts[5] && parts[6] === "cancel") {
      const body = await readJsonBody(req);
      const run = await directRuns.cancelRun(
        roomId,
        decodeURIComponent(parts[5]),
        body.reason || "Stopped by user"
      );
      sendJson(res, 200, { run });
      return;
    }

    if (req.method === "POST"
      && parts[4] === "runs"
      && parts[5]
      && parts[6] === "human-requests"
      && parts[7]
      && parts[8] === "response") {
      const body = await readJsonBody(req);
      const result = await directRuns.respondHumanRequest(
        roomId,
        decodeURIComponent(parts[5]),
        decodeURIComponent(parts[7]),
        body
      );
      sendJson(res, 200, result);
      return;
    }
  }

  sendError(res, 404, "Not found");
}

async function probeRuntime({ backendV2, runtimeManager, connectionProfile }) {
  try {
    if (connectionProfile.backend === "opencode" && connectionProfile.launchMode === "managed") {
      await runtimeManager.ensureStarted();
    }
    const result = await backendV2.probeConnection();
    return {
      ...result,
      connected: result.connected !== false,
      process: runtimeManager.status()
    };
  } catch (error) {
    return runtimeFailure(error, connectionProfile, runtimeManager.status());
  }
}

function runtimeFailure(error, connectionProfile, processStatus) {
  return {
    backend: connectionProfile.backend,
    connected: false,
    error: error.message || "Runtime unavailable",
    diagnostic: diagnoseRuntimeError(error, connectionProfile, processStatus),
    process: processStatus,
    capabilities: {}
  };
}

function buildSetupCandidate(body = {}, currentProfile = {}, config = {}) {
  const workspacePath = String(
    body.workspacePath
      ?? currentProfile.workspacePath
      ?? config.opencode?.directory
      ?? ""
  ).trim();
  return {
    backend: body.backend || currentProfile.backend || config.adapter,
    baseUrl: body.baseUrl || currentProfile.baseUrl || config.opencode?.baseUrl || "",
    launchMode: body.launchMode || currentProfile.launchMode || "external",
    workspacePath,
    fileAreaMode: normalizeFileAreaMode(body.fileAreaMode ?? currentProfile.fileAreaMode)
  };
}

function configWithWorkspace(config, workspacePath) {
  return {
    ...config,
    opencode: {
      ...config.opencode,
      directory: String(workspacePath || config.opencode?.directory || "").trim()
    }
  };
}

function normalizeFileAreaMode(value) {
  if (value === "project_input" || value === "teamroom_default") {
    return value;
  }
  return "automatic";
}

async function probeRuntimeCandidate({ backendV2, config, profile, savedProfile }) {
  const probeManager = new OpenCodeProcessManager(config);
  probeManager.configure(profile, config);
  if (typeof backendV2.configure === "function") {
    backendV2.configure({
      baseUrl: profile.baseUrl,
      directory: profile.workspacePath
    });
  }
  try {
    return await probeRuntime({
      backendV2,
      runtimeManager: probeManager,
      connectionProfile: profile
    });
  } finally {
    await probeManager.stop().catch(() => {});
    if (typeof backendV2.configure === "function") {
      backendV2.configure({
        baseUrl: savedProfile.baseUrl || config.opencode?.baseUrl,
        directory: savedProfile.workspacePath || config.opencode?.directory
      });
    }
  }
}

async function listProfiledAgents(adapter, store) {
  const agents = await adapter.listAgents();
  return Promise.all(agents.map(async (agent) => {
    const profile = await store.getAgentProfile(agent.id || agent.agentId);
    return mergeAgentProfile(agent, profile);
  }));
}

function mergeAgentProfile(agent, profile) {
  const id = agent.id || agent.agentId || profile?.agentId;
  const hasProfile = Boolean(profile);
  const roles = hasProfile ? profile.roles : agent.roles || [];
  const mergedRoles = new Set(roles);
  if (agent.isDefaultAgent || agent.isPrimaryAgent) {
    mergedRoles.add("main");
    mergedRoles.add("primary");
  }
  return {
    ...agent,
    id,
    roles: [...mergedRoles],
    capabilities: hasProfile ? profile.capabilities : agent.capabilities || [],
    profileSource: hasProfile ? "local" : "adapter"
  };
}

async function enrichMember(body, adapter, store) {
  const agentId = body.agentId || body.agent_id || body.id;
  const agents = await adapter.listAgents().catch(() => []);
  const known = agents.find((agent) => agent.id === agentId || agent.agentId === agentId) || {};
  const profile = await store.getAgentProfile(agentId);
  return {
    agentId,
    name: body.name || body.displayName || body.display_name || known.name || agentId,
    roles: body.roles || profile?.roles || known.roles || [],
    capabilities: body.capabilities || profile?.capabilities || known.capabilities || [],
    maxConcurrentTasks: body.maxConcurrentTasks || body.max_concurrent_tasks || 1,
    isDefaultAgent: Boolean(known.isDefaultAgent),
    isPrimaryAgent: Boolean(known.isPrimaryAgent),
    opencodeMode: known.opencodeMode || "",
    defaultAgentSource: known.defaultAgentSource || ""
  };
}

async function saveUploadedFile(body = {}, connectionProfile = {}, config = {}) {
  const name = safeFileName(body.name || "upload.bin");
  const contentBase64 = String(body.contentBase64 || "");
  if (!contentBase64) {
    throw httpError(400, "contentBase64 is required");
  }
  const buffer = Buffer.from(contentBase64, "base64");
  if (!buffer.length) {
    throw httpError(400, "Uploaded file is empty");
  }
  const fileArea = await resolveFileArea(
    configWithWorkspace(config, connectionProfile.workspacePath),
    connectionProfile.fileAreaMode
  );
  const root = fileArea.path || connectionProfile.fileAreaPath || path.join(path.dirname(config.dataFile), "files");
  const directory = path.join(root, "uploads");
  await fs.mkdir(directory, { recursive: true });
  const target = uniqueUploadPath(directory, name);
  await fs.writeFile(target, buffer);
  return {
    name,
    path: target,
    relativePath: path.relative(root, target),
    size: buffer.length,
    type: body.type || "application/octet-stream",
    uploadedAt: new Date().toISOString()
  };
}

function safeFileName(value) {
  const name = path.basename(String(value || "upload.bin"))
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return name || "upload.bin";
}

function uniqueUploadPath(directory, name) {
  const parsed = path.parse(name);
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(directory, `${parsed.name || "upload"}_${suffix}${parsed.ext || ""}`);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

async function applyConfiguredMainAgent(room, adapter, store) {
  if (!room) {
    return room;
  }
  if (room.mainAgentSource === "manual") {
    return room;
  }
  const projectInfo = await adapter.getProjectInfo?.().catch(() => null);
  const defaultAgentId = String(projectInfo?.defaultAgentId || "").trim();
  if (!defaultAgentId || room.mainAgentId === defaultAgentId) {
    return room;
  }
  if (!room.members?.some((member) => member.agentId === defaultAgentId)) {
    return room;
  }
  return store.setMainAgent(room.id, defaultAgentId, { source: "config" });
}

function isAuthorized(req, config, url) {
  if (!config.token) {
    return true;
  }
  return req.headers.authorization === `Bearer ${config.token}` || url.searchParams.get("token") === config.token;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  };
}

async function serveStatic(res, publicDir, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${cleanPath}`);
  if (!filePath.startsWith(publicDir)) {
    sendError(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
      "content-length": body.length
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function main() {
  const config = loadConfig();
  const { server, runtimeManager, v2Store } = await createTeamRoomServer(config);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close();
    server.closeAllConnections?.();
    await runtimeManager.stop().catch(() => {});
    v2Store.close?.();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${config.port} is already in use on ${config.host}.`);
      console.error(`Stop the existing process or start TeamRoom with TEAMROOM_PORT=<another-port>.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(config.port, config.host, () => {
    console.log(`OpenClaw TeamRoom listening on http://${config.host}:${config.port}`);
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
