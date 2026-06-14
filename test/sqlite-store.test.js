import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStore } from "../src/store.js";
import { V2SqliteStore } from "../src/v2/sqlite-store.js";

test("V2 SQLite store persists runs, human requests, and events across restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-sqlite-"));
  const jsonFile = path.join(directory, "legacy.json");
  const sqliteFile = path.join(directory, "teamroom-v2.sqlite");
  const legacyStore = new JsonStore(jsonFile);
  await legacyStore.load();
  const room = await legacyStore.createRoom({ name: "Persistent Room" });
  await legacyStore.addMember(room.id, {
    agentId: "main-agent",
    name: "Main Agent",
    roles: ["main"],
    capabilities: []
  });

  let store = new V2SqliteStore(sqliteFile, { legacyStore });
  await store.load();
  await store.syncLegacyRooms(await legacyStore.listRooms());
  const run = await store.createV2Run({
    roomId: room.id,
    conversationId: `room:${room.id}:main`,
    agentId: "main-agent",
    goal: "需要持久化的任务"
  });
  run.status = "waiting_user";
  run.startedAt = "2026-06-13T01:00:00.000Z";
  run.waitingSince = "2026-06-13T01:01:00.000Z";
  await store.updateV2Run(run);
  await store.createHumanRequest({
    id: "question_persisted",
    externalId: "question_persisted",
    roomId: room.id,
    runId: run.id,
    agentId: "main-agent",
    sessionId: "session_1",
    type: "question",
    status: "pending",
    title: "等待用户",
    questions: [{ question: "继续吗？", options: ["继续", "停止"] }],
    createdAt: "2026-06-13T01:01:00.000Z"
  });
  await store.appendEvent({
    id: "evt_persisted",
    roomId: room.id,
    taskId: run.id,
    type: "v2.human_request.created",
    timestamp: "2026-06-13T01:01:00.000Z",
    payload: { runId: run.id, taskId: run.id }
  });
  await store.appendEvent({
    id: "evt_invocation",
    roomId: room.id,
    taskId: run.id,
    type: "v2.invocation.started",
    timestamp: "2026-06-13T01:01:01.000Z",
    payload: {
      runId: run.id,
      taskId: run.id,
      sessionId: "session_child",
      parentRunId: "session_parent",
      agentId: "form-agent"
    }
  });
  store.close();

  store = new V2SqliteStore(sqliteFile, { legacyStore });
  await store.load();
  const restored = await store.getV2Run(run.id);
  const requests = await store.listHumanRequests(run.id);
  const events = await store.listEvents(room.id);
  const invocations = await store.listInvocations(run.id);

  assert.equal(restored.status, "waiting_user");
  assert.equal(restored.startedAt, "2026-06-13T01:00:00.000Z");
  assert.equal(restored.waitingSince, "2026-06-13T01:01:00.000Z");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, "pending");
  assert.equal(requests[0].questions[0].question, "继续吗？");
  assert.equal(events.length, 2);
  assert.equal(events[0].id, "evt_persisted");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].backendSessionId, "session_child");
  assert.equal(invocations[0].agentId, "form-agent");

  store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test("V2 SQLite store imports temporary V2 JSON records idempotently", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-migration-"));
  const legacyStore = new JsonStore(path.join(directory, "legacy.json"));
  await legacyStore.load();
  const room = await legacyStore.createRoom({ name: "Migration Room" });
  await legacyStore.addMember(room.id, {
    agentId: "main-agent",
    roles: ["main"],
    capabilities: []
  });
  const legacyRun = await legacyStore.createV2Run({
    roomId: room.id,
    conversationId: `room:${room.id}:main`,
    agentId: "main-agent",
    goal: "迁移任务"
  });

  const store = new V2SqliteStore(path.join(directory, "teamroom-v2.sqlite"), { legacyStore });
  await store.load();
  await store.syncLegacyRooms(await legacyStore.listRooms());
  const snapshot = await legacyStore.getV2MigrationSnapshot();
  await store.migrateLegacyV2Data(snapshot);
  await store.migrateLegacyV2Data(snapshot);

  const runs = await store.listV2Runs(room.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, legacyRun.id);

  store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test("room projection keeps its connection profile binding", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-profile-"));
  const legacyStore = new JsonStore(path.join(directory, "legacy.json"));
  await legacyStore.load();
  const room = await legacyStore.createRoom({ name: "Bound Room" });
  const store = new V2SqliteStore(path.join(directory, "teamroom-v2.sqlite"), { legacyStore });
  await store.load();
  const profile = await store.ensureConnectionProfile(
    { adapter: "mock" },
    { mode: "teamroom_default", path: path.join(directory, "files") }
  );
  await store.syncLegacyRooms(await legacyStore.listRooms(), profile.id);

  const projected = await store.getRoom(room.id);
  assert.equal(projected.connectionProfileId, profile.id);

  store.close();
  await fs.rm(directory, { recursive: true, force: true });
});
