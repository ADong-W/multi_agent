import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createAdapter } from "./adapters/index.js";
import { EventHub } from "./events.js";
import { Orchestrator } from "./orchestrator.js";
import { JsonStore } from "./store.js";
import { readJsonBody, sendError, sendJson } from "./utils.js";

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

  const adapter = createAdapter(config);
  const events = new EventHub({ store });
  const orchestrator = new Orchestrator({ store, events, adapter });

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest({
        req,
        res,
        config,
        store,
        events,
        adapter,
        orchestrator
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendError(res, statusCode, error.message || "Internal server error");
    }
  });

  return { server, store, events, adapter, orchestrator };
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

async function routeApi({ req, res, store, events, adapter, orchestrator }, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/agents") {
    sendJson(res, 200, { agents: await listProfiledAgents(adapter, store) });
    return;
  }

  if (parts[0] === "api" && parts[1] === "agents" && parts[2] && parts[3] === "profile") {
    const agentId = decodeURIComponent(parts[2]);
    const agents = await adapter.listAgents().catch(() => []);
    const known = agents.find((agent) => agent.id === agentId || agent.agentId === agentId) || { id: agentId };
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const profile = await store.upsertAgentProfile(agentId, {
        roles: body.roles,
        capabilities: body.capabilities
      });
      sendJson(res, 200, { profile, agent: mergeAgentProfile(known, profile) });
      return;
    }
    if (req.method === "DELETE") {
      await store.deleteAgentProfile(agentId, known);
      sendJson(res, 200, { agent: mergeAgentProfile(known, null) });
      return;
    }
    sendError(res, 405, "Method not allowed");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/rooms") {
    const rooms = await store.listRooms();
    sendJson(res, 200, { rooms });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJsonBody(req);
    const room = await store.createRoom(body);
    await events.publish(room.id, "room.created", { roomId: room.id, room });
    sendJson(res, 201, { room });
    return;
  }

  if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
    const roomId = parts[2];

    if (req.method === "GET" && parts.length === 3) {
      const room = await store.getRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      const tasks = await store.listTasks(roomId);
      sendJson(res, 200, { room, tasks });
      return;
    }

    if (req.method === "DELETE" && parts.length === 3) {
      const room = await store.deleteRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      sendJson(res, 200, { roomId, deleted: true });
      return;
    }

    if (req.method === "GET" && parts[3] === "events") {
      const room = await store.getRoom(roomId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      await events.subscribe(roomId, res);
      return;
    }

    if (req.method === "POST" && parts[3] === "members") {
      const body = await readJsonBody(req);
      const member = await enrichMember(body, adapter, store);
      if (!member.agentId) {
        sendError(res, 400, "agentId is required");
        return;
      }
      const room = await store.addMember(roomId, member);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      await events.publish(roomId, "member.added", { roomId, member });
      sendJson(res, 200, { room });
      return;
    }

    if (req.method === "DELETE" && parts[3] === "members" && parts[4]) {
      const agentId = decodeURIComponent(parts[4]);
      const room = await store.removeMember(roomId, agentId);
      if (!room) {
        sendError(res, 404, "Room not found");
        return;
      }
      await events.publish(roomId, "member.removed", { roomId, agentId });
      sendJson(res, 200, { room });
      return;
    }

    if (req.method === "POST" && parts[3] === "tasks") {
      const body = await readJsonBody(req);
      const task = await orchestrator.submitTask(roomId, body);
      sendJson(res, 202, { task });
      return;
    }
  }

  sendError(res, 404, "Not found");
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
  return {
    ...agent,
    id,
    roles: hasProfile ? profile.roles : agent.roles || [],
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
    maxConcurrentTasks: body.maxConcurrentTasks || body.max_concurrent_tasks || 1
  };
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
  const { server } = await createTeamRoomServer(config);
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
