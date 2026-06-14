import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStore } from "../src/store.js";
import { DirectRunService } from "../src/v2/direct-run-service.js";

test("simple message calls only the main agent without forced stages or review", async (t) => {
  const fixture = await createFixture(t, {
    async sendMessage({ agentId, content, context, hooks }) {
      fixture.calls.push({ agentId, content, context });
      await hooks.onSessionReady({
        sessionId: "session_direct",
        backendRunId: "backend_run_direct"
      });
      await context.onProgress({ text: "正在直接回答", state: "running" });
      return {
        status: "completed",
        summary: "这是主要助手的直接回答。",
        completionSource: "test_backend"
      };
    }
  });

  const submitted = await fixture.service.submitMessage(fixture.room.id, {
    content: "复盘一下刚才的工作"
  });
  const completed = await waitForRun(fixture.store, submitted.id, "completed");

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].agentId, "main-agent");
  assert.equal(fixture.calls[0].content, "复盘一下刚才的工作");
  assert.equal(completed.summary, "这是主要助手的直接回答。");
  assert.equal(completed.completionSource, "test_backend");
  const conversation = await fixture.store.getConversation(completed.conversationId);
  assert.equal(conversation.backendSessionId, "session_direct");
  assert.equal(completed.backendRunId, "backend_run_direct");

  const eventTypes = fixture.events.items.map((event) => event.type);
  assert.deepEqual(eventTypes, [
    "v2.message.created",
    "v2.run.created",
    "v2.run.started",
    "v2.run.output.delta",
    "v2.run.output.completed",
    "v2.run.completed"
  ]);
  assert.equal(eventTypes.some((type) => /stage|dispatch|review|planned/.test(type)), false);
});

test("internal tool progress is not published into the conversation stream", async (t) => {
  const fixture = await createFixture(t, {
    async sendMessage({ context }) {
      await context.onProgress({ text: "skill · running", state: "tool:running" });
      await context.onProgress({ text: "可见文字", state: "running" });
      return {
        status: "completed",
        summary: "最终文字",
        completionSource: "test_backend"
      };
    }
  });

  const submitted = await fixture.service.submitMessage(fixture.room.id, {
    content: "执行任务"
  });
  await waitForRun(fixture.store, submitted.id, "completed");

  const deltas = fixture.events.items.filter((event) => event.type === "v2.run.output.delta");
  assert.deepEqual(deltas.map((event) => event.payload.content), ["可见文字"]);
});

test("native human request pauses and resumes the same run", async (t) => {
  let approvalResponse;
  const fixture = await createFixture(t, {
    async sendMessage({ hooks }) {
      approvalResponse = await hooks.onApprovalRequest({
        id: "question_1",
        type: "question",
        title: "请选择处理方式",
        questions: [{
          header: "处理方式",
          question: "是否继续？",
          options: ["继续", "停止"]
        }]
      });
      return {
        status: "completed",
        summary: `已收到：${approvalResponse.answers[0][0]}`,
        completionSource: "test_backend"
      };
    }
  });

  const submitted = await fixture.service.submitMessage(fixture.room.id, {
    content: "执行需要确认的任务"
  });
  const waiting = await waitForRun(fixture.store, submitted.id, "waiting_user");
  assert.equal(waiting.id, submitted.id);

  const requests = await fixture.store.listHumanRequests(submitted.id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, "question_1");

  await fixture.service.respondHumanRequest(
    fixture.room.id,
    submitted.id,
    "question_1",
    { answers: [["继续"]] }
  );

  const completed = await waitForRun(fixture.store, submitted.id, "completed");
  assert.equal(completed.id, submitted.id);
  assert.equal(completed.summary, "已收到：继续");
  assert.deepEqual(approvalResponse.answers, [["继续"]]);
});

