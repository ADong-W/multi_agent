import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStore } from "../src/store.js";

test("first room member becomes main agent and removal promotes the next member", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-members-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, "teamroom.json"));
  await store.load();
  const room = await store.createRoom({ name: "成员测试" });

  await store.addMember(room.id, {
    agentId: "first-agent",
    name: "First Agent"
  });
  await store.addMember(room.id, {
    agentId: "second-agent",
    name: "Second Agent"
  });

  assert.equal((await store.getRoom(room.id)).mainAgentId, "first-agent");

  await store.removeMember(room.id, "first-agent");
  const updated = await store.getRoom(room.id);
  assert.equal(updated.mainAgentId, "second-agent");
  assert.deepEqual(updated.members.map((member) => member.agentId), ["second-agent"]);
});

test("adding to a legacy room preserves its first existing member as main agent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-legacy-members-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, "teamroom.json"));
  await store.load();
  const room = await store.createRoom({ name: "旧协作室" });
  room.members = [{
    agentId: "existing-agent",
    name: "Existing Agent",
    roles: [],
    capabilities: []
  }];
  await store.updateRoom(room);

  await store.addMember(room.id, {
    agentId: "new-agent",
    name: "New Agent"
  });

  assert.equal((await store.getRoom(room.id)).mainAgentId, "existing-agent");
});

test("room main agent can be changed explicitly to another member", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-main-agent-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, "teamroom.json"));
  await store.load();
  const room = await store.createRoom({ name: "主助手设置" });

  await store.addMember(room.id, {
    agentId: "dimension-agent",
    name: "Dimension Agent"
  });
  await store.addMember(room.id, {
    agentId: "supervisor-agent",
    name: "Supervisor Agent",
    roles: ["supervisor"]
  });

  await store.setMainAgent(room.id, "supervisor-agent");

  assert.equal((await store.getRoom(room.id)).mainAgentId, "supervisor-agent");
  await assert.rejects(
    store.setMainAgent(room.id, "not-a-member"),
    /Agent is not a member/
  );
});