test("a backend cannot complete while a human request is still pending", async (t) => {
  let requestPromise;
  const fixture = await createFixture(t, {
    async sendMessage({ hooks }) {
      requestPromise = hooks.onApprovalRequest({
        id: "late_question",
        type: "question",
        title: "仍需确认",
        questions: [{ question: "继续吗？", options: ["继续", "停止"] }]
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        status: "completed",
        summary: "不应提前完成",
        completionSource: "test_backend"
      };
    }
  });

  const submitted = await fixture.service.submitMessage(fixture.room.id, {
    content: "执行并等待确认"
  });
  const waiting = await waitForRun(fixture.store, submitted.id, "waiting_user");

  assert.equal(waiting.completedAt, null);
  assert.equal(
    fixture.events.items.some((event) => event.type === "v2.run.completed"),
    false
  );
  await fixture.service.respondHumanRequest(
    fixture.room.id,
    submitted.id,
    "late_question",
    { answers: [["继续"]] }
  );
  await requestPromise;
});

test("persisted human request can be answered after service restart", async (t) => {
  const fixture = await createFixture(t, {
    async sendMessage() {
      throw new Error("not used");
    }
  });
  const run = await fixture.store.createV2Run({
    roomId: fixture.room.id,
    conversationId: `room:${fixture.room.id}:main`,
    agentId: "main-agent",
    goal: "恢复确认"
  });
  run.status = "waiting_user";
  await fixture.store.updateV2Run(run);
  await fixture.store.createHumanRequest({
    id: "question_after_restart",
    externalId: "question_after_restart",
    roomId: fixture.room.id,
    runId: run.id,
    agentId: "main-agent",
    sessionId: "session_after_restart",
    type: "question",
    status: "pending",
    title: "继续吗",
    questions: [{ question: "继续吗？", options: ["继续"] }],
    createdAt: new Date().toISOString()
  });

  const answers = [];
  const restarted = new DirectRunService({
    store: fixture.store,
    events: fixture.events,
    backend: {
      async probeConnection() {
        return { connected: true };
      },
      async listAgents() {
        return [];
      },
      async sendMessage() {
        throw new Error("not used");
      },
      async answerQuestion(input) {
        answers.push(input);
      }
    }
  });
  await restarted.respondHumanRequest(
    fixture.room.id,
    run.id,
    "question_after_restart",
    { answers: [["继续"]] }
  );

  const request = await fixture.store.getHumanRequest("question_after_restart");
  const resumed = await fixture.store.getV2Run(run.id);
  assert.equal(answers.length, 1);
  assert.equal(request.status, "answered");
  assert.equal(resumed.status, "running");
});

test("answering a persisted request reattaches to the original backend session", async (t) => {
  const fixture = await createFixture(t, {
    async sendMessage() {
      throw new Error("not used");
    }
  });
  const run = await fixture.store.createV2Run({
    roomId: fixture.room.id,
    conversationId: `room:${fixture.room.id}:main`,
    agentId: "main-agent",
    goal: "重启后继续"
  });
  await fixture.store.updateConversationBackendSession(run.conversationId, "session_recover");
  run.status = "waiting_user";
  await fixture.store.updateV2Run(run);
  await fixture.store.createHumanRequest({
    id: "question_recover",
    externalId: "question_recover",
    roomId: fixture.room.id,
    runId: run.id,
    agentId: "main-agent",
    sessionId: "session_recover",
    type: "question",
    status: "pending",
    title: "继续吗",
    questions: [{ question: "继续吗？", options: ["继续"] }],
    createdAt: new Date().toISOString()
  });

  const watched = [];
  const restarted = new DirectRunService({
    store: fixture.store,
    events: fixture.events,
    backend: {
      async probeConnection() {
        return { connected: true };
      },
      async listAgents() {
        return [];
      },
      async sendMessage() {
        throw new Error("not used");
      },
      async answerQuestion() {
        return true;
      },
      async getSnapshot() {
        return { status: { type: "busy" }, messages: [] };
      },
      async watchSession(input) {
        watched.push(input.sessionId);
        return {
          status: "completed",
          summary: "原会话已继续完成",
          completionSource: "test_recovery"
        };
      }
    }
  });

  await restarted.respondHumanRequest(
    fixture.room.id,
    run.id,
    "question_recover",
    { answers: [["继续"]] }
  );
  const completed = await waitForRun(fixture.store, run.id, "completed");
  assert.deepEqual(watched, ["session_recover"]);
  assert.equal(completed.summary, "原会话已继续完成");
});

test("guidance during a run is delivered to the existing backend session", async (t) => {
  let finishRun;
  const interventions = [];
  const fixture = await createFixture(t, {
    async sendMessage({ hooks }) {
      await hooks.onSessionReady({
        sessionId: "session_in_progress",
        backendRunId: "backend_in_progress"
      });
      await new Promise((resolve) => {
        finishRun = resolve;
      });
      return {
        status: "completed",
        summary: "已按补充要求完成",
        completionSource: "test_backend"
      };
    },
    async sendIntervention(input) {
      interventions.push(input);
      return { delivered: true };
    }
  });

  const submitted = await fixture.service.submitMessage(fixture.room.id, {
    content: "先开始处理"
  });
  await waitForRun(fixture.store, submitted.id, "running");
  await waitForConversationSession(fixture.store, submitted.conversationId);

  await fixture.service.submitIntervention(fixture.room.id, submitted.id, {
    content: "先不要修改，只给影响分析"
  });

  assert.equal(interventions.length, 1);
  assert.equal(interventions[0].sessionId, "session_in_progress");
  assert.equal(interventions[0].content, "先不要修改，只给影响分析");
  assert.equal((await fixture.store.listV2Runs(fixture.room.id)).length, 1);

  finishRun();
  await waitForRun(fixture.store, submitted.id, "completed");
});

test("duplicate client message ids do not create duplicate tasks", async (t) => {
  const fixture = await createFixture(t, {
    async sendMessage() {
      return {
        status: "completed",
        summary: "完成",
        completionSource: "test_backend"
      };
    }
  });

  const first = await fixture.service.submitMessage(fixture.room.id, {
    content: "执行一次",
    clientMessageId: "client-message-1"
  });
  await waitForRun(fixture.store, first.id, "completed");
  const duplicate = await fixture.service.submitMessage(fixture.room.id, {
    content: "执行一次",
    clientMessageId: "client-message-1"
  });

  assert.equal(duplicate.id, first.id);
  assert.equal((await fixture.store.listV2Runs(fixture.room.id)).length, 1);
});

async function createFixture(t, backendOverrides) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-v2-"));
  const store = new JsonStore(path.join(directory, "teamroom.json"));
  t.after(async () => {
    await store.writeQueue;
    await fs.rm(directory, { recursive: true, force: true });
  });
  await store.load();
  const room = await store.createRoom({ name: "V2 Test Room" });
  await store.addMember(room.id, {
    agentId: "main-agent",
    name: "Main Agent",
    roles: ["main"],
    capabilities: []
  });
  await store.addMember(room.id, {
    agentId: "other-agent",
    name: "Other Agent",
    roles: ["specialist"],
    capabilities: []
  });

  const events = {
    items: [],
    async publish(roomId, type, payload) {
      const event = { roomId, type, payload };
      this.items.push(event);
      return event;
    }
  };
  const calls = [];
  const backend = {
    async probeConnection() {
      return { connected: true, capabilities: {} };
    },
    async listAgents() {
      return [];
    },
    ...backendOverrides
  };
  const service = new DirectRunService({ store, events, backend });
  return { store, room: await store.getRoom(room.id), events, calls, service };
}

async function waitForRun(store, runId, expectedStatus) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const run = await store.getV2Run(runId);
    if (run?.status === expectedStatus) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await store.getV2Run(runId);
  assert.fail(`Run ${runId} did not reach ${expectedStatus}; current status is ${run?.status}`);
}

async function waitForConversationSession(store, conversationId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const conversation = await store.getConversation(conversationId);
    if (conversation?.backendSessionId) {
      return conversation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Conversation ${conversationId} did not receive a backend session id`);
}
